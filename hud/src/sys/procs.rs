//! Топ процессов по загрузке процессора.
//! Проценты приведены к общей мощности, как в диспетчере задач.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::Instant;

use crate::win32::*;

#[derive(Clone, Debug)]
pub struct ProcessRow {
    pub name: String,
    pub cpu: f32,
    pub mem_mb: u32,
}

struct Tracked {
    cpu_time: u64,
    at: Instant,
}

static SEEN: Mutex<Option<HashMap<u32, Tracked>>> = Mutex::new(None);

fn process_cpu_time(handle: *mut c_void) -> Option<u64> {
    unsafe {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
            return None;
        }
        Some(kernel.as_u64() + user.as_u64())
    }
}

fn working_set_mb(handle: *mut c_void) -> u32 {
    unsafe {
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        if GetProcessMemoryInfo(handle, &mut counters, counters.cb) == 0 {
            return 0;
        }
        (counters.WorkingSetSize / 1024 / 1024) as u32
    }
}

fn threads() -> f32 {
    unsafe {
        let mut info = SYSTEM_INFO::default();
        GetSystemInfo(&mut info);
        info.dwNumberOfProcessors.max(1) as f32
    }
}

/// Первый обход только запоминает счётчики: загрузка считается разницей.
pub fn prime() {
    let _ = top(0);
}

pub fn top(limit: usize) -> Vec<ProcessRow> {
    let cores = threads();
    let now = Instant::now();

    let mut guard = SEEN.lock().unwrap();
    let previous = guard.get_or_insert_with(HashMap::new);
    let mut current: HashMap<u32, Tracked> = HashMap::new();
    let mut rows: Vec<ProcessRow> = Vec::new();

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot as isize == -1 {
            return rows;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut ok = Process32FirstW(snapshot, &mut entry);
        while ok != 0 {
            let pid = entry.th32ProcessID;
            // Процесс простоя — это счётчик бездействия, а не нагрузка.
            if pid != 0 {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if !handle.is_null() {
                    if let Some(cpu_time) = process_cpu_time(handle) {
                        if let Some(last) = previous.get(&pid) {
                            let span = now.duration_since(last.at).as_secs_f64();
                            if span > 0.05 {
                                // Время процесса идёт в интервалах по 100 нс.
                                let used = (cpu_time.saturating_sub(last.cpu_time)) as f64 / 10_000_000.0;
                                let share = (used / span / cores as f64 * 100.0) as f32;
                                if share >= 0.05 {
                                    let name = wide_to_string(&entry.szExeFile)
                                        .trim_end_matches(".exe")
                                        .to_string();
                                    rows.push(ProcessRow {
                                        name,
                                        cpu: share.min(100.0),
                                        mem_mb: working_set_mb(handle),
                                    });
                                }
                            }
                        }
                        current.insert(pid, Tracked { cpu_time, at: now });
                    }
                    CloseHandle(handle);
                }
            }
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }

    *previous = current;

    rows.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    rows.truncate(limit);
    rows
}
