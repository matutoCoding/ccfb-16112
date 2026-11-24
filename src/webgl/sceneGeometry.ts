import type { ProjectState, Vec3 } from '../types';
import { workerOccluders, type WorkerRig } from '../lib/occlusion';
import { wireOuterRadius } from '../lib/routing';
import { createRig, coveragePolygon } from '../lib/projectors';

export interface SceneGeometry {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
  linePositions: number[];
  lineColors: number[];
  triangleCount: number;
}

export interface BuildSceneOptions {
  /** 只包含 sequence < beforeSequence 的导线；不传则全部 */
  beforeSequence?: number;
  worker?: WorkerRig | null;
  showProjectorFrusta?: boolean;
}

function hexRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h || '888888', 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

class GeoBuilder implements SceneGeometry {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];
  linePositions: number[] = [];
  lineColors: number[] = [];
  triangleCount = 0;

  vertex(p: Vec3, n: Vec3, color: [number, number, number], shade = 1): number {
    const id = this.positions.length / 3;
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.colors.push(color[0] * shade, color[1] * shade, color[2] * shade);
    return id;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
    this.triangleCount++;
  }

  line(a: Vec3, b: Vec3, color: [number, number, number]): void {
    this.linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    this.lineColors.push(...color, ...color);
  }

  box(center: Vec3, size: Vec3, hex: string, rotZ = 0): void {
    const color = hexRgb(hex);
    const hx = size.x / 2, hy = size.y / 2, hz = size.z / 2;
    const cos = Math.cos(rotZ), sin = Math.sin(rotZ);
    const tr = (x: number, y: number, z: number): Vec3 => ({
      x: center.x + x * cos - y * sin,
      y: center.y + x * sin + y * cos,
      z: center.z + z
    });
    const nr = (x: number, y: number, z: number): Vec3 => ({
      x: x * cos - y * sin,
      y: x * sin + y * cos,
      z
    });
    const faces: Array<{ n: Vec3; corners: Array<[number, number, number]> }> = [
      { n: { x: 1, y: 0, z: 0 }, corners: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
      { n: { x: -1, y: 0, z: 0 }, corners: [[-hx, hy, -hz], [-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz]] },
      { n: { x: 0, y: 1, z: 0 }, corners: [[hx, hy, -hz], [-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz]] },
      { n: { x: 0, y: -1, z: 0 }, corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
      { n: { x: 0, y: 0, z: 1 }, corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
      { n: { x: 0, y: 0, z: -1 }, corners: [[-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz], [-hx, -hy, -hz]] }
    ];
    for (const face of faces) {
      const base = this.positions.length / 3;
      const n = nr(face.n.x, face.n.y, face.n.z);
      face.corners.forEach((c, i) => {
        const p = tr(c[0], c[1], c[2]);
        this.vertex(p, n, color, i < 2 ? 0.92 : 1);
      });
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.triangleCount += 2;
    }
  }

  cylinder(a: Vec3, b: Vec3, radius: number, hex: string, segments = 8): void {
    const color = hexRgb(hex);
    const axisVec = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.hypot(axisVec.x, axisVec.y, axisVec.z);
    if (len < 0.01) return;
    const axis = { x: axisVec.x / len, y: axisVec.y / len, z: axisVec.z / len };
    const ref = Math.abs(axis.z) < 0.92 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    const t1raw = {
      x: axis.y * ref.z - axis.z * ref.y,
      y: axis.z * ref.x - axis.x * ref.z,
      z: axis.x * ref.y - axis.y * ref.x
    };
    const l1 = Math.hypot(t1raw.x, t1raw.y, t1raw.z) || 1;
    const t1 = { x: t1raw.x / l1, y: t1raw.y / l1, z: t1raw.z / l1 };
    const t2 = {
      x: axis.y * t1.z - axis.z * t1.y,
      y: axis.z * t1.x - axis.x * t1.z,
      z: axis.x * t1.y - axis.y * t1.x
    };
    const ring = (p: Vec3, i: number): { p: Vec3; n: Vec3 } => {
      const ang = (i / segments) * Math.PI * 2;
      const co = Math.cos(ang), si = Math.sin(ang);
      const radial = {
        x: t1.x * co + t2.x * si,
        y: t1.y * co + t2.y * si,
        z: t1.z * co + t2.z * si
      };
      return {
        p: { x: p.x + radial.x * radius, y: p.y + radial.y * radius, z: p.z + radial.z * radius },
        n: radial
      };
    };

    const base = this.positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const ra = ring(a, i);
      const rb = ring(b, i);
      this.vertex(ra.p, ra.n, color);
      this.vertex(rb.p, rb.n, color);
    }
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const ai = base + i * 2;
      const bi = ai + 1;
      const aj = base + j * 2;
      const bj = aj + 1;
      this.indices.push(ai, bi, aj, aj, bi, bj);
      this.triangleCount += 2;
    }

    // 端盖
    const addCap = (p: Vec3, n: Vec3, sign: number) => {
      const center = this.vertex(p, n, color, 0.85);
      const start = this.positions.length / 3;
      for (let i = 0; i < segments; i++) {
        const rp = ring(p, i).p;
        this.vertex(rp, n, color, 0.9);
      }
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        if (sign > 0) this.indices.push(center, start + i, start + j);
        else this.indices.push(center, start + j, start + i);
        this.triangleCount++;
      }
    };
    addCap(a, { x: -axis.x, y: -axis.y, z: -axis.z }, -1);
    addCap(b, axis, 1);
  }

  sphere(center: Vec3, radius: number, hex: string, lat = 6, lon = 10): void {
    const color = hexRgb(hex);
    const base = this.positions.length / 3;
    for (let iy = 0; iy <= lat; iy++) {
      const theta = (iy / lat) * Math.PI;
      const st = Math.sin(theta), ct = Math.cos(theta);
      for (let ix = 0; ix <= lon; ix++) {
        const phi = (ix / lon) * Math.PI * 2;
        const n = { x: st * Math.cos(phi), y: st * Math.sin(phi), z: ct };
        this.vertex(
          { x: center.x + n.x * radius, y: center.y + n.y * radius, z: center.z + n.z * radius },
          n,
          color
        );
      }
    }
    const row = lon + 1;
    for (let iy = 0; iy < lat; iy++) {
      for (let ix = 0; ix < lon; ix++) {
        const a = base + iy * row + ix;
        const b = a + row;
        this.indices.push(a, b, a + 1, a + 1, b, b + 1);
        this.triangleCount += 2;
      }
    }
  }

  toGeometry(): SceneGeometry {
    return {
      positions: this.positions,
      normals: this.normals,
      colors: this.colors,
      indices: this.indices,
      linePositions: this.linePositions,
      lineColors: this.lineColors,
      triangleCount: this.triangleCount
    };
  }
}

