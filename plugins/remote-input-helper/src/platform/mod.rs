//! 三端输入后端抽象与装配。

#[cfg(windows)]
mod windows_backend;
#[cfg(linux)]
mod linux_backend;
#[cfg(darwin)]
mod macos_backend;

/// 跨平台虚拟键鼠后端能力。键码由上层（Electron 主进程）按平台映射好后下发：
/// Windows 收 VK 码，Linux 收 evdev 码，macOS 收 kVK 虚拟键码。
pub trait InputBackend {
    /// 后端标识，写进握手 JSON，便于日志区分。
    fn name(&self) -> &str;
    fn mouse_move(&mut self, x: i32, y: i32) -> Result<(), String>;
    fn mouse_down(&mut self, btn: &str) -> Result<(), String>;
    fn mouse_up(&mut self, btn: &str) -> Result<(), String>;
    fn scroll(&mut self, delta: i32) -> Result<(), String>;
    fn key(&mut self, code: u32, down: bool) -> Result<(), String>;
    /// 锁定光标在屏幕边界（仅 Windows 实现）。
    fn clip_lock(&mut self) -> Result<(), String> {
        Ok(())
    }
    /// 解除边界锁定（仅 Windows 实现）。
    fn clip_free(&mut self) -> Result<(), String> {
        Ok(())
    }
    /// 会话开始：抓拍当前光标可见性作为断开时的恢复基线（仅 Windows 实现）。
    fn record_cursor(&mut self) -> Result<bool, String> {
        Ok(true)
    }
    /// 兜底显示光标（仅 Windows 实现；其它平台光标本就不隐藏）。
    fn show_cursor(&mut self) -> Result<(), String> {
        Ok(())
    }
    /// 会话结束：恢复会话开始时记录的光标状态（仅 Windows 实现）。
    fn restore_cursor(&mut self) -> Result<(), String> {
        Ok(())
    }
    /// 手柄状态上报（标准映射：buttons 按键位图，axes 摇杆轴 -1..1）。
    /// 默认空实现；Windows ViGEmBus / Linux uinput 手柄设备接入后覆写。
    fn gamepad_report(&mut self, _buttons: &[u8], _axes: &[f32]) -> Result<(), String> {
        Ok(())
    }
    /// 会话结束清理（销毁虚拟设备等）。
    fn shutdown(&mut self) {}
}

pub fn create(sw: i32, sh: i32) -> Result<Box<dyn InputBackend>, String> {
    #[cfg(windows)]
    {
        let _ = (sw, sh);
        Ok(Box::new(windows_backend::WindowsBackend::new()))
    }
    #[cfg(linux)]
    {
        Ok(Box::new(linux_backend::LinuxBackend::new(sw, sh)?))
    }
    #[cfg(darwin)]
    {
        Ok(Box::new(macos_backend::MacosBackend::new()))
    }
    #[cfg(not(any(windows, linux, darwin)))]
    {
        Err("不支持的平台".into())
    }
}
