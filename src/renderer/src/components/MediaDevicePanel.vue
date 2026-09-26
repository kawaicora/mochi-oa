<script setup lang="ts">
/**
 * 音视频设备 + 音质面板（通话/会议内「更多」菜单）。
 * 枚举音频输入/输出/摄像头，选择音质（采样率/声道），点击「应用」后把参数 emit 给父级执行切换。
 */
import { ref, onMounted } from 'vue'
import VideoStream from '../media/VideoStream'

const emit = defineEmits<{
  (e: 'apply', payload: { audioInId: string; audioOutId: string; cameraId: string; sampleRate: number; channelCount: number }): void
}>()

const audioInputs = ref<MediaDeviceInfo[]>([])
const audioOutputs = ref<MediaDeviceInfo[]>([])
const cameraInputs = ref<MediaDeviceInfo[]>([])
const audioInId = ref('default')
const audioOutId = ref('')
const cameraId = ref('default')
const sampleRate = ref(48000)
const channelCount = ref(2)
const applying = ref(false)
const error = ref('')

async function load(): Promise<void> {
  try {
    const [ai, ao, cv] = await Promise.all([
      VideoStream.GetAudioDevices(),
      VideoStream.GetAudioOutputDevices(),
      VideoStream.GetVideoDevices()
    ])
    audioInputs.value = ai
    audioOutputs.value = ao
    cameraInputs.value = cv
  } catch {
    /* ignore */
  }
}

function apply(): void {
  if (applying.value) return
  applying.value = true
  error.value = ''
  emit('apply', {
    audioInId: audioInId.value,
    audioOutId: audioOutId.value,
    cameraId: cameraId.value,
    sampleRate: sampleRate.value,
    channelCount: channelCount.value
  })
  applying.value = false
}

onMounted(load)
</script>

<template>
  <div class="media-dev-panel">
    <div class="mdp-title">音视频设备与音质</div>
    <div class="mdp-row">
      <label>音频输入（麦克风）</label>
      <select v-model="audioInId">
        <option value="default">系统默认</option>
        <option v-for="d in audioInputs" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId }}</option>
      </select>
    </div>
    <div class="mdp-row">
      <label>音频输出（扬声器）</label>
      <select v-model="audioOutId">
        <option value="">系统默认</option>
        <option v-for="d in audioOutputs" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId }}</option>
      </select>
    </div>
    <div class="mdp-row">
      <label>摄像头</label>
      <select v-model="cameraId">
        <option value="default">关闭摄像头</option>
        <option v-for="d in cameraInputs" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId }}</option>
      </select>
    </div>
    <div class="mdp-row">
      <label>采样率（音质）</label>
      <select v-model.number="sampleRate">
        <option :value="48000">48000 Hz（高清，推荐）</option>
        <option :value="44100">44100 Hz</option>
        <option :value="32000">32000 Hz</option>
        <option :value="16000">16000 Hz</option>
      </select>
    </div>
    <div class="mdp-row">
      <label>声道</label>
      <select v-model.number="channelCount">
        <option :value="2">2（立体声，乐队/演出推荐）</option>
        <option :value="1">1（单声道）</option>
      </select>
    </div>
    <div class="mdp-hint">音质 16bit、画面使用采集原始分辨率，不重新采样压缩。</div>
    <div v-if="error" class="mdp-error">{{ error }}</div>
    <div class="mdp-actions">
      <button class="mdp-apply" :disabled="applying" @click="apply">应用</button>
    </div>
  </div>
</template>

<style scoped>
.media-dev-panel {
  width: 300px;
  background: #1a1a2e;
  border: 1px solid #2d2d44;
  border-radius: 8px;
  padding: 12px 14px;
  color: #e6e6e6;
  font-size: 13px;
}
.mdp-title { font-weight: 600; margin-bottom: 10px; }
.mdp-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.mdp-row label { color: #8a8f99; font-size: 12px; }
.mdp-row select {
  background: #0d1117;
  border: 1px solid #2d2d44;
  border-radius: 6px;
  color: #e6e6e6;
  font-size: 13px;
  padding: 6px 8px;
  outline: none;
}
.mdp-hint { color: #6b7280; font-size: 11px; margin-bottom: 10px; }
.mdp-error { color: #ff6b6b; font-size: 12px; margin-bottom: 8px; }
.mdp-actions { display: flex; justify-content: flex-end; }
.mdp-apply {
  background: #1677ff;
  border: none;
  color: #fff;
  padding: 7px 20px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
.mdp-apply:hover { background: #3a8aff; }
.mdp-apply:disabled { opacity: 0.5; cursor: default; }
</style>
