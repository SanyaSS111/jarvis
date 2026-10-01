//! Режим расстановки: модули перетаскиваются мышью, позиции запоминаются
//! отдельно для каждого монитора как доля его размера.

use femtovg::{Align, Paint, Path};

use super::theme::{self, with_alpha};
use super::widgets::Ctx;
use super::Hud;
use crate::overlay::Pointer;
use crate::lang::tr;

/// Где модуль оказался в последнем кадре — по этим прямоугольникам ловим щелчок.
#[derive(Clone)]
pub struct ModuleRect {
    pub monitor_key: String,
    pub key: &'static str,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Монитор в координатах холста: левый край, верх, ширина, высота.
    pub region: [f32; 4],
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EditButton {
    Done,
    Reset,
}

pub struct Drag {
    monitor_key: String,
    key: &'static str,
    offset: (f32, f32),
    region: [f32; 4],
    width: f32,
    height: f32,
}

pub fn position_key(monitor_key: &str, module_key: &str) -> String {
    format!("{monitor_key}|{module_key}")
}

fn inside(point: (f32, f32), x: f32, y: f32, width: f32, height: f32) -> bool {
    point.0 >= x && point.0 <= x + width && point.1 >= y && point.1 <= y + height
}

impl Hud {
    /// Разбор события мыши. Возвращает нажатую кнопку режима, если была.
    pub fn pointer(&mut self, event: Pointer) -> Option<EditButton> {
        match event {
            Pointer::Down(x, y) => {
                self.pointer_at = (x, y);
                for (button, rect) in &self.edit_buttons {
                    if inside((x, y), rect[0], rect[1], rect[2], rect[3]) {
                        return Some(*button);
                    }
                }
                // Берём верхний модуль под курсором: он нарисован последним.
                if let Some(rect) = self
                    .module_rects
                    .iter()
                    .rev()
                    .find(|rect| inside((x, y), rect.x, rect.y, rect.width, rect.height))
                {
                    self.drag = Some(Drag {
                        monitor_key: rect.monitor_key.clone(),
                        key: rect.key,
                        offset: (x - rect.x, y - rect.y),
                        region: rect.region,
                        width: rect.width,
                        height: rect.height,
                    });
                }
                None
            }
            Pointer::Move(x, y) => {
                self.pointer_at = (x, y);
                if let Some(drag) = &self.drag {
                    let [region_x, region_y, region_w, region_h] = drag.region;
                    let left = (x - drag.offset.0 - region_x).clamp(0.0, (region_w - drag.width).max(0.0));
                    let top = (y - drag.offset.1 - region_y).clamp(0.0, (region_h - drag.height).max(0.0));
                    let key = position_key(&drag.monitor_key, drag.key);
                    self.config.positions.insert(key, [left / region_w, top / region_h]);
                }
                None
            }
            Pointer::Up(x, y) => {
                self.pointer_at = (x, y);
                if self.drag.take().is_some() {
                    self.config.save();
                }
                None
            }
        }
    }

    /// Все модули возвращаются в автоматическую раскладку.
    pub fn reset_layout(&mut self) {
        self.drag = None;
        self.config.positions.clear();
        self.config.save();
    }

    pub fn is_dragging(&self, monitor_key: &str, module_key: &str) -> bool {
        self.drag
            .as_ref()
            .map(|drag| drag.monitor_key == monitor_key && drag.key == module_key)
            .unwrap_or(false)
    }

    pub fn pointer_position(&self) -> (f32, f32) {
        self.pointer_at
    }
}

/// Подсветка модуля в режиме расстановки.
pub fn outline(ctx: &mut Ctx, x: f32, y: f32, width: f32, height: f32, active: bool, hovered: bool) {
    let accent = ctx.accent;
    let pad = 5.0 * ctx.scale;
    let mut path = Path::new();
    path.rect(x - pad, y - pad, width + pad * 2.0, height + pad * 2.0);

    let fill = if active { 0.16 } else if hovered { 0.09 } else { 0.03 };
    ctx.canvas.fill_path(&path, &Paint::color(with_alpha(accent, fill)));

    let alpha = if active { 1.0 } else if hovered { 0.85 } else { 0.45 };
    let paint = ctx.stroke(with_alpha(accent, alpha), if active { 2.0 } else { 1.2 });
    ctx.canvas.stroke_path(&path, &paint);
}

/// Заголовок режима и кнопки. Прямоугольники кнопок — в координатах монитора.
pub fn banner(ctx: &mut Ctx, width: f32, y: f32, pointer: (f32, f32)) -> [(EditButton, [f32; 4]); 2] {
    let scale = ctx.scale;
    let accent = ctx.accent;
    let center = width / 2.0;

    let title = ctx
        .display_paint(15.0, accent)
        .with_text_align(Align::Center)
        .with_letter_spacing(3.0 * scale);
    let _ = ctx.canvas.fill_text(center, y, tr("РЕЖИМ РАССТАНОВКИ", "LAYOUT MODE"), &title);

    let hint = ctx
        .label_paint(11.5, with_alpha(theme::STEEL, 0.95))
        .with_text_align(Align::Center);
    let _ = ctx
        .canvas
        .fill_text(center, y + 22.0 * scale, tr("Перетащите модули мышью · Esc или «Готово» — выйти", "Drag modules with the mouse · Esc or “Done” to exit"), &hint);

    let button_height = 36.0 * scale;
    let button_y = y + 44.0 * scale;
    let done_width = 150.0 * scale;
    let reset_width = 250.0 * scale;
    let gap = 12.0 * scale;
    let start = center - (done_width + gap + reset_width) / 2.0;

    let buttons = [
        (EditButton::Done, [start, button_y, done_width, button_height]),
        (EditButton::Reset, [start + done_width + gap, button_y, reset_width, button_height]),
    ];

    for (button, rect) in buttons.iter() {
        let hovered = inside(pointer, rect[0], rect[1], rect[2], rect[3]);
        let primary = *button == EditButton::Done;

        let mut path = Path::new();
        path.rect(rect[0], rect[1], rect[2], rect[3]);
        let fill = match (primary, hovered) {
            (true, true) => 0.38,
            (true, false) => 0.24,
            (false, true) => 0.18,
            (false, false) => 0.08,
        };
        ctx.canvas.fill_path(&path, &Paint::color(with_alpha(accent, fill)));
        let paint = ctx.stroke(with_alpha(accent, 0.85), 1.2);
        ctx.canvas.stroke_path(&path, &paint);

        let label = if primary { tr("ГОТОВО", "DONE") } else { tr("СБРОСИТЬ РАССТАНОВКУ", "RESET LAYOUT") };
        let text = ctx
            .display_paint(12.5, if primary { theme::TEXT } else { accent })
            .with_text_align(Align::Center)
            .with_letter_spacing(2.0 * scale);
        let _ = ctx.canvas.fill_text(rect[0] + rect[2] / 2.0, rect[1] + rect[3] / 2.0, label, &text);
    }

    buttons
}
