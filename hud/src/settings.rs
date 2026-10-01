//! Окно настроек в стиле HUD. Рисуется тем же движком, что и обои:
//! готовые библиотеки интерфейса на этом toolchain не собираются.

use std::cell::Cell;

use femtovg::{Align, Color, Paint, Path};

use crate::autostart;
use crate::config::Config;
use crate::gl_window::{GlWindow, WindowSpec};
use crate::hud::theme::{self, with_alpha, Boot};
use crate::hud::widgets::Ctx;
use crate::hud::{Hud, MODULES};
use crate::monitors::{self, Monitor};
use crate::win32::*;
use crate::lang::tr;

const WIDTH: u32 = 820;
const HEIGHT: u32 = 720;
const TITLE_HEIGHT: i32 = 48;

const ACCENTS: [[f32; 3]; 6] = [
    [0.361, 0.882, 1.0],
    [0.35, 0.55, 1.0],
    [0.30, 1.0, 0.80],
    [1.0, 0.70, 0.30],
    [1.0, 0.36, 0.36],
    [0.72, 0.50, 1.0],
];

thread_local! {
    static MOUSE: Cell<(f32, f32)> = const { Cell::new((-1.0, -1.0)) };
    static CLICK: Cell<Option<(f32, f32)>> = const { Cell::new(None) };
    static CLOSE: Cell<bool> = const { Cell::new(false) };
}

fn point_from(lparam: LPARAM) -> (i32, i32) {
    let x = (lparam & 0xFFFF) as u16 as i16 as i32;
    let y = ((lparam >> 16) & 0xFFFF) as u16 as i16 as i32;
    (x, y)
}

unsafe extern "system" fn settings_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_ERASEBKGND => 1,
            WM_MOUSEMOVE => {
                let (x, y) = point_from(lparam);
                MOUSE.with(|cell| cell.set((x as f32, y as f32)));
                0
            }
            WM_LBUTTONDOWN => {
                let (x, y) = point_from(lparam);
                CLICK.with(|cell| cell.set(Some((x as f32, y as f32))));
                0
            }
            WM_NCHITTEST => {
                // Верхняя полоса перетаскивает окно, кроме кнопки закрытия справа.
                let (x, y) = point_from(lparam);
                let mut rect = RECT::default();
                GetWindowRect(hwnd, &mut rect);
                let local_x = x - rect.left;
                let local_y = y - rect.top;
                if local_y < TITLE_HEIGHT && local_x < (rect.right - rect.left) - TITLE_HEIGHT {
                    HTCAPTION as LRESULT
                } else {
                    DefWindowProcW(hwnd, msg, wparam, lparam)
                }
            }
            WM_KEYDOWN => {
                if wparam == 0x1B {
                    CLOSE.with(|cell| cell.set(true));
                }
                0
            }
            // Закрытие только прячет окно: обои продолжают работать.
            WM_CLOSE => {
                CLOSE.with(|cell| cell.set(true));
                0
            }
            WM_DESTROY => 0,
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

pub enum Outcome {
    Stay,
    Quit,
    /// Включить режим расстановки модулей на обоях.
    EditLayout,
}

struct Ui<'a> {
    ctx: Ctx<'a>,
    mouse: (f32, f32),
    click: Option<(f32, f32)>,
}

impl<'a> Ui<'a> {
    fn inside(point: (f32, f32), x: f32, y: f32, width: f32, height: f32) -> bool {
        point.0 >= x && point.0 <= x + width && point.1 >= y && point.1 <= y + height
    }

    fn hovered(&self, x: f32, y: f32, width: f32, height: f32) -> bool {
        Self::inside(self.mouse, x, y, width, height)
    }

    /// Щелчок достаётся первому элементу под курсором.
    fn clicked(&mut self, x: f32, y: f32, width: f32, height: f32) -> bool {
        match self.click {
            Some(point) if Self::inside(point, x, y, width, height) => {
                self.click = None;
                true
            }
            _ => false,
        }
    }

    fn rect(&mut self, x: f32, y: f32, width: f32, height: f32, color: Color) {
        let mut path = Path::new();
        path.rect(x, y, width, height);
        self.ctx.canvas.fill_path(&path, &Paint::color(color));
    }

