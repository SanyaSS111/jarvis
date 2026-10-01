//! Сборка кадра HUD: модули, раскладка, реактор, фон и анимация запуска.

pub mod theme;
pub mod widgets;

use femtovg::{Align, Color, Paint, Path, Solidity};

use crate::config::Config;
use crate::monitors::Monitor;
use crate::sys::{Sample, StaticInfo};
use crate::text::{Canvas, Fonts};
use theme::{with_alpha, Boot};
use widgets::Ctx;
use crate::lang::tr;

const HISTORY: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Slot {
    TopLeft,
    TopLeft2,
    LeftMiddle,
    TopCenter,
    TopRight,
    RightMiddle,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ModuleId {
    DateRing,
    Cluster,
    Load,
    Network,
    Gpu,
    Traffic,
    Storage,
    Energy,
    Thermal,
    Chrono,
    System,
    Display,
    Cores,
}

impl ModuleId {
    pub fn key(self) -> &'static str {
        match self {
            Self::DateRing => "datering",
            Self::Cluster => "cluster",
            Self::Load => "load",
            Self::Network => "network",
            Self::Gpu => "gpu",
            Self::Traffic => "traffic",
            Self::Storage => "storage",
            Self::Energy => "energy",
            Self::Thermal => "thermal",
            Self::Chrono => "chrono",
            Self::System => "system",
            Self::Display => "display",
            Self::Cores => "cores",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::DateRing => tr("КАЛЕНДАРЬ", "CALENDAR"),
            Self::Cluster => tr("ДАТЧИКИ", "SENSORS"),
            Self::Load => tr("НАГРУЗКА", "LOAD"),
            Self::Network => tr("СЕТЬ", "NETWORK"),
            Self::Gpu => tr("ВИДЕОКАРТА", "GPU"),
            Self::Traffic => tr("ТРАФИК", "TRAFFIC"),
            Self::Storage => tr("НАКОПИТЕЛЬ", "STORAGE"),
            Self::Energy => tr("ЭНЕРГИЯ", "POWER"),
            Self::Thermal => tr("ТЕМПЕРАТУРЫ", "TEMPERATURES"),
            Self::Chrono => tr("ХРОНОМЕТРИЯ", "CHRONOMETRY"),
            Self::System => tr("УЗЕЛ", "NODE"),
            Self::Display => tr("ДИСПЛЕЙ", "DISPLAY"),
            Self::Cores => tr("ЯДРА ПРОЦЕССОРА", "CPU CORES"),
        }
    }

    fn slot(self) -> Slot {
        match self {
            Self::DateRing => Slot::TopLeft,
            Self::Chrono => Slot::TopLeft2,
            Self::System | Self::Display | Self::Thermal => Slot::LeftMiddle,
            Self::Cluster => Slot::TopCenter,
            Self::Cores => Slot::BottomCenter,
            Self::Load => Slot::TopRight,
            Self::Network | Self::Gpu => Slot::RightMiddle,
            Self::Storage | Self::Energy => Slot::BottomLeft,
            Self::Traffic => Slot::BottomRight,
        }
    }

    /// Модули без панели: висят прямо на фоне.
    fn bare(self) -> bool {
        matches!(self, Self::DateRing | Self::Cluster | Self::Cores)
    }

    fn needs_gpu(self) -> bool {
        matches!(self, Self::Gpu | Self::Thermal | Self::Energy)
    }
}

pub const MODULES: [ModuleId; 13] = [
    ModuleId::DateRing,
    ModuleId::Cluster,
    ModuleId::Load,
    ModuleId::Network,
    ModuleId::Gpu,
    ModuleId::Traffic,
    ModuleId::Storage,
    ModuleId::Energy,
    ModuleId::Thermal,
    ModuleId::Chrono,
    ModuleId::System,
    ModuleId::Display,
    ModuleId::Cores,
];

/// Элемент содержимого модуля. Из него же считается высота.
enum Element {
    Row { label: String, value: String, color: Color },
    Meter { label: String, value: String, fill: f32, color: Color },
    Spark { values: Vec<f32>, max: Option<f32> },
    Dials { items: Vec<Dial>, radius: f32 },
    Column { fill: f32, facts: Vec<(String, String)> },
}

