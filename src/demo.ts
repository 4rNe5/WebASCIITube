// 자체 제작 데모 장면: 회전 큐브 + 튀는 공 + 흐르는 바닥 격자
const V = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const F = [
  [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
  [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7],
];

export const DEMO_W = 640;
export const DEMO_H = 360;

export function createDemo() {
  const canvas = document.createElement('canvas');
  canvas.width = DEMO_W;
  canvas.height = DEMO_H;
  const c = canvas.getContext('2d')!;

  function draw(t: number) {
    const W = DEMO_W, H = DEMO_H, hz = 228;
    let g = c.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, '#1b2a44');
    g.addColorStop(1, '#5a6f8f');
    c.fillStyle = g;
    c.fillRect(0, 0, W, hz);
    c.fillStyle = '#14181f';
    c.fillRect(0, hz, W, H - hz);

    c.strokeStyle = '#7d8fa8';
    c.lineWidth = 2;
    for (let i = -8; i <= 8; i++) {
      c.beginPath();
      c.moveTo(W / 2 + i * 26, hz);
      c.lineTo(W / 2 + i * 150, H);
      c.stroke();
    }
    const off = (t * 0.00035) % 1;
    for (let k = 0; k < 7; k++) {
      const z = (k + off) / 7;
      const y = hz + (H - hz) * z * z;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(W, y);
      c.stroke();
    }

    const ay = t * 0.0009;
    const ax = 0.55 + Math.sin(t * 0.0004) * 0.35;
    const s = 62, cx = 210, cy = 150;
    const P = V.map(([x, y, z]) => {
      const x1 = x * Math.cos(ay) - z * Math.sin(ay);
      const z1 = x * Math.sin(ay) + z * Math.cos(ay);
      const y1 = y * Math.cos(ax) - z1 * Math.sin(ax);
      const z2 = y * Math.sin(ax) + z1 * Math.cos(ax);
      const f = 5 / (5 + z2);
      return [cx + x1 * s * f, cy + y1 * s * f, z2];
    });
    F.map((f) => {
      const a = P[f[0]], b = P[f[1]], d = P[f[3]];
      const cross = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
      return { f, cross, z: f.reduce((m, i) => m + P[i][2], 0) / 4 };
    })
      .filter((o) => o.cross < 0)
      .sort((p, q) => q.z - p.z)
      .forEach((o, i) => {
        c.beginPath();
        o.f.forEach((vi, k) => (k ? c.lineTo(P[vi][0], P[vi][1]) : c.moveTo(P[vi][0], P[vi][1])));
        c.closePath();
        const sh = 80 + Math.min(150, Math.abs(o.cross) / 90);
        const hue = [[255, 170, 90], [120, 200, 255], [170, 255, 160]][i % 3];
        c.fillStyle = `rgb(${(hue[0] * sh) / 255},${(hue[1] * sh) / 255},${(hue[2] * sh) / 255})`;
        c.fill();
      });

    const bx = 470;
    const bounce = Math.abs(Math.sin(t * 0.0028));
    const by = 236 - bounce * 120;
    const r = 34;
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.beginPath();
    c.ellipse(bx, 258, r * (1 - bounce * 0.4), 9 * (1 - bounce * 0.4), 0, 0, Math.PI * 2);
    c.fill();
    g = c.createRadialGradient(bx - 12, by - 14, 4, bx, by, r);
    g.addColorStop(0, '#ffe7ef');
    g.addColorStop(1, '#a3375f');
    c.fillStyle = g;
    c.beginPath();
    c.arc(bx, by, r, 0, Math.PI * 2);
    c.fill();
  }

  return { canvas, draw };
}
