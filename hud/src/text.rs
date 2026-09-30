//! Шрифты берём системные: приложение должно работать без интернета и без файлов рядом.

use femtovg::renderer::OpenGl;
use femtovg::FontId;

pub type Canvas = femtovg::Canvas<OpenGl>;

pub struct Fonts {
    pub display: FontId,
    pub mono: FontId,
}

/// Bahnschrift — техничный DIN-шрифт из комплекта Windows, Consolas — моноширинный.
/// Оба содержат кириллицу, это проверено заранее.
const DISPLAY_CANDIDATES: &[&str] = &[
    r"C:\Windows\Fonts\bahnschrift.ttf",
    r"C:\Windows\Fonts\segoeuisb.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
];

const MONO_CANDIDATES: &[&str] = &[
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\cour.ttf",
];

fn load_first(canvas: &mut Canvas, paths: &[&str]) -> FontId {
    for path in paths {
        if let Ok(data) = std::fs::read(path) {
            if let Ok(id) = canvas.add_font_mem(&data) {
                return id;
            }
        }
    }
    panic!("не найден ни один системный шрифт из списка: {paths:?}");
}

impl Fonts {
    pub fn load(canvas: &mut Canvas) -> Self {
        Self {
            display: load_first(canvas, DISPLAY_CANDIDATES),
            mono: load_first(canvas, MONO_CANDIDATES),
        }
    }
}
