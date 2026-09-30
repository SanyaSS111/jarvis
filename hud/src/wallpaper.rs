//! Размещение окна в слое рабочего стола Windows (позади значков).

use std::ptr;

use crate::monitors::VirtualScreen;
use crate::win32::*;

/// Отсеивает служебные окна WorkerW размером в несколько пикселей.
fn covers_screen(hwnd: HWND, screen: &VirtualScreen) -> bool {
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return false;
    }
    let width = (rect.right - rect.left) as f32;
    let height = (rect.bottom - rect.top) as f32;
    width >= screen.width as f32 * 0.9 && height >= screen.height as f32 * 0.9
}

/// Окно WorkerW, лежащее между фоном рабочего стола и слоем значков.
pub fn find_desktop_layer(screen: &VirtualScreen) -> HWND {
    unsafe {
        let progman = FindWindowW(wide("Progman").as_ptr(), ptr::null());
        if progman.is_null() {
            return ptr::null_mut();
        }

        // Просьба к оболочке создать фоновый слой.
        let mut result: usize = 0;
        SendMessageTimeoutW(progman, WM_SPAWN_WORKER, 0, 0, SMTO_NORMAL, 1000, &mut result);

        // Windows 11 держит слой значков и фоновый WorkerW внутри Progman.
        let worker_class = wide("WorkerW");
        let mut child = FindWindowExW(progman, ptr::null_mut(), worker_class.as_ptr(), ptr::null());
        while !child.is_null() {
            if covers_screen(child, screen) {
                return child;
            }
            child = FindWindowExW(progman, child, worker_class.as_ptr(), ptr::null());
        }

        // Классический путь Windows 10: WorkerW-сосед за окном со значками.
        SIBLING.with(|cell| cell.set(ptr::null_mut()));
        SCREEN.with(|cell| cell.set((screen.width, screen.height)));
        EnumWindows(sibling_probe, 0);
        SIBLING.with(|cell| cell.get())
    }
}

thread_local! {
    static SIBLING: std::cell::Cell<HWND> = std::cell::Cell::new(ptr::null_mut());
    static SCREEN: std::cell::Cell<(i32, i32)> = std::cell::Cell::new((0, 0));
}

unsafe extern "system" fn sibling_probe(hwnd: HWND, _param: LPARAM) -> i32 {
    unsafe {
        let defview = FindWindowExW(hwnd, ptr::null_mut(), wide("SHELLDLL_DefView").as_ptr(), ptr::null());
        if defview.is_null() {
            return 1;
        }
        let sibling = FindWindowExW(ptr::null_mut(), hwnd, wide("WorkerW").as_ptr(), ptr::null());
        if sibling.is_null() {
            return 1;
        }

        let (width, height) = SCREEN.with(|cell| cell.get());
        let screen = VirtualScreen { x: 0, y: 0, width, height };
        if covers_screen(sibling, &screen) {
            SIBLING.with(|cell| cell.set(sibling));
            return 0;
        }
        1
    }
}

fn update_style(hwnd: HWND, index: i32, add: u32, remove: u32) -> u32 {
    unsafe {
        let current = GetWindowLongW(hwnd, index) as u32;
        let updated = (current | add) & !remove;
        // SetWindowLongW принимает знаковое значение, а стили выходят за его границу.
        SetWindowLongW(hwnd, index, updated as i32);
        updated
    }
}

/// Запись хода встраивания: окно приложения без консоли, иначе причину не увидеть.
pub fn trace(message: &str) {
    if std::env::var("JARVIS_TRACE").as_deref() != Ok("1") {
        return;
    }
    let path = crate::config::directory().join("embed.log");
    let _ = std::fs::create_dir_all(crate::config::directory());
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

/// Встраивает окно в рабочий стол. true — получился настоящий режим обоев.
pub fn embed(hwnd: HWND, screen: &VirtualScreen) -> bool {
    let layer = find_desktop_layer(screen);
    trace(&format!(
        "embed: hwnd={:?} layer={:?} style={:#x} ex={:#x}",
        hwnd, layer,
        unsafe { GetWindowLongW(hwnd, GWL_STYLE) as u32 },
        unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 }
    ));

    if !layer.is_null() {
        // Дочерним окном можно стать только со стилем WS_CHILD и без признака «поверх всех».
        // Прозрачность не ставим: у дочерних окон она подавляет отрисовку.
        update_style(hwnd, GWL_EXSTYLE, WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, WS_EX_TOPMOST | WS_EX_TRANSPARENT);
        // Окно не может быть одновременно всплывающим и дочерним.
        update_style(hwnd, GWL_STYLE, WS_CHILD, WS_POPUP);

        unsafe {
            SetParent(hwnd, layer);
            SetWindowPos(hwnd, ptr::null_mut(), 0, 0, screen.width, screen.height,
                SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);

            let parent = GetParent(hwnd);
            trace(&format!("embed: после SetParent parent={:?} ошибка={}", parent, GetLastError()));
            if parent == layer {
                return true;
            }
        }
    }

    // Запасной режим: окно без фокуса в самом низу z-порядка.
    update_style(hwnd, GWL_STYLE, WS_POPUP, WS_CHILD);
    update_style(hwnd, GWL_EXSTYLE, WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, WS_EX_TOPMOST);
    unsafe {
        SetParent(hwnd, ptr::null_mut());
        SetWindowPos(hwnd, HWND_BOTTOM, screen.x, screen.y, screen.width, screen.height,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    }
    false
}

/// Возвращает окно наверх — для режима настройки.
pub fn release(hwnd: HWND, screen: &VirtualScreen) {
    unsafe { SetParent(hwnd, ptr::null_mut()) };
    update_style(hwnd, GWL_STYLE, WS_POPUP, WS_CHILD);
    update_style(hwnd, GWL_EXSTYLE, 0, WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);
    unsafe {
        SetWindowPos(hwnd, HWND_TOPMOST, screen.x, screen.y, screen.width, screen.height,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    }
}

/// Подгоняет окно под изменившуюся конфигурацию мониторов.
pub fn refit(hwnd: HWND, screen: &VirtualScreen, embedded: bool) {
    unsafe {
        if embedded {
            SetWindowPos(hwnd, ptr::null_mut(), 0, 0, screen.width, screen.height,
                SWP_NOZORDER | SWP_SHOWWINDOW);
        } else {
            SetWindowPos(hwnd, ptr::null_mut(), screen.x, screen.y, screen.width, screen.height,
                SWP_NOZORDER | SWP_SHOWWINDOW);
        }
    }
}
