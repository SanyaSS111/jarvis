//! Перечисление мониторов: границы, рабочая область, масштаб DPI и частота обновления.

use std::ptr;

use crate::win32::*;

#[derive(Clone, Copy, Debug, Default)]
pub struct VirtualScreen {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug)]
pub struct Monitor {
    pub key: String,
    pub index: usize,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    /// Рабочая область без панели задач, в координатах относительно монитора.
    pub work_left: i32,
    pub work_top: i32,
    pub work_width: i32,
    pub work_height: i32,
    pub scale: f32,
    pub hz: u32,
    pub primary: bool,
}

pub fn virtual_screen() -> VirtualScreen {
    unsafe {
        VirtualScreen {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

thread_local! {
    static FOUND: std::cell::RefCell<Vec<Monitor>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn monitor_scale(handle: HMONITOR) -> f32 {
    // GetDpiForMonitor живёт в shcore.dll: подгружаем по требованию, чтобы не
    // тянуть лишнюю импортную библиотеку.
    unsafe {
        let shcore = LoadLibraryA(b"shcore.dll\0".as_ptr());
        if shcore.is_null() {
            return 1.0;
        }
        let symbol = GetProcAddress(shcore, b"GetDpiForMonitor\0".as_ptr());
        if symbol.is_null() {
            return 1.0;
        }
        let get_dpi: extern "system" fn(HMONITOR, u32, *mut u32, *mut u32) -> i32 =
            std::mem::transmute(symbol);
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        if get_dpi(handle, 0, &mut dpi_x, &mut dpi_y) != 0 {
            return 1.0;
        }
        dpi_x as f32 / 96.0
    }
}

fn refresh_rate(device: &[u16; 32]) -> u32 {
    unsafe {
        let mut mode: DEVMODEW = std::mem::zeroed();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if EnumDisplaySettingsW(device.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode) == 0 {
            return 0;
        }
        mode.dmDisplayFrequency
    }
}

unsafe extern "system" fn collect(handle: HMONITOR, _hdc: HDC, _rect: *mut RECT, _param: LPARAM) -> i32 {
    unsafe {
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(handle, &mut info) == 0 {
            return 1;
        }

        let area = info.rcMonitor;
        let work = info.rcWork;
        let monitor = Monitor {
            key: wide_to_string(&info.szDevice),
            index: 0,
            left: area.left,
            top: area.top,
            width: area.right - area.left,
            height: area.bottom - area.top,
            work_left: work.left - area.left,
            work_top: work.top - area.top,
            work_width: work.right - work.left,
            work_height: work.bottom - work.top,
            scale: monitor_scale(handle),
            hz: refresh_rate(&info.szDevice),
            primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
        };

        FOUND.with(|list| list.borrow_mut().push(monitor));
        1
    }
}

/// Мониторы, отсортированные слева направо, с координатами от левого верхнего
/// угла виртуального экрана.
pub fn enumerate() -> Vec<Monitor> {
    FOUND.with(|list| list.borrow_mut().clear());
    unsafe { EnumDisplayMonitors(ptr::null_mut(), ptr::null(), collect, 0) };

    let screen = virtual_screen();
    let mut monitors = FOUND.with(|list| list.borrow().clone());
    monitors.sort_by_key(|m| (m.left, m.top));

    for (index, monitor) in monitors.iter_mut().enumerate() {
        monitor.index = index + 1;
        monitor.left -= screen.x;
        monitor.top -= screen.y;
    }
    monitors
}

/// Отпечаток конфигурации экранов: по нему ловим подключение монитора и смену режима.
pub fn signature(monitors: &[Monitor]) -> String {
    let screen = virtual_screen();
    let mut parts = vec![format!("{}x{}", screen.width, screen.height)];
    for monitor in monitors {
        parts.push(format!(
            "{}:{},{},{}x{}@{}/{}",
            monitor.key, monitor.left, monitor.top, monitor.width, monitor.height, monitor.scale, monitor.hz
        ));
    }
    parts.join("|")
}
