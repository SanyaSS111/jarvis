//! Сеть: физический адаптер, скорость линка и трафик.
//! Тип адаптера берём из самой Windows (GetIfTable), а не по имени —
//! так туннель VPN не выдаёт себя за мобильную сеть.

use std::sync::Mutex;
use std::time::Instant;

use crate::win32::*;

#[derive(Clone, Debug, Default)]
pub struct Network {
    pub name: String,
    pub kind: String,
    pub link_mbps: u32,
    pub down_kbs: f32,
    pub up_kbs: f32,
    pub tunnel: Option<String>,
}

struct Counters {
    at: Instant,
    down: u64,
    up: u64,
}

static PREVIOUS: Mutex<Option<Counters>> = Mutex::new(None);

fn describe(row: &MIB_IFROW) -> String {
    let end = row.bDescr.iter().position(|&b| b == 0).unwrap_or(row.bDescr.len());
    String::from_utf8_lossy(&row.bDescr[..end.min(row.dwDescrLen as usize)]).to_string()
}

fn kind_of(row: &MIB_IFROW) -> &'static str {
    match row.dwType {
        IF_TYPE_ETHERNET => "Ethernet",
        IF_TYPE_IEEE80211 => "Wi-Fi",
        IF_TYPE_PPP => "PPP",
        IF_TYPE_TUNNEL => "Туннель",
        IF_TYPE_SOFTWARE_LOOPBACK => "Loopback",
        _ => "Прочее",
    }
}

fn read_table() -> Vec<MIB_IFROW> {
    unsafe {
        let mut size: u32 = 0;
        // Первый вызов только сообщает нужный размер буфера.
        GetIfTable(std::ptr::null_mut(), &mut size, 0);
        if size == 0 {
            return Vec::new();
        }

        let mut buffer = vec![0u8; size as usize];
        if GetIfTable(buffer.as_mut_ptr(), &mut size, 0) != 0 {
            return Vec::new();
        }

        let count = *(buffer.as_ptr() as *const u32) as usize;
        let rows = buffer.as_ptr().add(std::mem::size_of::<u32>()) as *const MIB_IFROW;
        (0..count).map(|index| *rows.add(index)).collect()
    }
}

pub fn prime() {
    let _ = sample();
}

pub fn sample() -> Network {
    let rows = read_table();
    let mut physical: Option<MIB_IFROW> = None;
    let mut tunnel: Option<String> = None;
    let mut down_total: u64 = 0;
    let mut up_total: u64 = 0;

    for row in &rows {
        let working = row.dwOperStatus == IF_OPER_CONNECTED || row.dwOperStatus == IF_OPER_OPERATIONAL;
        if !working || row.dwType == IF_TYPE_SOFTWARE_LOOPBACK {
            continue;
        }

        let description = describe(row);
        let virtual_like = row.dwType == IF_TYPE_TUNNEL
            || row.dwMtu >= 9000
            || description.to_lowercase().contains("virtual")
            || description.to_lowercase().contains("tap");

        if virtual_like {
            if tunnel.is_none() {
                tunnel = Some(description);
            }
            continue;
        }

        down_total += row.dwInOctets as u64;
        up_total += row.dwOutOctets as u64;

        // Ethernet предпочтительнее Wi-Fi, дальше — по скорости линка.
        let better = match &physical {
            None => true,
            Some(current) => {
                let rank = |t: u32| match t {
                    IF_TYPE_ETHERNET => 0,
                    IF_TYPE_IEEE80211 => 1,
                    _ => 2,
                };
                (rank(row.dwType), u32::MAX - row.dwSpeed.min(u32::MAX))
                    < (rank(current.dwType), u32::MAX - current.dwSpeed.min(u32::MAX))
            }
        };
        if better {
            physical = Some(*row);
        }
    }

    let now = Instant::now();
    let mut previous = PREVIOUS.lock().unwrap();
    let (down_kbs, up_kbs) = match previous.as_ref() {
        Some(last) => {
            let span = now.duration_since(last.at).as_secs_f32().max(0.001);
            // Счётчики 32-битные: при переполнении просто считаем шаг нулевым.
            let down = down_total.saturating_sub(last.down) as f32 / span / 1024.0;
            let up = up_total.saturating_sub(last.up) as f32 / span / 1024.0;
            (down.max(0.0), up.max(0.0))
        }
        None => (0.0, 0.0),
    };
    *previous = Some(Counters { at: now, down: down_total, up: up_total });

    match physical {
        Some(row) => {
            // Скорость линка в битах; у виртуальных адаптеров бывает мусор.
            let mbps = row.dwSpeed / 1_000_000;
            Network {
                name: describe(&row),
                kind: kind_of(&row).to_string(),
                link_mbps: if mbps > 0 && mbps <= 100_000 { mbps } else { 0 },
                down_kbs,
                up_kbs,
                tunnel,
            }
        }
        None => Network {
            name: "—".into(),
            kind: "Нет соединения".into(),
            link_mbps: 0,
            down_kbs,
            up_kbs,
            tunnel,
        },
    }
}
