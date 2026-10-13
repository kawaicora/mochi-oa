// Pure DrawingML geometry evaluator. Operates on plain data (presets.json) -> SVG path d.
// No DOM dependency: usable in the renderer (browser) and in Node unit tests.
// Semantics aligned to office-render-knowledge 03 (custGeom) / 04 (prstGeom).

const RAD = Math.PI / 10800000; // 60000ths of a degree -> radians

// ---- token / number / guide resolution ----
// tok: string like "l", "r", "x1", "adj1", "1234", "cd4", "hd2", "3cd8"
function resolveArg(tok, ctx, visiting) {
  if (tok == null) return 0;
  const s = String(tok).trim();
  if (s === '') return 0;
  if (/^-?[\d.]+$/.test(s)) return parseFloat(s);
  const W = ctx.logwidth, H = ctx.logheight;
  const mn = Math.min(W, H), mx = Math.max(W, H);
  switch (s) {
    case 'l': case 't': return 0;
    case 'r': return W;
    case 'b': return H;
    case 'w': case 'logwidth': return W;
    case 'h': case 'logheight': return H;
    case 'ls': return mx;
    case 'ss': return mn;
    case 'vc': return H / 2;
    case 'hc': return W / 2;
    case 'cd8': return 45 * 60000;
    case 'cd4': return 90 * 60000;
    case 'cd3': return 120 * 60000;
    case 'cd2': return 180 * 60000;
    case '3cd8': return 135 * 60000;
    case '5cd8': return 225 * 60000;
    case '7cd8': return 315 * 60000;
  }
  let m;
  if ((m = /^hd(\d+)$/.exec(s))) return H / +m[1];
  if ((m = /^wd(\d+)$/.exec(s))) return W / +m[1];
  if ((m = /^ssd(\d+)$/.exec(s))) return mn / +m[1];
  if (Object.prototype.hasOwnProperty.call(ctx.adj, s)) return ctx.adj[s];
  return evalGuide(s, ctx, visiting);
}

function evalGuide(name, ctx, visiting) {
  if (visiting.has(name)) return 0; // loop
  if (ctx._cache && ctx._cache[name] !== undefined) return ctx._cache[name];
  let g;
  for (let i = ctx.gdList.length - 1; i >= 0; i--) { // duplicate name -> last wins
    if (ctx.gdList[i][0] === name) { g = ctx.gdList[i]; break; }
  }
  if (!g) return 0;
  visiting.add(name);
  const v = evalFmla(g.slice(1), ctx, visiting);
  visiting.delete(name);
  (ctx._cache || (ctx._cache = {}))[name] = v;
  return v;
}

// fmla: array of tokens [op, a1, a2, a3]
function evalFmla(fmla, ctx, visiting = new Set()) {
  const op = fmla[0];
  const A = (t) => resolveArg(t, ctx, visiting);
  switch (op) {
    case 'val': return A(fmla[1]);
    case '*/': return A(fmla[1]) * A(fmla[2]) / A(fmla[3]); // a*b/c
    case '+-': return A(fmla[1]) + A(fmla[2]) - A(fmla[3]); // a+b-c
    case '+/': return (A(fmla[1]) + A(fmla[2])) / A(fmla[3]); // (a+b)/c
    case 'abs': return Math.abs(A(fmla[1]));
    case 'sqrt': return Math.sqrt(Math.abs(A(fmla[1])));
    case 'sin': return A(fmla[1]) * Math.sin(A(fmla[2]) * RAD);
    case 'cos': return A(fmla[1]) * Math.cos(A(fmla[2]) * RAD);
    case 'tan': return A(fmla[1]) * Math.tan(A(fmla[2]) * RAD);
    case 'at2': return 10800000 * Math.atan2(A(fmla[2]), A(fmla[1])) / Math.PI;
    case 'max': return Math.max(A(fmla[1]), A(fmla[2]));
    case 'min': return Math.min(A(fmla[1]), A(fmla[2]));
    case 'cat2': { const r = A(fmla[1]), x = A(fmla[2]), y = A(fmla[3]); return r * Math.cos(Math.atan2(y, x)); }
    case 'sat2': { const r = A(fmla[1]), x = A(fmla[2]), y = A(fmla[3]); return r * Math.sin(Math.atan2(y, x)); }
    case 'mod': { const a = A(fmla[1]), b = A(fmla[2]), c = A(fmla[3] || 0); return Math.sqrt(a * a + b * b + c * c); }
    case 'pin': { const lo = A(fmla[1]), v = A(fmla[2]), hi = A(fmla[3]); return Math.min(Math.max(v, lo), hi); }
    case 'if': case '?:': return A(fmla[1]) > 0 ? A(fmla[2]) : A(fmla[3]);
    default: return 0;
  }
}

