/**
 * Linux 键鼠注入后端：#1 uinput（Python3 常驻，Wayland / X11 都有效）
 *
 * 为什么不用 xdotool：它只能对 X11 生效，Wayland（GNOME/KDE 默认）下注入无效——
 * 这正是「Linux 上鼠标键盘事件都发不过去」的根因。uinput 是内核输入子系统，
 * 建一个虚拟键鼠设备，事件由内核直接派发，与显示服务器无关。
 *
 * 为什么用 Python：uinput 需要 ioctl，Node 没有 ioctl，跑原生插件要 node-gyp 编译；
 * Python3 在桌面发行版上基本都是预装的，用标准库 fcntl+struct 就能完整走完
 * UI_DEV_SETUP / UI_DEV_CREATE / input_event 写入，零编译、零第三方依赖。
 *
 * 权限：/dev/uinput 默认 root:root 0660 —— 需要把用户加入 input 组
 * （sudo usermod -aG input $USER，重新登录）或加一条 udev 规则。脚本会明确报告
 * 打不开的原因，上层据此在控制端提示，而不是静默失败。
 *
 * 协议：stdin 逐行 JSON：
 *   {"t":"move","x":..,"y":..}  绝对坐标（被控端屏幕像素）
 *   {"t":"down"|"up","btn":"left"|"right"|"middle"}
 *   {"t":"scroll","d":±120}     正=上滚
 *   {"t":"kdown"|"kup","c":<evdev keycode>}
 *   {"t":"ping"}                健康检查
 * stdout 逐行 JSON：{"ok":true,...} / {"ok":false,"reason":"..."}
 */
