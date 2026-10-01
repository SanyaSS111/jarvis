//! Настройки в %APPDATA%\JarvisHUD2\config.json.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub accent: [f32; 3],
    pub fps_cap: u32,
    pub icon_margin: f32,
    pub grid: bool,
    pub motes: bool,
    pub frame: bool,
    pub reactor: bool,
    pub boot_animation: bool,
    /// Скрытые модули по идентификатору.
    pub hidden: Vec<String>,
    /// Позиции, заданные перетаскиванием: доля от размера монитора.
    pub positions: HashMap<String, [f32; 2]>,
    /// Мониторы, на которых HUD выключен.
    pub disabled_monitors: Vec<String>,
    /// Язык интерфейса: "en" или "ru" (задаёт лаунчер).
    pub lang: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            accent: [0.361, 0.882, 1.0],
            fps_cap: 30,
            icon_margin: 300.0,
            grid: true,
            motes: true,
            frame: true,
            reactor: true,
            boot_animation: true,
            hidden: Vec::new(),
            positions: HashMap::new(),
            disabled_monitors: Vec::new(),
            lang: "en".into(),
        }
    }
}

pub fn directory() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("JarvisHUD2")
}

pub fn path() -> PathBuf {
    directory().join("config.json")
}

impl Config {
    pub fn load() -> Self {
        let config: Self = match std::fs::read_to_string(path()) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Self::default(),
        };
        crate::lang::set(&config.lang);
        config
    }

    pub fn save(&self) {
        let _ = std::fs::create_dir_all(directory());
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path(), text);
        }
    }

    pub fn is_hidden(&self, id: &str) -> bool {
        self.hidden.iter().any(|entry| entry == id)
    }

    pub fn toggle(&mut self, id: &str) {
        if let Some(index) = self.hidden.iter().position(|entry| entry == id) {
            self.hidden.remove(index);
        } else {
            self.hidden.push(id.to_string());
        }
        self.save();
    }
}
