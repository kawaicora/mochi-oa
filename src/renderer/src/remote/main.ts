import { createApp } from 'vue'
import RemoteWindow from './RemoteWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

/**
 * 独立远程控制窗口（控制端）入口。
 * 由 main 进程 openRemoteWindow IPC 打开 remote.html，会话参数经 remoteGetParams
 * 从 main 暂存区取回，然后由 RemoteWindow 壳（无边框标题栏 + 主窗口样式 + 可缩放）
 * 在窗口内建立 WebRTC 会话（屏幕+系统声音 + DataChannel 键鼠控制）。
 */
async function boot(): Promise<void> {
  const params = await window.pantry.remoteGetParams()
  if (!params) {
    document.body.innerHTML = '<div style="padding:40px;color:#9aa0aa;font-size:14px">会话参数缺失，请从主窗口重新发起远程控制</div>'
    return
  }
  const app = createApp(RemoteWindow, {
    room: params.room,
    iceServers: (params.iceServers ?? []) as RTCIceServer[],
    mode: params.mode === 'local' ? ('local' as const) : ('remote' as const),
    peerId: params.peerId,
    peerName: params.peerName || '对端',
    meId: params.meId || 0
  })
  app.mount('#app')
}
void boot()