    fn outline(&mut self, x: f32, y: f32, width: f32, height: f32, color: Color, line: f32) {
        let mut path = Path::new();
        path.rect(x, y, width, height);
        let paint = self.ctx.stroke(color, line);
        self.ctx.canvas.stroke_path(&path, &paint);
    }

    fn line(&mut self, from: (f32, f32), to: (f32, f32), color: Color, width: f32) {
        let mut path = Path::new();
        path.move_to(from.0, from.1);
        path.line_to(to.0, to.1);
        let paint = self.ctx.stroke(color, width);
        self.ctx.canvas.stroke_path(&path, &paint);
    }

    fn text(&mut self, x: f32, y: f32, text: &str, size: f32, color: Color, display: bool, align: Align, spacing: f32) {
        let paint = if display { self.ctx.display_paint(size, color) } else { self.ctx.label_paint(size, color) }
            .with_text_align(align)
            .with_letter_spacing(spacing);
        let _ = self.ctx.canvas.fill_text(x, y, text, &paint);
    }

    fn section(&mut self, x: f32, y: f32, width: f32, title: &str) {
        let accent = self.ctx.accent;
        self.text(x, y, title, 11.0, accent, true, Align::Left, 2.6);
        self.line((x, y + 11.0), (x + width, y + 11.0), with_alpha(accent, 0.18), 1.0);
    }

    fn checkbox(&mut self, x: f32, y: f32, width: f32, label: &str, checked: bool) -> bool {
        let accent = self.ctx.accent;
        let height = 26.0;
        if self.hovered(x, y, width, height) {
            self.rect(x, y, width, height, with_alpha(accent, 0.07));
        }
        self.outline(x + 6.0, y + 5.0, 16.0, 16.0, with_alpha(accent, if checked { 1.0 } else { 0.45 }), 1.2);
        if checked {
            self.rect(x + 10.0, y + 9.0, 8.0, 8.0, accent);
        }
        self.text(x + 34.0, y + height / 2.0, label, 13.0, with_alpha(theme::TEXT, 0.92), false, Align::Left, 0.0);
        self.clicked(x, y, width, height)
    }

    fn segmented(&mut self, x: f32, y: f32, width: f32, height: f32, labels: &[&str], selected: usize) -> Option<usize> {
        let accent = self.ctx.accent;
        let cell = width / labels.len() as f32;
        let mut result = None;

        for (index, label) in labels.iter().enumerate() {
            let cell_x = x + index as f32 * cell;
            let active = index == selected;
            if active {
                self.rect(cell_x, y, cell, height, with_alpha(accent, 0.2));
            } else if self.hovered(cell_x, y, cell, height) {
                self.rect(cell_x, y, cell, height, with_alpha(accent, 0.07));
            }
            self.outline(
                cell_x + 0.5,
                y + 0.5,
                cell - 1.0,
                height - 1.0,
                with_alpha(accent, if active { 0.9 } else { 0.25 }),
                1.0,
            );
            let color = if active { theme::TEXT } else { with_alpha(accent, 0.8) };
            self.text(cell_x + cell / 2.0, y + height / 2.0, label, 12.0, color, true, Align::Center, 1.5);
            if self.clicked(cell_x, y, cell, height) {
                result = Some(index);
            }
        }
        result
    }

    fn swatch(&mut self, cx: f32, cy: f32, color: Color, selected: bool) -> bool {
        let mut dot = Path::new();
        dot.circle(cx, cy, 12.0);
        self.ctx.canvas.fill_path(&dot, &Paint::color(color));

        if selected || self.hovered(cx - 17.0, cy - 17.0, 34.0, 34.0) {
            let mut ring = Path::new();
            ring.circle(cx, cy, 17.0);
            let paint = self.ctx.stroke(with_alpha(Color::white(), if selected { 0.95 } else { 0.4 }), 1.5);
            self.ctx.canvas.stroke_path(&ring, &paint);
        }
        self.clicked(cx - 17.0, cy - 17.0, 34.0, 34.0)
    }

