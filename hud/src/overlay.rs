//! Слой HUD поверх рабочего стола.
//!
//! Дочернее окно в дереве проводника не получает собственной поверхности для
//! композитора: ни обычная отрисовка, ни копирование в его контекст не доходят
//! до экрана. Поэтому берём слоистое окно: кадр с попиксельной прозрачностью
//! отдаётся композитору напрямую. Прозрачные места оставляют видимыми обои и
//! значки рабочего стола, а щелчки проходят сквозь окно.
//!
//! В режиме расстановки окно поднимается наверх и начинает принимать мышь.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::ptr;

use crate::win32::*;

/// Событие мыши в координатах слоя (они же координаты холста HUD).
#[derive(Clone, Copy, Debug)]
pub enum Pointer {
    Down(f32, f32),
    Move(f32, f32),
    Up(f32, f32),
}

thread_local! {
    static EDIT: Cell<bool> = const { Cell::new(false) };
    static EVENTS: RefCell<Vec<Pointer>> = const { RefCell::new(Vec::new()) };
    static ESCAPE: Cell<bool> = const { Cell::new(false) };
}

pub fn take_events() -> Vec<Pointer> {
    EVENTS.with(|events| std::mem::take(&mut *events.borrow_mut()))
}

pub fn take_escape() -> bool {
    ESCAPE.with(|cell| cell.replace(false))
}

fn point_from(lparam: LPARAM) -> (f32, f32) {
    let x = (lparam & 0xFFFF) as u16 as i16 as f32;
    let y = ((lparam >> 16) & 0xFFFF) as u16 as i16 as f32;
    (x, y)
}

