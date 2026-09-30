//! Отрисовка кадра: фон, реактор, модули, связи и анимация запуска.

use femtovg::{Align, Color, Paint, Path, Solidity};

use super::theme::{self, with_alpha};
use super::widgets::{self, Ctx};
use super::{Element, Hud, ModuleId, Slot, MODULES};
use crate::clock;
use crate::monitors::Monitor;
use crate::sys::{Sample, StaticInfo};
use crate::text::{Canvas, Fonts};

struct Placed {
    id: ModuleId,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    elements: Vec<Element>,
}

fn overlaps(a: (f32, f32, f32, f32), b: (f32, f32, f32, f32), gap: f32) -> bool {
    !(a.0 + a.2 + gap <= b.0 || a.0 >= b.0 + b.2 + gap || a.1 + a.3 + gap <= b.1 || a.1 >= b.1 + b.3 + gap)
}

/// Ставит модуль в свободное место, сдвигая его по направлению стека.
fn place_avoiding(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    direction: f32,
    gap: f32,
    occupied: &[(f32, f32, f32, f32)],
    limit: (f32, f32),
) -> (f32, f32) {
    let mut candidate = y;
    for _ in 0..40 {
        let box_ = (x, candidate, width, height);
        let Some(clash) = occupied.iter().find(|other| overlaps(box_, **other, gap * 0.5)) else {
            break;
        };
        candidate = if direction > 0.0 {
            clash.1 + clash.3 + gap
        } else {
            clash.1 - height - gap
        };
        if candidate < limit.0 || candidate + height > limit.1 {
            candidate = y;
            break;
        }
    }
    (x, candidate)
}

