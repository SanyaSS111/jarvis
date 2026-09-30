//! Местное время системы: в стандартной библиотеке Rust его форматирования нет.

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SYSTEMTIME {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    milliseconds: u16,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetLocalTime(time: *mut SYSTEMTIME);
}

pub struct Now {
    pub year: u16,
    /// Номер месяца с нуля — удобно для таблицы названий.
    pub month: usize,
    pub day: u16,
    pub weekday: usize,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
}

pub fn now() -> Now {
    let mut time = SYSTEMTIME::default();
    unsafe { GetLocalTime(&mut time) };
    Now {
        year: time.year,
        month: (time.month.max(1) - 1) as usize,
        day: time.day,
        weekday: time.day_of_week as usize,
        hour: time.hour,
        minute: time.minute,
        second: time.second,
    }
}

/// Доля прошедшего месяца — для кольца даты.
pub fn month_progress(now: &Now) -> f32 {
    let days_in_month = match now.month {
        0 | 2 | 4 | 6 | 7 | 9 | 11 => 31.0,
        3 | 5 | 8 | 10 => 30.0,
        _ => {
            let leap = (now.year % 4 == 0 && now.year % 100 != 0) || now.year % 400 == 0;
            if leap { 29.0 } else { 28.0 }
        }
    };
    ((now.day as f32 - 1.0) + now.hour as f32 / 24.0) / days_in_month
}
