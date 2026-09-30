//! Загрузка процессора по каждому логическому ядру.
//! Данные берём из NtQuerySystemInformation — тем же способом, что диспетчер задач.

use std::ffi::c_void;
use std::sync::Mutex;

use crate::win32::*;

type NtQuery = unsafe extern "system" fn(u32, *mut c_void, u32, *mut u32) -> i32;

static PREVIOUS: Mutex<Vec<(i64, i64)>> = Mutex::new(Vec::new());
static LAST_LOADS: Mutex<Vec<f32>> = Mutex::new(Vec::new());

// Меньше этого окна замер недостоверен: гранулярность системного таймера
// около 15 мс, и разница времени простоя может округлиться в ноль.
const MIN_DELTA: i64 = 150_000; // 15 мс в интервалах по 100 нс

fn query() -> Vec<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION> {
    unsafe {
        let ntdll = LoadLibraryA(b"ntdll.dll\0".as_ptr());
        if ntdll.is_null() {
            return Vec::new();
        }
        let symbol = GetProcAddress(ntdll, b"NtQuerySystemInformation\0".as_ptr());
        if symbol.is_null() {
            return Vec::new();
        }
        let nt_query: NtQuery = std::mem::transmute(symbol);

        let mut info = SYSTEM_INFO::default();
        GetSystemInfo(&mut info);
        let count = info.dwNumberOfProcessors.max(1) as usize;

        let mut buffer: Vec<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION> =
            vec![Default::default(); count];
        let size = (std::mem::size_of::<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION>() * count) as u32;
        let mut written: u32 = 0;

        let status = nt_query(
            SYSTEM_PROCESSOR_PERFORMANCE,
            buffer.as_mut_ptr() as *mut c_void,
            size,
            &mut written,
        );
        if status != 0 {
            return Vec::new();
        }
        buffer
    }
}

/// Первый замер задаёт точку отсчёта: загрузка считается разницей между вызовами.
pub fn prime() {
    let now = query();
    let mut previous = PREVIOUS.lock().unwrap();
    *previous = now.iter().map(|core| (core.IdleTime, core.KernelTime + core.UserTime)).collect();
}

/// Возвращает загрузку по ядрам и общую в процентах.
pub fn sample() -> (Vec<f32>, f32) {
    let now = query();
    if now.is_empty() {
        return (Vec::new(), 0.0);
    }

    let mut previous = PREVIOUS.lock().unwrap();
    if previous.len() != now.len() {
        *previous = now.iter().map(|c| (c.IdleTime, c.KernelTime + c.UserTime)).collect();
        return (vec![0.0; now.len()], 0.0);
    }

    let mut loads = Vec::with_capacity(now.len());
    for (index, core) in now.iter().enumerate() {
        // KernelTime уже включает время простоя, поэтому занятое время — это разница.
        let busy_total = core.KernelTime + core.UserTime;
        let idle_delta = (core.IdleTime - previous[index].0) as f64;
        let total_delta = (busy_total - previous[index].1) as f64;

        let reliable = (busy_total - previous[index].1) > MIN_DELTA;
        let load = if reliable && total_delta > 0.0 {
            (((total_delta - idle_delta) / total_delta) * 100.0).clamp(0.0, 100.0) as f32
        } else {
            // Окно слишком короткое — оставляем прошлое значение, а не мигаем сотней.
            LAST_LOADS.lock().unwrap().get(index).copied().unwrap_or(0.0)
        };
        loads.push(load);
        if reliable {
            previous[index] = (core.IdleTime, busy_total);
        }
    }

    *LAST_LOADS.lock().unwrap() = loads.clone();
    let average = loads.iter().sum::<f32>() / loads.len() as f32;
    (loads, average)
}