impl Hud {
    fn layout(
        &self,
        monitor: &Monitor,
        sample: &Sample,
        info: &StaticInfo,
        scale: f32,
    ) -> Vec<Placed> {
        let pad = 44.0 * scale;
        let gap = 12.0 * scale;
        let icon_margin = self.config.icon_margin;

        let left = monitor.work_left as f32 + pad.max(icon_margin);
        let right = monitor.work_left as f32 + monitor.work_width as f32 - pad;
        let top = monitor.work_top as f32 + pad * 1.15;
        let bottom = monitor.work_top as f32 + monitor.work_height as f32 - pad * 0.5;

        let mut prepared: Vec<(ModuleId, Vec<Element>, f32, f32)> = Vec::new();
        for id in MODULES {
            if self.config.is_hidden(id.key()) {
                continue;
            }
            if id.needs_gpu() && info.gpu_name.is_none() {
                continue;
            }
            let elements = self.elements(id, sample, info, scale, monitor);
            let (width, height) = self.module_size(id, &elements, scale);
            if width <= 0.0 || height <= 0.0 {
                continue;
            }
            prepared.push((id, elements, width, height));
        }

        let mut occupied: Vec<(f32, f32, f32, f32)> = Vec::new();
        let mut placed: Vec<Placed> = Vec::new();
        let limits = (monitor.work_top as f32, monitor.work_top as f32 + monitor.work_height as f32);

        // Модули, поставленные вручную, занимают места первыми; остальные их обходят.
        let region_w = monitor.width as f32;
        let region_h = monitor.height as f32;
        let mut automatic = Vec::with_capacity(prepared.len());
        for (id, elements, width, height) in prepared {
            let key = super::edit::position_key(&monitor.key, id.key());
            match self.config.positions.get(&key) {
                Some([fx, fy]) => {
                    let x = (fx * region_w).clamp(0.0, (region_w - width).max(0.0));
                    let y = (fy * region_h).clamp(0.0, (region_h - height).max(0.0));
                    occupied.push((x, y, width, height));
                    placed.push(Placed { id, x, y, width, height, elements });
                }
                None => automatic.push((id, elements, width, height)),
            }
        }
        let prepared = automatic;

        // Колонки: сверху вниз, снизу вверх и по центру высоты.
        let mut cursor_tl = top;
        let mut cursor_tl2 = top;
        let mut cursor_tr = top;
        let mut cursor_bl = bottom;
        let mut cursor_br = bottom;

        let middle_height = |slot: Slot, prepared: &Vec<(ModuleId, Vec<Element>, f32, f32)>| -> f32 {
            let items: Vec<_> = prepared.iter().filter(|(id, _, _, _)| id.slot() == slot).collect();
            let total: f32 = items.iter().map(|(_, _, _, h)| h).sum();
            total + gap * (items.len().max(1) - 1) as f32
        };

        let mut cursor_lm =
            monitor.work_top as f32 + (monitor.work_height as f32 - middle_height(Slot::LeftMiddle, &prepared)) / 2.0;
        let mut cursor_rm =
            monitor.work_top as f32 + (monitor.work_height as f32 - middle_height(Slot::RightMiddle, &prepared)) / 2.0;

        let center_width = |slot: Slot, prepared: &Vec<(ModuleId, Vec<Element>, f32, f32)>| -> f32 {
            let items: Vec<_> = prepared.iter().filter(|(id, _, _, _)| id.slot() == slot).collect();
            let total: f32 = items.iter().map(|(_, _, w, _)| w).sum();
            total + gap * (items.len().max(1) - 1) as f32
        };

        let mut cursor_tc = left + (right - left - center_width(Slot::TopCenter, &prepared)) / 2.0;
        let mut cursor_bc = left + (right - left - center_width(Slot::BottomCenter, &prepared)) / 2.0;

        let column_width_tl: f32 = prepared
            .iter()
            .filter(|(id, _, _, _)| id.slot() == Slot::TopLeft)
            .map(|(_, _, w, _)| *w)
            .fold(0.0, f32::max);

        for (id, elements, width, height) in prepared {
            let (x, y) = match id.slot() {
                Slot::TopLeft => {
                    let spot = place_avoiding(left, cursor_tl, width, height, 1.0, gap, &occupied, limits);
                    cursor_tl = spot.1 + height + gap;
                    spot
                }
                Slot::TopLeft2 => {
                    let x = left + column_width_tl + gap;
                    let spot = place_avoiding(x, cursor_tl2, width, height, 1.0, gap, &occupied, limits);
                    cursor_tl2 = spot.1 + height + gap;
                    spot
                }
                Slot::LeftMiddle => {
                    let spot = place_avoiding(left, cursor_lm, width, height, 1.0, gap, &occupied, limits);
                    cursor_lm = spot.1 + height + gap;
                    spot
                }
                Slot::TopRight => {
                    let spot =
                        place_avoiding(right - width, cursor_tr, width, height, 1.0, gap, &occupied, limits);
                    cursor_tr = spot.1 + height + gap;
                    spot
                }
                Slot::RightMiddle => {
                    let spot =
                        place_avoiding(right - width, cursor_rm, width, height, 1.0, gap, &occupied, limits);
                    cursor_rm = spot.1 + height + gap;
                    spot
                }
                Slot::BottomLeft => {
                    let spot =
                        place_avoiding(left, cursor_bl - height, width, height, -1.0, gap, &occupied, limits);
                    cursor_bl = spot.1 - gap;
                    spot
                }
                Slot::BottomRight => {
                    let spot = place_avoiding(
                        right - width,
                        cursor_br - height,
                        width,
                        height,
                        -1.0,
                        gap,
                        &occupied,
                        limits,
                    );
                    cursor_br = spot.1 - gap;
                    spot
                }
                Slot::TopCenter => {
                    let spot = (cursor_tc, top);
                    cursor_tc += width + gap;
                    spot
                }
                Slot::BottomCenter => {
                    let spot = (cursor_bc, bottom - height);
                    cursor_bc += width + gap;
                    spot
                }
            };

            occupied.push((x, y, width, height));
            placed.push(Placed { id, x, y, width, height, elements });
        }

        placed
    }

