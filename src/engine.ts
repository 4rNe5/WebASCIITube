import { createDemo, DEMO_H, DEMO_W } from './demo';

export type Mode = 'dir' | 'solid' | 'shade';

export interface Settings {
  fontSize: number; // px, 글자 한 칸 높이
  threshold: number; // 0~1, 프레임 상위 5% 윤곽 세기 대비 비율
  mode: Mode;
  color: boolean;
  blur: boolean;
  thin: boolean;
}

export interface Stats {
  name: string;
  kind: SourceKind;
  srcW: number;
  srcH: number;
  cols: number;
  rows: number;
  fps: number;
  playing: boolean;
  muted: boolean;
}

export type SourceKind = 'demo' | 'image' | 'video';

interface Source {
  kind: SourceKind;
  name: string;
  el: CanvasImageSource;
  w: number;
  h: number;
  video?: HTMLVideoElement;
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 10,
  threshold: 0.18,
  mode: 'dir',
  color: false,
  blur: true,
  thin: false,
};

const SHADE = ' .,:;-~=+*';
const EDGE_COLOR = '#ececec';
const SHADE_COLOR = '#6f6f6f';
const MAX_COLS = 600;
const FPS_CAP = 30;

export class AsciiEngine {
  settings: Settings;
  onStats?: (s: Stats) => void;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sCv = document.createElement('canvas');
  private sctx = this.sCv.getContext('2d', { willReadFrequently: true })!;
  private fontFamily: string;
  private charRatio = 0.6;

  private demo = createDemo();
  private demoT = 0;
  private demoRunning = true;
  private source: Source;

  private raf = 0;
  private dirty = true;
  private last = 0;
  private lastNow = 0;
  private peak = 0;
  private fps = 0;
  private fpsN = 0;
  private fpsT = 0;
  private statsT = 0;
  private cols = 0;
  private rows = 0;
  private text = '';

  // 프레임마다 재사용하는 버퍼
  private L = new Float32Array(0);
  private mx = new Float32Array(0);
  private jxx = new Float32Array(0);
  private jyy = new Float32Array(0);
  private jxy = new Float32Array(0);
  private lum = new Float32Array(0);
  private cr = new Float32Array(0);
  private cg = new Float32Array(0);
  private cb = new Float32Array(0);
  private chars = new Uint16Array(0);
  private kinds = new Uint8Array(0); // 0 빈칸, 1 윤곽, 2 명암
  private hist = new Uint32Array(256);
  private colorCache = new Map<number, string>();

