//! macOS 后端：CoreGraphics CGEvent（kCGHIDEventTap 上报）。
//!
//! 直接对 CoreGraphics 做 FFI，不引第三方 crate。权限：必须授予「辅助功能」，
//! 否则 CGEventPost 会被系统静默丢弃；该自检沿用主进程能力描述口径。
//! 键码为上层映射好的 kVK_* 虚拟键码。

use super::InputBackend;
use std::ffi::c_void;

#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateMouseEvent(
        source: *const c_void,
        mouse_type: u32,
        point: CGPoint,
        button: u32,
    ) -> *mut c_void;
    fn CGEventCreateKeyboardEvent(source: *const c_void, keycode: u16, key_down: bool) -> *mut c_void;
    fn CGEventCreateScrollWheelEvent(
        source: *const c_void,
        units: u32,
        wheel_count: u32,
        wheel1: i32,
    ) -> *mut c_void;
    fn CGEventPost(tap: u32, event: *mut c_void);
}

// CGEventType / CGMouseButton / CGEventTapLocation 常量（HIToolbox Events.h）
const KCG_EVENT_MOUSE_MOVED: u32 = 5;
const KCG_EVENT_LEFT_DOWN: u32 = 1;
const KCG_EVENT_LEFT_UP: u32 = 2;
const KCG_EVENT_RIGHT_DOWN: u32 = 3;
const KCG_EVENT_RIGHT_UP: u32 = 4;
const KCG_EVENT_OTHER_DOWN: u32 = 25;
const KCG_EVENT_OTHER_UP: u32 = 26;

const KCG_MOUSE_BUTTON_LEFT: u32 = 0;
const KCG_MOUSE_BUTTON_RIGHT: u32 = 1;
const KCG_MOUSE_BUTTON_CENTER: u32 = 2;

const KCG_HID_EVENT_TAP: u32 = 0;
const KCG_SCROLL_EVENT_UNIT_LINE: u32 = 1;

pub struct MacosBackend;

impl MacosBackend {
    pub fn new() -> Self {
        Self
    }

    fn button_index(btn: &str) -> u32 {
        match btn {
            "right" => KCG_MOUSE_BUTTON_RIGHT,
            "middle" => KCG_MOUSE_BUTTON_CENTER,
            _ => KCG_MOUSE_BUTTON_LEFT,
        }
    }
}

impl InputBackend for MacosBackend {
    fn name(&self) -> &str {
        "rust-cgevent"
    }

    fn mouse_move(&mut self, x: i32, y: i32) -> Result<(), String> {
        unsafe {
            let event = CGEventCreateMouseEvent(
                std::ptr::null(),
                KCG_EVENT_MOUSE_MOVED,
                CGPoint { x: x as f64, y: y as f64 },
                KCG_MOUSE_BUTTON_LEFT,
            );
            CGEventPost(KCG_HID_EVENT_TAP, event);
        }
        Ok(())
    }

    fn mouse_down(&mut self, btn: &str) -> Result<(), String> {
        let button = Self::button_index(btn);
        let event_type = match button {
            KCG_MOUSE_BUTTON_RIGHT => KCG_EVENT_RIGHT_DOWN,
            KCG_MOUSE_BUTTON_CENTER => KCG_EVENT_OTHER_DOWN,
            _ => KCG_EVENT_LEFT_DOWN,
        };
        unsafe {
            let event = CGEventCreateMouseEvent(std::ptr::null(), event_type, CGPoint { x: 0.0, y: 0.0 }, button);
            CGEventPost(KCG_HID_EVENT_TAP, event);
        }
        Ok(())
    }

    fn mouse_up(&mut self, btn: &str) -> Result<(), String> {
        let button = Self::button_index(btn);
        let event_type = match button {
            KCG_MOUSE_BUTTON_RIGHT => KCG_EVENT_RIGHT_UP,
            KCG_MOUSE_BUTTON_CENTER => KCG_EVENT_OTHER_UP,
            _ => KCG_EVENT_LEFT_UP,
        };
        unsafe {
            let event = CGEventCreateMouseEvent(std::ptr::null(), event_type, CGPoint { x: 0.0, y: 0.0 }, button);
            CGEventPost(KCG_HID_EVENT_TAP, event);
        }
        Ok(())
    }

    fn scroll(&mut self, delta: i32) -> Result<(), String> {
        unsafe {
            let event = CGEventCreateScrollWheelEvent(
                std::ptr::null(),
                KCG_SCROLL_EVENT_UNIT_LINE,
                1,
                delta,
            );
            CGEventPost(KCG_HID_EVENT_TAP, event);
        }
        Ok(())
    }

    fn key(&mut self, code: u32, down: bool) -> Result<(), String> {
        unsafe {
            let event = CGEventCreateKeyboardEvent(std::ptr::null(), code as u16, down);
            CGEventPost(KCG_HID_EVENT_TAP, event);
        }
        Ok(())
    }
}
