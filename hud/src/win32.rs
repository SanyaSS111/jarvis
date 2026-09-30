//! Объявления Win32, которые нужны приложению.
//! Собственные объявления вместо библиотеки windows-rs: она тянет генерацию
//! импортных библиотек через dlltool, которого нет в поставке Rust для GNU.

#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::ffi::c_void;

pub type HWND = *mut c_void;
pub type HDC = *mut c_void;
pub type HGLRC = *mut c_void;
pub type HINSTANCE = *mut c_void;
pub type HICON = *mut c_void;
pub type HCURSOR = *mut c_void;
pub type HBRUSH = *mut c_void;
pub type HMENU = *mut c_void;
pub type HMONITOR = *mut c_void;
pub type WPARAM = usize;
pub type LPARAM = isize;
pub type LRESULT = isize;

pub type WndProc = unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT;

// --- стили окна ---
pub const WS_POPUP: u32 = 0x8000_0000;
pub const WS_VISIBLE: u32 = 0x1000_0000;
pub const WS_CHILD: u32 = 0x4000_0000;
pub const WS_CLIPSIBLINGS: u32 = 0x0400_0000;
pub const WS_CLIPCHILDREN: u32 = 0x0200_0000;

pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
pub const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
pub const WS_EX_TOPMOST: u32 = 0x0000_0008;
pub const WS_EX_LAYERED: u32 = 0x0008_0000;
pub const LWA_ALPHA: u32 = 0x0000_0002;

pub const GWL_STYLE: i32 = -16;
pub const GWL_EXSTYLE: i32 = -20;

// --- сообщения ---
pub const WM_DESTROY: u32 = 0x0002;
pub const WM_CLOSE: u32 = 0x0010;
pub const WM_QUIT: u32 = 0x0012;
pub const WM_ERASEBKGND: u32 = 0x0014;
pub const WM_DISPLAYCHANGE: u32 = 0x007E;
pub const PM_REMOVE: u32 = 0x0001;
pub const WM_MOUSEMOVE: u32 = 0x0200;
pub const WM_LBUTTONDOWN: u32 = 0x0201;
pub const WM_NCHITTEST: u32 = 0x0084;
pub const WM_KEYDOWN: u32 = 0x0100;
pub const HTCAPTION: u32 = 2;
pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
pub const WM_LBUTTONUP: u32 = 0x0202;
pub const HWND_NOTOPMOST: HWND = -2isize as HWND;

#[link(name = "user32")]
unsafe extern "system" {
    pub fn SetCapture(hwnd: HWND) -> HWND;
    pub fn ReleaseCapture() -> i32;
}

// --- позиционирование ---
pub const SWP_NOSIZE: u32 = 0x0001;
pub const SWP_NOMOVE: u32 = 0x0002;
pub const SWP_NOZORDER: u32 = 0x0004;
pub const SWP_FRAMECHANGED: u32 = 0x0020;
pub const SWP_SHOWWINDOW: u32 = 0x0040;
pub const SWP_NOACTIVATE: u32 = 0x0010;
pub const HWND_BOTTOM: HWND = 1 as HWND;
pub const HWND_TOPMOST: HWND = usize::MAX as HWND; // (HWND)-1

pub const SW_SHOW: i32 = 5;
pub const SW_HIDE: i32 = 0;

// --- метрики экрана ---
pub const SM_XVIRTUALSCREEN: i32 = 76;
pub const SM_YVIRTUALSCREEN: i32 = 77;
pub const SM_CXVIRTUALSCREEN: i32 = 78;
pub const SM_CYVIRTUALSCREEN: i32 = 79;

