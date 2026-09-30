//! Автозапуск через раздел реестра пользователя — без прав администратора.

use crate::registry;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE: &str = "JarvisHUD2";

fn command() -> String {
    let path = std::env::current_exe().unwrap_or_default();
    format!("\"{}\"", path.display())
}

pub fn is_enabled() -> bool {
    registry::read_user_string(RUN_KEY, VALUE).map(|value| value == command()).unwrap_or(false)
}

pub fn set_enabled(enabled: bool) -> bool {
    if enabled {
        registry::write_user_string(RUN_KEY, VALUE, &command())
    } else {
        registry::delete_user_value(RUN_KEY, VALUE)
    }
}
