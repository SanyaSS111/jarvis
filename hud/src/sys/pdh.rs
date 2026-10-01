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
type PdhGetArray = unsafe extern "system" fn(*mut c_void, u32, *mut u32, *mut u32, *mut u8) -> i32;

const PDH_MORE_DATA: i32 = 0x8000_07D2_u32 as i32;

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
    /// Видеокарта без NVML (gpu_any.rs): загрузка всех движков 3D и собственная занятая память.
    gpu_engines: *mut c_void,
    gpu_memory: *mut c_void,
    gpu_luid: String,
    collect: PdhCollect,
    get_value: PdhGetValue,
    get_array: Option<PdhGetArray>,
}

/// Элемент PDH_FMT_COUNTERVALUE_ITEM_W.
#[repr(C)]
struct CounterItem {
    name: *const u16,
    value: CounterValue,
}

// Дескрипторы PDH используются только из потока сборщика.
unsafe impl Send for Pdh {}

static PDH: Mutex<Option<Pdh>> = Mutex::new(None);

/// gpu_luid: адаптер, чьи счётчики читать, когда NVML недоступен.
pub fn init(gpu_luid: Option<&str>) {
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
        let array = GetProcAddress(library, b"PdhGetFormattedCounterArrayW\0".as_ptr());
        let get_array: Option<PdhGetArray> = if array.is_null() { None } else { Some(std::mem::transmute(array)) };

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
        let (gpu_engines, gpu_memory) = match gpu_luid {
            Some(luid) => (
                counter(r"\GPU Engine(*)\Utilization Percentage"),
                counter(&format!(r"\GPU Adapter Memory({luid}_phys_0)\Dedicated Usage")),
            ),
            None => (std::ptr::null_mut(), std::ptr::null_mut()),
        };

        collect(query); // первый сбор задаёт точку отсчёта

        *PDH.lock().unwrap() = Some(Pdh {
            query,
            cpu_perf,
            cpu_base,
            disk_read,
            disk_write,
            gpu_engines,
            gpu_memory,
            gpu_luid: gpu_luid.unwrap_or_default().to_lowercase(),
            collect,
            get_value,
            get_array,
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

/// Загрузка видеокарты (сумма движков 3D её LUID, %) и занятая собственная память (байты).
pub fn gpu_usage() -> Option<(f32, u64)> {
    let guard = PDH.lock().unwrap();
    let pdh = guard.as_ref()?;
    if pdh.gpu_engines.is_null() {
        return None;
    }
    let memory = read(pdh, pdh.gpu_memory).unwrap_or(0.0) as u64;
    let mut load = 0.0;
    if let Some(get_array) = pdh.get_array {
        unsafe {
            let mut size: u32 = 0;
            let mut count: u32 = 0;
            if get_array(pdh.gpu_engines, PDH_FMT_DOUBLE, &mut size, &mut count, std::ptr::null_mut()) == PDH_MORE_DATA && size > 0 {
                // u64: выравнивание для элементов с double внутри.
                let mut buffer = vec![0u64; (size as usize + 7) / 8];
                if get_array(pdh.gpu_engines, PDH_FMT_DOUBLE, &mut size, &mut count, buffer.as_mut_ptr() as *mut u8) == 0 {
                    let items = std::slice::from_raw_parts(buffer.as_ptr() as *const CounterItem, count as usize);
                    for item in items {
                        if item.name.is_null() || item.value.status != 0 {
                            continue;
                        }
                        let mut len = 0;
                        while *item.name.add(len) != 0 {
                            len += 1;
                        }
                        let name = String::from_utf16_lossy(std::slice::from_raw_parts(item.name, len)).to_lowercase();
                        if name.contains(&pdh.gpu_luid) && name.ends_with("engtype_3d") {
                            load += item.value.value;
                        }
                    }
                }
            }
        }
    }
    Some((load.min(100.0) as f32, memory))
}

/// Чтение и запись диска в килобайтах в секунду.
pub fn disk_io() -> (f32, f32) {
    let guard = PDH.lock().unwrap();
    let Some(pdh) = guard.as_ref() else { return (0.0, 0.0) };

    let read_bytes = read(pdh, pdh.disk_read).unwrap_or(0.0);
    let write_bytes = read(pdh, pdh.disk_write).unwrap_or(0.0);
    ((read_bytes / 1024.0) as f32, (write_bytes / 1024.0) as f32)
}
