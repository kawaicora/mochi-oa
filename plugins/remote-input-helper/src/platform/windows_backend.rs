//! Windows 后端：user32 SendInput / SetCursorPos / ClipCursor / ShowCursor。
//!
//! 与旧 PowerShell 助手同一套 user32 口径，只是换成常驻原生进程，去掉 PS 管道
//! 序列化与脚本解析抖动。仍是用户态注入：向管理员窗口发送受 UIPI 限制，
//! 这一点由主进程在能力描述里提示。

use super::InputBackend;
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, MAPVK_VK_TO_VSC, MapVirtualKeyW, SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ClipCursor, CURSORINFO, GetCursorInfo, GetSystemMetrics, SetCursorPos, ShowCursor,
    SM_CXSCREEN, SM_CYSCREEN,
};

/// CURSORINFO.flags：光标可见标志
const CURSORINFO_FLAG_VISIBLE: u32 = 0x1;
pub struct WindowsBackend {
    /** 会话开始时记录的原始光标可见性；None 表示尚未记录/非 Windows 路径 */
    baseline_visible: Option<bool>,
}

impl WindowsBackend {
    pub fn new() -> Self {
        Self { baseline_visible: None }
    }

    unsafe fn query_visible() -> bool {
        let mut ci = CURSORINFO {
            cbSize: core::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        GetCursorInfo(&mut ci).is_ok() && (ci.flags.0 & CURSORINFO_FLAG_VISIBLE) != 0
    }

    unsafe fn send_mouse(flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, data: u32) {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: data,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(&[input], core::mem::size_of::<INPUT>() as i32);
    }

    /// 需要 KEYEVENTF_EXTENDEDKEY 的扩展键（右侧修饰、方向键、导航键、右 Win）。
    fn is_extended(vk: u16) -> bool {
        matches!(
            vk,
            0xA3 | 0xA5 | 0x5C | 0x21 | 0x22 | 0x23 | 0x24 | 0x25 | 0x26 | 0x27 | 0x28 | 0x2D | 0x2E
        )
    }

    unsafe fn send_key(code: u16, down: bool) {
        // 系统/修饰键（Win、Ctrl/Alt、方向键等）靠扫描码才能被系统钩子与目标程序识别；
        // 仅给 VK、wScan=0 时这些键经常注入不生效。这里由 VK 反查扫描码，优先按扫描码注入。
        let scan = MapVirtualKeyW(code as u32, MAPVK_VK_TO_VSC);
        let mut flags = KEYBD_EVENT_FLAGS(0);
        let mut wscan: u16 = 0;
        if scan != 0 {
            flags |= KEYEVENTF_SCANCODE;
            wscan = scan as u16;
            if Self::is_extended(code) {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(code),
                    wScan: wscan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(&[input], core::mem::size_of::<INPUT>() as i32);
    }

    fn mouse_flags(btn: &str, down: bool) -> Option<windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS> {
        match (btn, down) {
            ("left", true) => Some(MOUSEEVENTF_LEFTDOWN),
            ("left", false) => Some(MOUSEEVENTF_LEFTUP),
            ("right", true) => Some(MOUSEEVENTF_RIGHTDOWN),
            ("right", false) => Some(MOUSEEVENTF_RIGHTUP),
            ("middle", true) => Some(MOUSEEVENTF_MIDDLEDOWN),
            ("middle", false) => Some(MOUSEEVENTF_MIDDLEUP),
            _ => None,
        }
    }
}

impl InputBackend for WindowsBackend {
    fn name(&self) -> &str {
        "rust-sendinput"
    }

    fn mouse_move(&mut self, x: i32, y: i32) -> Result<(), String> {
        unsafe {
            SetCursorPos(x, y).map_err(|e| format!("SetCursorPos 失败：{e}"))?;
        }
        Ok(())
    }

    fn mouse_down(&mut self, btn: &str) -> Result<(), String> {
        let flags = Self::mouse_flags(btn, true).ok_or_else(|| format!("未知鼠标按键 {btn}"))?;
        unsafe { Self::send_mouse(flags, 0) };
        Ok(())
    }

    fn mouse_up(&mut self, btn: &str) -> Result<(), String> {
        let flags = Self::mouse_flags(btn, false).ok_or_else(|| format!("未知鼠标按键 {btn}"))?;
        unsafe { Self::send_mouse(flags, 0) };
        Ok(())
    }

    fn scroll(&mut self, delta: i32) -> Result<(), String> {
        // MOUSEEVENTF_WHEEL 的 mouseData 为有符号 16 位滚轮增量（±120），按位回绕写入 u32。
        unsafe { Self::send_mouse(MOUSEEVENTF_WHEEL, delta as i32 as u32) };
        Ok(())
    }

    fn key(&mut self, code: u32, down: bool) -> Result<(), String> {
        unsafe { Self::send_key(code as u16, down) };
        Ok(())
    }

    fn clip_lock(&mut self) -> Result<(), String> {
        unsafe {
            let rect = RECT {
                left: 0,
                top: 0,
                right: GetSystemMetrics(SM_CXSCREEN),
                bottom: GetSystemMetrics(SM_CYSCREEN),
            };
            ClipCursor(Some(&rect)).map_err(|e| format!("ClipCursor 锁定失败：{e}"))?;
        }
        Ok(())
    }

    fn clip_free(&mut self) -> Result<(), String> {
        unsafe {
            ClipCursor(None).map_err(|e| format!("ClipCursor 解冻失败：{e}"))?;
        }
        Ok(())
    }

    fn record_cursor(&mut self) -> Result<bool, String> {
        let visible = unsafe { Self::query_visible() };
        self.baseline_visible = Some(visible);
        Ok(visible)
    }

    fn show_cursor(&mut self) -> Result<(), String> {
        // 递增显示计数直到光标可见（复位上一会话遗留的隐藏计数），最多 10 次兜底
        unsafe {
            for _ in 0..10 {
                ShowCursor(true);
                if Self::query_visible() {
                    break;
                }
            }
        }
        Ok(())
    }

    fn restore_cursor(&mut self) -> Result<(), String> {
        match self.baseline_visible {
            Some(false) => {
                // 会话前原本隐藏：递减计数直到重新隐藏，最多 10 次兜底
                unsafe {
                    for _ in 0..10 {
                        ShowCursor(false);
                        if !Self::query_visible() {
                            break;
                        }
                    }
                }
            }
            // 会话前可见（或未记录）：保持显示即可
            _ => {
                self.show_cursor()?;
            }
        }
        Ok(())
    }
}