export function buildSceneGeometry(state: ProjectState, options: BuildSceneOptions = {}): SceneGeometry {
  const g = new GeoBuilder();
  const boardColor = state.board.color;

  // 板体：板面 z=0，厚度向 -Z
  g.box(
    { x: state.board.width / 2, y: state.board.height / 2, z: -state.board.thickness / 2 },
    { x: state.board.width, y: state.board.height, z: state.board.thickness },
    boardColor
  );
  // 铝边框
  const edge = '#4b5563';
  g.box({ x: state.board.width / 2, y: -12, z: -8 }, { x: state.board.width + 24, y: 24, z: 34 }, edge);
  g.box({ x: state.board.width / 2, y: state.board.height + 12, z: -8 }, { x: state.board.width + 24, y: 24, z: 34 }, edge);
  g.box({ x: -12, y: state.board.height / 2, z: -8 }, { x: 24, y: state.board.height, z: 34 }, edge);
  g.box({ x: state.board.width + 12, y: state.board.height / 2, z: -8 }, { x: 24, y: state.board.height, z: 34 }, edge);

  // DXF 参考线
  if (state.board.dxf) {
    const dxfColor: [number, number, number] = [0.13, 0.78, 0.95];
    for (const e of state.board.dxf.entities) {
      if (e.type === 'line' && e.points && e.points.length === 2) {
        g.line({ ...e.points[0], z: 0.35 }, { ...e.points[1], z: 0.35 }, dxfColor);
      } else if (e.type === 'polyline' && e.points) {
        for (let i = 1; i < e.points.length; i++) g.line({ ...e.points[i - 1], z: 0.35 }, { ...e.points[i], z: 0.35 }, dxfColor);
      } else if ((e.type === 'circle' || e.type === 'arc') && e.center && e.radius) {
        const a0 = e.type === 'arc' ? ((e.startAngle ?? 0) * Math.PI) / 180 : 0;
        const a1 = e.type === 'arc' ? ((e.endAngle ?? 360) * Math.PI) / 180 : Math.PI * 2;
        const steps = 40;
        let prev: Vec3 | null = null;
        for (let i = 0; i <= steps; i++) {
          const a = a0 + ((a1 - a0) * i) / steps;
          const p = { x: e.center.x + Math.cos(a) * e.radius, y: e.center.y + Math.sin(a) * e.radius, z: 0.35 };
          if (prev) g.line(prev, p, dxfColor);
          prev = p;
        }
      }
    }
  }

  // 工装
  for (const f of state.fixtures) {
    const rot = ((f.rotation || 0) * Math.PI) / 180;
    if (f.kind === 'fork') {
      g.cylinder({ x: f.x, y: f.y, z: 1 }, { x: f.x, y: f.y, z: 7 }, 13, '#64748b', 12);
      g.cylinder({ x: f.x, y: f.y, z: 5 }, { x: f.x, y: f.y, z: f.height ?? 42 }, f.radius ?? 6, '#cbd5e1', 10);
      g.sphere({ x: f.x, y: f.y, z: f.height ?? 42 }, (f.radius ?? 6) + 1.2, '#e2e8f0', 5, 8);
    } else if (f.kind === 'tape') {
      g.cylinder({ x: f.x, y: f.y, z: 0.4 }, { x: f.x, y: f.y, z: 3.2 }, f.radius ?? 17, '#f59e0b', 18);
      g.cylinder({ x: f.x, y: f.y, z: 3.3 }, { x: f.x, y: f.y, z: 4.2 }, (f.radius ?? 17) * 0.35, '#78350f', 14);
    } else if (f.kind === 'connector') {
      g.box({ x: f.x, y: f.y, z: (f.height ?? 24) / 2 }, { x: f.width ?? 120, y: f.depth ?? 42, z: f.height ?? 24 }, '#334155', rot);
      g.box({ x: f.x, y: f.y, z: (f.height ?? 24) + 2 }, { x: (f.width ?? 120) - 12, y: (f.depth ?? 42) - 10, z: 5 }, '#0f172a', rot);
      for (const cav of f.cavities ?? []) {
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const x = f.x + cav.dx * cos - cav.dy * sin;
        const y = f.y + cav.dx * sin + cav.dy * cos;
        g.box({ x, y, z: (f.height ?? 24) + 0.6 }, { x: 4.4, y: 3.4, z: 1.0 }, '#020617', rot);
      }
    } else {
      g.box({ x: f.x, y: f.y, z: (f.height ?? 26) / 2 }, { x: f.width ?? 80, y: f.depth ?? 38, z: f.height ?? 26 }, f.kind === 'cradle' ? '#0f766e' : '#64748b', rot);
      if (f.kind === 'cradle') {
        g.cylinder({ x: f.x - 24, y: f.y, z: f.height ?? 26 }, { x: f.x + 24, y: f.y, z: f.height ?? 26 }, 5, '#99f6e4', 8);
      }
    }
  }

  // 分支/捆扎点
  for (const t of state.tiePoints) {
    g.sphere({ x: t.x, y: t.y, z: t.z }, t.kind === 'branch' ? 8 : 5.5, t.kind === 'branch' ? '#22d3ee' : '#facc15', 5, 8);
  }

  // 导线
  for (const w of state.wires) {
    if (options.beforeSequence !== undefined && w.sequence >= options.beforeSequence) continue;
    const r = wireOuterRadius(w);
    for (let i = 1; i < w.route.length; i++) {
      g.cylinder(w.route[i - 1], w.route[i], r, w.color, 6);
    }
  }

  // 工人：直接使用 CPU 遮挡胶囊，保证所见即所算
  if (options.worker) {
    const occ = workerOccluders(options.worker);
    for (const o of occ) {
      if (o.kind !== 'capsule') continue;
      const color = o.tag.includes('head') ? '#d6a06f' : o.tag.includes('hand') ? '#d6a06f' : o.tag.includes('body') ? '#1d4ed8' : '#f97316';
      g.cylinder(o.a, o.b, o.radius, color, 12);
      g.sphere(o.a, o.radius, color, 6, 10);
      g.sphere(o.b, o.radius, color, 6, 10);
    }
  }

  // 投影仪和视锥线
  for (const p of state.projectors) {
    if (!p.enabled) continue;
    const rig = createRig(p);
    g.box(p.pos, { x: 430, y: 320, z: 145 }, '#e5e7eb', 0);
    const lensEnd = { x: p.pos.x + rig.forward.x * 95, y: p.pos.y + rig.forward.y * 95, z: p.pos.z + rig.forward.z * 95 };
    g.cylinder({ ...p.pos }, lensEnd, 48, '#111827', 18);
    if (options.showProjectorFrusta) {
      const color = hexRgb(p.id === 'pj-left' ? '#60a5fa' : p.id === 'pj-right' ? '#34d399' : '#f472b6');
      const cov = coveragePolygon(rig, 0.5);
      if (cov.length === 4) {
        for (let i = 0; i < 4; i++) {
          const c = cov[i];
          const n = cov[(i + 1) % 4];
          g.line(rig.eye, { x: c.x, y: c.y, z: 0.5 }, color);
          g.line({ x: c.x, y: c.y, z: 0.5 }, { x: n.x, y: n.y, z: 0.5 }, color);
        }
      }
    }
  }

  return g.toGeometry();
}
