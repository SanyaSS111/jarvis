//! Примитивы HUD: панель с уголками, круглый датчик, шкала, график, строки.

use femtovg::{Align, Baseline, Color, Paint, Path, Solidity};

use super::theme::{self, with_alpha};
use crate::text::{Canvas, Fonts};

pub struct Ctx<'a> {
    pub canvas: &'a mut Canvas,
    pub fonts: &'a Fonts,
    pub scale: f32,
    pub accent: Color,
}

impl<'a> Ctx<'a> {
    pub fn label_paint(&self, size: f32, color: Color) -> Paint {
        Paint::color(color)
            .with_font(&[self.fonts.mono])
            .with_font_size(size * self.scale)
            .with_text_baseline(Baseline::Middle)
    }

    pub fn display_paint(&self, size: f32, color: Color) -> Paint {
        Paint::color(color)
            .with_font(&[self.fonts.display])
            .with_font_size(size * self.scale)
            .with_text_baseline(Baseline::Middle)
    }

    pub fn stroke(&self, color: Color, width: f32) -> Paint {
        Paint::color(color).with_line_width(width.max(0.6)).with_anti_alias(true)
    }
}

/// Панель модуля: полупрозрачный фон, тонкая рамка и уголки в двух углах.
pub fn panel(ctx: &mut Ctx, x: f32, y: f32, width: f32, height: f32, alpha: f32) {
    let mut background = Path::new();
    background.rect(x, y, width, height);
    ctx.canvas.fill_path(
        &background,
        &Paint::color(Color::rgbaf(0.027, 0.071, 0.098, 0.66 * alpha)),
    );

    let edge = with_alpha(ctx.accent, 0.16 * alpha);
    ctx.canvas.stroke_path(&background, &ctx.stroke(edge, 1.0));

    // Уголки: вертикальный акцент, который держит всю композицию.
    let arm = 11.0 * ctx.scale;
    let bright = with_alpha(ctx.accent, 0.85 * alpha);

    let mut corners = Path::new();
    corners.move_to(x, y + arm);
    corners.line_to(x, y);
    corners.line_to(x + arm, y);
    corners.move_to(x + width, y + height - arm);
    corners.line_to(x + width, y + height);
    corners.line_to(x + width - arm, y + height);
    ctx.canvas.stroke_path(&corners, &ctx.stroke(bright, 1.2));
}

/// Заголовок модуля с тонкой линией под ним.
pub fn panel_title(ctx: &mut Ctx, x: f32, y: f32, width: f32, title: &str, tag: &str, alpha: f32) {
    let paint = ctx
        .display_paint(11.0, with_alpha(ctx.accent, alpha))
        .with_letter_spacing(2.2 * ctx.scale);
    let _ = ctx.canvas.fill_text(x, y, title, &paint);

    if !tag.is_empty() {
        let tag_paint = ctx
            .label_paint(9.0, with_alpha(theme::STEEL, 0.7 * alpha))
            .with_text_align(Align::Right);
        let _ = ctx.canvas.fill_text(x + width, y, tag, &tag_paint);
    }

    let mut line = Path::new();
    line.move_to(x, y + 8.0 * ctx.scale);
    line.line_to(x + width, y + 8.0 * ctx.scale);
    ctx.canvas.stroke_path(&line, &ctx.stroke(with_alpha(ctx.accent, 0.16 * alpha), 1.0));
}

/// Обрезает слишком длинное значение, чтобы оно не налезло на подпись.
fn clip_to(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    text.chars().take(limit.saturating_sub(1)).collect::<String>() + "…"
}

/// Строка «подпись — значение».
pub fn row(ctx: &mut Ctx, x: f32, y: f32, width: f32, label: &str, value: &str, color: Color, alpha: f32) {
    let label_paint = ctx.label_paint(10.5, with_alpha(theme::STEEL, alpha));
    let _ = ctx.canvas.fill_text(x, y, label, &label_paint);

    // На строку приходится примерно ширина/6 символов моноширинного шрифта,
    // из них часть занимает подпись слева.
    let budget = ((width / (6.2 * ctx.scale)) as usize).saturating_sub(label.chars().count() + 1);
    let value_paint = ctx
        .label_paint(10.5, with_alpha(color, alpha))
        .with_text_align(Align::Right);
    let _ = ctx.canvas.fill_text(x + width, y, clip_to(value, budget.max(4)), &value_paint);
}

/// Горизонтальная шкала заполнения.
pub fn meter(ctx: &mut Ctx, x: f32, y: f32, width: f32, height: f32, fill: f32, color: Color, alpha: f32) {
    let mut frame = Path::new();
    frame.rect(x, y, width, height);
    ctx.canvas.fill_path(&frame, &Paint::color(with_alpha(ctx.accent, 0.08 * alpha)));
    ctx.canvas.stroke_path(&frame, &ctx.stroke(with_alpha(ctx.accent, 0.18 * alpha), 1.0));

    let filled = (width * fill.clamp(0.0, 1.0)).max(0.0);
    if filled > 0.5 {
        let mut bar = Path::new();
        bar.rect(x, y, filled, height);
        let paint = Paint::linear_gradient(
            x,
            y,
            x + width,
            y,
            with_alpha(color, 0.45 * alpha),
            with_alpha(color, alpha),
        );
        ctx.canvas.fill_path(&bar, &paint);
    }
}

