//! J.A.R.V.I.S. HUD 2.0 — живые обои рабочего стола.
//! Отрисовка идёт напрямую на видеокарте, без встроенного браузера.

#![windows_subsystem = "windows"]

mod autostart;
mod clock;
mod config;
mod gl_window;
mod hud;
mod lang;
mod monitors;
mod overlay;
mod registry;
mod settings;
mod sys;
mod text;
mod tray;
mod visibility;
mod wallpaper;
mod win32;

use std::time::{Duration, Instant};

use config::Config;
use gl_window::GlWindow;
use hud::Hud;
use win32::*;

const MUTEX_NAME: &str = "JarvisHUD2.SingleInstance";

fn already_running() -> bool {
    unsafe {
        CreateMutexW(std::ptr::null_mut(), 1, wide(MUTEX_NAME).as_ptr());
        GetLastError() == ERROR_ALREADY_EXISTS
    }
}

fn report_already_running() {
    let text = wide(
        "J.A.R.V.I.S. HUD 2.0 уже работает.\n\n\
         Обои идут за значками рабочего стола, управление — через иконку в области уведомлений.",
    );
    let caption = wide("J.A.R.V.I.S. HUD 2.0");
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x40 | 0x4_0000) };
}

/// Приложение без консоли: причину падения видно только из файла.
fn install_crash_log() {
    std::panic::set_hook(Box::new(|info| {
        let directory = config::directory();
        let _ = std::fs::create_dir_all(&directory);
        let message = format!(
            "--- сбой ---
{info}
"
        );
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("error.log"))
        {
            let _ = file.write_all(message.as_bytes());
        }

        let text = win32::wide(&format!(
            "J.A.R.V.I.S. HUD 2.0 не смог запуститься.

{info}

Подробности в файле error.log внутри папки APPDATA/JarvisHUD2"
        ));
        let caption = win32::wide("J.A.R.V.I.S. HUD 2.0");
        unsafe {
            win32::MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10 | 0x4_0000)
        };
    }));
}

fn main() {
    install_crash_log();
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--probe") {
        probe();
        return;
    }

    if let Some(index) = args.iter().position(|a| a == "--shot") {
        let path = args.get(index + 1).cloned().unwrap_or_else(|| "shot.png".into());
        let at: f32 = args
            .iter()
            .position(|a| a == "--at")
            .and_then(|i| args.get(i + 1))
            .and_then(|value| value.parse().ok())
            .unwrap_or(99.0);
        shot(&path, at);
        return;
    }

    if let Some(index) = args.iter().position(|a| a == "--settings-shot") {
        let path = args.get(index + 1).cloned().unwrap_or_else(|| "settings.png".into());
        let monitor_list = monitors::enumerate();
        let mut hud = Hud::new(Config::load());
        settings::Settings::render_png(&monitor_list, &mut hud, &path);
        println!("снимок настроек сохранён: {path}");
        return;
    }

    if already_running() {
        report_already_running();
        return;
    }

    run();
}

fn probe() {
    let screen = monitors::virtual_screen();
    println!("виртуальный экран: {}x{}", screen.width, screen.height);
    for monitor in monitors::enumerate() {
        println!(
            "монитор {}: {}x{} @ {} Гц, масштаб {:.2}, рабочая область {}x{}",
            monitor.index, monitor.width, monitor.height, monitor.hz, monitor.scale,
            monitor.work_width, monitor.work_height
        );
    }

    let metrics = sys::Metrics::start();
    std::thread::sleep(Duration::from_millis(2500));
    let sample = metrics.snapshot();
    println!(
        "ЦП {:.0}% @ {} МГц | ОЗУ {:.0}% | ГП {:.0}% {} °C {:.1} Вт",
        sample.cpu, sample.cpu_freq_mhz, sample.ram_percent, sample.gpu_load, sample.gpu_temp, sample.gpu_power_w
    );
    println!(
        "сеть: {} {} Мбит/с, вниз {:.0} КБ/с",
        sample.net_kind, sample.net_link_mbps, sample.net_down_kbs
    );
}

/// Снимок кадра в PNG: так можно проверить вид обоев, не трогая рабочий стол.
fn shot(path: &str, at_seconds: f32) {
    let screen = monitors::virtual_screen();
    let monitor_list = monitors::enumerate();
    let metrics = sys::Metrics::start();
    std::thread::sleep(Duration::from_millis(3600));

    let mut window = GlWindow::new(screen.width as u32, screen.height as u32, false);
    let mut hud = Hud::new(Config::load());
    let sample = metrics.snapshot();

    // Прокручиваем анимацию до нужного момента, попутно наполняя графики.
    let steps = 90;
    for index in 0..steps {
        hud.update(at_seconds / steps as f32, index as f32 * 1.1, &sample);
    }

    hud.draw_frame(
        &mut window.canvas,
        &window.fonts,
        &monitor_list,
        &sample,
        &metrics.info,
        at_seconds,
        screen.width as f32,
        screen.height as f32,
    );
    window.canvas.flush();
    window.save_png(path);
    println!("снимок сохранён: {path}");
}

