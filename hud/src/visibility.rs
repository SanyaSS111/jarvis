//! Определение того, видны ли обои: если экран закрыт окном, рисовать незачем.

use std::ptr;

use crate::monitors::Monitor;
use crate::win32::*;

const SHELL_CLASSES: [&str; 6] = [
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
];

thread_local! {
    static RECTS: std::cell::RefCell<Vec<RECT>> = const { std::cell::RefCell::new(Vec::new()) };
    static OWN: std::cell::Cell<HWND> = const { std::cell::Cell::new(ptr::null_mut()) };
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

/// Свёрнутые приложения UWP остаются «видимыми», но скрыты композитором.
fn is_cloaked(hwnd: HWND) -> bool {
    unsafe {
        let dwmapi = LoadLibraryA(b"dwmapi.dll\0".as_ptr());
        if dwmapi.is_null() {
            return false;
        }
        let symbol = GetProcAddress(dwmapi, b"DwmGetWindowAttribute\0".as_ptr());
        if symbol.is_null() {
            return false;
        }
        let get_attribute: extern "system" fn(HWND, u32, *mut i32, u32) -> i32 =
            std::mem::transmute(symbol);
        let mut value: i32 = 0;
        // 14 — DWMWA_CLOAKED
        if get_attribute(hwnd, 14, &mut value, 4) != 0 {
            return false;
        }
        value != 0
    }
}

unsafe extern "system" fn collect(hwnd: HWND, _param: LPARAM) -> i32 {
    unsafe {
        if hwnd == OWN.with(|cell| cell.get()) {
            return 1;
        }
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }

        let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if style & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW) != 0 {
            return 1;
        }
        if SHELL_CLASSES.contains(&class_name(hwnd).as_str()) || is_cloaked(hwnd) {
            return 1;
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return 1;
        }
        if rect.right - rect.left <= 1 || rect.bottom - rect.top <= 1 {
            return 1;
        }
        RECTS.with(|list| list.borrow_mut().push(rect));
        1
    }
}

/// Для каждого монитора: закрыт ли он целиком каким-нибудь одним окном.
pub fn covered(monitors: &[Monitor], own: HWND) -> Vec<bool> {
    RECTS.with(|list| list.borrow_mut().clear());
    OWN.with(|cell| cell.set(own));
    unsafe { EnumWindows(collect, 0) };

    let screen = crate::monitors::virtual_screen();
    RECTS.with(|list| {
        let rects = list.borrow();
        monitors
            .iter()
            .map(|monitor| {
                // Координаты монитора хранятся от угла виртуального экрана.
                let left = monitor.left + screen.x;
                let top = monitor.top + screen.y;
                let right = left + monitor.width;
                let bottom = top + monitor.height;
                rects.iter().any(|rect| {
                    rect.left <= left + 2 && rect.top <= top + 2 && rect.right >= right - 2 && rect.bottom >= bottom - 2
                })
            })
            .collect()
    })
}
