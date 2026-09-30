//! Чтение и запись реестра пользователя: версия Windows и автозапуск.

use std::ffi::c_void;

use crate::win32::wide;

pub const HKEY_CURRENT_USER: *mut c_void = 0x8000_0001u32 as usize as *mut c_void;
pub const HKEY_LOCAL_MACHINE: *mut c_void = 0x8000_0002u32 as usize as *mut c_void;

const KEY_READ: u32 = 0x2_0019;
const KEY_SET_VALUE: u32 = 0x0002;
const REG_SZ: u32 = 1;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(key: *mut c_void, path: *const u16, options: u32, access: u32, out: *mut *mut c_void) -> i32;
    fn RegQueryValueExW(
        key: *mut c_void,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        size: *mut u32,
    ) -> i32;
    fn RegSetValueExW(key: *mut c_void, name: *const u16, reserved: u32, kind: u32, data: *const u8, size: u32) -> i32;
    fn RegDeleteValueW(key: *mut c_void, name: *const u16) -> i32;
    fn RegCloseKey(key: *mut c_void) -> i32;
}

pub fn read_string(path: &str, name: &str) -> Option<String> {
    unsafe {
        let mut key: *mut c_void = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_LOCAL_MACHINE, wide(path).as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return None;
        }

        let mut buffer = [0u16; 512];
        let mut size = (buffer.len() * 2) as u32;
        let status = RegQueryValueExW(
            key,
            wide(name).as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            buffer.as_mut_ptr() as *mut u8,
            &mut size,
        );
        RegCloseKey(key);

        if status != 0 {
            return None;
        }
        let chars = (size as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buffer[..chars]))
    }
}

pub fn read_user_string(path: &str, name: &str) -> Option<String> {
    unsafe {
        let mut key: *mut c_void = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return None;
        }

        let mut buffer = [0u16; 512];
        let mut size = (buffer.len() * 2) as u32;
        let status = RegQueryValueExW(
            key,
            wide(name).as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            buffer.as_mut_ptr() as *mut u8,
            &mut size,
        );
        RegCloseKey(key);

        if status != 0 {
            return None;
        }
        let chars = (size as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buffer[..chars]))
    }
}

pub fn write_user_string(path: &str, name: &str, value: &str) -> bool {
    unsafe {
        let mut key: *mut c_void = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_SET_VALUE, &mut key) != 0 {
            return false;
        }
        let data = wide(value);
        let status = RegSetValueExW(
            key,
            wide(name).as_ptr(),
            0,
            REG_SZ,
            data.as_ptr() as *const u8,
            (data.len() * 2) as u32,
        );
        RegCloseKey(key);
        status == 0
    }
}

pub fn delete_user_value(path: &str, name: &str) -> bool {
    unsafe {
        let mut key: *mut c_void = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_SET_VALUE, &mut key) != 0 {
            return false;
        }
        let status = RegDeleteValueW(key, wide(name).as_ptr());
        RegCloseKey(key);
        status == 0
    }
}