fn run() {
    let metrics = sys::Metrics::start();
    let config = Config::load();

    let screen = monitors::virtual_screen();
    let mut monitor_list = monitors::enumerate();
    let mut signature = monitors::signature(&monitor_list);

    // Слой рабочего стола ищем до создания окна: так контекст OpenGL сразу
    // принадлежит окну, которое уже стоит на своём месте.
    // Кадр считаем в скрытом окне на видеокарте, а показываем через слоистое
    // окно: только оно надёжно доходит до композитора рабочего стола.
    let mut window = GlWindow::new(screen.width as u32, screen.height as u32, false);
    let overlay = overlay::Overlay::new(screen.x, screen.y, screen.width, screen.height);
    wallpaper::trace(&format!("слой HUD: {}", if overlay.is_some() { "создан" } else { "не создан" }));

    let tray = tray::Tray::new();
    let mut hud = Hud::new(config);
    // Окно настроек создаётся при первом открытии: без него контекст OpenGL не нужен.
    let mut panel: Option<settings::Settings> = None;

    let started = Instant::now();
    let mut previous = started;
    let mut last_check = started;
    let mut paused = false;
    let mut frames: u64 = 0;
    let mut frame_saved = false;
    let trace_frames = std::env::var("JARVIS_TRACE").as_deref() == Ok("1");

    loop {
        if !window.pump() || tray.quit_requested() {
            break;
        }

        let now = Instant::now();
        let delta = now.duration_since(previous).as_secs_f32().min(0.1);
        previous = now;
        let seconds = now.duration_since(started).as_secs_f32();

        // Лимит кадров читается каждый кадр: его меняют в окне настроек.
        let refresh = monitor_list.iter().map(|m| m.hz).max().unwrap_or(60).max(30);
        let cap = if hud.config.fps_cap == 0 { refresh } else { hud.config.fps_cap };
        let mut frame_budget = Duration::from_micros(1_000_000 / cap.clamp(10, 240) as u64);

        if tray.take_setup_request() {
            panel.get_or_insert_with(|| settings::Settings::new(&monitor_list)).show();
        }

        let mut settings_open = false;
        if let Some(settings) = panel.as_mut() {
            if settings.visible() {
                settings_open = true;
                match settings.frame(&mut hud, &monitor_list) {
                    settings::Outcome::Quit => break,
                    settings::Outcome::EditLayout => {
                        hud.edit_mode = true;
                        if let Some(overlay) = overlay.as_ref() {
                            overlay.set_interactive(true);
                        }
                    }
                    settings::Outcome::Stay => {}
                }
                // Окно настроек должно откликаться быстро даже при низком лимите кадров.
                frame_budget = frame_budget.min(Duration::from_millis(16));
            }
        }

        // Режим расстановки: мышь и Esc приходят в слой HUD.
        if hud.edit_mode {
            let mut finish = overlay::take_escape();
            for event in overlay::take_events() {
                match hud.pointer(event) {
                    Some(crate::hud::edit::EditButton::Done) => finish = true,
                    Some(crate::hud::edit::EditButton::Reset) => hud.reset_layout(),
                    None => {}
                }
            }
            if finish {
                hud.edit_mode = false;
                hud.config.save();
                if let Some(overlay) = overlay.as_ref() {
                    overlay.set_interactive(false);
                }
            }
            // Перетаскивание должно идти плавно независимо от лимита кадров.
            frame_budget = frame_budget.min(Duration::from_millis(16));
        }

        // Раз в секунду проверяем конфигурацию экранов и перекрытие окнами.
        if now.duration_since(last_check) >= Duration::from_millis(1000) {
            last_check = now;

            let fresh = monitors::enumerate();
            let current = monitors::signature(&fresh);
            if current != signature {
                signature = current;
                monitor_list = fresh;
                let screen = monitors::virtual_screen();
                window.resize(screen.width as u32, screen.height as u32);
            }

            if let Some(overlay) = overlay.as_ref() {
                overlay.keep_at_bottom();
            }

            let covered = visibility::covered(&monitor_list, window.hwnd);
            let all_covered = !covered.is_empty() && covered.iter().all(|flag| *flag);
            if all_covered != paused {
                paused = all_covered;
                metrics.set_idle(paused);
                wallpaper::trace(&format!("пауза: {paused}"));
            }

        }

        // В режиме расстановки слой HUD наверху, поэтому пауза не действует.
        if paused && !hud.edit_mode {
            // Обои закрыты окнами: кадры не рисуем, но окно настроек продолжает жить.
            std::thread::sleep(if settings_open { frame_budget } else { Duration::from_millis(200) });
            continue;
        }

        window.make_current();
        frames += 1;
        if trace_frames && seconds > 6.0 && !frame_saved {
            frame_saved = true;
            let path = config::directory().join("live.png");
            window.save_png(&path.to_string_lossy());
            wallpaper::trace(&format!("живой кадр сохранён, кадров за {seconds:.1} с: {frames}"));
        }

        let sample = metrics.snapshot();
        hud.update(delta, seconds, &sample);
        hud.draw_frame(
            &mut window.canvas,
            &window.fonts,
            &monitor_list,
            &sample,
            &metrics.info,
            seconds,
            window.width as f32,
            window.height as f32,
        );
        window.canvas.flush();

        match overlay.as_ref() {
            Some(overlay) => overlay.present(),
            None => window.present(),
        }

        // Темп задаём сами: закадровая отрисовка не ждёт развёртки монитора.
        let spent = Instant::now().duration_since(now);
        if spent < frame_budget {
            std::thread::sleep(frame_budget - spent);
        }
    }
}
