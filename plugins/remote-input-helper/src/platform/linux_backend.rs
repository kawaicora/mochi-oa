//! Linux 后端：/dev/uinput 内核虚拟键鼠设备（与旧 Python 助手同一套口径）。
//!
//! 不依赖显示服务器（Wayland / X11 都有效）；权限不足或内核未加载 uinput 时，
//! 握手阶段就把明确原因写进 JSON，由主进程转提示给控制端。

use super::InputBackend;
use std::io::Error as IoError;
use std::os::fd::RawFd;

const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const EV_REL: u16 = 2;
const EV_ABS: u16 = 3;
const SYN_REPORT: u16 = 0;

const REL_X: u16 = 0;
const REL_Y: u16 = 1;
const REL_WHEEL: u16 = 8;
const REL_HWHEEL: u16 = 6;
const ABS_X: u16 = 0;
const ABS_Y: u16 = 1;

const BTN_LEFT: u16 = 0x110;
const BTN_RIGHT: u16 = 0x111;
const BTN_MIDDLE: u16 = 0x112;

const BUS_USB: u16 = 3;

const UI_IOCTL: u8 = b'U';
const fn _io(nr: u32) -> libc::c_ulong {
    ((UI_IOCTL as libc::c_ulong) << 8) | nr
}
const fn _iow(nr: u32, size: usize) -> libc::c_ulong {
    (1 << 30) | ((size as libc::c_ulong) << 16) | ((UI_IOCTL as libc::c_ulong) << 8) | nr
}
const UI_DEV_CREATE: libc::c_ulong = _io(1);
const UI_DEV_DESTROY: libc::c_ulong = _io(2);
const UI_DEV_SETUP: libc::c_ulong = _iow(3, 92);
const UI_ABS_SETUP: libc::c_ulong = _iow(4, 28);
const UI_SET_EVBIT: libc::c_ulong = _iow(100, 4);
const UI_SET_KEYBIT: libc::c_ulong = _iow(101, 4);
const UI_SET_RELBIT: libc::c_ulong = _iow(102, 4);
const UI_SET_ABSBIT: libc::c_ulong = _iow(103, 4);

#[repr(C)]
struct InputId {
    bustype: u16,
    vendor: u16,
    product: u16,
    version: u16,
}

#[repr(C)]
struct UinputSetup {
    id: InputId,
    name: [u8; 80],
    ff_effects_max: u32,
}

#[repr(C)]
struct AbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}

#[repr(C)]
struct UinputAbsSetup {
    code: u16,
    pad: u16,
    absinfo: AbsInfo,
}

pub struct LinuxBackend {
    fd: RawFd,
    sw: i32,
    sh: i32,
}

