//! Иконка в области уведомлений: режим настройки, автозапуск и выход.
//! Живёт в отдельном потоке со своим окном сообщений.

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::autostart;
use crate::win32::*;
use crate::lang::tr;

const WM_TRAY: u32 = 0x0400 + 1; // WM_APP + 1
const ID_SETUP: u32 = 1;
const ID_AUTOSTART: u32 = 2;
const ID_QUIT: u32 = 3;

const NIM_ADD: u32 = 0;
const NIM_DELETE: u32 = 2;
const NIF_MESSAGE: u32 = 0x01;
const NIF_ICON: u32 = 0x02;
const NIF_TIP: u32 = 0x04;

const TPM_RIGHTBUTTON: u32 = 0x0002;
const MF_STRING: u32 = 0x0000;
const MF_CHECKED: u32 = 0x0008;
const MF_SEPARATOR: u32 = 0x0800;

const WM_COMMAND: u32 = 0x0111;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_LBUTTONDBLCLK: u32 = 0x0203;

#[repr(C)]
struct NOTIFYICONDATAW {
    cbSize: u32,
    hWnd: HWND,
    uID: u32,
    uFlags: u32,
    uCallbackMessage: u32,
    hIcon: HICON,
    szTip: [u16; 128],
    dwState: u32,
    dwStateMask: u32,
    szInfo: [u16; 256],
    uVersion: u32,
    szInfoTitle: [u16; 64],
    dwInfoFlags: u32,
    guidItem: [u8; 16],
    hBalloonIcon: HICON,
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn Shell_NotifyIconW(message: u32, data: *mut NOTIFYICONDATAW) -> i32;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn CreatePopupMenu() -> HMENU;
    fn AppendMenuW(menu: HMENU, flags: u32, id: usize, text: *const u16) -> i32;
    fn DestroyMenu(menu: HMENU) -> i32;
    fn TrackPopupMenu(menu: HMENU, flags: u32, x: i32, y: i32, reserved: i32, hwnd: HWND, rect: *const RECT) -> i32;
    fn GetCursorPos(point: *mut POINT) -> i32;
    fn SetForegroundWindow(hwnd: HWND) -> i32;
    fn LoadIconW(instance: HINSTANCE, name: *const u16) -> HICON;
    fn GetMessageW(msg: *mut MSG, hwnd: HWND, min: u32, max: u32) -> i32;
}

struct Flags {
    quit: AtomicBool,
    setup: AtomicBool,
}

pub struct Tray {
    flags: Arc<Flags>,
}

thread_local! {
    static FLAGS: std::cell::RefCell<Option<Arc<Flags>>> = const { std::cell::RefCell::new(None) };
}

unsafe extern "system" fn tray_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_TRAY => {
                let event = lparam as u32;
                if event == WM_RBUTTONUP {
                    show_menu(hwnd);
                } else if event == WM_LBUTTONUP || event == WM_LBUTTONDBLCLK {
                    // Щелчок левой кнопкой сразу открывает окно настроек.
                    FLAGS.with(|cell| {
                        if let Some(flags) = cell.borrow().as_ref() {
                            flags.setup.store(true, Ordering::Relaxed);
                        }
                    });
                }
                0
            }
            WM_COMMAND => {
                let id = (wparam & 0xFFFF) as u32;
                FLAGS.with(|cell| {
                    if let Some(flags) = cell.borrow().as_ref() {
                        match id {
                            ID_SETUP => flags.setup.store(true, Ordering::Relaxed),
                            ID_QUIT => flags.quit.store(true, Ordering::Relaxed),
                            ID_AUTOSTART => {
                                let _ = autostart::set_enabled(!autostart::is_enabled());
                            }
                            _ => {}
                        }
                    }
                });
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

unsafe fn show_menu(hwnd: HWND) {
    unsafe {
        let menu = CreatePopupMenu();
        AppendMenuW(menu, MF_STRING, ID_SETUP as usize, wide(tr("Настройки…", "Settings…")).as_ptr());
        let autostart_flags = MF_STRING | if autostart::is_enabled() { MF_CHECKED } else { 0 };
        AppendMenuW(menu, autostart_flags, ID_AUTOSTART as usize, wide(tr("Запускать с Windows", "Start with Windows")).as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, ptr::null());
        AppendMenuW(menu, MF_STRING, ID_QUIT as usize, wide(tr("Выход", "Exit")).as_ptr());

        let mut point = POINT::default();
        GetCursorPos(&mut point);
        // Без вывода окна на передний план меню не закроется по щелчку мимо.
        SetForegroundWindow(hwnd);
        TrackPopupMenu(menu, TPM_RIGHTBUTTON, point.x, point.y, 0, hwnd, ptr::null());
        DestroyMenu(menu);
    }
}

impl Tray {
    pub fn new() -> Self {
        let flags = Arc::new(Flags { quit: AtomicBool::new(false), setup: AtomicBool::new(false) });
        let worker = flags.clone();

        std::thread::spawn(move || unsafe {
            FLAGS.with(|cell| *cell.borrow_mut() = Some(worker));

            let instance = GetModuleHandleW(ptr::null());
            let class_name = wide("JarvisHudTray");
            let class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(tray_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: ptr::null_mut(),
                hCursor: ptr::null_mut(),
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            RegisterClassW(&class);

            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                wide("JarvisHudTray").as_ptr(),
                0,
                0,
                0,
                0,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null_mut(),
            );

            let mut data: NOTIFYICONDATAW = std::mem::zeroed();
            data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            data.hWnd = hwnd;
            data.uID = 1;
            data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            data.uCallbackMessage = WM_TRAY;
            data.hIcon = LoadIconW(ptr::null_mut(), 32512 as *const u16); // IDI_APPLICATION
            let tip = wide("J.A.R.V.I.S. HUD 2.0");
            data.szTip[..tip.len().min(127)].copy_from_slice(&tip[..tip.len().min(127)]);
            Shell_NotifyIconW(NIM_ADD, &mut data);

            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            Shell_NotifyIconW(NIM_DELETE, &mut data);
        });

        Self { flags }
    }

    pub fn quit_requested(&self) -> bool {
        self.flags.quit.load(Ordering::Relaxed)
    }

    /// Запрос режима настройки читается один раз: дальше флаг сбрасывается.
    pub fn take_setup_request(&self) -> bool {
        self.flags.setup.swap(false, Ordering::Relaxed)
    }
}
