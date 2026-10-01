//! Язык интерфейса: "en" (по умолчанию) или "ru" — поле `lang` в config.json, его пишет лаунчер J.A.R.V.I.S.

use std::sync::atomic::{AtomicBool, Ordering};

static RUSSIAN: AtomicBool = AtomicBool::new(false);

pub fn set(lang: &str) {
    RUSSIAN.store(lang == "ru", Ordering::Relaxed);
}

/// Строка для текущего языка.
pub fn tr(ru: &'static str, en: &'static str) -> &'static str {
    if RUSSIAN.load(Ordering::Relaxed) { ru } else { en }
}

/// Десятичный разделитель: запятая по-русски, точка по-английски.
pub fn dec() -> &'static str {
    tr(",", ".")
}
