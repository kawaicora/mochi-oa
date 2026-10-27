# 服务端 SFU 化改造 + 配置服务端下发 — 实施计划

> 状态：待确认。确认后按此计划实现，逐项验收。
> 覆盖两端：服务端 `mochi-oa-server-go`（分支 report-and-erp-support）、客户端 `mochi-oa`（分支 report-and-erp-support）。

---

## 一、现状梳理（已核实）

### 1. 媒体链路现状
| 场景 | 当前实现 | 结论 |
|---|---|---|
| 视频会议 / 群通话 / 单聊音视频 | 客户端已用 **LiveKit SFU**（`src/renderer/src/rtc/RtcEngine.ts`） | 已 SFU ✅ |
| 服务端会议/通话 | `internal/handlers/rtcdev/rtc.go`：房间状态内存管理 + `rtc:signal` **P2P 信令转发** | 仍 P2P，要改 |
| 远程设备查看/控制 | 客户端 `src/renderer/src/remote/`（RemoteSession/RemoteControl/main）+ 服务端 `rtcdev/dev.go` `dev:signal` **P2P** | 仍 P2P，要改 |
| 系统监控 | 服务端 `rtcdev/sysmon.go`（sys:info/perf/processes） | 非媒体，不动 |

### 2. 客户端 LiveKit 配置现状（要改）
- 来源：本地 `resources/brand.json` 的 `rtc` 段（`window.pantry.getBranding()`）。
- **`apiSecret` 存在客户端**，token 在客户端用 WebCrypto 本地签发（`rtc/livekit.ts` `signLiveKitToken`）。
- 服务端不参与 token 签发、不下发配置。

### 3. 远程控制现状（要改）
- `remote/RemoteSession.ts`：屏幕+系统声音走 **WebRTC track**（P2P）；键鼠控制走 **DataChannel('control')** JSON 协议（控制端→被控端指令、被控端→控制端 meta/bye）。
- 信令：`dev:signal` 经服务端转发 offer/answer/ice。
- 键鼠注入由被控端 main 进程真实执行（IPC），这部分不改。

---

## 二、改造目标

1. **服务端会议/通话**：`rtc:join` / `rtc:createMeeting` 改为**签发 LiveKit token**（客户端连 SFU），移除 P2P `rtc:signal` 媒体信令。
2. **服务端远程查看/控制**：`dev:view` / `dev:start` 改为**同一 LiveKit room**（被控端发布屏幕+声音、控制端订阅），键鼠改走 **LiveKit data 消息**，移除 P2P 信令。
3. **配置服务端下发**：客户端不再内置 LiveKit 配置。服务端从 `.env` 读取 `LIVEKIT_URL/API_KEY/API_SECRET/ROOM_PREFIX`，**服务端统一签发 token**，客户端每次进入向服务端申请。
4. **清理客户端 WebRTC 残留**：会议已是 SFU，仅清理远程控制与无用 P2P 代码。

---

## 三、服务端改动（mochi-oa-server-go）

### 3.1 配置
- `.env` 新增（`.env.example` 同步）：
  ```
  LIVEKIT_URL=wss://live.kawaimoe.org
  LIVEKIT_API_KEY=
  LIVEKIT_API_SECRET=
  LIVEKIT_ROOM_PREFIX=oa
  ```
- `internal/config`：新增字段 `LiveKitURL / LiveKitAPIKey / LiveKitAPISecret / LiveKitRoomPrefix`，解析 `LIVEKIT_*`。
- 未配置 LIVEKIT_API_SECRET → 相关事件返回「SFU 未配置」，不影响其他功能。

### 3.2 新增 LiveKit token 签发（核心）
- 新增 `internal/handlers/rtcdev/livekit.go`：
  - `signLiveKitToken(identity, room string) (token string, err error)`：用 `.env` 的 `API_KEY/API_SECRET` 按 LiveKit JWT 规范签发（`iss/apiKey`、`sub/identity`、`video.grants`：`roomJoin, canPublish, canSubscribe, canPublishData`）。
  - 纯函数 + 注释，复用现有 `nowMs()`/logger 风格。
- **token 只由服务端签发**，客户端不再持有 `apiSecret`。

### 3.3 会议/通话（rtc.go）改 SFU
- `rtc:join`（671 行附近）：入会校验通过后，返回 `{ url, token, roomName }`（`roomName = prefix + "-" + rtcID`），客户端据此连 LiveKit。
- `rtc:createMeeting` / `rtc:getMeeting`：返回房间视图不变（权限/预约仍服务端管），**加返回 `url`**；token 在 join 时签。
- `rtc:signal`（721 行附近）：**P2P 媒体信令废弃**（保留 handler 空转/标记 deprecated，避免旧客户端断开报错；新客户端不再调用）。
- 房间状态（`rooms` map、密码、权限）**全部保留**，服务端仍管。

### 3.4 远程查看/控制（dev.go）改 SFU
- `dev:view` / `dev:start`（517/582 行附近）：校验授权后，为「被控端」与「控制端」签发**同一 LiveKit room** 的 token，返回 `{ url, token, roomName }`。
- `dev:signal`（439 行附近）：**P2P 信令废弃**（保留 deprecated handler）。
- 键鼠/屏幕元数据：客户端改走 LiveKit data 消息，**服务端不再转发**（由 SFU 中继）。

### 3.5 下发配置
- 新增 socket 事件 `app:rtc:config`（或并入现有配置获取）：返回 `{ url, roomPrefix }`（**不含 apiSecret**），客户端据此连接。
- 也可复用 `rtc:join` 返回的 `url`，二者取其一（计划采用「join/start 返回 url + token」为主，不单独下发配置事件，减少改动面）。

