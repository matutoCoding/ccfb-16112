import type { Cavity, Fixture, Vec3 } from '../types';

export function ensureCavities(f: Fixture): Cavity[] {
  if (f.kind !== 'connector') return [];
  if (f.cavities && f.cavities.length) return f.cavities;
  const count = f.cavityCount ?? 12;
  const rows = Math.max(1, f.rows ?? (count > 16 ? 2 : 1));
  const cols = Math.ceil(count / rows);
  const pitch = f.pitch ?? 8;
  const cavities: Cavity[] = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols && n < count; c++) {
      const dx = (c - (cols - 1) / 2) * pitch;
      const dy = (r - (rows - 1) / 2) * pitch;
      cavities.push({
        id: `C${String(n + 1).padStart(2, '0')}`,
        index: n,
        dx,
        dy,
        z: f.height ?? 22,
        label: `${r + 1}-${c + 1}`
      });
      n++;
    }
  }
  f.cavities = cavities;
  f.width = f.width ?? (cols - 1) * pitch + 22;
  f.depth = f.depth ?? (rows - 1) * pitch + 20;
  return cavities;
}

export function rotateOffset(f: Fixture, dx: number, dy: number): { x: number; y: number } {
  const a = ((f.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

export function cavityWorld(f: Fixture, cavityId: string): Vec3 {
  ensureCavities(f);
  const cav = f.cavities?.find((c) => c.id === cavityId) ?? f.cavities?.[0];
  if (!cav) return { x: f.x, y: f.y, z: f.height ?? 20 };
  const o = rotateOffset(f, cav.dx, cav.dy);
  return { x: f.x + o.x, y: f.y + o.y, z: cav.z ?? f.height ?? 22 };
}

export function fixtureTop(f: Fixture): Vec3 {
  return { x: f.x, y: f.y, z: f.height ?? 30 };
}

export function defaultFixture(kind: Fixture['kind'], x: number, y: number, code: string): Fixture {
  const base: Fixture = {
    id: `fx-${Math.random().toString(36).slice(2, 9)}`,
    kind,
    code,
    name: code,
    x,
    y,
    rotation: 0,
    height: 34
  };
  if (kind === 'fork') {
    base.name = `叉子 ${code}`;
    base.height = 42;
    base.radius = 6;
  } else if (kind === 'bracket') {
    base.name = `托架 ${code}`;
    base.height = 28;
    base.width = 90;
    base.depth = 42;
  } else if (kind === 'cradle') {
    base.name = `线托 ${code}`;
    base.height = 22;
    base.width = 70;
    base.depth = 36;
    base.radius = 16;
  } else if (kind === 'tape') {
    base.name = `胶带点 ${code}`;
    base.height = 4;
    base.radius = 18;
  } else {
    base.name = `接插件座 ${code}`;
    base.height = 24;
    base.width = 110;
    base.depth = 42;
    base.cavityCount = 24;
    base.pitch = 8;
    base.rows = 2;
    ensureCavities(base);
  }
  return base;
}

export const FIXTURE_LABEL: Record<Fixture['kind'], string> = {
  fork: '叉子',
  bracket: '托架',
  tape: '胶带点',
  connector: '接插件座',
  cradle: '线托'
};