// arcTo (wR,hR,stAng,swAng in 60000ths of a degree) at current point cur=[x,y] (coord space)
function arcToToSvg(cur, wR, hR, stAng, swAng) {
  let swDeg = swAng / 60000;
  swDeg = Math.max(-360, Math.min(360, swDeg));
  const sr = (stAng / 60000) * Math.PI / 180;
  const er = (stAng / 60000 + swDeg) * Math.PI / 180;
  const ex = cur[0] + wR * (Math.cos(er) - Math.cos(sr));
  const ey = cur[1] + hR * (Math.sin(er) - Math.sin(sr));
  const large = Math.abs(swDeg) > 180 ? 1 : 0;
  const sweep = swDeg >= 0 ? 1 : 0;
  return { args: [wR, hR, 0, large, sweep, ex, ey], end: [ex, ey] };
}

// Merge preset default adjustments with user overrides. userAv: {name:number}
function buildAdj(presetAv, userAv) {
  const adj = {};
  for (const gd of presetAv || []) {
    // default adjustment fmla is "val N"
    adj[gd[0]] = gd[1] === 'val' ? parseFloat(gd[2]) : 0;
  }
  if (userAv) Object.assign(adj, userAv);
  return adj;
}

// Render a preset -> { viewBox:[w,h], paths:[{d,fill,stroke}], textRect:[l,t,r,b] (coord space) }
// preset: entry from presets.json. userAv: {adjName:number} overrides.
export function renderPreset(preset, userAv) {
  const adj = buildAdj(preset.av, userAv);
  const out = { viewBox: [21600, 21600], paths: [], textRect: null };
  for (const path of preset.paths || []) {
    const pw = path.w, ph = path.h;
    out.viewBox = [pw, ph];
    const ctx = { adj, gdList: preset.gd || [], logwidth: pw, logheight: ph, _cache: {} };
    const resol = (tok) => resolveArg(tok, ctx, new Set());
    let cur = [0, 0];
    const pt = (xTok, yTok) => [resol(xTok), resol(yTok)];
    let d = '';
    for (const seg of path.segs) {
      const c = seg[0];
      if (c === 'moveTo') { const p = pt(seg[1], seg[2]); cur = p; d += `M ${p[0]} ${p[1]} `; }
      else if (c === 'lnTo') { const p = pt(seg[1], seg[2]); cur = p; d += `L ${p[0]} ${p[1]} `; }
      else if (c === 'quadBezTo') {
        const c1 = pt(seg[1], seg[2]), e = pt(seg[3], seg[4]); cur = e;
        d += `Q ${c1[0]} ${c1[1]} ${e[0]} ${e[1]} `;
      } else if (c === 'cubicBezTo') {
        const c1 = pt(seg[1], seg[2]), c2 = pt(seg[3], seg[4]), e = pt(seg[5], seg[6]); cur = e;
        d += `C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${e[0]} ${e[1]} `;
      } else if (c === 'arcTo') {
        const a = arcToToSvg(cur, resol(seg[1]), resol(seg[2]), resol(seg[3]), resol(seg[4]));
        cur = a.end;
        d += `A ${a.args.join(' ')} `;
      } else if (c === 'close') { d += 'Z '; }
    }
    out.paths.push({ d: d.trim(), fill: path.fill, stroke: path.stroke });
  }
  if (preset.rect) {
    const ctx = { adj, gdList: preset.gd || [], logwidth: out.viewBox[0], logheight: out.viewBox[1], _cache: {} };
    const resol = (tok) => resolveArg(tok, ctx, new Set());
    out.textRect = [resol(preset.rect.l), resol(preset.rect.t), resol(preset.rect.r), resol(preset.rect.b)];
  }
  return out;
}

export { evalFmla, resolveArg, arcToToSvg, buildAdj };

// ---- srcRect: crop edges of the SOURCE image (0..100000 = 1/1000 percent per edge) ----
// Returns geometry for a wrapper(overflow:hidden, dw x dh) + inner <img>.
// dw/dh: display box in pt. l/t/r/b: srcRect attrs (0..100000).
export function srcRectCss(l = 0, t = 0, r = 0, b = 0, dwPt = 0, dhPt = 0) {
  const L = l / 100000, T = t / 100000, R = r / 100000, B = b / 100000
  const visW = Math.max(1e-6, 1 - L - R)
  const visH = Math.max(1e-6, 1 - T - B)
  return {
    imgW: dwPt / visW,
    imgH: dhPt / visH,
    imgLeft: (-dwPt * L) / visW,
    imgTop: (-dhPt * T) / visH,
    visW,
    visH
  }
}

