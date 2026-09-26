/** 最小类型声明：flv.js（无官方 @types 包） */
declare module 'flv.js' {
  export interface FlvPlayer {
    attachMediaElement(video: HTMLVideoElement): void
    load(): void
    play(): Promise<void>
    pause(): void
    destroy(): void
  }
  export interface FlvPlayerConfig {
    type: string
    url: string
    isLive?: boolean
    hasAudio?: boolean
    hasVideo?: boolean
  }
  const flvjs: {
    isSupported(): boolean
    createPlayer(config: FlvPlayerConfig, opts?: Record<string, unknown>): FlvPlayer
  }
  export default flvjs
}
