<script setup lang="ts">
/**
 * 3D 模型预览（three.js）。
 * 通过 IPC 读取已下载到本地的模型文件字节，用对应 loader 解析后渲染：
 * FBX / OBJ / GLTF / GLB / STL。支持轨道旋转 + 缩放。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'

const props = defineProps<{ path: string; name: string }>()
const emit = defineEmits<{ close: [] }>()

const boxEl = ref<HTMLElement | null>(null)
const status = ref('加载中…')
const error = ref('')

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controls: any = null
let raf = 0
let resizeObs: ResizeObserver | null = null

function extOf(name: string): string {
  return (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
}

async function loadAndRender(): Promise<void> {
  const ext = extOf(props.name)
  if (!['fbx', 'obj', 'stl', 'glb', 'gltf'].includes(ext)) {
    error.value = `暂不支持 ${ext.toUpperCase()} 格式预览`
    return
  }
  // 读取本地文件字节（IPC 返回 ArrayBuffer）
  const r = await window.pantry.serverReadFileBytes(props.path)
  if (!r.ok || !r.data) {
    error.value = r.error || '读取模型文件失败'
    return
  }
  const bytes = r.data
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let obj: any
    if (ext === 'obj') {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
      const loader = new (OBJLoader as any)()
      obj = loader.parse(new TextDecoder().decode(bytes))
    } else if (ext === 'fbx') {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
      const loader = new (FBXLoader as any)()
      obj = loader.parse(bytes)
    } else if (ext === 'stl') {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
      const loader = new (STLLoader as any)()
      obj = loader.parse(bytes)
    } else {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
      const loader = new (GLTFLoader as any)()
      const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) =>
        loader.parse(bytes, '', resolve, reject)
      )
      obj = gltf.scene
    }
    fitAndCenter(obj)
    // STL 解析返回 BufferGeometry：包一层 Mesh 便于渲染/居中
    if (ext === 'stl') {
      const mesh = new THREE.Mesh(obj, new THREE.MeshStandardMaterial({ color: 0x9aa5ff, flatShading: true }))
      scene?.add(mesh)
    } else if (scene) {
      scene.add(obj)
    }
    status.value = ''
  } catch (e) {
    error.value = `模型解析失败：${e instanceof Error ? e.message : String(e)}`
  }
}

/** 居中 + 缩放适配可视范围 */
function fitAndCenter(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  const target = 2
  const scale = target / maxDim
  obj.scale.setScalar(scale)
  obj.position.sub(center.clone().multiplyScalar(scale))
}

function animate(): void {
  raf = requestAnimationFrame(animate)
  controls?.update()
  if (renderer && scene && camera) renderer.render(scene, camera)
}

onMounted(async () => {
  if (!boxEl.value) return
  const el = boxEl.value
  const w = el.clientWidth || 640
  const h = el.clientHeight || 480

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xf4f6fa)

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000)
  camera.position.set(2.4, 2, 2.4)

  // 灯光
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8888aa, 0.9)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 1.1)
  dir.position.set(3, 5, 2)
  scene.add(dir)
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.4)
  dir2.position.set(-3, 1, -2)
  scene.add(dir2)

  // 地面网格
  const grid = new THREE.GridHelper(4, 12, 0xbbbbbb, 0xdddddd)
  grid.position.y = -1.2
  scene.add(grid)

  // 轨道控制
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')
  controls = new (OrbitControls as any)(camera, renderer.domElement)
  controls.enableDamping = true
  controls.autoRotate = true
  controls.autoRotateSpeed = 1.5

  resizeObs = new ResizeObserver(() => {
    const cw = el.clientWidth || w
    const ch = el.clientHeight || h
    renderer?.setSize(cw, ch)
    if (camera) {
      camera.aspect = cw / ch
      camera.updateProjectionMatrix()
    }
  })
  resizeObs.observe(el)

  animate()
  void loadAndRender()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObs?.disconnect()
  controls?.dispose()
  renderer?.dispose()
  if (renderer && renderer.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement)
})
</script>

<template>
  <div class="model-mask" @click.self="emit('close')">
    <div class="model-box">
      <div class="model-head">
        <span class="model-title"><i class="fas fa-cube"></i>&nbsp;3D 模型预览</span>
        <div class="model-name" :title="name">{{ name }}</div>
        <button class="model-x" @click="emit('close')"><i class="fas fa-times"></i></button>
      </div>
      <div ref="boxEl" class="model-canvas">
        <div v-if="status" class="model-status">{{ status }}</div>
        <div v-if="error" class="model-error">{{ error }}</div>
      </div>
      <div class="model-foot">
        <span class="model-hint">拖动旋转 · 滚轮缩放</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 140;
}
.model-box {
  width: 720px;
  height: 560px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.model-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dt-border-light);
}
.model-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dt-text);
  flex-shrink: 0;
}
.model-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--dt-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-x {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 14px;
  flex-shrink: 0;
}
.model-x:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.model-canvas {
  flex: 1;
  position: relative;
  min-height: 0;
}
.model-canvas :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}
.model-status {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--dt-text-3);
  font-size: 14px;
}
.model-error {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--dt-danger);
  font-size: 14px;
  text-align: center;
  padding: 0 20px;
}
.model-foot {
  padding: 8px 16px;
  border-top: 1px solid var(--dt-border-light);
  display: flex;
  justify-content: center;
}
.model-hint {
  font-size: 12px;
  color: var(--dt-text-4);
}
</style>
