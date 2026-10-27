/**
 * Mochi OA - 远程控制 UI 控制器（客户端对客户端）。
 *
 * 负责把「请求协助/远程控制」会话接到 RemoteSession，并驱动控制端查看面板
 * （RemoteViewer）与被控端状态提示。信令复用 rtc:signal（房间广播），
 * 密码校验走 socket.io（服务端 rtc:dmCall），LiveKit data 只承载屏幕/控制数据。
 */

import { reactive } from 'vue'
import type { RtcIceServer, RtcKind, RtcSignalPayload, RtcSfuInfo } from '@shared/server-types'
import RemoteSession, { type RemoteMode } from './RemoteSession'
import { useServerStore } from '../stores/server'
import { rlog, rwarn, rerr } from '../../../shared/remote-log'

/** 控制端查看面板显示状态（RemoteViewer 组件订阅） */
export const remoteViewer = reactive({
  open: false,
  /** 对端（被控端）昵称 */
  peerName: '',
  /** 被控端屏幕/声音流 */
  stream: null as MediaStream | null,
  /** 被控端屏幕尺寸 + 键鼠模式（坐标换算用） */
  meta: null as { w: number; h: number; mode: 'remote' | 'local' } | null
})

/** 被控端提示状态（被控制中） */
export const remoteSlaveState = reactive({
  controlling: false,
  byName: ''
})

class RemoteUi {
  private iceFallback(): RtcIceServer[] {
    return [{ urls: 'stun:stun.l.google.com:19302' }]
  }

  /** 控制端：发起/建立远程控制会话并打开独立远程窗口（失败会抛出，由调用方记日志） */
  async openMaster(opts: { room: string; kind: RtcKind; iceServers?: RtcIceServer[]; mode: RemoteMode; peerId: number; peerName?: string; sfu?: RtcSfuInfo }): Promise<void> {
    const server = useServerStore()
    try {
      const r = await window.pantry.openRemoteWindow({
        room: opts.room,
        iceServers: (opts.iceServers ?? this.iceFallback()) as unknown[],
        mode: opts.mode,
        peerId: opts.peerId,
        peerName: opts.peerName ?? '',
        meId: server.state.userId ?? 0,
        sfu: opts.sfu
      })
      if (!r?.ok) throw new Error(r?.error || '远程窗口打开失败')
    } catch (e) {
      console.error('[remote] openMaster 打开远程窗口失败', e)
      throw e
    }
  }

  /** 被控端：同意后启动被控会话（采集屏幕+系统声音+键鼠注入）；peerId=控制端（发起者）userId */
  async openSlave(opts: { room: string; kind: RtcKind; iceServers?: RtcIceServer[]; mode: RemoteMode; peerId: number; byName?: string; sfu?: RtcSfuInfo }): Promise<boolean> {
    const server = useServerStore()
    remoteSlaveState.byName = opts.byName ?? ''
    remoteSlaveState.controlling = true
    rlog('ui', `被控端开始：room=${opts.room} by=${opts.byName ?? ''} mode=${opts.mode}`)
    const ok = await RemoteSession.startSlave({
      room: opts.room,
      sfu: opts.sfu as RtcSfuInfo,
      mode: opts.mode,
      meId: server.state.userId ?? 0,
      peerId: opts.peerId,
      callbacks: {
        onState: (st) => {
          // 会话真的结束（对端 bye / 掉线超时 / 连接失败）→ 立刻撤掉「正在被控制」提示
          if (st.ended) {
            rlog('ui', '会话结束 → 清除「正在被控制」提示')
            remoteSlaveState.controlling = false
          }
        },
        onError: (msg) => {
          rwarn('ui', `被控端会话错误：${msg}`)
          remoteSlaveState.controlling = false
        }
      }
    })
    if (!ok) {
      rerr('ui', '被控端启动会话失败')
      remoteSlaveState.controlling = false
    }
    return ok
  }

  /** 关闭远程会话（任一端主动结束） */
  end(): void {
    rlog('ui', '主动结束远程会话')
    RemoteSession.stop('ui-end')
    remoteViewer.open = false
    remoteViewer.stream = null
    remoteViewer.meta = null
    remoteSlaveState.controlling = false
  }
}

export default new RemoteUi()
