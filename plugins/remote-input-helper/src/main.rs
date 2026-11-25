//! Mochi OA 远程控制虚拟键鼠常驻助手。
//!
//! 协议与 Electron 主进程 `remote-input.ts` 的指令协议对齐：
//! - argv[1]=屏幕宽 argv[2]=屏幕高（Linux uinput 的 ABS 范围按此设置）
//! - stdin 逐行 JSON 命令；stdout 首行握手 JSON，之后每条结果一行 JSON。
//!
//! 命令：
//!   {"t":"move","x":..,"y":..}              绝对坐标移动
//!   {"t":"down"|"up","btn":"left|right|middle"}
//!   {"t":"scroll","d":±120}                 正=上滚
//!   {"t":"kdown"|"kup","k":<原生键码>}       兼容旧字段 c
//!   {"t":"cliplock"|"clipfree"|"show"|"record"|"restore"|"ping"}
//!
//! 结果：{"ok":true,...} / {"ok":false,"reason":"..."}

use serde::Deserialize;
use std::io::{self, BufRead, Write};

mod platform;

#[derive(Deserialize, Default)]
struct Cmd {
    t: String,
    x: Option<i32>,
    y: Option<i32>,
    d: Option<i32>,
    k: Option<u32>,
    c: Option<u32>,
    btn: Option<String>,
    buttons: Option<Vec<u8>>,
    axes: Option<Vec<f32>>,
}

fn emit_json(v: &serde_json::Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn fail(reason: &str) -> ! {
    emit_json(&serde_json::json!({ "ok": false, "reason": reason }));
    std::process::exit(1);
}

fn screen_args() -> (i32, i32) {
    let w = std::env::args()
        .nth(1)
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(1920);
    let h = std::env::args()
        .nth(2)
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(1080);
    (w.max(2), h.max(2))
}

fn dispatch(b: &mut dyn platform::InputBackend, cmd: &Cmd) -> Result<(), String> {
    match cmd.t.as_str() {
        "move" => b.mouse_move(cmd.x.unwrap_or(0), cmd.y.unwrap_or(0)),
        "down" => b.mouse_down(cmd.btn.as_deref().unwrap_or("left")),
        "up" => b.mouse_up(cmd.btn.as_deref().unwrap_or("left")),
        "scroll" => b.scroll(cmd.d.unwrap_or(0)),
        "kdown" => {
            let code = cmd.k.or(cmd.c).unwrap_or(0);
            if code == 0 {
                return Err("缺少键码 k/c".into());
            }
            b.key(code, true)
        }
        "kup" => {
            let code = cmd.k.or(cmd.c).unwrap_or(0);
            if code == 0 {
                return Err("缺少键码 k/c".into());
            }
            b.key(code, false)
        }
        "cliplock" => b.clip_lock(),
        "clipfree" => b.clip_free(),
        "show" => b.show_cursor(),
        "record" => {
            let visible = b.record_cursor()?;
            emit_json(&serde_json::json!({ "ok": true, "visible": visible }));
            Ok(())
        }
        "restore" => b.restore_cursor(),
        "gamepad" => {
            let buttons: &[u8] = cmd.buttons.as_deref().unwrap_or(&[]);
            let axes: &[f32] = cmd.axes.as_deref().unwrap_or(&[]);
            b.gamepad_report(buttons, axes)
        }
        "ping" => {
            emit_json(&serde_json::json!({ "ok": true, "pong": true }));
            Ok(())
        }
        other => Err(format!("未知命令 t={other}")),
    }
}

fn main() {
    let (sw, sh) = screen_args();
    let mut backend = match platform::create(sw, sh) {
        Ok(b) => b,
        Err(e) => fail(&format!("初始化输入后端失败：{e}")),
    };
    emit_json(&serde_json::json!({ "ok": true, "backend": backend.name(), "screen": [sw, sh] }));

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let cmd: Cmd = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                emit_json(&serde_json::json!({ "ok": false, "reason": format!("命令不是合法 JSON：{e}") }));
                continue;
            }
        };
        if let Err(e) = dispatch(&mut *backend, &cmd) {
            emit_json(&serde_json::json!({ "ok": false, "reason": e }));
        }
    }

    backend.shutdown();
    emit_json(&serde_json::json!({ "ok": true, "bye": true }));
}
