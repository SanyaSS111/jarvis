//! Сбор системных метрик напрямую через Win32.
//! Считается в отдельном потоке с постоянным шагом, чтобы отрисовка
//! никогда не ждала опроса датчиков.

pub mod cpu;
pub mod net;
pub mod nvml;
pub mod pdh;
pub mod procs;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::win32::*;

#[derive(Clone, Debug, Default)]
pub struct StaticInfo {
    pub hostname: String,
    pub os: String,
    pub threads: usize,
    pub ram_total_gb: f32,
    pub disk_total_gb: f32,
    pub has_battery: bool,
    pub gpu_name: Option<String>,
    pub gpu_vram_total_gb: f32,
    pub gpu_power_limit_w: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub cpu: f32,
    pub cpu_cores: Vec<f32>,
    pub cpu_freq_mhz: u32,
    pub ram_percent: f32,
    pub ram_used_gb: f32,
    pub disk_percent: f32,
    pub disk_free_gb: f32,
    pub disk_read_kbs: f32,
    pub disk_write_kbs: f32,
    pub uptime_secs: u64,
    pub net_kind: String,
    pub net_name: String,
    pub net_link_mbps: u32,
    pub net_down_kbs: f32,
    pub net_up_kbs: f32,
    pub net_tunnel: Option<String>,
    pub gpu_load: f32,
    pub gpu_vram_used_gb: f32,
    pub gpu_vram_percent: f32,
    pub gpu_temp: u32,
    pub gpu_power_w: f32,
    pub gpu_fan: u32,
    pub gpu_clock_core: u32,
    pub gpu_clock_mem: u32,
    pub top_processes: Vec<procs::ProcessRow>,
}

/// Общий снимок: поток сборщика пишет, отрисовка читает.
#[derive(Clone)]
pub struct Metrics {
    sample: Arc<Mutex<Sample>>,
    idle: Arc<Mutex<bool>>,
    pub info: StaticInfo,
}

fn hostname() -> String {
    unsafe {
        let mut buffer = [0u16; 64];
        let mut size = buffer.len() as u32;
        if GetComputerNameW(buffer.as_mut_ptr(), &mut size) == 0 {
            return "—".into();
        }
        String::from_utf16_lossy(&buffer[..size as usize])
    }
}

fn thread_count() -> usize {
    unsafe {
        let mut info = SYSTEM_INFO::default();
        GetSystemInfo(&mut info);
        info.dwNumberOfProcessors as usize
    }
}

fn memory() -> (f32, f32, f32) {
    unsafe {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return (0.0, 0.0, 0.0);
        }
        let total = status.ullTotalPhys as f32 / 1024.0 / 1024.0 / 1024.0;
        let used = (status.ullTotalPhys - status.ullAvailPhys) as f32 / 1024.0 / 1024.0 / 1024.0;
        (status.dwMemoryLoad as f32, used, total)
    }
}

fn system_disk() -> (f32, f32, f32) {
    unsafe {
        let path = wide("C:\\");
        let mut free_to_caller = 0u64;
        let mut total = 0u64;
        let mut free = 0u64;
        if GetDiskFreeSpaceExW(path.as_ptr(), &mut free_to_caller, &mut total, &mut free) == 0 {
            return (0.0, 0.0, 0.0);
        }
        let total_gb = total as f32 / 1024.0 / 1024.0 / 1024.0;
        let free_gb = free as f32 / 1024.0 / 1024.0 / 1024.0;
        let percent = if total_gb > 0.0 { (1.0 - free_gb / total_gb) * 100.0 } else { 0.0 };
        (percent, free_gb, total_gb)
    }
}

/// Версия Windows из реестра: RtlGetVersion в оболочке лишний.
fn os_name() -> String {
    let build = crate::registry::read_string(
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        "CurrentBuildNumber",
    )
    .unwrap_or_default();
    let build_number: u32 = build.parse().unwrap_or(0);
    if build_number >= 22000 { "Windows 11".into() } else { "Windows 10".into() }
}

impl Metrics {
    pub fn start() -> Self {
        nvml::init();
        pdh::init();
        cpu::prime();
        net::prime();

        let gpu_static = nvml::static_info();
        let (_, _, ram_total) = memory();
        let (_, _, disk_total) = system_disk();

        let info = StaticInfo {
            hostname: hostname(),
            os: os_name(),
            threads: thread_count(),
            ram_total_gb: ram_total,
            disk_total_gb: disk_total,
            has_battery: false,
            gpu_name: gpu_static.as_ref().map(|g| g.name.clone()),
            gpu_vram_total_gb: gpu_static.as_ref().map(|g| g.vram_total_gb).unwrap_or(0.0),
            gpu_power_limit_w: gpu_static.as_ref().map(|g| g.power_limit_w).unwrap_or(0.0),
        };

        let metrics = Self {
            sample: Arc::new(Mutex::new(Sample::default())),
            idle: Arc::new(Mutex::new(false)),
            info,
        };

        let worker = metrics.clone();
        std::thread::spawn(move || worker.collect_loop());
        metrics
    }

    pub fn snapshot(&self) -> Sample {
        self.sample.lock().unwrap().clone()
    }

    /// Когда обои закрыты окнами, шаг сбора увеличивается и процессы не обходятся.
    pub fn set_idle(&self, value: bool) {
        *self.idle.lock().unwrap() = value;
    }

    fn collect_loop(&self) {
        procs::prime();
        let mut tick: u64 = 0;

        loop {
            let idle = *self.idle.lock().unwrap();
            std::thread::sleep(Duration::from_millis(if idle { 5000 } else { 1000 }));
            tick += 1;

            let (cores, total) = cpu::sample();
            let (ram_percent, ram_used, _) = memory();
            let (disk_percent, disk_free, _) = system_disk();
            let network = net::sample();
            let gpu = nvml::sample();
            let (read_kbs, write_kbs) = pdh::disk_io();

            let processes = if idle {
                self.sample.lock().unwrap().top_processes.clone()
            } else if tick % 3 == 1 {
                procs::top(5)
            } else {
                self.sample.lock().unwrap().top_processes.clone()
            };

            let next = Sample {
                cpu: total,
                cpu_cores: cores,
                cpu_freq_mhz: pdh::cpu_freq_mhz(),
                ram_percent,
                ram_used_gb: ram_used,
                disk_percent,
                disk_free_gb: disk_free,
                disk_read_kbs: read_kbs,
                disk_write_kbs: write_kbs,
                uptime_secs: unsafe { GetTickCount64() } / 1000,
                net_kind: network.kind,
                net_name: network.name,
                net_link_mbps: network.link_mbps,
                net_down_kbs: network.down_kbs,
                net_up_kbs: network.up_kbs,
                net_tunnel: network.tunnel,
                gpu_load: gpu.load,
                gpu_vram_used_gb: gpu.vram_used_gb,
                gpu_vram_percent: gpu.vram_percent,
                gpu_temp: gpu.temp,
                gpu_power_w: gpu.power_w,
                gpu_fan: gpu.fan,
                gpu_clock_core: gpu.clock_core,
                gpu_clock_mem: gpu.clock_mem,
                top_processes: processes,
            };

            *self.sample.lock().unwrap() = next;
        }
    }
}