    fn button(&mut self, x: f32, y: f32, width: f32, height: f32, label: &str, danger: bool) -> bool {
        let tone = if danger { theme::RED } else { self.ctx.accent };
        let fill = if self.hovered(x, y, width, height) { 0.18 } else { 0.07 };
        self.rect(x, y, width, height, with_alpha(tone, fill));
        self.outline(x + 0.5, y + 0.5, width - 1.0, height - 1.0, with_alpha(tone, 0.7), 1.0);
        self.text(x + width / 2.0, y + height / 2.0, label, 12.0, tone, true, Align::Center, 1.8);
        self.clicked(x, y, width, height)
    }
}

fn sentence_case(text: &str) -> String {
    let lower = text.to_lowercase();
    let mut chars = lower.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn same_color(a: [f32; 3], b: [f32; 3]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 0.02)
}

fn flag_reactor(config: &mut Config) -> &mut bool {
    &mut config.reactor
}
fn flag_frame(config: &mut Config) -> &mut bool {
    &mut config.frame
}
fn flag_grid(config: &mut Config) -> &mut bool {
    &mut config.grid
}
fn flag_motes(config: &mut Config) -> &mut bool {
    &mut config.motes
}
fn flag_boot(config: &mut Config) -> &mut bool {
    &mut config.boot_animation
}

pub struct Settings {
    window: GlWindow,
    visible: bool,
    autostart: bool,
}

impl Settings {
    pub fn new(monitor_list: &[Monitor]) -> Self {
        let screen = monitors::virtual_screen();
        let primary = monitor_list.iter().find(|m| m.primary).or(monitor_list.first());
        let (x, y) = match primary {
            Some(m) => (
                screen.x + m.left + m.work_left + (m.work_width - WIDTH as i32) / 2,
                screen.y + m.top + m.work_top + (m.work_height - HEIGHT as i32) / 2,
            ),
            None => (100, 100),
        };

        let window = GlWindow::create(WindowSpec {
            class: "JarvisHudSettings",
            title: tr("Настройка J.A.R.V.I.S. HUD", "J.A.R.V.I.S. HUD settings"),
            proc: settings_proc,
            style: WS_POPUP | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            ex_style: WS_EX_APPWINDOW,
            x,
            y,
            width: WIDTH,
            height: HEIGHT,
            visible: false,
        });

        Self { window, visible: false, autostart: autostart::is_enabled() }
    }

    pub fn show(&mut self) {
        unsafe {
            ShowWindow(self.window.hwnd, SW_SHOW);
            SetForegroundWindow(self.window.hwnd);
        }
        self.visible = true;
        self.autostart = autostart::is_enabled();
    }

    fn hide(&mut self) {
        unsafe { ShowWindow(self.window.hwnd, SW_HIDE) };
        self.visible = false;
    }

    pub fn visible(&self) -> bool {
        self.visible
    }

    /// Кадр окна настроек: разбор щелчка, отрисовка, применение изменений.
    pub fn frame(&mut self, hud: &mut Hud, monitor_list: &[Monitor]) -> Outcome {
        let mouse = MOUSE.with(|cell| cell.get());
        let click = CLICK.with(|cell| cell.take());
        let escape = CLOSE.with(|cell| cell.replace(false));

        self.window.make_current();
        let (outcome, close) = self.draw(hud, monitor_list, mouse, click);
        self.window.present();

        if close || escape {
            self.hide();
        }
        outcome
    }

    /// Снимок окна настроек в PNG — для проверки вида без показа окна.
    pub fn render_png(monitor_list: &[Monitor], hud: &mut Hud, path: &str) {
        let mut settings = Settings::new(monitor_list);
        settings.window.make_current();
        let _ = settings.draw(hud, monitor_list, (-1.0, -1.0), None);
        settings.window.canvas.flush();
        settings.window.save_png(path);
    }

