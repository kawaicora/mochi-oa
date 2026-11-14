/**
 * 远程画面鼠标坐标换算（纯函数，node 环境可测，不碰 DOM/IPC）。
 *
 * 画面以 object-fit: contain 显示：视频在容器内等比缩放并居中，两侧/上下留黑边。
 * 若按整个容器矩形把鼠标坐标线性映射到被控端屏幕，黑边会被算进画面，
 * 导致鼠标在横向（左右黑边）或纵向（上下黑边）出现偏移。这里先算出 contain
 * 模式下视频的实际渲染矩形，再在该矩形内做归一化映射，黑边区域钳制到画面边缘。
 */

export interface ContainBox {
  /** 渲染矩形相对容器左上角的 CSS 像素偏移（居中留白） */
  offsetX: number
  offsetY: number
  /** 渲染矩形 CSS 像素尺寸 */
  renderW: number
  renderH: number
}

/** 计算 contain 模式下视频在容器内的实际渲染矩形。 */
export function containBox(
  containerW: number,
  containerH: number,
  frameW: number,
  frameH: number
): ContainBox {
  const cw = Math.max(0, containerW)
  const ch = Math.max(0, containerH)
  const fw = frameW > 0 ? frameW : 1
  const fh = frameH > 0 ? frameH : 1
  const scale = Math.min(cw / fw, ch / fh)
  const renderW = fw * scale
  const renderH = fh * scale
  return {
    offsetX: (cw - renderW) / 2,
    offsetY: (ch - renderH) / 2,
    renderW,
    renderH
  }
}

export interface RemotePoint {
  x: number
  y: number
}

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 把容器内鼠标坐标换算成被控端屏幕像素坐标。
 *
 * @param rect      容器 getBoundingClientRect()
 * @param clientX   鼠标相对视口的 clientX
 * @param clientY   鼠标相对视口的 clientY
 * @param frameW/H  实际画面（视频帧）宽高；取不到时回退被控端屏幕尺寸
 * @param targetW/H 被控端屏幕目标宽高（meta 上报尺寸）
 * @returns 被控端屏幕像素坐标；容器/目标尺寸非法时返回 null
 */
export function mapRemotePoint(
  rect: RectLike,
  clientX: number,
  clientY: number,
  frameW: number,
  frameH: number,
  targetW: number,
  targetH: number
): RemotePoint | null {
  if (!rect.width || !rect.height || !targetW || !targetH) return null
  const box = containBox(rect.width, rect.height, frameW, frameH)
  if (box.renderW <= 0 || box.renderH <= 0) return null
  let nx = (clientX - rect.left - box.offsetX) / box.renderW
  let ny = (clientY - rect.top - box.offsetY) / box.renderH
  nx = Math.min(1, Math.max(0, nx))
  ny = Math.min(1, Math.max(0, ny))
  return { x: Math.round(nx * targetW), y: Math.round(ny * targetH) }
}
