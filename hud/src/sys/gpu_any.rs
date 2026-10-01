//! Видеокарта любого производителя, когда NVML нет (AMD, Intel): имя, объём памяти и LUID — через DXGI.
//! Загрузку и занятую память по этому LUID читают счётчики Windows (pdh.rs).

use std::ffi::c_void;

use crate::win32::*;

#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);

// IID_IDXGIFactory1
const IID_FACTORY1: Guid = Guid(0x770a_ae78, 0xf26f, 0x4dba, [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]);
const ADAPTER_FLAG_SOFTWARE: u32 = 2;
const VENDOR_MICROSOFT: u32 = 0x1414; // Microsoft Basic Render Driver

#[repr(C)]
struct AdapterDesc1 {
    description: [u16; 128],
    vendor_id: u32,
    device_id: u32,
    sub_sys_id: u32,
    revision: u32,
    dedicated_video_memory: usize,
    dedicated_system_memory: usize,
    shared_system_memory: usize,
    luid_low: u32,
    luid_high: i32,
    flags: u32,
}

#[derive(Clone, Debug)]
pub struct Adapter {
    pub name: String,
    pub vram_bytes: u64,
    /// Префикс имени экземпляра в счётчиках «GPU Engine» / «GPU Adapter Memory».
    pub luid: String,
}

type CreateFactory1 = unsafe extern "system" fn(*const Guid, *mut *mut c_void) -> i32;
type Release = unsafe extern "system" fn(*mut c_void) -> u32;
type EnumAdapters1 = unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> i32;
type GetDesc1 = unsafe extern "system" fn(*mut c_void, *mut AdapterDesc1) -> i32;

/// Метод COM-объекта по номеру в таблице виртуальных функций.
unsafe fn method(object: *mut c_void, index: usize) -> *const c_void {
    unsafe {
        let table = *(object as *const *const *const c_void);
        *table.add(index)
    }
}

/// Аппаратный адаптер с наибольшей собственной памятью: та видеокарта, что вставлена сейчас.
pub fn best_adapter() -> Option<Adapter> {
    unsafe {
        let library = LoadLibraryA(b"dxgi.dll\0".as_ptr());
        if library.is_null() {
            return None;
        }
        let create = GetProcAddress(library, b"CreateDXGIFactory1\0".as_ptr());
        if create.is_null() {
            return None;
        }
        let create: CreateFactory1 = std::mem::transmute(create);
        let mut factory: *mut c_void = std::ptr::null_mut();
        if create(&IID_FACTORY1, &mut factory) < 0 || factory.is_null() {
            return None;
        }
        // IUnknown 0–2, IDXGIObject 3–6, IDXGIFactory 7–11, IDXGIFactory1::EnumAdapters1 = 12.
        let enum_adapters: EnumAdapters1 = std::mem::transmute(method(factory, 12));
        let release_factory: Release = std::mem::transmute(method(factory, 2));

        let mut best: Option<Adapter> = None;
        let mut index = 0;
        loop {
            let mut adapter: *mut c_void = std::ptr::null_mut();
            if enum_adapters(factory, index, &mut adapter) < 0 || adapter.is_null() {
                break; // DXGI_ERROR_NOT_FOUND: адаптеры кончились
            }
            index += 1;
            // IDXGIAdapter 7–9, IDXGIAdapter1::GetDesc1 = 10.
            let get_desc: GetDesc1 = std::mem::transmute(method(adapter, 10));
            let release_adapter: Release = std::mem::transmute(method(adapter, 2));
            let mut desc: AdapterDesc1 = std::mem::zeroed();
            if get_desc(adapter, &mut desc) >= 0 && desc.flags & ADAPTER_FLAG_SOFTWARE == 0 && desc.vendor_id != VENDOR_MICROSOFT {
                let len = desc.description.iter().position(|&c| c == 0).unwrap_or(desc.description.len());
                let name = String::from_utf16_lossy(&desc.description[..len]).trim().to_string();
                let vram = desc.dedicated_video_memory as u64;
                if best.as_ref().map_or(true, |b| vram > b.vram_bytes) {
                    best = Some(Adapter {
                        name,
                        vram_bytes: vram,
                        luid: format!("luid_0x{:08x}_0x{:08x}", desc.luid_high as u32, desc.luid_low),
                    });
                }
            }
            release_adapter(adapter);
        }
        release_factory(factory);
        best
    }
}