  constructor(canvas: HTMLCanvasElement, settings: Settings, fontFamily: string) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.settings = settings;
    this.fontFamily = fontFamily;
    this.source = this.demoSource();
    this.demoRunning = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.measure();
  }

  // ---------- 외부 API ----------
  start() {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.releaseVideo();
  }

  measure() {
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = `100px ${this.fontFamily}`;
    const r = c.measureText('MMMMMMMMMM').width / 1000;
    if (r > 0.3 && r < 1) this.charRatio = r;
    this.dirty = true;
  }

  setSettings(s: Settings) {
    this.settings = s;
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }

  useDemo() {
    this.releaseVideo();
    this.source = this.demoSource();
    this.peak = 0;
    this.dirty = true;
    this.emitStats(true);
  }

  setImage(img: HTMLImageElement, name: string) {
    this.releaseVideo();
    this.source = { kind: 'image', name, el: img, w: img.naturalWidth, h: img.naturalHeight };
    this.peak = 0;
    this.dirty = true;
    this.emitStats(true);
  }

  setVideo(v: HTMLVideoElement, name: string) {
    this.releaseVideo();
    this.source = { kind: 'video', name, el: v, w: v.videoWidth, h: v.videoHeight, video: v };
    this.peak = 0;
    this.dirty = true;
    v.addEventListener('play', () => this.emitStats(true));
    v.addEventListener('pause', () => this.emitStats(true));
    v.addEventListener('volumechange', () => this.emitStats(true));
    this.emitStats(true);
  }

  isPlaying() {
    const s = this.source;
    if (s.kind === 'video') return !!s.video && !s.video.paused;
    if (s.kind === 'demo') return this.demoRunning;
    return false;
  }

  togglePlay() {
    const s = this.source;
    if (s.kind === 'video' && s.video) {
      if (s.video.paused) s.video.play().catch(() => {});
      else s.video.pause();
    } else if (s.kind === 'demo') {
      this.demoRunning = !this.demoRunning;
      this.dirty = true;
    }
    this.emitStats(true);
  }

  toggleMute() {
    const v = this.source.video;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.paused) v.play().catch(() => {});
    this.emitStats(true);
  }

  getText() {
    return this.text;
  }

  // ---------- 내부 ----------
  private demoSource(): Source {
    return { kind: 'demo', name: '데모', el: this.demo.canvas, w: DEMO_W, h: DEMO_H };
  }

  private releaseVideo() {
    const v = this.source?.video;
    if (!v) return;
    v.pause();
    const url = v.src;
    v.removeAttribute('src');
    v.load();
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }

  private emitStats(force = false) {
    const now = performance.now();
    if (!force && now - this.statsT < 500) return;
    this.statsT = now;
    const s = this.source;
    this.onStats?.({
      name: s.name,
      kind: s.kind,
      srcW: s.w,
      srcH: s.h,
      cols: this.cols,
      rows: this.rows,
      fps: this.fps,
      playing: this.isPlaying(),
      muted: s.video ? s.video.muted : true,
    });
  }

  private frame(now: number) {
    const playing = this.isPlaying();
    if (this.source.kind === 'demo' && this.demoRunning) this.demoT += now - (this.lastNow || now);
    this.lastNow = now;
    if (!this.dirty && !(playing && now - this.last >= 1000 / FPS_CAP - 2)) return;

    const s = this.source;
    if (s.kind === 'video' && s.video && s.video.readyState < 2) return;
    if (s.kind === 'demo') this.demo.draw(this.demoT);

    const wasDirty = this.dirty;
    this.render();
    this.last = now;
    this.dirty = false;

    if (playing) {
      this.fpsN++;
      if (now - this.fpsT > 1000) {
        this.fps = (this.fpsN * 1000) / (now - this.fpsT);
        this.fpsN = 0;
        this.fpsT = now;
      }
    } else {
      this.fps = 0;
      this.fpsN = 0;
      this.fpsT = now;
    }
    this.emitStats(wasDirty);
  }

  private ensure(n: number, c: number) {
    if (this.L.length !== n) this.L = new Float32Array(n);
    if (this.mx.length !== c) {
      this.mx = new Float32Array(c);
      this.jxx = new Float32Array(c);
      this.jyy = new Float32Array(c);
      this.jxy = new Float32Array(c);
      this.lum = new Float32Array(c);
      this.cr = new Float32Array(c);
      this.cg = new Float32Array(c);
      this.cb = new Float32Array(c);
      this.chars = new Uint16Array(c);
      this.kinds = new Uint8Array(c);
    } else {
      this.mx.fill(0);
      this.jxx.fill(0);
      this.jyy.fill(0);
      this.jxy.fill(0);
      this.lum.fill(0);
      this.cr.fill(0);
      this.cg.fill(0);
      this.cb.fill(0);
    }
  }

  private render() {
    const { settings: st, source: src } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    if (W < 1 || H < 1) return;
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }

    // ---- 창 전체에 미디어 비율을 맞춘(contain) 글자 격자 ----
    const fs = st.fontSize;
    const cw = fs * this.charRatio;
    const ch = fs;
    let cols = Math.floor(W / cw);
    let rows = Math.round((cols * cw * src.h) / (src.w * ch));
    if (rows > Math.floor(H / ch)) {
      rows = Math.floor(H / ch);
      cols = Math.round((rows * ch * src.w) / (src.h * cw));
    }
    if (cols > MAX_COLS) {
      cols = MAX_COLS;
      rows = Math.round((cols * cw * src.h) / (src.w * ch));
    }
    cols = Math.max(8, cols);
    rows = Math.max(4, rows);
    this.cols = cols;
    this.rows = rows;

    // ---- 샘플링 (픽셀이 정사각형에 가깝도록 셀당 bx × by) ----
    const bx = cols > 200 ? 2 : 3;
    const by = Math.max(2, Math.round(bx / this.charRatio));
    const sw = cols * bx, sh = rows * by;
    if (this.sCv.width !== sw || this.sCv.height !== sh) {
      this.sCv.width = sw;
      this.sCv.height = sh;
    }
    const sx = this.sctx;
    sx.filter = st.blur ? `blur(${bx * 0.25}px)` : 'none';
    sx.drawImage(src.el, 0, 0, sw, sh);
    sx.filter = 'none';
    const d = sx.getImageData(0, 0, sw, sh).data;

    const N = sw * sh, C = cols * rows;
    this.ensure(N, C);
    const { L, mx, jxx, jyy, jxy, lum, cr, cg, cb, chars, kinds, hist } = this;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      L[i] = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
    }

    // ---- 소벨 + 셀별 구조 텐서 누적 ----
    let maxM = 0;
    for (let y = 0; y < sh; y++) {
      const y0 = y > 0 ? y - 1 : 0, y2 = y < sh - 1 ? y + 1 : sh - 1;
      const rowBase = ((y / by) | 0) * cols;
      const r0 = y0 * sw, r1 = y * sw, r2 = y2 * sw;
      for (let x = 0; x < sw; x++) {
        const x0 = x > 0 ? x - 1 : 0, x2 = x < sw - 1 ? x + 1 : sw - 1;
        const a = L[r0 + x0], b = L[r0 + x], c = L[r0 + x2];
        const dl = L[r1 + x0], f = L[r1 + x2];
        const g = L[r2 + x0], h = L[r2 + x], k = L[r2 + x2];
        const gx = c + 2 * f + k - (a + 2 * dl + g);
        const gy = g + 2 * h + k - (a + 2 * b + c);
        const ci = rowBase + ((x / bx) | 0);
        jxx[ci] += gx * gx;
        jyy[ci] += gy * gy;
        jxy[ci] += gx * gy;
        const m = Math.sqrt(gx * gx + gy * gy);
        if (m > mx[ci]) mx[ci] = m;
        if (m > maxM) maxM = m;
        const p = (r1 + x) * 4;
        lum[ci] += L[r1 + x];
        cr[ci] += d[p];
        cg[ci] += d[p + 1];
        cb[ci] += d[p + 2];
      }
    }

    // ---- 프레임 대비 기준값: 셀 윤곽 세기 상위 5% (히스토그램) ----
    hist.fill(0);
    const inv = maxM > 0 ? 255 / maxM : 0;
    for (let i = 0; i < C; i++) hist[Math.min(255, (mx[i] * inv) | 0)]++;
    let acc = 0, bin = 255;
    const target = C * 0.05;
    for (; bin > 0; bin--) {
      acc += hist[bin];
      if (acc >= target) break;
    }
    const p95 = maxM > 0 ? (bin / 255) * maxM : 1e-6;
    const animated = src.kind !== 'image';
    this.peak = animated && this.peak ? this.peak * 0.85 + p95 * 0.15 : p95;
    const thr = st.threshold * Math.max(this.peak, 0.08);

    // ---- 셀 → 문자 ----
    const area = bx * by;
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const i = r * cols + q, m = mx[i];
        let edge = m > thr;
        let th = 0;
        if (edge) {
          th = 0.5 * Math.atan2(2 * jxy[i], jxx[i] - jyy[i]);
          if (st.thin) {
            const dx = Math.round(Math.cos(th)), dy = Math.round(Math.sin(th));
            const r1 = r + dy, q1 = q + dx, r2 = r - dy, q2 = q - dx;
            const n1 = r1 >= 0 && r1 < rows && q1 >= 0 && q1 < cols ? mx[r1 * cols + q1] : 0;
            const n2 = r2 >= 0 && r2 < rows && q2 >= 0 && q2 < cols ? mx[r2 * cols + q2] : 0;
            if (m < n1 || m < n2) edge = false;
          }
        }
        if (edge) {
          kinds[i] = 1;
          if (st.mode === 'solid') chars[i] = 35; // #
          else {
            let a = (th * 180) / Math.PI;
            if (a < 0) a += 180;
            chars[i] = a < 22.5 || a >= 157.5 ? 124 : a < 67.5 ? 47 : a < 112.5 ? 45 : 92; // | / - \
          }
        } else if (st.mode === 'shade') {
          const v = lum[i] / area;
          const ch2 = SHADE.charCodeAt(Math.min(SHADE.length - 1, Math.floor(v * v * SHADE.length)));
          chars[i] = ch2;
          kinds[i] = ch2 === 32 ? 0 : 2;
        } else {
          chars[i] = 32;
          kinds[i] = 0;
        }
      }
    }

    // ---- 그리기 ----
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${fs}px ${this.fontFamily}`;
    ctx.textBaseline = 'top';
    const x0 = Math.round((W - cols * cw) / 2);
    const y0 = Math.round((H - rows * ch) / 2);

    const lines: string[] = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      lines[r] = String.fromCharCode.apply(null, Array.from(chars.subarray(base, base + cols)));
    }
    this.text = lines.join('\n');

    if (!st.color) {
      // 한 줄씩 통째로 그려서 빠르게: 명암(어둡게) → 윤곽(밝게) 두 번
      for (const pass of [2, 1]) {
        ctx.fillStyle = pass === 1 ? EDGE_COLOR : SHADE_COLOR;
        for (let r = 0; r < rows; r++) {
          const base = r * cols;
          let any = false;
          const codes = new Array<number>(cols);
          for (let q = 0; q < cols; q++) {
            if (kinds[base + q] === pass) {
              codes[q] = chars[base + q];
              any = true;
            } else codes[q] = 32;
          }
          if (any) ctx.fillText(String.fromCharCode.apply(null, codes), x0, y0 + r * ch);
        }
      }
    } else {
      for (let r = 0; r < rows; r++) {
        for (let q = 0; q < cols; q++) {
          const i = r * cols + q;
          if (!kinds[i]) continue;
          ctx.fillStyle = this.cellColor(cr[i] / area, cg[i] / area, cb[i] / area, kinds[i] === 2);
          ctx.fillText(String.fromCharCode(chars[i]), x0 + q * cw, y0 + r * ch);
        }
      }
    }
  }

  // 검은 배경에서 보이도록 어두운 색은 끌어올리고, 5비트로 양자화해서 캐시
  private cellColor(r: number, g: number, b: number, dim: boolean) {
    const k = Math.max(r, g, b, 1);
    const target = dim ? 150 : 235;
    const s = k < target ? Math.min(4, target / k) : 1;
    const R = Math.min(255, r * s) >> 3, G = Math.min(255, g * s) >> 3, B = Math.min(255, b * s) >> 3;
    const key = (R << 10) | (G << 5) | B;
    let v = this.colorCache.get(key);
    if (!v) {
      v = `rgb(${R << 3},${G << 3},${B << 3})`;
      this.colorCache.set(key, v);
    }
    return v;
  }
}