pub const SMTO_NORMAL: u32 = 0x0000;
pub const WM_SPAWN_WORKER: u32 = 0x052C;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct RECT {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MSG {
    pub hwnd: HWND,
    pub message: u32,
    pub wParam: WPARAM,
    pub lParam: LPARAM,
    pub time: u32,
    pub pt: POINT,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SIZE {
    pub cx: i32,
    pub cy: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BLENDFUNCTION {
    pub BlendOp: u8,
    pub BlendFlags: u8,
    pub SourceConstantAlpha: u8,
    pub AlphaFormat: u8,
}

pub const AC_SRC_OVER: u8 = 0x00;
pub const AC_SRC_ALPHA: u8 = 0x01;
pub const ULW_ALPHA: u32 = 0x0000_0002;
pub const WM_WINDOWPOSCHANGING: u32 = 0x0046;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct WINDOWPOS {
    pub hwnd: HWND,
    pub hwndInsertAfter: HWND,
    pub x: i32,
    pub y: i32,
    pub cx: i32,
    pub cy: i32,
    pub flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PAINTSTRUCT {
    pub hdc: HDC,
    pub fErase: i32,
    pub rcPaint: RECT,
    pub fRestore: i32,
    pub fIncUpdate: i32,
    pub rgbReserved: [u8; 32],
}

pub const WM_PAINT: u32 = 0x000F;

#[repr(C)]
pub struct WNDCLASSW {
    pub style: u32,
    pub lpfnWndProc: Option<WndProc>,
    pub cbClsExtra: i32,
    pub cbWndExtra: i32,
    pub hInstance: HINSTANCE,
    pub hIcon: HICON,
    pub hCursor: HCURSOR,
    pub hbrBackground: HBRUSH,
    pub lpszMenuName: *const u16,
    pub lpszClassName: *const u16,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct PIXELFORMATDESCRIPTOR {
    pub nSize: u16,
    pub nVersion: u16,
    pub dwFlags: u32,
    pub iPixelType: u8,
    pub cColorBits: u8,
    pub cRedBits: u8,
    pub cRedShift: u8,
    pub cGreenBits: u8,
    pub cGreenShift: u8,
    pub cBlueBits: u8,
    pub cBlueShift: u8,
    pub cAlphaBits: u8,
    pub cAlphaShift: u8,
    pub cAccumBits: u8,
    pub cAccumRedBits: u8,
    pub cAccumGreenBits: u8,
    pub cAccumBlueBits: u8,
    pub cAccumAlphaBits: u8,
    pub cDepthBits: u8,
    pub cStencilBits: u8,
    pub cAuxBuffers: u8,
    pub iLayerType: u8,
    pub bReserved: u8,
    pub dwLayerMask: u32,
    pub dwVisibleMask: u32,
    pub dwDamageMask: u32,
}

pub const PFD_DRAW_TO_WINDOW: u32 = 0x0000_0004;
pub const PFD_SUPPORT_OPENGL: u32 = 0x0000_0020;
pub const PFD_DOUBLEBUFFER: u32 = 0x0000_0001;
pub const PFD_TYPE_RGBA: u8 = 0;

#[link(name = "user32")]
unsafe extern "system" {
    pub fn RegisterClassW(class: *const WNDCLASSW) -> u16;
    pub fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: HWND,
        menu: HMENU,
        instance: HINSTANCE,
        param: *mut c_void,
    ) -> HWND;
    pub fn DefWindowProcW(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    pub fn DestroyWindow(hwnd: HWND) -> i32;
    pub fn PostQuitMessage(code: i32);
    pub fn PeekMessageW(msg: *mut MSG, hwnd: HWND, min: u32, max: u32, remove: u32) -> i32;
    pub fn TranslateMessage(msg: *const MSG) -> i32;
    pub fn DispatchMessageW(msg: *const MSG) -> LRESULT;
    pub fn GetDC(hwnd: HWND) -> HDC;
    pub fn ReleaseDC(hwnd: HWND, hdc: HDC) -> i32;
    pub fn ShowWindow(hwnd: HWND, cmd: i32) -> i32;
    pub fn GetSystemMetrics(index: i32) -> i32;
    pub fn FindWindowW(class_name: *const u16, window_name: *const u16) -> HWND;
    pub fn FindWindowExW(parent: HWND, child: HWND, class: *const u16, title: *const u16) -> HWND;
    pub fn SetParent(child: HWND, parent: HWND) -> HWND;
    pub fn GetParent(hwnd: HWND) -> HWND;
    pub fn SetWindowPos(
        hwnd: HWND,
        after: HWND,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    pub fn GetWindowLongW(hwnd: HWND, index: i32) -> i32;
    pub fn SetWindowLongW(hwnd: HWND, index: i32, value: i32) -> i32;
    pub fn GetWindowRect(hwnd: HWND, rect: *mut RECT) -> i32;
    pub fn IsWindowVisible(hwnd: HWND) -> i32;
    pub fn IsIconic(hwnd: HWND) -> i32;
    pub fn GetClassNameW(hwnd: HWND, buffer: *mut u16, max: i32) -> i32;
    pub fn EnumWindows(callback: unsafe extern "system" fn(HWND, LPARAM) -> i32, param: LPARAM) -> i32;
    pub fn SendMessageTimeoutW(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        flags: u32,
        timeout: u32,
        result: *mut usize,
    ) -> isize;
    pub fn MessageBoxW(hwnd: HWND, text: *const u16, caption: *const u16, kind: u32) -> i32;
    pub fn SetForegroundWindow(hwnd: HWND) -> i32;
    pub fn LoadIconW(instance: HINSTANCE, name: *const u16) -> HICON;
    pub fn LoadCursorW(instance: HINSTANCE, name: *const u16) -> HCURSOR;
    pub fn EnumDisplayMonitors(
        hdc: HDC,
        clip: *const RECT,
        callback: unsafe extern "system" fn(HMONITOR, HDC, *mut RECT, LPARAM) -> i32,
        param: LPARAM,
    ) -> i32;
    pub fn GetMonitorInfoW(monitor: HMONITOR, info: *mut MONITORINFOEXW) -> i32;
    pub fn EnumDisplaySettingsW(device: *const u16, mode: u32, devmode: *mut DEVMODEW) -> i32;
    pub fn SetLayeredWindowAttributes(hwnd: HWND, key: u32, alpha: u8, flags: u32) -> i32;
    pub fn BeginPaint(hwnd: HWND, paint: *mut PAINTSTRUCT) -> HDC;
    pub fn EndPaint(hwnd: HWND, paint: *const PAINTSTRUCT) -> i32;
    pub fn InvalidateRect(hwnd: HWND, rect: *const RECT, erase: i32) -> i32;
    pub fn UpdateWindow(hwnd: HWND) -> i32;
    pub fn UpdateLayeredWindow(
        hwnd: HWND,
        dest_dc: HDC,
        dest_point: *const POINT,
        size: *const SIZE,
        src_dc: HDC,
        src_point: *const POINT,
        key: u32,
        blend: *const BLENDFUNCTION,
        flags: u32,
    ) -> i32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    pub fn ChoosePixelFormat(hdc: HDC, pfd: *const PIXELFORMATDESCRIPTOR) -> i32;
    pub fn SetPixelFormat(hdc: HDC, format: i32, pfd: *const PIXELFORMATDESCRIPTOR) -> i32;
    pub fn SwapBuffers(hdc: HDC) -> i32;
    pub fn CreateCompatibleDC(hdc: HDC) -> HDC;
    pub fn CreateDIBSection(
        hdc: HDC,
        info: *const BITMAPINFO,
        usage: u32,
        bits: *mut *mut u8,
        section: *mut c_void,
        offset: u32,
    ) -> *mut c_void;
    pub fn SelectObject(hdc: HDC, object: *mut c_void) -> *mut c_void;
    pub fn DeleteObject(object: *mut c_void) -> i32;
    pub fn DeleteDC(hdc: HDC) -> i32;
    pub fn BitBlt(
        dest: HDC, x: i32, y: i32, width: i32, height: i32,
        src: HDC, src_x: i32, src_y: i32, rop: u32,
    ) -> i32;
}

pub const SRCCOPY: u32 = 0x00CC_0020;
pub const DIB_RGB_COLORS: u32 = 0;
pub const BI_RGB: u32 = 0;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BITMAPINFOHEADER {
    pub biSize: u32,
    pub biWidth: i32,
    pub biHeight: i32,
    pub biPlanes: u16,
    pub biBitCount: u16,
    pub biCompression: u32,
    pub biSizeImage: u32,
    pub biXPelsPerMeter: i32,
    pub biYPelsPerMeter: i32,
    pub biClrUsed: u32,
    pub biClrImportant: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BITMAPINFO {
    pub header: BITMAPINFOHEADER,
    pub colors: [u32; 3],
}

// Чтение кадра из буфера видеокарты.
pub const GL_BGRA: u32 = 0x80E1;
pub const GL_UNSIGNED_BYTE: u32 = 0x1401;

#[link(name = "opengl32")]
unsafe extern "system" {
    pub fn glReadPixels(x: i32, y: i32, width: i32, height: i32, format: u32, kind: u32, pixels: *mut u8);
    pub fn glFinish();
}

#[link(name = "opengl32")]
unsafe extern "system" {
    pub fn wglCreateContext(hdc: HDC) -> HGLRC;
    pub fn wglMakeCurrent(hdc: HDC, ctx: HGLRC) -> i32;
    pub fn wglDeleteContext(ctx: HGLRC) -> i32;
    pub fn wglGetProcAddress(name: *const u8) -> *const c_void;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    pub fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
    pub fn LoadLibraryA(name: *const u8) -> HINSTANCE;
    pub fn GetProcAddress(module: HINSTANCE, name: *const u8) -> *const c_void;
    pub fn CreateMutexW(attrs: *mut c_void, owner: i32, name: *const u16) -> *mut c_void;
    pub fn GetLastError() -> u32;
    pub fn GlobalMemoryStatusEx(status: *mut MEMORYSTATUSEX) -> i32;
    pub fn GetDiskFreeSpaceExW(
        path: *const u16,
        free_to_caller: *mut u64,
        total: *mut u64,
        free: *mut u64,
    ) -> i32;
    pub fn GetTickCount64() -> u64;
    pub fn GetComputerNameW(buffer: *mut u16, size: *mut u32) -> i32;
    pub fn GetSystemInfo(info: *mut SYSTEM_INFO);
    pub fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    pub fn Process32FirstW(snapshot: *mut c_void, entry: *mut PROCESSENTRY32W) -> i32;
    pub fn Process32NextW(snapshot: *mut c_void, entry: *mut PROCESSENTRY32W) -> i32;
    pub fn CloseHandle(handle: *mut c_void) -> i32;
    pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    pub fn GetProcessTimes(
        process: *mut c_void,
        creation: *mut FILETIME,
        exit: *mut FILETIME,
        kernel: *mut FILETIME,
        user: *mut FILETIME,
    ) -> i32;
}

#[link(name = "psapi")]
unsafe extern "system" {
    pub fn GetProcessMemoryInfo(
        process: *mut c_void,
        counters: *mut PROCESS_MEMORY_COUNTERS,
        size: u32,
    ) -> i32;
}

#[link(name = "iphlpapi")]
unsafe extern "system" {
    pub fn GetIfTable(table: *mut u8, size: *mut u32, order: i32) -> u32;
}

pub const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
pub const MAX_PATH: usize = 260;

// Типы сетевых интерфейсов из ipifcons.h
pub const IF_TYPE_ETHERNET: u32 = 6;
pub const IF_TYPE_IEEE80211: u32 = 71;
pub const IF_TYPE_PPP: u32 = 23;
pub const IF_TYPE_TUNNEL: u32 = 131;
pub const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
// У старой структуры MIB_IFROW своя нумерация статусов: рабочее состояние — 4 и 5.
pub const IF_OPER_CONNECTED: u32 = 4;
pub const IF_OPER_OPERATIONAL: u32 = 5;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct FILETIME {
    pub low: u32,
    pub high: u32,
}

impl FILETIME {
    pub fn as_u64(self) -> u64 {
        ((self.high as u64) << 32) | self.low as u64
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct MEMORYSTATUSEX {
    pub dwLength: u32,
    pub dwMemoryLoad: u32,
    pub ullTotalPhys: u64,
    pub ullAvailPhys: u64,
    pub ullTotalPageFile: u64,
    pub ullAvailPageFile: u64,
    pub ullTotalVirtual: u64,
    pub ullAvailVirtual: u64,
    pub ullAvailExtendedVirtual: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SYSTEM_INFO {
    pub wProcessorArchitecture: u16,
    pub wReserved: u16,
    pub dwPageSize: u32,
    pub lpMinimumApplicationAddress: usize,
    pub lpMaximumApplicationAddress: usize,
    pub dwActiveProcessorMask: usize,
    pub dwNumberOfProcessors: u32,
    pub dwProcessorType: u32,
    pub dwAllocationGranularity: u32,
    pub wProcessorLevel: u16,
    pub wProcessorRevision: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PROCESSENTRY32W {
    pub dwSize: u32,
    pub cntUsage: u32,
    pub th32ProcessID: u32,
    pub th32DefaultHeapID: usize,
    pub th32ModuleID: u32,
    pub cntThreads: u32,
    pub th32ParentProcessID: u32,
    pub pcPriClassBase: i32,
    pub dwFlags: u32,
    pub szExeFile: [u16; MAX_PATH],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct PROCESS_MEMORY_COUNTERS {
    pub cb: u32,
    pub PageFaultCount: u32,
    pub PeakWorkingSetSize: usize,
    pub WorkingSetSize: usize,
    pub QuotaPeakPagedPoolUsage: usize,
    pub QuotaPagedPoolUsage: usize,
    pub QuotaPeakNonPagedPoolUsage: usize,
    pub QuotaNonPagedPoolUsage: usize,
    pub PagefileUsage: usize,
    pub PeakPagefileUsage: usize,
}

/// Строка MIB_IFROW: плоская структура, даёт тип адаптера, скорость линка и счётчики.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MIB_IFROW {
    pub wszName: [u16; 256],
    pub dwIndex: u32,
    pub dwType: u32,
    pub dwMtu: u32,
    pub dwSpeed: u32,
    pub dwPhysAddrLen: u32,
    pub bPhysAddr: [u8; 8],
    pub dwAdminStatus: u32,
    pub dwOperStatus: u32,
    pub dwLastChange: u32,
    pub dwInOctets: u32,
    pub dwInUcastPkts: u32,
    pub dwInNUcastPkts: u32,
    pub dwInDiscards: u32,
    pub dwInErrors: u32,
    pub dwInUnknownProtos: u32,
    pub dwOutOctets: u32,
    pub dwOutUcastPkts: u32,
    pub dwOutNUcastPkts: u32,
    pub dwOutDiscards: u32,
    pub dwOutErrors: u32,
    pub dwOutQLen: u32,
    pub dwDescrLen: u32,
    pub bDescr: [u8; 256],
}

/// Данные одного логического процессора из NtQuerySystemInformation.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION {
    pub IdleTime: i64,
    pub KernelTime: i64,
    pub UserTime: i64,
    pub DpcTime: i64,
    pub InterruptTime: i64,
    pub InterruptCount: u32,
    pub _padding: u32,
}

pub const SYSTEM_PROCESSOR_PERFORMANCE: u32 = 8;

pub const ERROR_ALREADY_EXISTS: u32 = 183;
pub const ENUM_CURRENT_SETTINGS: u32 = 0xFFFF_FFFF;
pub const MONITORINFOF_PRIMARY: u32 = 1;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MONITORINFOEXW {
    pub cbSize: u32,
    pub rcMonitor: RECT,
    pub rcWork: RECT,
    pub dwFlags: u32,
    pub szDevice: [u16; 32],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct DEVMODEW {
    pub dmDeviceName: [u16; 32],
    pub dmSpecVersion: u16,
    pub dmDriverVersion: u16,
    pub dmSize: u16,
    pub dmDriverExtra: u16,
    pub dmFields: u32,
    pub dmPositionX: i32,
    pub dmPositionY: i32,
    pub dmDisplayOrientation: u32,
    pub dmDisplayFixedOutput: u32,
    pub dmColor: i16,
    pub dmDuplex: i16,
    pub dmYResolution: i16,
    pub dmTTOption: i16,
    pub dmCollate: i16,
    pub dmFormName: [u16; 32],
    pub dmLogPixels: u16,
    pub dmBitsPerPel: u32,
    pub dmPelsWidth: u32,
    pub dmPelsHeight: u32,
    pub dmDisplayFlags: u32,
    pub dmDisplayFrequency: u32,
    pub dmICMMethod: u32,
    pub dmICMIntent: u32,
    pub dmMediaType: u32,
    pub dmDitherType: u32,
    pub dmReserved1: u32,
    pub dmReserved2: u32,
    pub dmPanningWidth: u32,
    pub dmPanningHeight: u32,
}

/// Строка UTF-16 с завершающим нулём — Win32 принимает только такие.
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn wide_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}
