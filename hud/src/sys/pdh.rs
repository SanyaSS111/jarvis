//! Счётчики производительности Windows: живая частота процессора и обмен с диском.
//! pdh.dll подгружаем по требованию, импортной библиотеки для неё в поставке Rust нет.

use std::ffi::c_void;
use std::sync::Mutex;

use crate::win32::*;

const PDH_FMT_DOUBLE: u32 = 0x0000_0200;

type PdhOpenQuery = unsafe extern "system" fn(*const u16, usize, *mut *mut c_void) -> i32;
type PdhAddCounter = unsafe extern "system" fn(*mut c_void, *const u16, usize, *mut *mut c_void) -> i32;
type PdhCollect = unsafe extern "system" fn(*mut c_void) -> i32;
type PdhGetValue = unsafe extern "system" fn(*mut c_void, u32, *mut u32, *mut CounterValue) -> i32;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CounterValue {
    status: u32,
    _padding: u32,
    value: f64,
}

struct Pdh {
    query: *mut c_void,
    cpu_perf: *mut c_void,
    cpu_base: *mut c_void,
    disk_read: *mut c_void,
    disk_write: *mut c_void,
    collect: PdhCollect,
    get_value: PdhGetValue,
}

// Дескрипторы PDH используются только из потока сборщика.
unsafe impl Send for Pdh {}

static PDH: Mutex<Option<Pdh>> = Mutex::new(None);

pub fn init() {
    unsafe {
        let library = LoadLibraryA(b"pdh.dll\0".as_ptr());
        if library.is_null() {
            return;
        }

        let open = GetProcAddress(library, b"PdhOpenQueryW\0".as_ptr());
        let add = GetProcAddress(library, b"PdhAddEnglishCounterW\0".as_ptr());
        let collect = GetProcAddress(library, b"PdhCollectQueryData\0".as_ptr());
        let value = GetProcAddress(library, b"PdhGetFormattedCounterValue\0".as_ptr());
        if open.is_null() || add.is_null() || collect.is_null() || value.is_null() {
            return;
        }

        let open: PdhOpenQuery = std::mem::transmute(open);
        let add: PdhAddCounter = std::mem::transmute(add);
        let collect: PdhCollect = std::mem::transmute(collect);
        let get_value: PdhGetValue = std::mem::transmute(value);

        let mut query: *mut c_void = std::ptr::null_mut();
        if open(std::ptr::null(), 0, &mut query) != 0 {
            return;
        }

        // Английские имена счётчиков работают и на локализованной Windows.
        let mut counter = |path: &str| -> *mut c_void {
            let wide_path = wide(path);
            let mut handle: *mut c_void = std::ptr::null_mut();
            if add(query, wide_path.as_ptr(), 0, &mut handle) != 0 {
                return std::ptr::null_mut();
            }
            handle
        };

        let cpu_perf = counter(r"\Processor Information(_Total)\% Processor Performance");
        let cpu_base = counter(r"\Processor Information(_Total)\Processor Frequency");
        let disk_read = counter(r"\PhysicalDisk(_Total)\Disk Read Bytes/sec");
        let disk_write = counter(r"\PhysicalDisk(_Total)\Disk Write Bytes/sec");

        collect(query); // первый сбор задаёт точку отсчёта

        *PDH.lock().unwrap() = Some(Pdh {
            query,
            cpu_perf,
            cpu_base,
            disk_read,
            disk_write,
            collect,
            get_value,
        });
    }
}

fn read(pdh: &Pdh, counter: *mut c_void) -> Option<f64> {
    if counter.is_null() {
        return None;
    }
    let mut value = CounterValue::default();
    let status = unsafe { (pdh.get_value)(counter, PDH_FMT_DOUBLE, std::ptr::null_mut(), &mut value) };
    if status != 0 {
        return None;
    }
    Some(value.value)
}

/// Один сбор на такт: обновляет все счётчики сразу.
fn collect_all() {
    if let Some(pdh) = PDH.lock().unwrap().as_ref() {
        unsafe { (pdh.collect)(pdh.query) };
    }
}

/// Живая частота процессора. psutil-подобный путь через реестр даёт лишь базовую.
pub fn cpu_freq_mhz() -> u32 {
    collect_all();
    let guard = PDH.lock().unwrap();
    let Some(pdh) = guard.as_ref() else { return 0 };

    match (read(pdh, pdh.cpu_perf), read(pdh, pdh.cpu_base)) {
        (Some(percent), Some(base)) if base > 0.0 => (base * percent / 100.0).round() as u32,
        _ => 0,
    }
}

/// Чтение и запись диска в килобайтах в секунду.
pub fn disk_io() -> (f32, f32) {
    let guard = PDH.lock().unwrap();
    let Some(pdh) = guard.as_ref() else { return (0.0, 0.0) };

    let read_bytes = read(pdh, pdh.disk_read).unwrap_or(0.0);
    let write_bytes = read(pdh, pdh.disk_write).unwrap_or(0.0);
    ((read_bytes / 1024.0) as f32, (write_bytes / 1024.0) as f32)
}