---

## 四、客户端改动（mochi-oa）

### 4.1 rtc/livekit.ts —— 去本地签发
- `getRtcConfig()`：不再读 brand.json 的 apiSecret；改为从**服务端 join 响应 / 配置**拿 `url`。
- `signLiveKitToken()`：**删除本地 HMAC 签发**；token 一律由服务端 `rtc:join` / `rtc:dmCall` / `dev:view` 下发。
- `toLiveKitRoomName()`：前缀改由服务端下发（或客户端统一 `oa-`，与服务端一致）。

### 4.2 rtc/RtcEngine.ts —— 会议改服务端拿 token
- `_connect()`（83 行附近）：不再 `getRtcConfig()+signLiveKitToken()`；改为调用 `window.pantry` 新增方法 `serverRtcToken(...)`（触发服务端 `rtc:join`），用返回的 `{ url, token }` 执行 `room.connect(url, token)`。
- 订阅/发布/录制逻辑（TrackSubscribed / 发布轨道 / MediaRecorder）**不动**。

### 4.3 remote/ —— 远程控制改 SFU
- `RemoteSession.ts` / `RemoteControl.ts` / `remote/main.ts`：
  - **屏幕 + 系统声音**：被控端 `room.localParticipant.publishTrack(...)` 发布屏幕/声音；控制端 `TrackSubscribed` 接收 → 绑定 video/audio。
  - **键鼠控制**：改用 LiveKit data 消息（`publishData(JSON, { destination })`）承载现有 `control` JSON 协议；被控端 `RoomEvent.DataReceived` 收指令 → IPC 注入键鼠。
  - **meta / bye**：同走 LiveKit data（发给对端 participant）。
  - 移除 `RTCPeerConnection` / `createDataChannel` / `dev:signal` 信令逻辑。
- 密码校验 / 授权入口（`RemoteUi.ts` 走 socket.io `rtc:dmCall`）**保留**，仅媒体通道换 SFU。

### 4.4 清理 WebRTC 残留
- 删除/停用 `remote/` 下 P2P 专用代码、`RTCPeerConnection` 引用。
- `src/main/index.ts`、`server-ipc.ts` 中 WebRTC 相关注释/逻辑同步更新。
- 保留 `media/VideoStream.ts`（采集抽象，SFU 仍用）。

### 4.5 版本
- 客户端 `package.json` version **+1**，改动完成即提交两端。

---

## 五、键鼠通道技术决策（需你确认）

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. LiveKit data 消息**（推荐） | `publishData(...,{destination})` 承载键鼠指令；延迟略增、走 SFU | 统一 SFU、无需任何 P2P；但键鼠实时性依赖 SFU data 通道 |
| B. 保留 P2P 仅键鼠 | 屏幕走 SFU、键鼠仍直连 DataChannel | 实时性最佳，但保留部分 WebRTC、不彻底 |

**默认选 A**：彻底 SFU 化、架构统一。若你更看重键鼠极致低延迟选 B，告诉我。

---

## 六、验收标准

1. **会议**：进入会议拿到服务端签发的 token，连上 SFU，多方画面/声音互看互听正常；离开/结束正常。
2. **远程查看**：控制端能看到被控端屏幕（SFU 订阅）、声音正常；键鼠点击/拖动/输入能注入到被控端。
3. **无本地密钥**：客户端不存 `apiSecret`，token 全部服务端签发；改服务端 `.env` 的 `LIVEKIT_URL` 后客户端无需改包即生效。
4. **服务端不再转发 P2P 信令**：`rtc:signal` / `dev:signal` 不再承担媒体协商。
5. **build/vet 通过**：服务端 `go build ./...`+`go vet`；客户端 `npm run typecheck:web` 通过。
6. **提交**：两端 `git add -A && commit`，客户端 version+1。

---

## 七、风险与兼容

- **键鼠实时性**：走 SFU data 通道，局域网/低延迟场景基本无感；公网延迟略增。
- **旧客户端兼容**：移除 P2P 信令后，旧版客户端视频/远程会失效——两端同时升级，可接受。
- **SFU 未配置**：服务端 `.env` 缺 `LIVEKIT_API_SECRET` 时相关功能明确报「SFU 未配置」，其余功能不受影响。
- **LiveKit data 权限**：token 的 `video.grants` 必须含 `canPublishData:true`，否则键鼠不可用（计划已含）。

---

## 八、涉及文件清单

**服务端 mochi-oa-server-go**
- `.env` / `.env.example`
- `internal/config/config.go`（+ LK 字段）
- `internal/handlers/rtcdev/livekit.go`（新增：签发 token）
- `internal/handlers/rtcdev/rtc.go`（join 返回 token、signal 弃用）
- `internal/handlers/rtcdev/dev.go`（view/start 返回 token、signal 弃用）

**客户端 mochi-oa**
- `src/renderer/src/rtc/livekit.ts`（去本地签发）
- `src/renderer/src/rtc/RtcEngine.ts`（token 服务端拿）
- `src/renderer/src/remote/RemoteSession.ts` / `RemoteControl.ts` / `remote/main.ts`（SFU 化）
- `src/renderer/src/remote/RemoteUi.ts`（密码入口保留，媒体改 SFU）
- `src/main/index.ts` / `src/main/server-ipc.ts`（pantry 方法：服务端 token）
- `src/shared/server-types.ts`（新增事件/类型）
- `package.json`（version+1）

---

**请确认**：① 键鼠通道选 A（LiveKit data）还是 B（保留 P2P）；② 整体方案 OK 后我开始实现。