    pub fn draw_frame(
        &mut self,
        canvas: &mut Canvas,
        fonts: &Fonts,
        monitors: &[Monitor],
        sample: &Sample,
        info: &StaticInfo,
        seconds: f32,
        width: f32,
        height: f32,
    ) {
        let accent = self.accent();
        // Полностью прозрачный кадр: обои и значки рабочего стола остаются видны,
        // а панели HUD сами задают свою плотность.
        canvas.clear_rect(0, 0, width as u32, height as u32, Color::rgbaf(0.0, 0.0, 0.0, 0.0));
        self.seed_motes(width, height);
        self.module_rects.clear();
        self.edit_buttons.clear();
        let pointer = self.pointer_position();

        // Раскрытие в начале: содержимое проявляется из горизонтальной полосы.
        let open = if self.config.boot_animation { self.boot.sweep_open() } else { 1.0 };

        for monitor in monitors {
            if self.config.disabled_monitors.iter().any(|key| key == &monitor.key) {
                continue;
            }

            let scale = (monitor.height as f32 / 1080.0).clamp(0.8, 2.5) * monitor.scale;
            let region_x = monitor.left as f32;
            let region_y = monitor.top as f32;
            let region_w = monitor.width as f32;
            let region_h = monitor.height as f32;

            canvas.save();
            canvas.translate(region_x, region_y);
            canvas.scissor(0.0, 0.0, region_w, region_h);

            let mut ctx = Ctx { canvas, fonts, scale, accent };
            background(&mut ctx, region_w, region_h, &self.config, open);

            for mote in &self.motes {
                if mote.x > region_w || mote.y > region_h {
                    continue;
                }
                let mut dot = Path::new();
                dot.circle(mote.x, mote.y.rem_euclid(region_h), mote.radius * scale);
                ctx.canvas
                    .fill_path(&dot, &Paint::color(with_alpha(accent, mote.alpha * open)));
            }

            let placed = self.layout(monitor, sample, info, scale);

            // Линии связи: разбегаются от центра во время запуска.
            let center = (region_w / 2.0, region_h / 2.0 - region_h * 0.02);
            let link_progress = if self.config.boot_animation { self.boot.links() } else { 1.0 };
            if link_progress > 0.01 {
                for module in &placed {
                    let target = (module.x + module.width / 2.0, module.y + module.height / 2.0);
                    let end = (
                        center.0 + (target.0 - center.0) * link_progress,
                        center.1 + (target.1 - center.1) * link_progress,
                    );
                    let mut line = Path::new();
                    line.move_to(center.0, center.1);
                    line.line_to(end.0, end.1);
                    ctx.canvas
                        .stroke_path(&line, &ctx.stroke(with_alpha(accent, 0.14 * open), 1.0));

                    // Пакет бежит к модулю: скорость зависит от сетевого трафика.
                    let flow = 0.08 + (sample.net_down_kbs / 3000.0).min(1.0) * 0.5;
                    let position = (seconds * flow).fract();
                    let px = center.0 + (target.0 - center.0) * position;
                    let py = center.1 + (target.1 - center.1) * position;
                    let mut packet = Path::new();
                    packet.circle(px, py, 1.8 * scale);
                    ctx.canvas.fill_path(
                        &packet,
                        &Paint::color(with_alpha(Color::rgbf(0.67, 0.96, 1.0), 0.8 * link_progress * open)),
                    );
                }
            }

            if self.config.reactor {
                reactor(&mut ctx, center.0, center.1, region_h * 0.2, sample, &self.boot, self.config.boot_animation, seconds, open);
            }

            chrome(&mut ctx, region_w, region_h, monitor, &self.config, open, self.boot.title());

            for (index, module) in placed.iter().enumerate() {
                let appear = if self.config.boot_animation { self.boot.module(index) } else { 1.0 };
                if appear <= 0.001 {
                    continue;
                }
                draw_module(&mut ctx, module, appear * open, &self.boot, self.config.boot_animation);
            }

            if self.edit_mode {
                // Затемнение нужно и для попадания мышью: слоистое окно
                // пропускает щелчки сквозь полностью прозрачные пиксели.
                let mut shade = Path::new();
                shade.rect(0.0, 0.0, region_w, region_h);
                ctx.canvas.fill_path(&shade, &Paint::color(Color::rgbaf(0.0, 0.02, 0.04, 0.22)));

                let local_pointer = (pointer.0 - region_x, pointer.1 - region_y);
                for module in &placed {
                    let key = module.id.key();
                    let active = self.is_dragging(&monitor.key, key);
                    let hovered = local_pointer.0 >= module.x
                        && local_pointer.0 <= module.x + module.width
                        && local_pointer.1 >= module.y
                        && local_pointer.1 <= module.y + module.height;
                    super::edit::outline(&mut ctx, module.x, module.y, module.width, module.height, active, hovered);
                    self.module_rects.push(super::edit::ModuleRect {
                        monitor_key: monitor.key.clone(),
                        key,
                        x: module.x + region_x,
                        y: module.y + region_y,
                        width: module.width,
                        height: module.height,
                        region: [region_x, region_y, region_w, region_h],
                    });
                }

                let buttons = super::edit::banner(&mut ctx, region_w, region_h * 0.74, local_pointer);
                for (button, rect) in buttons {
                    self.edit_buttons
                        .push((button, [rect[0] + region_x, rect[1] + region_y, rect[2], rect[3]]));
                }
            }

            // Финальная полоса сканирования проходит сверху вниз один раз.
            let scan = if self.config.boot_animation { self.boot.final_scan() } else { 1.0 };
            if scan > 0.0 && scan < 1.0 {
                let y = scan * region_h;
                let band = region_h * 0.06;
                let mut sweep = Path::new();
                sweep.rect(0.0, y - band, region_w, band * 2.0);
                let paint = Paint::linear_gradient(
                    0.0,
                    y - band,
                    0.0,
                    y + band,
                    with_alpha(accent, 0.0),
                    with_alpha(accent, 0.16),
                );
                ctx.canvas.fill_path(&sweep, &paint);
            }

            ctx.canvas.reset_scissor();
            ctx.canvas.restore();
        }
    }
}