pub struct Overlay {
    pub hwnd: HWND,
    screen_dc: HDC,
    memory_dc: HDC,
    bitmap: *mut c_void,
    previous: *mut c_void,
    bits: *mut u8,
    width: i32,
    height: i32,
    origin: POINT,
}

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_ERASEBKGND => 1,
            // Вне режима расстановки окно всегда в самом низу: любое приложение его закрывает.
            WM_WINDOWPOSCHANGING => {
                if !EDIT.with(|cell| cell.get()) {
                    let position = lparam as *mut WINDOWPOS;
                    if !position.is_null() {
                        (*position).hwndInsertAfter = HWND_BOTTOM;
                    }
                }
                0
            }
            WM_LBUTTONDOWN => {
                // Захват мыши: модуль не «отпустится», если курсор уйдёт за край.
                SetCapture(hwnd);
                let (x, y) = point_from(lparam);
                EVENTS.with(|events| events.borrow_mut().push(Pointer::Down(x, y)));
                0
            }
            WM_MOUSEMOVE => {
                let (x, y) = point_from(lparam);
                EVENTS.with(|events| {
                    let mut events = events.borrow_mut();
                    // Между кадрами важна только последняя позиция курсора.
                    if let Some(Pointer::Move(..)) = events.last() {
                        events.pop();
                    }
                    events.push(Pointer::Move(x, y));
                });
                0
            }
            WM_LBUTTONUP => {
                ReleaseCapture();
                let (x, y) = point_from(lparam);
                EVENTS.with(|events| events.borrow_mut().push(Pointer::Up(x, y)));
                0
            }
            WM_KEYDOWN => {
                if wparam == 0x1B {
                    ESCAPE.with(|cell| cell.set(true));
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

impl Overlay {
    pub fn new(x: i32, y: i32, width: i32, height: i32) -> Option<Self> {
        unsafe {
            let instance = GetModuleHandleW(ptr::null());
            let class_name = wide("JarvisHudOverlay");

            let class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(overlay_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: ptr::null_mut(),
                hCursor: LoadCursorW(ptr::null_mut(), 32512 as *const u16), // IDC_ARROW
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            RegisterClassW(&class);

            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                class_name.as_ptr(),
                wide("J.A.R.V.I.S. HUD").as_ptr(),
                WS_POPUP | WS_VISIBLE,
                x,
                y,
                width,
                height,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            );
            if hwnd.is_null() {
                return None;
            }

            let screen_dc = GetDC(ptr::null_mut());
            let memory_dc = CreateCompatibleDC(screen_dc);

            // Растр снизу вверх — в таком порядке кадр отдаёт и OpenGL.
            let info = BITMAPINFO {
                header: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..Default::default()
                },
                colors: [0; 3],
            };

            let mut bits: *mut u8 = ptr::null_mut();
            let bitmap = CreateDIBSection(memory_dc, &info, DIB_RGB_COLORS, &mut bits, ptr::null_mut(), 0);
            if bitmap.is_null() || bits.is_null() {
                DeleteDC(memory_dc);
                ReleaseDC(ptr::null_mut(), screen_dc);
                DestroyWindow(hwnd);
                return None;
            }

            let previous = SelectObject(memory_dc, bitmap);
            SetWindowPos(hwnd, HWND_BOTTOM, x, y, width, height, SWP_SHOWWINDOW);

            Some(Self {
                hwnd,
                screen_dc,
                memory_dc,
                bitmap,
                previous,
                bits,
                width,
                height,
                origin: POINT { x, y },
            })
        }
    }

    /// Забирает кадр из буфера видеокарты и отдаёт его композитору.
    pub fn present(&self) {
        unsafe {
            glReadPixels(0, 0, self.width, self.height, GL_BGRA, GL_UNSIGNED_BYTE, self.bits);

            // Композитор ждёт цвет, уже умноженный на прозрачность.
            let count = (self.width * self.height) as usize;
            let pixels = std::slice::from_raw_parts_mut(self.bits as *mut u32, count);
            for pixel in pixels.iter_mut() {
                let value = *pixel;
                let alpha = (value >> 24) & 0xFF;
                if alpha == 0xFF {
                    continue;
                }
                if alpha == 0 {
                    *pixel = 0;
                    continue;
                }
                let blue = ((value & 0xFF) * alpha / 255) & 0xFF;
                let green = (((value >> 8) & 0xFF) * alpha / 255) & 0xFF;
                let red = (((value >> 16) & 0xFF) * alpha / 255) & 0xFF;
                *pixel = (alpha << 24) | (red << 16) | (green << 8) | blue;
            }

            let size = SIZE { cx: self.width, cy: self.height };
            let source = POINT { x: 0, y: 0 };
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER,
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: AC_SRC_ALPHA,
            };

            UpdateLayeredWindow(
                self.hwnd,
                self.screen_dc,
                &self.origin,
                &size,
                self.memory_dc,
                &source,
                0,
                &blend,
                ULW_ALPHA,
            );
        }
    }

    /// Режим расстановки: окно поднимается наверх и принимает мышь и клавиатуру.
    pub fn set_interactive(&self, enabled: bool) {
        EDIT.with(|cell| cell.set(enabled));
        let _ = take_events();
        unsafe {
            let style = GetWindowLongW(self.hwnd, GWL_EXSTYLE) as u32;
            let updated = if enabled {
                style & !(WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)
            } else {
                style | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE
            };
            SetWindowLongW(self.hwnd, GWL_EXSTYLE, updated as i32);

            if enabled {
                SetWindowPos(self.hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
                SetForegroundWindow(self.hwnd);
            } else {
                SetWindowPos(self.hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                SetWindowPos(self.hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }

    /// Возвращает окно в самый низ: новые приложения не должны его поднимать.
    pub fn keep_at_bottom(&self) {
        if EDIT.with(|cell| cell.get()) {
            return;
        }
        unsafe {
            SetWindowPos(self.hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.memory_dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.memory_dc);
            ReleaseDC(ptr::null_mut(), self.screen_dc);
            DestroyWindow(self.hwnd);
        }
    }
}
