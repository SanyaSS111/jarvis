//! Видеокарта NVIDIA через NVML. Библиотека идёт с драйвером, поэтому
//! подгружаем её по требованию: без карты NVIDIA модули просто скрываются.

use std::ffi::c_void;
use std::sync::Mutex;

use crate::win32::*;

const TEMPERATURE_GPU: u32 = 0;
const CLOCK_GRAPHICS: u32 = 0;
const CLOCK_MEM: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Utilization {
    gpu: u32,
    memory: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Memory {
    total: u64,
    free: u64,
    used: u64,
}

type Init = unsafe extern "C" fn() -> i32;
type GetHandle = unsafe extern "C" fn(u32, *mut *mut c_void) -> i32;
type GetName = unsafe extern "C" fn(*mut c_void, *mut u8, u32) -> i32;
type GetUtil = unsafe extern "C" fn(*mut c_void, *mut Utilization) -> i32;
type GetMemory = unsafe extern "C" fn(*mut c_void, *mut Memory) -> i32;
type GetU32 = unsafe extern "C" fn(*mut c_void, *mut u32) -> i32;
type GetTemp = unsafe extern "C" fn(*mut c_void, u32, *mut u32) -> i32;
type GetClock = unsafe extern "C" fn(*mut c_void, u32, *mut u32) -> i32;

struct Nvml {
    device: *mut c_void,
    get_util: GetUtil,
    get_memory: GetMemory,
    get_temp: GetTemp,
    get_power: GetU32,
    get_fan: Option<GetU32>,
    get_clock: GetClock,
}

unsafe impl Send for Nvml {}

#[derive(Clone, Debug)]
pub struct GpuStatic {
    pub name: String,
    pub vram_total_gb: f32,
    pub power_limit_w: f32,
}

#[derive(Clone, Debug, Default)]
pub struct GpuSample {
    pub load: f32,
    pub vram_used_gb: f32,
    pub vram_percent: f32,
    pub temp: u32,
    pub power_w: f32,
    pub fan: u32,
    pub clock_core: u32,
    pub clock_mem: u32,
}

static NVML: Mutex<Option<Nvml>> = Mutex::new(None);
static STATIC: Mutex<Option<GpuStatic>> = Mutex::new(None);

pub fn init() {
    unsafe {
        let library = LoadLibraryA(b"nvml.dll\0".as_ptr());
        let library = if library.is_null() {
            LoadLibraryA(b"C:\\Windows\\System32\\nvml.dll\0".as_ptr())
        } else {
            library
        };
        if library.is_null() {
            return;
        }

        let symbol = |name: &[u8]| GetProcAddress(library, name.as_ptr());

        let init_fn = symbol(b"nvmlInit_v2\0");
        let handle_fn = symbol(b"nvmlDeviceGetHandleByIndex_v2\0");
        let name_fn = symbol(b"nvmlDeviceGetName\0");
        let util_fn = symbol(b"nvmlDeviceGetUtilizationRates\0");
        let memory_fn = symbol(b"nvmlDeviceGetMemoryInfo\0");
        let temp_fn = symbol(b"nvmlDeviceGetTemperature\0");
        let power_fn = symbol(b"nvmlDeviceGetPowerUsage\0");
        let limit_fn = symbol(b"nvmlDeviceGetEnforcedPowerLimit\0");
        let fan_fn = symbol(b"nvmlDeviceGetFanSpeed\0");
        let clock_fn = symbol(b"nvmlDeviceGetClockInfo\0");

        if init_fn.is_null() || handle_fn.is_null() || util_fn.is_null() || memory_fn.is_null() {
            return;
        }

        let init: Init = std::mem::transmute(init_fn);
        if init() != 0 {
            return;
        }

        let get_handle: GetHandle = std::mem::transmute(handle_fn);
        let mut device: *mut c_void = std::ptr::null_mut();
        if get_handle(0, &mut device) != 0 {
            return;
        }

        let mut name = String::from("NVIDIA");
        if !name_fn.is_null() {
            let get_name: GetName = std::mem::transmute(name_fn);
            let mut buffer = [0u8; 96];
            if get_name(device, buffer.as_mut_ptr(), buffer.len() as u32) == 0 {
                let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
                name = String::from_utf8_lossy(&buffer[..end]).replace("NVIDIA ", "");
            }
        }

        let get_memory: GetMemory = std::mem::transmute(memory_fn);
        let mut memory = Memory::default();
        get_memory(device, &mut memory);

        let mut power_limit = 0.0;
        if !limit_fn.is_null() {
            let get_limit: GetU32 = std::mem::transmute(limit_fn);
            let mut milliwatts: u32 = 0;
            if get_limit(device, &mut milliwatts) == 0 {
                power_limit = milliwatts as f32 / 1000.0;
            }
        }

        *STATIC.lock().unwrap() = Some(GpuStatic {
            name,
            vram_total_gb: memory.total as f32 / 1024.0 / 1024.0 / 1024.0,
            power_limit_w: power_limit,
        });

        *NVML.lock().unwrap() = Some(Nvml {
            device,
            get_util: std::mem::transmute(util_fn),
            get_memory,
            get_temp: std::mem::transmute(temp_fn),
            get_power: std::mem::transmute(power_fn),
            get_fan: if fan_fn.is_null() { None } else { Some(std::mem::transmute(fan_fn)) },
            get_clock: std::mem::transmute(clock_fn),
        });
    }
}

pub fn static_info() -> Option<GpuStatic> {
    STATIC.lock().unwrap().clone()
}

pub fn available() -> bool {
    NVML.lock().unwrap().is_some()
}

pub fn sample() -> GpuSample {
    let guard = NVML.lock().unwrap();
    let Some(nvml) = guard.as_ref() else { return GpuSample::default() };

    unsafe {
        let mut util = Utilization::default();
        (nvml.get_util)(nvml.device, &mut util);

        let mut memory = Memory::default();
        (nvml.get_memory)(nvml.device, &mut memory);

        let mut temp: u32 = 0;
        (nvml.get_temp)(nvml.device, TEMPERATURE_GPU, &mut temp);

        let mut milliwatts: u32 = 0;
        (nvml.get_power)(nvml.device, &mut milliwatts);

        let mut fan: u32 = 0;
        if let Some(get_fan) = nvml.get_fan {
            get_fan(nvml.device, &mut fan);
        }

        let mut clock_core: u32 = 0;
        let mut clock_mem: u32 = 0;
        (nvml.get_clock)(nvml.device, CLOCK_GRAPHICS, &mut clock_core);
        (nvml.get_clock)(nvml.device, CLOCK_MEM, &mut clock_mem);

        let total = memory.total.max(1) as f32;
        GpuSample {
            load: util.gpu as f32,
            vram_used_gb: memory.used as f32 / 1024.0 / 1024.0 / 1024.0,
            vram_percent: memory.used as f32 / total * 100.0,
            temp,
            power_w: milliwatts as f32 / 1000.0,
            fan,
            clock_core,
            clock_mem,
        }
    }
}