/// Круглый датчик с засечками по кругу и числом в центре.
pub fn dial(
    ctx: &mut Ctx,
    cx: f32,
    cy: f32,
    radius: f32,
    fill: f32,
    value: &str,
    caption: &str,
    color: Color,
    alpha: f32,
) {
    let ticks = 30;
    for index in 0..ticks {
        let angle = index as f32 / ticks as f32 * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
        let long = index % 5 == 0;
        let outer = radius * 1.16;
        let inner = radius * if long { 1.05 } else { 1.09 };
        let mut tick = Path::new();
        tick.move_to(cx + angle.cos() * inner, cy + angle.sin() * inner);
        tick.line_to(cx + angle.cos() * outer, cy + angle.sin() * outer);
        let tick_alpha = if long { 0.5 } else { 0.22 };
        ctx.canvas.stroke_path(&tick, &ctx.stroke(with_alpha(ctx.accent, tick_alpha * alpha), 1.0));
    }

    let mut track = Path::new();
    track.circle(cx, cy, radius);
    ctx.canvas.stroke_path(&track, &ctx.stroke(with_alpha(ctx.accent, 0.12 * alpha), radius * 0.13));

    let share = fill.clamp(0.0, 1.0);
    if share > 0.001 {
        let start = -std::f32::consts::FRAC_PI_2;
        let mut arc = Path::new();
        arc.arc(cx, cy, radius, start, start + share * std::f32::consts::TAU, Solidity::Hole);
        ctx.canvas.stroke_path(&arc, &ctx.stroke(with_alpha(color, alpha), radius * 0.13));
    }

    let value_paint = ctx
        .display_paint(radius * 0.44, with_alpha(theme::TEXT, alpha))
        .with_text_align(Align::Center);
    let _ = ctx.canvas.fill_text(cx, cy - radius * 0.08, value, &value_paint);

    let caption_paint = ctx
        .label_paint(radius * 0.24, with_alpha(theme::STEEL, alpha))
        .with_text_align(Align::Center)
        .with_letter_spacing(1.4 * ctx.scale);
    let _ = ctx.canvas.fill_text(cx, cy + radius * 0.34, caption, &caption_paint);
}

/// График по истории значений: заливка, линия и яркая последняя точка.
pub fn spark(
    ctx: &mut Ctx,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    values: &[f32],
    maximum: Option<f32>,
    alpha: f32,
) {
    if values.len() < 2 {
        return;
    }

    let peak = maximum.unwrap_or_else(|| values.iter().cloned().fold(1.0, f32::max)).max(1.0);
    let step = width / (values.len() - 1) as f32;

    let point = |index: usize, value: f32| {
        let px = x + index as f32 * step;
        let py = y + height - (value / peak).clamp(0.0, 1.0) * height;
        (px, py)
    };

    let mut line = Path::new();
    for (index, value) in values.iter().enumerate() {
        let (px, py) = point(index, *value);
        if index == 0 {
            line.move_to(px, py);
        } else {
            line.line_to(px, py);
        }
    }

    let mut area = line.clone();
    area.line_to(x + width, y + height);
    area.line_to(x, y + height);
    area.close();
    ctx.canvas.fill_path(&area, &Paint::color(with_alpha(ctx.accent, 0.10 * alpha)));
    ctx.canvas.stroke_path(&line, &ctx.stroke(with_alpha(ctx.accent, 0.85 * alpha), 1.3));

    let (last_x, last_y) = point(values.len() - 1, *values.last().unwrap());
    let mut head = Path::new();
    head.circle(last_x, last_y, 1.9 * ctx.scale);
    ctx.canvas.fill_path(&head, &Paint::color(with_alpha(Color::white(), 0.9 * alpha)));

    let mut base = Path::new();
    base.move_to(x, y + height);
    base.line_to(x + width, y + height);
    ctx.canvas.stroke_path(&base, &ctx.stroke(with_alpha(ctx.accent, 0.16 * alpha), 1.0));
}

/// Вертикальная колонка заполнения — для накопителя.
pub fn column(ctx: &mut Ctx, x: f32, y: f32, width: f32, height: f32, fill: f32, alpha: f32) {
    let mut frame = Path::new();
    frame.rect(x, y, width, height);
    ctx.canvas.fill_path(&frame, &Paint::color(with_alpha(ctx.accent, 0.06 * alpha)));
    ctx.canvas.stroke_path(&frame, &ctx.stroke(with_alpha(ctx.accent, 0.18 * alpha), 1.0));

    let filled = height * fill.clamp(0.0, 1.0);
    if filled > 0.5 {
        let mut bar = Path::new();
        bar.rect(x, y + height - filled, width, filled);
        let paint = Paint::linear_gradient(
            x,
            y + height,
            x,
            y,
            with_alpha(ctx.accent, 0.4 * alpha),
            with_alpha(ctx.accent, alpha),
        );
        ctx.canvas.fill_path(&bar, &paint);
    }
}