fn background(ctx: &mut Ctx, width: f32, height: f32, config: &crate::config::Config, open: f32) {
    let mut base = Path::new();
    base.rect(0.0, 0.0, width, height);
    // Лёгкое затемнение к центру: HUD читается поверх любых обоев.
    let glow = Paint::radial_gradient(
        width / 2.0,
        height * 0.44,
        0.0,
        height * 0.75,
        Color::rgbaf(0.02, 0.06, 0.09, 0.55 * open),
        Color::rgbaf(0.01, 0.02, 0.04, 0.78 * open),
    );
    ctx.canvas.fill_path(&base, &glow);

    if config.grid {
        let step = 44.0 * ctx.scale;
        let mut grid = Path::new();
        let mut x = 0.0;
        while x < width {
            grid.move_to(x, 0.0);
            grid.line_to(x, height);
            x += step;
        }
        let mut y = 0.0;
        while y < height {
            grid.move_to(0.0, y);
            grid.line_to(width, y);
            y += step;
        }
        ctx.canvas
            .stroke_path(&grid, &ctx.stroke(with_alpha(ctx.accent, 0.05 * open), 1.0));
    }
}

/// Рамка по краям, линейка сверху и подпись монитора.
fn chrome(
    ctx: &mut Ctx,
    width: f32,
    height: f32,
    monitor: &Monitor,
    config: &crate::config::Config,
    open: f32,
    title_progress: f32,
) {
    let accent = ctx.accent;

    if config.frame {
        let arm = 34.0 * ctx.scale;
        let inset = 18.0 * ctx.scale;
        let mut corners = Path::new();
        corners.move_to(inset, inset + arm);
        corners.line_to(inset, inset);
        corners.line_to(inset + arm, inset);
        corners.move_to(width - inset - arm, inset);
        corners.line_to(width - inset, inset);
        corners.line_to(width - inset, inset + arm);
        corners.move_to(inset, height - inset - arm);
        corners.line_to(inset, height - inset);
        corners.line_to(inset + arm, height - inset);
        corners.move_to(width - inset - arm, height - inset);
        corners.line_to(width - inset, height - inset);
        corners.line_to(width - inset, height - inset - arm);
        ctx.canvas
            .stroke_path(&corners, &ctx.stroke(with_alpha(accent, 0.25 * open), 1.2));
    }

    // Линейка сверху: деления и редкие номера.
    let ruler_y = 26.0 * ctx.scale;
    let start = config.icon_margin.max(40.0 * ctx.scale);
    let end = width - 40.0 * ctx.scale;
    let steps = 28;
    let mut ticks = Path::new();
    for index in 0..=steps {
        let x = start + (end - start) * index as f32 / steps as f32;
        let long = index % 4 == 0;
        ticks.move_to(x, ruler_y);
        ticks.line_to(x, ruler_y - if long { 10.0 } else { 5.0 } * ctx.scale);
    }
    ticks.move_to(start, ruler_y);
    ticks.line_to(end, ruler_y);
    ctx.canvas
        .stroke_path(&ticks, &ctx.stroke(with_alpha(accent, 0.18 * open), 1.0));

    let head = format!(
        "J.A.R.V.I.S. · МОНИТОР {}{}",
        monitor.index,
        if monitor.primary { " · ОСНОВНОЙ" } else { "" }
    );
    let paint = ctx
        .display_paint(11.5, with_alpha(accent, title_progress.max(0.0) * open))
        .with_letter_spacing(3.0 * ctx.scale);
    let _ = ctx.canvas.fill_text(start, ruler_y + 18.0 * ctx.scale, &head, &paint);

    let meta = format!("{}×{} · {} ГЦ", monitor.width, monitor.height, monitor.hz);
    let meta_paint = ctx
        .label_paint(10.0, with_alpha(theme::STEEL, 0.8 * open))
        .with_text_align(Align::Right);
    let _ = ctx.canvas.fill_text(end, ruler_y + 18.0 * ctx.scale, &meta, &meta_paint);
}

