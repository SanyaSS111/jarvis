//! Окна с контекстом OpenGL — напрямую на Win32 и WGL.

use std::ffi::{c_void, CString};
use std::ptr;

use femtovg::renderer::OpenGl;

use crate::text::{Canvas, Fonts};
use crate::win32::*;

pub struct GlWindow {
    pub hwnd: HWND,
    hdc: HDC,
    context: HGLRC,
    pub canvas: Canvas,
    pub fonts: Fonts,
    pub width: u32,
    pub height: u32,
}

/// Параметры окна: у скрытого окна кадров HUD и у окна настроек они разные.
pub struct WindowSpec<'a> {
    pub class: &'a str,
    pub title: &'a str,
    pub proc: WndProc,
    pub style: u32,
    pub ex_style: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub visible: bool,
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        // Фон не стираем: его целиком рисует OpenGL, иначе будет мерцание.
        WM_ERASEBKGND => 1,
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Загрузка функций OpenGL: современные идут через wglGetProcAddress,
/// базовые версии 1.1 — только из самой opengl32.dll.
fn gl_loader(opengl32: HINSTANCE, name: &str) -> *const c_void {
    let symbol = CString::new(name).unwrap();
    unsafe {
        let address = wglGetProcAddress(symbol.as_ptr() as *const u8);
        let invalid = address.is_null()
            || address as isize == 1
            || address as isize == 2
            || address as isize == 3
            || address as isize == -1;
        if !invalid {
            return address;
        }
        GetProcAddress(opengl32, symbol.as_ptr() as *const u8)
    }
}

impl GlWindow {
    /// Скрытое окно, в котором считается кадр HUD.
    pub fn new(width: u32, height: u32, visible: bool) -> Self {
        Self::create(WindowSpec {
            class: "JarvisHudWindow",
            title: "J.A.R.V.I.S. HUD",
            proc: wnd_proc,
            style: WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            ex_style: WS_EX_TOOLWINDOW,
            x: 0,
            y: 0,
            width,
            height,
            visible,
        })
    }

    pub fn create(spec: WindowSpec) -> Self {
        unsafe {
            let instance = GetModuleHandleW(ptr::null());
            let class_name = wide(spec.class);

            let class = WNDCLASSW {
                style: 0x0020 | 0x0002 | 0x0001, // CS_OWNDC | CS_HREDRAW | CS_VREDRAW
                lpfnWndProc: Some(spec.proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                // Значок из ресурсов exe: его вписывает tools/set_icon.py.
                hIcon: LoadIconW(instance, 1 as *const u16),
                hCursor: LoadCursorW(ptr::null_mut(), 32512 as *const u16), // IDC_ARROW
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            RegisterClassW(&class);

            let title = wide(spec.title);
            let style = spec.style | if spec.visible { WS_VISIBLE } else { 0 };

            let hwnd = CreateWindowExW(
                spec.ex_style,
                class_name.as_ptr(),
                title.as_ptr(),
                style,
                spec.x,
                spec.y,
                spec.width as i32,
                spec.height as i32,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            );
            assert!(!hwnd.is_null(), "не удалось создать окно");

            let hdc = GetDC(hwnd);

            let mut pfd = PIXELFORMATDESCRIPTOR {
                nSize: std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u16,
                nVersion: 1,
                dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
                iPixelType: PFD_TYPE_RGBA,
                cColorBits: 32,
                cAlphaBits: 8,
                cDepthBits: 24,
                cStencilBits: 8,
                ..Default::default()
            };

            let format = ChoosePixelFormat(hdc, &pfd);
            assert!(format != 0, "не найден подходящий формат пикселей");
            SetPixelFormat(hdc, format, &mut pfd);

            let context = wglCreateContext(hdc);
            assert!(!context.is_null(), "не удалось создать контекст OpenGL");
            wglMakeCurrent(hdc, context);

            let opengl32 = LoadLibraryA(b"opengl32.dll\0".as_ptr());
            let renderer = OpenGl::new_from_function(|name| gl_loader(opengl32, name))
                .expect("не удалось инициализировать рендерер");

            let mut canvas = Canvas::new(renderer).expect("не удалось создать холст");
            canvas.set_size(spec.width, spec.height, 1.0);
            let fonts = Fonts::load(&mut canvas);

            let swap_interval = wglGetProcAddress(b"wglSwapIntervalEXT\0".as_ptr());
            if !swap_interval.is_null() {
                let set: extern "system" fn(i32) -> i32 = std::mem::transmute(swap_interval);
                set(1);
            }

            Self { hwnd, hdc, context, canvas, fonts, width: spec.width, height: spec.height }
        }
    }

    /// Окон с OpenGL два, а контекст на поток активен один: перед отрисовкой
    /// каждое окно делает свой текущим.
    pub fn make_current(&self) {
        unsafe { wglMakeCurrent(self.hdc, self.context) };
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        self.canvas.set_size(width, height, 1.0);
    }

    pub fn present(&mut self) {
        self.canvas.flush();
        unsafe { SwapBuffers(self.hdc) };
    }

    pub fn save_png(&mut self, path: &str) {
        let image = self.canvas.screenshot().expect("не удалось снять кадр");
        let width = image.width() as u32;
        let height = image.height() as u32;
        let mut bytes = Vec::with_capacity((width * height * 4) as usize);
        for pixel in image.buf() {
            bytes.extend_from_slice(&[pixel.r, pixel.g, pixel.b, pixel.a]);
        }
        image::save_buffer(path, &bytes, width, height, image::ColorType::Rgba8)
            .expect("не удалось сохранить PNG");
    }

    /// Разбор очереди сообщений всех окон потока. false означает запрос на выход.
    pub fn pump(&self) -> bool {
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                if msg.message == WM_QUIT {
                    return false;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            true
        }
    }
}

impl Drop for GlWindow {
    fn drop(&mut self) {
        unsafe {
            wglMakeCurrent(ptr::null_mut(), ptr::null_mut());
            wglDeleteContext(self.context);
            ReleaseDC(self.hwnd, self.hdc);
            DestroyWindow(self.hwnd);
        }
    }
}
