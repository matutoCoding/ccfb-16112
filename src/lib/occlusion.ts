import type { ProjectState, Vec3, Wire } from '../types';
import { cavityWorld } from './fixtures';
import { lerpV } from './math';
import { wireOuterRadius } from './routing';
import type { BoxOccluder, CapsuleOccluder, Occluder } from './projectors';

export interface WorkerRig {
  bodyX: number;
  standY: number;
  handA: Vec3;
  handB: Vec3;
}

export function getStepWorkerRig(state: ProjectState, stepOrder?: number): WorkerRig | null {
  if (!state.settings.workerEnabled) return null;
  let anchor: Vec3 = { x: state.settings.workerX, y: 430, z: 90 };
  let target: Vec3 = { x: state.settings.workerX + 180, y: 520, z: 70 };

  if (stepOrder !== undefined && state.settings.workerFollowStep) {
    const step = state.steps.find((s) => s.order === stepOrder);
    const wire = step ? state.wires.find((w) => w.id === step.wireId) : undefined;
    if (wire && wire.route.length > 1) {
      const idx = Math.floor(wire.route.length * 0.62);
      anchor = { ...wire.route[Math.min(idx, wire.route.length - 1)] };
      // 手在路径侧上方，而不是把待投影箭头本身攥住
      anchor.z += 92;
      anchor.y -= 42;
      const f = state.fixtures.find((x) => x.id === wire.to.fixtureId);
      if (f) target = cavityWorld(f, wire.to.cavityId);
      target = { ...target, x: target.x + 76, y: target.y - 92, z: target.z + 82 };
    }
  }

  const bodyX = Math.max(260, Math.min(state.board.width - 260, (anchor.x + target.x) / 2));
  return { bodyX, standY: state.settings.workerY ?? -280, handA: anchor, handB: target };
}

export function workerOccluders(rig: WorkerRig): Occluder[] {
  const out: Occluder[] = [];
  const shoulderZ = 500;
  const torsoBottom: Vec3 = { x: rig.bodyX, y: rig.standY - 70, z: -520 };
  const torsoTop: Vec3 = { x: rig.bodyX, y: rig.standY + 10, z: 430 };
  out.push({ kind: 'capsule', a: torsoBottom, b: torsoTop, radius: 165, tag: 'worker-body' });
  out.push({
    kind: 'capsule',
    a: { x: rig.bodyX, y: rig.standY + 20, z: 570 },
    b: { x: rig.bodyX, y: rig.standY + 35, z: 700 },
    radius: 92,
    tag: 'worker-head'
  });

  for (const side of [-1, 1]) {
    const shoulder: Vec3 = { x: rig.bodyX + side * 205, y: rig.standY + 25, z: shoulderZ };
    const hand = side < 0 ? rig.handA : rig.handB;
    const elbow = lerpV(shoulder, hand, 0.48);
    elbow.z = Math.max(elbow.z + 120, hand.z + 150);
    elbow.y -= 55;
    out.push({ kind: 'capsule', a: shoulder, b: elbow, radius: 36, tag: 'worker-arm' });
    out.push({ kind: 'capsule', a: elbow, b: hand, radius: 29, tag: 'worker-arm' });
    const wrist = lerpV(elbow, hand, 0.82);
    out.push({ kind: 'capsule', a: wrist, b: { ...hand, z: hand.z + 8 }, radius: 37, tag: 'worker-hand' });
  }
  return out;
}

function rotatedAabb(f: ProjectState['fixtures'][number]): BoxOccluder {
  const w = f.width ?? (f.kind === 'connector' ? 90 : 60);
  const d = f.depth ?? 34;
  const a = ((f.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const corners = [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2]
  ].map(([x, y]) => ({ x: f.x + x * c - y * s, y: f.y + x * s + y * c }));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    kind: 'box',
    min: { x: Math.min(...xs), y: Math.min(...ys), z: 0 },
    max: { x: Math.max(...xs), y: Math.max(...ys), z: f.height ?? 24 },
    tag: `fixture:${f.code}`
  };
}

export interface SceneOccluderOptions {
  /** 仅包含 sequence < beforeSequence 的已布导线 */
  beforeSequence?: number;
  worker?: WorkerRig | null;
}

export function buildSceneOccluders(state: ProjectState, opts: SceneOccluderOptions = {}): Occluder[] {
  const out: Occluder[] = [];

  for (const f of state.fixtures) {
    if (f.kind === 'tape') continue;
    if (f.kind === 'fork') {
      out.push({
        kind: 'capsule',
        a: { x: f.x, y: f.y, z: 2 },
        b: { x: f.x, y: f.y, z: f.height ?? 42 },
        radius: (f.radius ?? 6) + 2.5,
        tag: `fixture:${f.code}`
      } satisfies CapsuleOccluder);
    } else {
      out.push(rotatedAabb(f) satisfies BoxOccluder);
    }
  }

  const wires: Wire[] = state.wires;
  for (const w of wires) {
    if (opts.beforeSequence !== undefined && w.sequence >= opts.beforeSequence) continue;
    const r = wireOuterRadius(w) + 0.25;
    for (let i = 1; i < w.route.length; i++) {
      out.push({ kind: 'capsule', a: w.route[i - 1], b: w.route[i], radius: r, tag: `harness:${w.lineNo}` });
    }
  }

  if (opts.worker) out.push(...workerOccluders(opts.worker));
  return out;
}