/// Реактор: кольца, засечки и часы. Во время запуска кольцо собирается по дуге.
fn reactor(
    ctx: &mut Ctx,
    cx: f32,
    cy: f32,
    radius: f32,
    sample: &Sample,
    boot: &theme::Boot,
    animate: bool,
    seconds: f32,
    open: f32,
) {
    let accent = ctx.accent;
    let build = if animate { boot.reactor() } else { 1.0 };
    if build <= 0.001 {
        return;
    }

    // Засечки по кругу: загораются пропорционально загрузке процессора.
    let ticks = 60;
    let hot = (sample.cpu / 100.0 * ticks as f32) as usize;
    for index in 0..ticks {
        if (index as f32 / ticks as f32) > build {
            continue;
        }
        let angle = index as f32 / ticks as f32 * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
        let long = index % 5 == 0;
        let inner = radius * 1.12;
        let outer = radius * if long { 1.24 } else { 1.19 };
        let mut tick = Path::new();
        tick.move_to(cx + angle.cos() * inner, cy + angle.sin() * inner);
        tick.line_to(cx + angle.cos() * outer, cy + angle.sin() * outer);
        let lit = index < hot;
        let color = if lit { accent } else { with_alpha(accent, 0.3) };
        ctx.canvas.stroke_path(&tick, &ctx.stroke(with_alpha(color, open), 1.2));
    }

    let mut track = Path::new();
    track.circle(cx, cy, radius);
    ctx.canvas
        .stroke_path(&track, &ctx.stroke(with_alpha(accent, 0.12 * open), 2.5));

    // Дуга загрузки процессора.
    let start = -std::f32::consts::FRAC_PI_2;
    let span = (sample.cpu / 100.0).clamp(0.0, 1.0) * std::f32::consts::TAU * build;
    if span > 0.01 {
        let mut arc = Path::new();
        arc.arc(cx, cy, radius, start, start + span, Solidity::Hole);
        ctx.canvas.stroke_path(&arc, &ctx.stroke(with_alpha(accent, open), 2.5));
    }

    // Внутреннее кольцо оперативной памяти и вращающийся штрих.
    let mut inner = Path::new();
    inner.circle(cx, cy, radius * 0.78);
    ctx.canvas
        .stroke_path(&inner, &ctx.stroke(with_alpha(accent, 0.14 * open), 1.5));

    let ram_span = (sample.ram_percent / 100.0).clamp(0.0, 1.0) * std::f32::consts::TAU * build;
    if ram_span > 0.01 {
        let mut arc = Path::new();
        arc.arc(cx, cy, radius * 0.78, start, start + ram_span, Solidity::Hole);
        ctx.canvas
            .stroke_path(&arc, &ctx.stroke(with_alpha(accent, 0.6 * open), 1.5));
    }

    let spin = seconds * 0.35;
    let mut dashes = Path::new();
    for index in 0..12 {
        let angle = spin + index as f32 / 12.0 * std::f32::consts::TAU;
        let r0 = radius * 0.6;
        let r1 = radius * 0.66;
        dashes.move_to(cx + angle.cos() * r0, cy + angle.sin() * r0);
        dashes.line_to(cx + angle.cos() * r1, cy + angle.sin() * r1);
    }
    ctx.canvas
        .stroke_path(&dashes, &ctx.stroke(with_alpha(accent, 0.5 * build * open), 1.4));

    // Мягкое свечение ядра, пульс зависит от нагрузки.
    let pulse = 0.85 + (seconds * (1.6 + sample.cpu / 60.0)).sin() * 0.15;
    let mut core = Path::new();
    core.circle(cx, cy, radius * 0.55 * pulse);
    let glow = Paint::radial_gradient(
        cx,
        cy,
        0.0,
        radius * 0.55 * pulse,
        with_alpha(accent, 0.22 * build * open),
        with_alpha(accent, 0.0),
    );
    ctx.canvas.fill_path(&core, &glow);

    let now = clock::now();
    let time = format!("{:02}:{:02}", now.hour, now.minute);
    let clock_paint = ctx
        .display_paint(radius * 0.42, with_alpha(theme::TEXT, build * open))
        .with_text_align(Align::Center);
    let _ = ctx.canvas.fill_text(cx, cy, &time, &clock_paint);

    let seconds_paint = ctx
        .display_paint(radius * 0.16, with_alpha(accent, build * open))
        .with_text_align(Align::Left);
    let _ = ctx.canvas.fill_text(
        cx + radius * 0.44,
        cy - radius * 0.16,
        &format!("{:02}", now.second),
        &seconds_paint,
    );

    let date = format!(
        "{} {} {} {}",
        super::WEEKDAYS[now.weekday],
        now.day,
        super::MONTHS[now.month],
        now.year
    );
    let date_paint = ctx
        .label_paint(radius * 0.12, with_alpha(theme::STEEL, build * open))
        .with_text_align(Align::Center)
        .with_letter_spacing(2.0 * ctx.scale);
    let _ = ctx.canvas.fill_text(cx, cy + radius * 0.3, &date, &date_paint);
}

