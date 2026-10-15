/**
 * macOS 键鼠注入后端：CGEvent（JXA 常驻进程，零编译）
 *
 * macOS 注入只有一条正路：CoreGraphics 的 CGEventCreateMouseEvent /
 * CGEventCreateKeyboardEvent + CGEventPost(kCGHIDEventTap)。
 *
 * 一般不编译原生工具就用不了它，但 osascript 的 JavaScript for Automation（JXA）
 * 可以通过 ObjC 桥直接调 CoreGraphics 的 C 函数：
 *     osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); $.CGEventPost(...)'
 * 所以这里起一个【常驻】osascript 进程（每事件起一次进程要 100ms+，鼠标移动根本没法用），
 * stdin 逐行喂 JSON 命令，进程内直接调 CGEvent。
 *
 * 权限：必须授予「辅助功能」（System Settings → Privacy & Security → Accessibility），
 * 否则 CGEventPost 会被系统静默丢弃（发了也白发）。启动时用 AXIsProcessTrusted()
 * 自检并明确报告，避免"连上了但不动"这种没法排查的状态。
 *
 * 协议：stdin 逐行 JSON：
 *   {"t":"move","x":..,"y":..}（屏幕像素坐标，左上原点，与 CGEvent 的全局坐标系一致）
 *   {"t":"down"|"up","btn":0|1|2}      0=左 1=右 2=中
 *   {"t":"scroll","d":±N}
 *   {"t":"kdown"|"kup","c":<macOS 虚拟键码>}
 *   {"t":"ping"}
 * stdout 逐行 JSON：{"ok":true,...} / {"ok":false,"reason":"..."}
 */
export const CGEVENT_JXA = String.raw`
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
ObjC.import('ApplicationServices')

function out(obj) {
  var s = $.NSString.alloc.initWithUTF8String(JSON.stringify(obj))
  // 写到 stdout（osascript 的 console.log 也走 stderr，这里直接写 fd 1 更可靠）
  var d = s.dataUsingEncoding($.NSUTF8StringEncoding)
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(d)
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($.NSString.alloc.initWithUTF8String('\n').dataUsingEncoding($.NSUTF8StringEncoding))
}

// 辅助功能权限自检：没有权限时 CGEventPost 会被系统丢掉
var trusted = false
try { trusted = $.AXIsProcessTrusted() } catch (e) { trusted = false }

var KCG_HID = 0            // kCGHIDEventTap
var EV_MOUSE_MOVED = 5
var EV_LEFT_DOWN = 1, EV_LEFT_UP = 2
var EV_RIGHT_DOWN = 3, EV_RIGHT_UP = 4
var EV_OTHER_DOWN = 25, EV_OTHER_UP = 26
var EV_SCROLL = 22

function mouseEvent(type, x, y, button) {
  var e = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), button)
  $.CGEventPost(KCG_HID, e)
}

function keyEvent(code, down) {
  var e = $.CGEventCreateKeyboardEvent($(), code, down)
  $.CGEventPost(KCG_HID, e)
}

function scrollEvent(delta) {
  var e = $.CGEventCreateScrollWheelEvent($(), 1 /* kCGScrollEventUnitLine */, 1, delta)
  $.CGEventPost(KCG_HID, e)
}

out({ ok: true, backend: 'cgevent', trusted: trusted,
      reason: trusted ? '' : '未授予「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能 里勾选本应用后重启客户端' })

var stdin = $.NSFileHandle.fileHandleWithStandardInput
var buffer = ''
var count = 0
while (true) {
  var data = stdin.availableData   // 阻塞直到有数据；EOF 返回长度 0
  if (data.length === 0) break
  var chunk = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  buffer += chunk
  var lines = buffer.split('\n')
  buffer = lines.pop()             // 最后一段可能不完整，留到下次
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line) continue
    var c
    try { c = JSON.parse(line) } catch (e) { out({ ok: false, reason: '命令不是合法 JSON: ' + line }); continue }
    try {
      if (c.t === 'move') { mouseEvent(EV_MOUSE_MOVED, c.x, c.y, 0); count++ }
      else if (c.t === 'down' || c.t === 'up') {
        var b = c.btn === 1 ? 1 : c.btn === 2 ? 2 : 0
        var type = b === 0 ? (c.t === 'down' ? EV_LEFT_DOWN : EV_LEFT_UP)
                 : b === 1 ? (c.t === 'down' ? EV_RIGHT_DOWN : EV_RIGHT_UP)
                 : (c.t === 'down' ? EV_OTHER_DOWN : EV_OTHER_UP)
        mouseEvent(type, c.x || 0, c.y || 0, b)
      }
      else if (c.t === 'scroll') { scrollEvent(c.d > 0 ? 1 : -1) }
      else if (c.t === 'kdown' || c.t === 'kup') {
        if (c.c > 0) keyEvent(c.c, c.t === 'kdown')
      }
      else if (c.t === 'ping') { out({ ok: true, pong: true, moved: count }) }
      else { out({ ok: false, reason: '未知命令 t=' + c.t }) }
    } catch (e) {
      out({ ok: false, reason: '执行 ' + c.t + ' 失败: ' + e })
    }
  }
}
out({ ok: true, bye: true })
`