// ---- a:effectLst/a:outerShdw -> CSS filter: drop-shadow(...) ----
// sh: { blurRad, dist, dir, algn, color(hex no '#'), alpha(0..100000) } | null
// Semantics (ECMA-376 §20.1.8.47 + LO oox effectproperties.cxx pushToPropMap):
//   offsetX = cos(dir) * dist ; offsetY = sin(dir) * dist   (dir 单位 60000°)
//   algn 指定阴影相对形状朝哪个角/边偏移（本文件 algn='tl' → 朝右下投影）；
//   dist 缺省 38100 EMU(3pt)，dir 缺省 5400000(=90° 竖直向下)。
//   alpha 100000=不透明；blurRad/dist 均为 EMU，输出统一为 pt（1pt=12700EMU）。
// 返回 '' 表示无阴影。CSS drop-shadow 沿元素 alpha 轮廓投影（配合 clip-path 即沿遮罩轮廓）。
const SH_EMU = 12700
export function outerShdwCss(sh) {
  if (!sh) return ''
  const blur = (Number(sh.blurRad) || 0) / SH_EMU
  const dist = (Number(sh.dist) || 38100) / SH_EMU
  const algn = sh.algn || ''
  let dx, dy
  if (algn) {
    const c = Math.SQRT1_2 // 45° 角对角偏移
    switch (algn) {
      case 'tl': dx = c; dy = c; break    // 阴影朝右下（Word 默认 Outer Offset）
      case 't': dx = 0; dy = 1; break
      case 'tr': dx = -c; dy = c; break
      case 'l': dx = 1; dy = 0; break
      case 'ctr': dx = 0; dy = 0; break
      case 'r': dx = -1; dy = 0; break
      case 'bl': dx = c; dy = -c; break
      case 'b': dx = 0; dy = -1; break
      case 'br': dx = -c; dy = -c; break
      default: dx = 0; dy = 0
    }
  } else {
    const dirRad = ((Number(sh.dir) || 5400000) / 60000) * Math.PI / 180
    dx = Math.cos(dirRad); dy = Math.sin(dirRad)
  }
  const ox = dx * dist, oy = dy * dist
  const alpha = ((sh.alpha == null ? 100000 : Number(sh.alpha)) / 100000)
  const col = (sh.color || '000000').replace('#', '')
  const r = parseInt(col.slice(0, 2), 16) || 0
  const g = parseInt(col.slice(2, 4), 16) || 0
  const b = parseInt(col.slice(4, 6), 16) || 0
  return `drop-shadow(${ox.toFixed(2)}pt ${oy.toFixed(2)}pt ${blur.toFixed(2)}pt rgba(${r},${g},${b},${alpha.toFixed(3)}))`
}

// ---- 预设遮罩轮廓的多边形顶点（pt 坐标空间），用于沿遮罩画 SVG 描边边框 ----
// 与 applyGeometryMask 的 CSS clip-path 同一套切角数学（s = min(w,h)/6）。
// 返回 [[x,y],...]（已闭合多边形的顶点序列）；非多边形预设（rect/roundRect/ellipse/circle）返回 null。
export function maskPolygonPts(geom, w, h) {
  const s = Math.min(w, h) / 6
  switch (geom) {
    case 'snip2DiagRect':
      return [[0, 0], [w - s, 0], [w, s], [w, h], [s, h], [0, h - s]]
    case 'snip1Rect':
      return [[0, 0], [w - s, 0], [w, s], [w, h], [0, h]]
    case 'snip2SameRect':
      return [[s, 0], [w - s, 0], [w, s], [w, h], [s, h], [0, h - s], [0, s]]
    default:
      return null
  }
}

// ---- wp:wrapPolygon 多边形绕排：在对象垂直中线处求左/右内缩(pt) ----
// wrapPts: 21600 逻辑网格顶点 [[x,y],...]；w/h: 对象 pt 尺寸。
// 返回 { insetL, insetR }：中线处多边形相对包围盒左/右边缘的内缩。
// 用于把 float 占位向文字侧收窄（文字可贴到切角处更近）；只收窄不放宽，安全。
// snip2DiagRect 中线处仍占满整宽 → inset 全 0（与 square 近似一致，不改变布局）。
export function wrapInsetAtMid(wrapPts, w, h) {
  if (!wrapPts || wrapPts.length < 3) return { insetL: 0, insetR: 0 }
  const G = 21600
  const pts = wrapPts.map(([x, y]) => [(x / G) * w, (y / G) * h])
  const midY = h / 2
  let minX = w, maxX = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    if ((y1 - midY) * (y2 - midY) > 0) continue // 两端都在中线同侧 → 不相交
    if (y1 === y2) continue
    const t = (midY - y1) / (y2 - y1)
    if (t < 0 || t > 1) continue
    const x = x1 + t * (x2 - x1)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
  }
  if (minX > maxX) return { insetL: 0, insetR: 0 }
  return { insetL: Math.max(0, minX), insetR: Math.max(0, w - maxX) }
}

// ---- InkML trace -> SVG path ----
// A trace is a flat list of (x,y[,pressure][,...]) comma-separated points.
// Normalize by the ink bounding box (traceGroup boundingBox) into [0..1], then scale to the box.
// points: [[x,y],...]; bbox: {minX,minY,maxX,maxY}; outW/outH: display size (any unit, e.g. 0..21600).
export function inkTraceToSvg(points, bbox, outW = 21600, outH = 21600, pad = 0) {
  if (!points || points.length === 0) return ''
  const bw = bbox.maxX - bbox.minX || 1
  const bh = bbox.maxY - bbox.minY || 1
  const sx = (outW - pad * 2) / bw
  const sy = (outH - pad * 2) / bh
  let d = ''
  points.forEach((p, i) => {
    const x = pad + (p[0] - bbox.minX) * sx
    const y = pad + (p[1] - bbox.minY) * sy
    d += (i === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2) + ' '
  })
  return d.trim()
}

