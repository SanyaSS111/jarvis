//! Палитра, плавности и таймлайн анимации запуска.

use femtovg::Color;

pub const VOID: Color = Color { r: 0.012, g: 0.027, b: 0.039, a: 1.0 };
pub const DEEP: Color = Color { r: 0.024, g: 0.067, b: 0.094, a: 1.0 };
pub const TEXT: Color = Color { r: 0.863, g: 0.949, b: 0.984, a: 1.0 };
pub const STEEL: Color = Color { r: 0.486, g: 0.616, b: 0.690, a: 1.0 };
pub const AMBER: Color = Color { r: 1.0, g: 0.706, b: 0.329, a: 1.0 };
pub const RED: Color = Color { r: 1.0, g: 0.373, b: 0.337, a: 1.0 };
pub const OK: Color = Color { r: 0.361, g: 1.0, b: 0.694, a: 1.0 };

pub fn accent() -> Color {
    Color { r: 0.361, g: 0.882, b: 1.0, a: 1.0 }
}

pub fn with_alpha(color: Color, alpha: f32) -> Color {
    Color { a: color.a * alpha.clamp(0.0, 1.0), ..color }
}

/// Порог тревоги: 80% нагрузки — рабочая норма, а не авария.
pub fn level_color(percent: f32) -> Color {
    if percent >= 95.0 {
        RED
    } else if percent >= 85.0 {
        AMBER
    } else {
        accent()
    }
}

pub fn temp_color(celsius: f32) -> Color {
    if celsius >= 88.0 {
        RED
    } else if celsius >= 80.0 {
        AMBER
    } else {
        accent()
    }
}

// --- плавности ---

pub fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

pub fn ease_out_back(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let c = 1.70158;
    1.0 + (c + 1.0) * (t - 1.0).powi(3) + c * (t - 1.0).powi(2)
}

pub fn ease_in_out(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 { 2.0 * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(2) / 2.0 }
}

/// Сценарий запуска. Каждая фаза — своя полоса времени, поэтому
/// элементы появляются по очереди, а не все разом.
pub struct Boot {
    pub elapsed: f32,
}

pub const BOOT_TOTAL: f32 = 3.6;

impl Boot {
    pub fn new() -> Self {
        Self { elapsed: 0.0 }
    }

    pub fn done(&self) -> bool {
        self.elapsed >= BOOT_TOTAL
    }

    /// Прогресс фазы 0..1 с указанным началом и длительностью.
    pub fn stage(&self, start: f32, duration: f32) -> f32 {
        if duration <= 0.0 {
            return 1.0;
        }
        ((self.elapsed - start) / duration).clamp(0.0, 1.0)
    }

    /// Горизонтальная развёртка в самом начале.
    pub fn sweep_open(&self) -> f32 {
        ease_out_cubic(self.stage(0.0, 0.55))
    }

    /// Сборка кольца реактора.
    pub fn reactor(&self) -> f32 {
        ease_out_cubic(self.stage(0.35, 0.85))
    }

    /// Линии связи разбегаются от центра к модулям.
    pub fn links(&self) -> f32 {
        ease_out_cubic(self.stage(0.8, 0.8))
    }

    /// Появление модуля с задержкой по его номеру.
    pub fn module(&self, index: usize) -> f32 {
        let start = 1.15 + index as f32 * 0.075;
        ease_out_back(self.stage(start, 0.45))
    }

    /// Разгон стрелок датчиков до настоящих значений.
    pub fn dials(&self) -> f32 {
        ease_in_out(self.stage(1.9, 0.9))
    }

    /// Финальная полоса сканирования сверху вниз.
    pub fn final_scan(&self) -> f32 {
        self.stage(2.5, 0.9)
    }

    /// Проявление заголовка.
    pub fn title(&self) -> f32 {
        ease_out_cubic(self.stage(2.7, 0.6))
    }
}