fn draw_module(ctx: &mut Ctx, module: &Placed, alpha: f32, boot: &theme::Boot, animate: bool) {
    let scale = ctx.scale;
    let inset = 12.0 * scale;
    let content_width = module.width - inset * 2.0;

    if module.id == ModuleId::DateRing {
        date_ring(ctx, module, alpha);
        return;
    }

    let mut cursor = module.y + inset;
    if !module.id.bare() {
        widgets::panel(ctx, module.x, module.y, module.width, module.height, alpha);
        widgets::panel_title(ctx, module.x + inset, cursor + 4.0 * scale, content_width, module.id.title(), "", alpha);
        cursor += 24.0 * scale;
    }

    let dial_progress = if animate { boot.dials() } else { 1.0 };

    for element in &module.elements {
        let height = Hud::element_height(element, scale);
        match element {
            Element::Row { label, value, color } => {
                widgets::row(
                    ctx,
                    module.x + inset,
                    cursor + height * 0.5,
                    content_width,
                    label,
                    value,
                    *color,
                    alpha,
                );
            }
            Element::Meter { label, value, fill, color } => {
                widgets::row(
                    ctx,
                    module.x + inset,
                    cursor + 6.0 * scale,
                    content_width,
                    label,
                    value,
                    *color,
                    alpha,
                );
                widgets::meter(
                    ctx,
                    module.x + inset,
                    cursor + 13.0 * scale,
                    content_width,
                    5.0 * scale,
                    fill * dial_progress,
                    *color,
                    alpha,
                );
            }
            Element::Spark { values, max } => {
                widgets::spark(
                    ctx,
                    module.x + inset,
                    cursor + 4.0 * scale,
                    content_width,
                    height - 8.0 * scale,
                    values,
                    *max,
                    alpha,
                );
            }
            Element::Dials { items, radius } => {
                let gap = radius * 0.8;
                let total = items.len() as f32 * radius * 2.0 + (items.len().max(1) - 1) as f32 * gap;
                let mut x = module.x + (module.width - total) / 2.0 + radius;
                for dial in items {
                    widgets::dial(
                        ctx,
                        x,
                        cursor + radius * 1.2,
                        *radius,
                        dial.fill * dial_progress,
                        &dial.value,
                        &dial.caption,
                        dial.color,
                        alpha,
                    );
                    x += radius * 2.0 + gap;
                }
            }
            Element::Column { fill, facts } => {
                widgets::column(
                    ctx,
                    module.x + inset,
                    cursor + 2.0 * scale,
                    14.0 * scale,
                    height - 8.0 * scale,
                    fill * dial_progress,
                    alpha,
                );
                let mut fact_y = cursor + 10.0 * scale;
                for (label, value) in facts {
                    widgets::row(
                        ctx,
                        module.x + inset + 22.0 * scale,
                        fact_y,
                        content_width - 22.0 * scale,
                        label,
                        value,
                        theme::TEXT,
                        alpha,
                    );
                    fact_y += 15.0 * scale;
                }
            }
        }
        cursor += height;
    }
}