struct Dial {
    value: String,
    caption: String,
    fill: f32,
    color: Color,
}

struct Mote {
    x: f32,
    y: f32,
    radius: f32,
    speed: f32,
    alpha: f32,
}

#[derive(Default)]
struct History {
    cpu: Vec<f32>,
    gpu: Vec<f32>,
    down: Vec<f32>,
    up: Vec<f32>,
}

impl History {
    fn push(&mut self, sample: &Sample) {
        let mut add = |series: &mut Vec<f32>, value: f32| {
            series.push(value);
            if series.len() > HISTORY {
                series.remove(0);
            }
        };
        add(&mut self.cpu, sample.cpu);
        add(&mut self.gpu, sample.gpu_load);
        add(&mut self.down, sample.net_down_kbs);
        add(&mut self.up, sample.net_up_kbs);
    }
}

pub struct Hud {
    pub boot: Boot,
    history: History,
    motes: Vec<Mote>,
    last_history_at: f32,
    pub config: Config,
    /// Режим расстановки: модули можно перетаскивать мышью.
    pub edit_mode: bool,
    pub module_rects: Vec<edit::ModuleRect>,
    pub edit_buttons: Vec<(edit::EditButton, [f32; 4])>,
    drag: Option<edit::Drag>,
    pointer_at: (f32, f32),
}

fn format_speed(kbs: f32) -> String {
    if kbs >= 1024.0 {
        format!("{:.1} {}", kbs / 1024.0, tr("МБ/с", "MB/s")).replace('.', crate::lang::dec())
    } else {
        format!("{:.0} {}", kbs, tr("КБ/с", "KB/s"))
    }
}

fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86400;
    let rest = seconds % 86400;
    let text = format!("{:02}:{:02}:{:02}", rest / 3600, (rest % 3600) / 60, rest % 60);
    if days > 0 { format!("{days} {} {text}", tr("д", "d")) } else { text }
}

const WEEKDAYS_RU: [&str; 7] = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
const WEEKDAYS_EN: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS_RU: [&str; 12] = [
    "ЯНВ", "ФЕВ", "МАР", "АПР", "МАЯ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК",
];
const MONTHS_EN: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

pub(crate) fn weekday(index: usize) -> &'static str {
    tr(WEEKDAYS_RU[index], WEEKDAYS_EN[index])
}

pub(crate) fn month(index: usize) -> &'static str {
    tr(MONTHS_RU[index], MONTHS_EN[index])
}

pub mod edit;

impl Hud {
    pub fn new(config: Config) -> Self {
        Self {
            boot: Boot::new(),
            history: History::default(),
            motes: Vec::new(),
            last_history_at: 0.0,
            config,
            edit_mode: false,
            module_rects: Vec::new(),
            edit_buttons: Vec::new(),
            drag: None,
            pointer_at: (-1.0, -1.0),
        }
    }

    pub fn accent(&self) -> Color {
        let [r, g, b] = self.config.accent;
        Color { r, g, b, a: 1.0 }
    }

    pub fn update(&mut self, delta: f32, seconds: f32, sample: &Sample) {
        self.boot.elapsed += delta;

        // История для графиков пополняется раз в секунду, а не каждый кадр.
        if seconds - self.last_history_at >= 1.0 {
            self.last_history_at = seconds;
            self.history.push(sample);
        }

        for mote in &mut self.motes {
            mote.y -= mote.speed * delta;
        }
    }