impl LinuxBackend {
    pub fn new(sw: i32, sh: i32) -> Result<Self, String> {
        let fd = unsafe {
            libc::open(
                b"/dev/uinput\0".as_ptr() as *const libc::c_char,
                libc::O_WRONLY | libc::O_NONBLOCK,
                0,
            )
        };
        if fd < 0 {
            let err = IoError::last_os_error();
            let reason = match err.raw_os_error() {
                Some(libc::EPERM) | Some(libc::EACCES) => {
                    "没有 /dev/uinput 写权限（把用户加入 input 组：sudo usermod -aG input $USER 后重新登录，或加 udev 规则）".into()
                }
                Some(libc::ENOENT) => "不存在 /dev/uinput（内核未启用 uinput 模块：sudo modprobe uinput）".into(),
                _ => format!("打开 /dev/uinput 失败：{err}"),
            };
            return Err(reason);
        }

        let set_bit = |request: libc::c_ulong, bit: u16| -> Result<(), String> {
            let rc = unsafe { libc::ioctl(fd, request, bit as libc::c_ulong) };
            if rc < 0 {
                return Err(format!("ioctl 失败：{}", IoError::last_os_error()));
            }
            Ok(())
        };

        set_bit(UI_SET_EVBIT, EV_KEY)?;
        set_bit(UI_SET_EVBIT, EV_REL)?;
        set_bit(UI_SET_EVBIT, EV_ABS)?;
        set_bit(UI_SET_RELBIT, REL_X)?;
        set_bit(UI_SET_RELBIT, REL_Y)?;
        set_bit(UI_SET_RELBIT, REL_WHEEL)?;
        set_bit(UI_SET_RELBIT, REL_HWHEEL)?;
        for btn in [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE] {
            set_bit(UI_SET_KEYBIT, btn)?;
        }
        // 键码 1..255 全部打开：上层只发常用键，这里不做白名单，避免漏键。
        for code in 1..=255u16 {
            set_bit(UI_SET_KEYBIT, code)?;
        }
        set_bit(UI_SET_ABSBIT, ABS_X)?;
        set_bit(UI_SET_ABSBIT, ABS_Y)?;

        let abs_setup = |code: u16, max: i32| -> Result<(), String> {
            let setup = UinputAbsSetup {
                code,
                pad: 0,
                absinfo: AbsInfo { value: 0, minimum: 0, maximum: max - 1, fuzz: 0, flat: 0, resolution: 0 },
            };
            let rc = unsafe { libc::ioctl(fd, UI_ABS_SETUP, &setup as *const _ as libc::c_ulong) };
            if rc < 0 {
                return Err(format!("ABS_SETUP 失败：{}", IoError::last_os_error()));
            }
            Ok(())
        };
        abs_setup(ABS_X, sw)?;
        abs_setup(ABS_Y, sh)?;

        let mut name = [0u8; 80];
        let label = b"Mochi OA Virtual Input";
        name[..label.len()].copy_from_slice(label);
        let setup = UinputSetup {
            id: InputId { bustype: BUS_USB, vendor: 0x1234, product: 0x5678, version: 1 },
            name,
            ff_effects_max: 0,
        };
        let rc = unsafe { libc::ioctl(fd, UI_DEV_SETUP, &setup as *const _ as libc::c_ulong) };
        if rc < 0 {
            return Err(format!("UI_DEV_SETUP 失败：{}", IoError::last_os_error()));
        }
        let rc = unsafe { libc::ioctl(fd, UI_DEV_CREATE, 0) };
        if rc < 0 {
            return Err(format!("UI_DEV_CREATE 失败：{}", IoError::last_os_error()));
        }

        Ok(Self { fd, sw, sh })
    }

    fn emit(&mut self, etype: u16, code: u16, value: i32) {
        let event = libc::input_event {
            time: libc::timeval { tv_sec: 0, tv_usec: 0 },
            type: etype,
            code,
            value,
        };
        unsafe {
            libc::write(
                self.fd,
                &event as *const _ as *const libc::c_void,
                core::mem::size_of::<libc::input_event>(),
            );
        }
    }

    fn sync(&mut self) {
        self.emit(EV_SYN, SYN_REPORT, 0);
    }

    fn btn_code(btn: &str) -> u16 {
        match btn {
            "right" => BTN_RIGHT,
            "middle" => BTN_MIDDLE,
            _ => BTN_LEFT,
        }
    }
}

impl InputBackend for LinuxBackend {
    fn name(&self) -> &str {
        "rust-uinput"
    }

    fn mouse_move(&mut self, x: i32, y: i32) -> Result<(), String> {
        let x = x.clamp(0, self.sw - 1);
        let y = y.clamp(0, self.sh - 1);
        self.emit(EV_ABS, ABS_X, x);
        self.emit(EV_ABS, ABS_Y, y);
        self.sync();
        Ok(())
    }

    fn mouse_down(&mut self, btn: &str) -> Result<(), String> {
        let code = Self::btn_code(btn);
        self.emit(EV_KEY, code, 1);
        self.sync();
        Ok(())
    }

    fn mouse_up(&mut self, btn: &str) -> Result<(), String> {
        let code = Self::btn_code(btn);
        self.emit(EV_KEY, code, 0);
        self.sync();
        Ok(())
    }

    fn scroll(&mut self, delta: i32) -> Result<(), String> {
        self.emit(EV_REL, REL_WHEEL, if delta >= 0 { 1 } else { -1 });
        self.sync();
        Ok(())
    }

    fn key(&mut self, code: u32, down: bool) -> Result<(), String> {
        self.emit(EV_KEY, code as u16, if down { 1 } else { 0 });
        self.sync();
        Ok(())
    }

    fn shutdown(&mut self) {
        unsafe {
            libc::ioctl(self.fd, UI_DEV_DESTROY, 0);
            libc::close(self.fd);
        }
    }
}