/// Кольцо даты: месяц, число и день недели внутри дуги месяца.
fn date_ring(ctx: &mut Ctx, module: &Placed, alpha: f32) {
    let cx = module.x + module.width / 2.0;
    let cy = module.y + module.height / 2.0;
    let radius = module.width * 0.42;
    let accent = ctx.accent;

    let mut outer = Path::new();
    outer.circle(cx, cy, radius * 1.12);
    ctx.canvas
        .stroke_path(&outer, &ctx.stroke(with_alpha(accent, 0.35 * alpha), 1.0));

    let mut track = Path::new();
    track.circle(cx, cy, radius);
    ctx.canvas
        .stroke_path(&track, &ctx.stroke(with_alpha(accent, 0.14 * alpha), 4.0 * ctx.scale));

    let now = clock::now();
    let progress = clock::month_progress(&now);
    let start = -std::f32::consts::FRAC_PI_2;
    let mut arc = Path::new();
    arc.arc(cx, cy, radius, start, start + progress * std::f32::consts::TAU, Solidity::Hole);
    ctx.canvas
        .stroke_path(&arc, &ctx.stroke(with_alpha(accent, alpha), 4.0 * ctx.scale));

    let month_paint = ctx
        .display_paint(12.0, with_alpha(accent, alpha))
        .with_text_align(Align::Center)
        .with_letter_spacing(2.0 * ctx.scale);
    let _ = ctx
        .canvas
        .fill_text(cx, cy - radius * 0.42, super::MONTHS[now.month], &month_paint);

    let day_paint = ctx
        .display_paint(42.0, with_alpha(theme::TEXT, alpha))
        .with_text_align(Align::Center);
    let _ = ctx.canvas.fill_text(cx, cy + radius * 0.05, &now.day.to_string(), &day_paint);

    let weekday_paint = ctx
        .label_paint(10.0, with_alpha(theme::STEEL, alpha))
        .with_text_align(Align::Center)
        .with_letter_spacing(3.0 * ctx.scale);
    let _ = ctx
        .canvas
        .fill_text(cx, cy + radius * 0.55, super::WEEKDAYS[now.weekday], &weekday_paint);
}