export const UINPUT_PY = String.raw`#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mochi OA 虚拟键鼠（uinput）。由 Electron 主进程以常驻子进程方式启动。"""
import sys, os, json, fcntl, struct, time

DEV = "/dev/uinput"

# ioctl 请求号（_IOW/_IO，见 linux/uinput.h）
def _IO(t, nr): return (t << 8) | nr
def _IOW(t, nr, size): return (1 << 30) | (size << 16) | (t << 8) | nr

UI_IOCTL = ord('U')
UI_DEV_CREATE = _IO(UI_IOCTL, 1)
UI_DEV_DESTROY = _IO(UI_IOCTL, 2)
UI_DEV_SETUP = _IOW(UI_IOCTL, 3, 92)      # struct uinput_setup
UI_ABS_SETUP = _IOW(UI_IOCTL, 4, 28)      # struct uinput_abs_setup
UI_SET_EVBIT = _IOW(UI_IOCTL, 100, 4)
UI_SET_KEYBIT = _IOW(UI_IOCTL, 101, 4)
UI_SET_RELBIT = _IOW(UI_IOCTL, 102, 4)
UI_SET_ABSBIT = _IOW(UI_IOCTL, 103, 4)

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
SYN_REPORT = 0
REL_X, REL_Y, REL_WHEEL, REL_HWHEEL = 0, 1, 8, 6
ABS_X, ABS_Y = 0, 1
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
BUS_USB = 0x03

def log(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def abs_setup(fd, code, minimum, maximum, fuzz=0, flat=0, res=0):
    # struct uinput_abs_setup { __u16 code; __u16 pad; struct input_absinfo absinfo; }
    # struct input_absinfo { __s32 value, minimum, maximum, fuzz, flat, resolution; }
    buf = struct.pack("HH6i", code, 0, 0, int(minimum), int(maximum), int(fuzz), int(flat), int(res))
    fcntl.ioctl(fd, UI_ABS_SETUP, buf)

def main():
    # 屏幕尺寸由上层传入（argv[1]=宽 argv[2]=高），ABS 范围按它设置
    try:
        sw = int(sys.argv[1]); sh = int(sys.argv[2])
    except Exception:
        sw, sh = 1920, 1080
    sw = max(2, sw); sh = max(2, sh)

    try:
        fd = os.open(DEV, os.O_WRONLY | os.O_NONBLOCK)
    except PermissionError as e:
        log(ok=False, reason="没有 " + DEV + " 的写权限（把用户加入 input 组：sudo usermod -aG input $USER 后重新登录，或加 udev 规则）", errno=e.errno)
        return 2
    except FileNotFoundError:
        log(ok=False, reason="不存在 " + DEV + "（内核未启用 uinput 模块：sudo modprobe uinput）")
        return 3
    except Exception as e:
        log(ok=False, reason="打开 " + DEV + " 失败: %s" % e)
        return 4

    try:
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_ABS)
        fcntl.ioctl(fd, UI_SET_RELBIT, REL_X)
        fcntl.ioctl(fd, UI_SET_RELBIT, REL_Y)
        fcntl.ioctl(fd, UI_SET_RELBIT, REL_WHEEL)
        fcntl.ioctl(fd, UI_SET_RELBIT, REL_HWHEEL)
        for btn in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
            fcntl.ioctl(fd, UI_SET_KEYBIT, btn)
        # 键码 1..255 全部打开：上层只发常用键，这里不做白名单，避免漏键
        for k in range(1, 256):
            fcntl.ioctl(fd, UI_SET_KEYBIT, k)
        fcntl.ioctl(fd, UI_SET_ABSBIT, ABS_X)
        fcntl.ioctl(fd, UI_SET_ABSBIT, ABS_Y)
        abs_setup(fd, ABS_X, 0, sw - 1)
        abs_setup(fd, ABS_Y, 0, sh - 1)

        # struct uinput_setup { struct input_id id; char name[80]; __u32 ff_effects_max; }
        # struct input_id { __u16 bustype, vendor, product, version; }
        name = b"Mochi OA Virtual Input"
        setup = struct.pack("HHHH80sI", BUS_USB, 0x1234, 0x5678, 1, name.ljust(80, b"\0"), 0)
        fcntl.ioctl(fd, UI_DEV_SETUP, setup)
        fcntl.ioctl(fd, UI_DEV_CREATE)
    except Exception as e:
        log(ok=False, reason="创建虚拟输入设备失败: %s" % e)
        return 5

    time.sleep(0.2)
    # 先回一个 ready，再开始收命令
    log(ok=True, backend="uinput", screen=[sw, sh], device=DEV)

    ev = struct.Struct("llHHi")   # struct input_event { timeval(2 longs) type code value }
    def emit(etype, code, value):
        os.write(fd, ev.pack(0, 0, etype, code, value))

    def sync():
        emit(EV_SYN, SYN_REPORT, 0)

    btn_map = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}
    moved = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            c = json.loads(line)
        except Exception:
            log(ok=False, reason="命令不是合法 JSON: " + line[:120])
            continue
        t = c.get("t")
        try:
            if t == "move":
                emit(EV_ABS, ABS_X, max(0, min(sw - 1, int(c.get("x", 0)))))
                emit(EV_ABS, ABS_Y, max(0, min(sh - 1, int(c.get("y", 0)))))
                sync()
                moved += 1
            elif t == "down" or t == "up":
                code = btn_map.get(str(c.get("btn", "left")), BTN_LEFT)
                emit(EV_KEY, code, 1 if t == "down" else 0)
                sync()
            elif t == "scroll":
                d = int(c.get("d", 0))
                emit(EV_REL, REL_WHEEL, 1 if d >= 0 else -1)
                sync()
            elif t == "kdown" or t == "kup":
                code = int(c.get("c", 0))
                if code > 0:
                    emit(EV_KEY, code, 1 if t == "kdown" else 0)
                    sync()
            elif t == "ping":
                log(ok=True, pong=True, moved=moved)
            else:
                log(ok=False, reason="未知命令 t=%s" % t)
        except Exception as e:
            log(ok=False, reason="执行 %s 失败: %s" % (t, e))
    try:
        fcntl.ioctl(fd, UI_DEV_DESTROY)
        os.close(fd)
    except Exception:
        pass
    log(ok=True, bye=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
`
