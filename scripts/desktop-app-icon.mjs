/**
 * 生成桌面 App 的图标（1024×1024 PNG，纯手画，不引依赖）。
 *
 * 为什么不放一张现成的 png 进仓库：图标是代码算出来的，改配色不用重新导出
 * 素材；仓库里也不必躺一个二进制文件。画法是逐像素求有符号距离场（SDF），
 * 靠距离做 1px 抗锯齿——比拉 canvas 依赖轻，效果够用。
 */

import zlib from 'node:zlib';

const SIZE = 1024;

// ── 配色。深色背景 + 青色雷达环 + 绿色行情线 ──
const BG_TOP = [0x11, 0x1c, 0x27];
const BG_BOTTOM = [0x05, 0x09, 0x0d];
const TEAL = [0x22, 0xd3, 0xee];
const GREEN = [0x34, 0xd3, 0x99];
const WHITE = [0xec, 0xfd, 0xf5];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;

class Canvas {
  constructor(size) {
    this.size = size;
    this.px = new Float32Array(size * size * 4); // 直通 alpha，非预乘
  }

  /** src-over 合成。cov 是这一像素被形状覆盖的比例 */
  blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0) return;
    const i = (y * this.size + x) * 4;
    const p = this.px;
    const a = clamp(alpha, 0, 1);
    const outA = a + p[i + 3] * (1 - a);
    if (outA <= 0) return;
    p[i] = (r * a + p[i] * p[i + 3] * (1 - a)) / outA;
    p[i + 1] = (g * a + p[i + 1] * p[i + 3] * (1 - a)) / outA;
    p[i + 2] = (b * a + p[i + 2] * p[i + 3] * (1 - a)) / outA;
    p[i + 3] = outA;
  }

  /**
   * 按 SDF 填充。sdf 返回像素到形状边界的有符号距离（内部为负，单位像素），
   * 覆盖率取 0.5 - d 截断到 [0,1]，这就是 1px 宽的软边。
   * shade(x, y) 返回 [color, alpha]，让渐变与角向渐变都能复用这一条路径。
   */
  fill(sdf, shade, bounds) {
    const [x0, y0, x1, y1] = bounds ?? [0, 0, this.size - 1, this.size - 1];
    for (let y = Math.max(0, y0 | 0); y <= Math.min(this.size - 1, y1 | 0); y++) {
      for (let x = Math.max(0, x0 | 0); x <= Math.min(this.size - 1, x1 | 0); x++) {
        const cov = clamp(0.5 - sdf(x + 0.5, y + 0.5), 0, 1);
        if (cov <= 0) continue;
        const [color, alpha] = shade(x + 0.5, y + 0.5);
        this.blend(x, y, color, alpha * cov);
      }
    }
  }

  toPNG() {
    const n = this.size * this.size * 4;
    const rgba = Buffer.alloc(n);
    // alpha 在画布里是 0~1，写进 PNG 前要乘回 255；颜色通道本来就是 0~255
    for (let i = 0; i < n; i++) {
      const v = i % 4 === 3 ? this.px[i] * 255 : this.px[i];
      rgba[i] = clamp(Math.round(v), 0, 255);
    }
    return encodePNG(this.size, this.size, rgba);
  }
}

// ── SDF ──
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  );
};

const sdRing = (px, py, cx, cy, radius, width) =>
  Math.abs(Math.hypot(px - cx, py - cy) - radius) - width / 2;

/** 胶囊：带圆头的线段，用来画折线的每一段 */
const sdSegment = (px, py, ax, ay, bx, by, width) => {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - width / 2;
};

const solid = (color, alpha = 1) => () => [color, alpha];

export function renderIcon() {
  const c = new Canvas(SIZE);
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  // 圆角方块。留白按 macOS Big Sur 之后的图标网格来——四周约 100px，
  // 不留的话 Dock 里会比旁边的系统图标显得大一圈
  const pad = 96;
  const half = (SIZE - pad * 2) / 2;
  const plate = (x, y) => sdRoundRect(x, y, cx, cy, half, half, 200);
  c.fill(plate, (_x, y) => {
    const t = (y - pad) / (SIZE - pad * 2);
    return [[mix(BG_TOP[0], BG_BOTTOM[0], t), mix(BG_TOP[1], BG_BOTTOM[1], t), mix(BG_TOP[2], BG_BOTTOM[2], t)], 1];
  });

  // 雷达扫描扇形：从 -45° 起向后拖 100° 的角向渐变，靠边缘再淡出
  const sweepFrom = -Math.PI / 4;
  const sweepSpan = (100 * Math.PI) / 180;
  c.fill(
    (x, y) => Math.hypot(x - cx, y - cy) - 372,
    (x, y) => {
      let d = sweepFrom - Math.atan2(y - cy, x - cx);
      while (d < 0) d += Math.PI * 2;
      while (d > Math.PI * 2) d -= Math.PI * 2;
      if (d > sweepSpan) return [TEAL, 0];
      const angular = 1 - d / sweepSpan;
      const radial = clamp(Math.hypot(x - cx, y - cy) / 372, 0, 1);
      return [TEAL, angular * angular * 0.3 * (0.35 + 0.65 * radial)];
    },
  );

  // 三圈刻度环
  for (const [radius, alpha] of [[150, 0.34], [262, 0.26], [372, 0.2]]) {
    c.fill((x, y) => sdRing(x, y, cx, cy, radius, 5), solid(TEAL, alpha));
  }

  // 扫描线本体
  c.fill(
    (x, y) =>
      sdSegment(x, y, cx, cy, cx + Math.cos(sweepFrom) * 372, cy + Math.sin(sweepFrom) * 372, 7),
    solid(TEAL, 0.75),
  );

  // 行情折线。刻意先跌后涨，比一条直线更像 K 线走势
  const pts = [
    [292, 610],
    [396, 546],
    [470, 626],
    [576, 470],
    [660, 528],
    [742, 372],
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    c.fill((x, y) => sdSegment(x, y, ax, ay, bx, by, 30), solid(GREEN, 1), [
      Math.min(ax, bx) - 24,
      Math.min(ay, by) - 24,
      Math.max(ax, bx) + 24,
      Math.max(ay, by) + 24,
    ]);
  }

  // 折线末端的光点：先铺一圈辉光，再压一个实心点
  const [hx, hy] = pts[pts.length - 1];
  c.fill(
    (x, y) => Math.hypot(x - hx, y - hy) - 88,
    (x, y) => [GREEN, 0.42 * (1 - clamp(Math.hypot(x - hx, y - hy) / 88, 0, 1)) ** 1.6],
  );
  c.fill((x, y) => Math.hypot(x - hx, y - hy) - 34, solid(WHITE, 1));

  return c.toPNG();
}

// ── 最小 PNG 编码器（8-bit RGBA，无滤波） ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 每行滤波类型 None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