    fn seed_motes(&mut self, width: f32, height: f32) {
        let target = ((width * height) / 26000.0) as usize;
        if self.motes.len() == target {
            return;
        }
        self.motes.clear();
        let mut seed = 0x2545F491_4F6CDD1Du64;
        let mut random = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 10_000) as f32 / 10_000.0
        };
        for _ in 0..target {
            self.motes.push(Mote {
                x: random() * width,
                y: random() * height,
                radius: random() * 1.3 + 0.4,
                speed: random() * 22.0 + 6.0,
                alpha: random() * 0.4 + 0.12,
            });
        }
    }

    /// Содержимое модуля: из него считается и высота, и отрисовка.
    fn elements(&self, id: ModuleId, sample: &Sample, info: &StaticInfo, scale: f32, monitor: &Monitor) -> Vec<Element> {
        let accent = self.accent();
        let level = theme::level_color;

        match id {
            ModuleId::Load => {
                let mut items = vec![
                    Element::Meter {
                        label: tr("ЦП", "CPU").into(),
                        value: format!("{:.0} %", sample.cpu),
                        fill: sample.cpu / 100.0,
                        color: level(sample.cpu),
                    },
                    Element::Meter {
                        label: tr("ОЗУ", "RAM").into(),
                        value: format!("{:.1} {}", sample.ram_used_gb, tr("ГБ", "GB")),
                        fill: sample.ram_percent / 100.0,
                        color: level(sample.ram_percent),
                    },
                    Element::Meter {
                        label: tr("ДИСК", "DISK").into(),
                        value: format!("{:.0} %", sample.disk_percent),
                        fill: sample.disk_percent / 100.0,
                        color: level(sample.disk_percent),
                    },
                ];
                for process in sample.top_processes.iter().take(5) {
                    let memory = if process.mem_mb >= 1024 {
                        format!("{:.1} {}", process.mem_mb as f32 / 1024.0, tr("ГБ", "GB")).replace('.', crate::lang::dec())
                    } else {
                        format!("{} {}", process.mem_mb, tr("МБ", "MB"))
                    };
                    items.push(Element::Row {
                        label: process.name.clone(),
                        value: format!("{:.1} % · {memory}", process.cpu),
                        color: theme::STEEL,
                    });
                }
                items
            }

            ModuleId::Network => {
                let online = sample.net_kind != tr("Нет соединения", "No connection");
                let mut name = sample.net_name.clone();
                if let Some(cut) = name.find("-WFP") {
                    name.truncate(cut);
                }
                vec![
                    Element::Row {
                        label: tr("СТАТУС", "STATUS").into(),
                        value: if online { tr("Подключено", "Connected").into() } else { tr("Нет связи", "Offline").into() },
                        color: if online { theme::OK } else { theme::RED },
                    },
                    Element::Row { label: tr("ТИП", "TYPE").into(), value: sample.net_kind.clone(), color: theme::TEXT },
                    Element::Row {
                        label: tr("ЛИНК", "LINK").into(),
                        value: if sample.net_link_mbps > 0 {
                            format!("{} {}", sample.net_link_mbps, tr("Мбит/с", "Mbit/s"))
                        } else {
                            "—".into()
                        },
                        color: theme::TEXT,
                    },
                    Element::Row { label: tr("ЗАГРУЗКА", "DOWN").into(), value: format_speed(sample.net_down_kbs), color: theme::TEXT },
                    Element::Row { label: tr("ОТДАЧА", "UP").into(), value: format_speed(sample.net_up_kbs), color: theme::TEXT },
                    Element::Row {
                        label: tr("ТУННЕЛЬ", "TUNNEL").into(),
                        value: sample.net_tunnel.clone().unwrap_or_else(|| tr("нет", "none").into()),
                        color: theme::STEEL,
                    },
                    Element::Row { label: tr("АДАПТЕР", "ADAPTER").into(), value: name, color: theme::STEEL },
                ]
            }

            ModuleId::Gpu => vec![
                Element::Row {
                    label: tr("МОДЕЛЬ", "MODEL").into(),
                    value: info.gpu_name.clone().unwrap_or_else(|| "—".into()),
                    color: theme::TEXT,
                },
                Element::Row {
                    label: tr("ЗАГРУЗКА", "LOAD").into(),
                    value: format!("{:.0} %", sample.gpu_load),
                    color: level(sample.gpu_load),
                },
                Element::Row {
                    label: tr("ВИДЕОПАМЯТЬ", "VRAM").into(),
                    value: format!("{:.1} / {:.0} {}", sample.gpu_vram_used_gb, info.gpu_vram_total_gb, tr("ГБ", "GB")),
                    color: theme::TEXT,
                },
                Element::Row { label: tr("ВЕНТИЛЯТОР", "FAN").into(), value: format!("{} %", sample.gpu_fan), color: theme::TEXT },
                Element::Row {
                    label: tr("ЧАСТОТЫ", "CLOCKS").into(),
                    value: format!("{}/{} {}", sample.gpu_clock_core, sample.gpu_clock_mem, tr("МГц", "MHz")),
                    color: theme::TEXT,
                },
                Element::Spark { values: self.history.gpu.clone(), max: Some(100.0) },
            ],

            ModuleId::Thermal => vec![
                Element::Row {
                    label: tr("ВИДЕОКАРТА", "GPU").into(),
                    value: format!("{} °C", sample.gpu_temp),
                    color: theme::temp_color(sample.gpu_temp as f32),
                },
                Element::Row { label: tr("ПРОЦЕССОР", "CPU").into(), value: tr("недоступно", "unavailable").into(), color: theme::STEEL },
            ],

            ModuleId::Energy => vec![
                Element::Meter {
                    label: tr("ВИДЕОКАРТА", "GPU").into(),
                    value: format!("{:.1} {}", sample.gpu_power_w, tr("Вт", "W")).replace('.', crate::lang::dec()),
                    fill: if info.gpu_power_limit_w > 0.0 {
                        sample.gpu_power_w / info.gpu_power_limit_w
                    } else {
                        0.0
                    },
                    color: accent,
                },
                Element::Row {
                    label: tr("ПРЕДЕЛ", "LIMIT").into(),
                    value: format!("{:.0} {}", info.gpu_power_limit_w, tr("Вт", "W")),
                    color: theme::TEXT,
                },
                Element::Row { label: tr("ПРОЦЕССОР", "CPU").into(), value: tr("недоступно", "unavailable").into(), color: theme::STEEL },
            ],

            ModuleId::Chrono => {
                let now = crate::clock::now();
                vec![
                    Element::Row {
                        label: tr("ДАТА", "DATE").into(),
                        value: format!("{} {} {} {}", weekday(now.weekday), now.day, month(now.month), now.year),
                        color: theme::TEXT,
                    },
                    Element::Row { label: tr("АПТАЙМ", "UPTIME").into(), value: format_uptime(sample.uptime_secs), color: theme::TEXT },
                    Element::Row {
                        label: tr("ЧАСТОТА ЦП", "CPU CLOCK").into(),
                        value: if sample.cpu_freq_mhz > 0 {
                            format!("{:.2} {}", sample.cpu_freq_mhz as f32 / 1000.0, tr("ГГц", "GHz")).replace('.', crate::lang::dec())
                        } else {
                            "—".into()
                        },
                        color: theme::TEXT,
                    },
                ]
            }

            ModuleId::System => vec![
                Element::Row { label: tr("ИМЯ", "NAME").into(), value: info.hostname.clone(), color: theme::TEXT },
                Element::Row { label: tr("СИСТЕМА", "SYSTEM").into(), value: info.os.clone(), color: theme::TEXT },
                Element::Row { label: tr("ПОТОКИ ЦП", "CPU THREADS").into(), value: format!("{}", info.threads), color: theme::TEXT },
                Element::Spark { values: self.history.cpu.clone(), max: Some(100.0) },
            ],

            ModuleId::Display => vec![
                Element::Row {
                    label: tr("РАЗРЕШЕНИЕ", "RESOLUTION").into(),
                    value: format!("{}×{}", monitor.width, monitor.height),
                    color: theme::TEXT,
                },
                Element::Row { label: tr("ЧАСТОТА", "REFRESH").into(), value: format!("{} {}", monitor.hz, tr("Гц", "Hz")), color: theme::TEXT },
                Element::Row {
                    label: tr("МАСШТАБ", "SCALE").into(),
                    value: format!("{:.0} %", monitor.scale * 100.0),
                    color: theme::TEXT,
                },
            ],

            ModuleId::Storage => vec![
                Element::Column {
                    fill: sample.disk_percent / 100.0,
                    facts: vec![
                        (tr("ЗАНЯТО", "USED").into(), format!("{:.0} {}", info.disk_total_gb - sample.disk_free_gb, tr("ГБ", "GB"))),
                        (tr("СВОБОДНО", "FREE").into(), format!("{:.0} {}", sample.disk_free_gb, tr("ГБ", "GB"))),
                        (tr("ОБЪЁМ", "TOTAL").into(), format!("{:.0} {}", info.disk_total_gb, tr("ГБ", "GB"))),
                    ],
                },
                Element::Row {
                    label: tr("ЧТ/ЗП", "R/W").into(),
                    value: format!("{} / {}", format_speed(sample.disk_read_kbs), format_speed(sample.disk_write_kbs)),
                    color: theme::TEXT,
                },
            ],

            ModuleId::Traffic => vec![
                Element::Row { label: tr("ЗАГРУЗКА", "DOWN").into(), value: format_speed(sample.net_down_kbs), color: accent },
                Element::Spark { values: self.history.down.clone(), max: None },
                Element::Row { label: tr("ОТДАЧА", "UP").into(), value: format_speed(sample.net_up_kbs), color: accent },
                Element::Spark { values: self.history.up.clone(), max: None },
            ],

            ModuleId::Cluster => {
                let mut items = vec![Dial {
                    value: format!("{:.0}", sample.cpu),
                    caption: tr("ЦП", "CPU").into(),
                    fill: sample.cpu / 100.0,
                    color: level(sample.cpu),
                }];
                if info.gpu_name.is_some() {
                    items.push(Dial {
                        value: format!("{:.0}", sample.gpu_load),
                        caption: tr("ГП", "GPU").into(),
                        fill: sample.gpu_load / 100.0,
                        color: level(sample.gpu_load),
                    });
                }
                items.push(Dial {
                    value: format!("{:.0}", sample.ram_percent),
                    caption: tr("ОЗУ", "RAM").into(),
                    fill: sample.ram_percent / 100.0,
                    color: level(sample.ram_percent),
                });
                items.push(Dial {
                    value: format!("{:.0}", sample.disk_percent),
                    caption: tr("ДИСК", "DISK").into(),
                    fill: sample.disk_percent / 100.0,
                    color: level(sample.disk_percent),
                });
                items.push(Dial {
                    value: format!("{:.0}", sample.net_down_kbs.min(9999.0)),
                    caption: tr("КБ/С", "KB/S").into(),
                    fill: (sample.net_down_kbs / 12000.0).min(1.0),
                    color: accent,
                });
                vec![Element::Dials { items, radius: 26.0 * scale }]
            }

            ModuleId::Cores => {
                let items = sample
                    .cpu_cores
                    .iter()
                    .enumerate()
                    .map(|(index, load)| Dial {
                        value: format!("{:.0}", load),
                        caption: format!("#{}", index + 1),
                        fill: load / 100.0,
                        color: level(*load),
                    })
                    .collect();
                vec![Element::Dials { items, radius: 17.0 * scale }]
            }

            ModuleId::DateRing => Vec::new(),
        }
    }

    fn element_height(element: &Element, scale: f32) -> f32 {
        match element {
            Element::Row { .. } => 15.0 * scale,
            Element::Meter { .. } => 21.0 * scale,
            Element::Spark { .. } => 34.0 * scale,
            Element::Dials { radius, .. } => radius * 2.9,
            Element::Column { .. } => 58.0 * scale,
        }
    }

    fn module_size(&self, id: ModuleId, elements: &[Element], scale: f32) -> (f32, f32) {
        if id == ModuleId::DateRing {
            let size = 122.0 * scale;
            return (size, size);
        }

        if id.bare() {
            let width: f32 = elements
                .iter()
                .map(|element| match element {
                    Element::Dials { items, radius } => {
                        items.len() as f32 * radius * 2.0 + (items.len().max(1) - 1) as f32 * radius * 0.8
                    }
                    _ => 0.0,
                })
                .fold(0.0, f32::max);
            let height: f32 = elements.iter().map(|e| Self::element_height(e, scale)).sum();
            return (width, height);
        }

        let width = 236.0 * scale;
        let content: f32 = elements.iter().map(|e| Self::element_height(e, scale)).sum();
        (width, 26.0 * scale + content + 10.0 * scale)
    }
}

pub mod draw;