    fn draw(
        &mut self,
        hud: &mut Hud,
        monitor_list: &[Monitor],
        mouse: (f32, f32),
        click: Option<(f32, f32)>,
    ) -> (Outcome, bool) {
        let accent = hud.accent();
        let width = self.window.width as f32;
        let height = self.window.height as f32;
        let mut outcome = Outcome::Stay;
        let mut close = false;
        let mut autostart_on = self.autostart;

        {
            let canvas = &mut self.window.canvas;
            let fonts = &self.window.fonts;
            canvas.clear_rect(0, 0, WIDTH, HEIGHT, Color::rgbf(0.016, 0.035, 0.05));

            let mut ui = Ui { ctx: Ctx { canvas, fonts, scale: 1.0, accent }, mouse, click };

            // Рамка с уголками — как у модулей HUD.
            ui.outline(0.5, 0.5, width - 1.0, height - 1.0, with_alpha(accent, 0.3), 1.0);
            let arm = 18.0;
            let bright = with_alpha(accent, 0.9);
            ui.line((1.0, arm), (1.0, 1.0), bright, 1.6);
            ui.line((1.0, 1.0), (arm, 1.0), bright, 1.6);
            ui.line((width - 1.0, height - arm), (width - 1.0, height - 1.0), bright, 1.6);
            ui.line((width - 1.0, height - 1.0), (width - arm, height - 1.0), bright, 1.6);

            // Шапка: за неё окно перетаскивается.
            let title = TITLE_HEIGHT as f32;
            ui.rect(0.0, 0.0, width, title, with_alpha(accent, 0.05));
            ui.line((0.0, title), (width, title), with_alpha(accent, 0.18), 1.0);
            ui.text(24.0, title / 2.0, tr("НАСТРОЙКА J.A.R.V.I.S. HUD", "J.A.R.V.I.S. HUD SETTINGS"), 14.0, accent, true, Align::Left, 3.0);
            ui.text(
                width - 64.0,
                title / 2.0,
                tr("изменения применяются сразу", "changes apply instantly"),
                11.0,
                with_alpha(theme::STEEL, 0.9),
                false,
                Align::Right,
                0.0,
            );

            let close_x = width - title;
            if ui.hovered(close_x, 0.0, title, title) {
                ui.rect(close_x, 0.0, title, title, with_alpha(theme::RED, 0.28));
            }
            let cross = with_alpha(theme::TEXT, 0.85);
            ui.line((close_x + 18.0, 18.0), (close_x + 30.0, 30.0), cross, 1.4);
            ui.line((close_x + 30.0, 18.0), (close_x + 18.0, 30.0), cross, 1.4);
            if ui.clicked(close_x, 0.0, title, title) {
                close = true;
            }

            let left = 28.0;
            let right = 432.0;
            let column = 360.0;

            // --- левая колонка: модули и оформление ---
            ui.section(left, 76.0, column, tr("МОДУЛИ", "MODULES"));
            let mut y = 92.0;
            for id in MODULES {
                let key = id.key();
                let checked = !hud.config.is_hidden(key);
                if ui.checkbox(left, y, column, &sentence_case(id.title()), checked) {
                    hud.config.toggle(key);
                }
                y += 27.0;
            }

            ui.section(left, 470.0, column, tr("ОФОРМЛЕНИЕ", "LOOK"));
            let flags: [(&str, fn(&mut Config) -> &mut bool); 5] = [
                (tr("Реактор с часами", "Reactor with clock"), flag_reactor),
                (tr("Рамка и линейка", "Frame and ruler"), flag_frame),
                (tr("Сетка фона", "Background grid"), flag_grid),
                (tr("Частицы", "Particles"), flag_motes),
                (tr("Анимация запуска", "Boot animation"), flag_boot),
            ];
            let mut y = 486.0;
            for (label, field) in flags {
                let value = *field(&mut hud.config);
                if ui.checkbox(left, y, column, label, value) {
                    let slot = field(&mut hud.config);
                    *slot = !*slot;
                    hud.config.save();
                }
                y += 27.0;
            }

            // --- правая колонка ---
            ui.section(right, 76.0, column, tr("ЦВЕТ АКЦЕНТА", "ACCENT COLOR"));
            for (index, preset) in ACCENTS.iter().enumerate() {
                let cx = right + 14.0 + index as f32 * 48.0;
                let color = Color::rgbf(preset[0], preset[1], preset[2]);
                if ui.swatch(cx, 112.0, color, same_color(hud.config.accent, *preset)) {
                    hud.config.accent = *preset;
                    hud.config.save();
                }
            }

            ui.section(right, 150.0, column, tr("ЛИМИТ КАДРОВ", "FRAME LIMIT"));
            let rates = [15u32, 30, 60, 120, 0];
            let selected = rates.iter().position(|v| *v == hud.config.fps_cap).unwrap_or(1);
            if let Some(index) = ui.segmented(right, 166.0, column, 32.0, &["15", "30", "60", "120", tr("МАКС", "MAX")], selected) {
                hud.config.fps_cap = rates[index];
                hud.config.save();
            }

            ui.section(right, 222.0, column, tr("ОТСТУП ПОД ЗНАЧКИ", "SPACE FOR ICONS"));
            let margins = [0.0f32, 160.0, 300.0, 440.0];
            let selected = margins.iter().position(|v| (v - hud.config.icon_margin).abs() < 1.0).unwrap_or(2);
            if let Some(index) = ui.segmented(right, 238.0, column, 32.0, &[tr("НЕТ", "NONE"), "160 PX", "300 PX", "440 PX"], selected) {
                hud.config.icon_margin = margins[index];
                hud.config.save();
            }

            ui.section(right, 294.0, column, tr("МОНИТОРЫ", "MONITORS"));
            let mut y = 310.0;
            for monitor in monitor_list {
                let enabled = !hud.config.disabled_monitors.iter().any(|key| key == &monitor.key);
                let label = format!(
                    "{} {} · {}×{} · {} {}{}",
                    tr("Монитор", "Monitor"),
                    monitor.index,
                    monitor.width,
                    monitor.height,
                    monitor.hz,
                    tr("Гц", "Hz"),
                    if monitor.primary { tr(" · основной", " · primary") } else { "" }
                );
                if ui.checkbox(right, y, column, &label, enabled) {
                    if enabled {
                        hud.config.disabled_monitors.push(monitor.key.clone());
                    } else {
                        hud.config.disabled_monitors.retain(|key| key != &monitor.key);
                    }
                    hud.config.save();
                }
                y += 27.0;
            }

            let system_y = y + 16.0;
            ui.section(right, system_y, column, tr("СИСТЕМА", "SYSTEM"));
            if ui.checkbox(right, system_y + 16.0, column, tr("Запускать вместе с Windows", "Start with Windows"), autostart_on) {
                let _ = autostart::set_enabled(!autostart_on);
                autostart_on = autostart::is_enabled();
            }

            let buttons_y = height - 132.0;
            if ui.button(right, buttons_y, column, 36.0, tr("ПРОИГРАТЬ АНИМАЦИЮ ЗАПУСКА", "PLAY BOOT ANIMATION"), false) {
                hud.boot = Boot::new();
            }
            if ui.button(right, buttons_y + 48.0, 140.0, 36.0, tr("СБРОСИТЬ", "RESET"), false) {
                hud.config = Config::default();
                hud.config.save();
            }
            if ui.button(right + 152.0, buttons_y + 48.0, 208.0, 36.0, tr("ВЫЙТИ ИЗ ПРОГРАММЫ", "QUIT"), true) {
                outcome = Outcome::Quit;
            }

            // Расстановка идёт прямо на обоях, поэтому окно настроек прячем.
            if ui.button(left, height - 92.0, column, 36.0, tr("РАССТАВИТЬ МОДУЛИ МЫШЬЮ", "ARRANGE MODULES WITH MOUSE"), false) {
                outcome = Outcome::EditLayout;
                close = true;
            }

            ui.text(
                left,
                height - 26.0,
                tr("Щелчок по значку в трее открывает это окно · Esc закрывает", "Clicking the tray icon opens this window · Esc closes it"),
                11.0,
                with_alpha(theme::STEEL, 0.8),
                false,
                Align::Left,
                0.0,
            );
        }

        self.autostart = autostart_on;
        (outcome, close)
    }
}
