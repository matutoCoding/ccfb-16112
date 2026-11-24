import type { ProjectorDevice, Vec2, Vec3 } from '../types';
import {
  clamp,
  distance,
  mat4Frustum,
  mat4Identity,
  mat4Invert,
  mat4LookAt,
  mat4Multiply,
  normalize,
  projectToNdc,
  sub,
  transformMat4,
  unprojectNdc,
  type Mat4
} from './math';

export interface ProjectorRig {
  device: ProjectorDevice;
  view: Mat4;
  proj: Mat4;
  vp: Mat4;
  invVp: Mat4;
  eye: Vec3;
  forward: Vec3;
  aspect: number;
  throwDistance: number;
  imageWidthMm: number;
  imageHeightMm: number;
  depressionDeg: number;
}

const NEAR_MM = 12;
const FAR_MM = 7000;

function rotatedUp(device: ProjectorDevice, forward: Vec3): Vec3 {
  const base = Math.abs(forward.y) > 0.96 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const roll = (device.roll || 0) * Math.PI / 180;
  if (!roll) return base;
  // Rodrigues 绕光轴旋转 up
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return {
    x: base.x * c + (forward.y * base.z - forward.z * base.y) * s + forward.x * (forward.x * base.x + forward.y * base.y + forward.z * base.z) * (1 - c),
    y: base.y * c + (forward.z * base.x - forward.x * base.z) * s + forward.y * (forward.x * base.x + forward.y * base.y + forward.z * base.z) * (1 - c),
    z: base.z * c + (forward.x * base.y - forward.y * base.x) * s + forward.z * (forward.x * base.x + forward.y * base.y + forward.z * base.z) * (1 - c)
  };
}

export function createRig(device: ProjectorDevice): ProjectorRig {
  const eye = { ...device.pos };
  const target = { ...device.target };
  const forward = normalize(sub(target, eye));
  const throwDistance = Math.max(100, distance(eye, target));
  const aspect = device.resolutionW / Math.max(1, device.resolutionH);
  const halfWidthNear = NEAR_MM / (2 * Math.max(0.1, device.throwRatio));
  const halfHeightNear = halfWidthNear / aspect;
  const shiftX = device.lensShiftX * 2 * halfWidthNear;
  const shiftY = device.lensShiftY * 2 * halfHeightNear;
  const proj = mat4Frustum(
    -halfWidthNear + shiftX,
    halfWidthNear + shiftX,
    -halfHeightNear + shiftY,
    halfHeightNear + shiftY,
    NEAR_MM,
    FAR_MM
  );
  const up = rotatedUp(device, forward);
  const view = mat4LookAt(eye, target, up);
  const vp = mat4Multiply(proj, view);
  const invVp = mat4Invert(vp);
  const horiz = Math.hypot(eye.x - target.x, eye.y - target.y);
  const depressionDeg = (Math.atan2(eye.z - target.z, horiz) * 180) / Math.PI;
  return {
    device,
    view,
    proj,
    vp,
    invVp,
    eye,
    forward,
    aspect,
    throwDistance,
    imageWidthMm: throwDistance / device.throwRatio,
    imageHeightMm: throwDistance / device.throwRatio / aspect,
    depressionDeg
  };
}

export interface PixelPoint {
  x: number;
  y: number;
  ndcX: number;
  ndcY: number;
  ndcZ: number;
  inFrustum: boolean;
}

export function projectPoint(rig: ProjectorRig, p: Vec3): PixelPoint | null {
  const ndc = projectToNdc(rig.vp, p);
  if (!ndc) return null;
  const w = rig.device.resolutionW;
  const h = rig.device.resolutionH;
  return {
    x: (ndc.x * 0.5 + 0.5) * w,
    y: (1 - (ndc.y * 0.5 + 0.5)) * h,
    ndcX: ndc.x,
    ndcY: ndc.y,
    ndcZ: ndc.z,
    inFrustum: ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1 && ndc.z >= -1 && ndc.z <= 1
  };
}

export function unprojectPixel(rig: ProjectorRig, px: number, py: number, ndcZ: number): Vec3 {
  const nx = (px / rig.device.resolutionW) * 2 - 1;
  const ny = 1 - (py / rig.device.resolutionH) * 2;
  return unprojectNdc(rig.invVp, { x: nx, y: ny, z: ndcZ });
}

export function rayFromPixel(rig: ProjectorRig, px: number, py: number): { origin: Vec3; dir: Vec3 } {
  const a = unprojectPixel(rig, px, py, -1);
  const b = unprojectPixel(rig, px, py, 1);
  return { origin: rig.eye, dir: normalize(sub(b, a)) };
}

function rayPlaneZ(origin: Vec3, dir: Vec3, z = 0): Vec3 | null {
  if (Math.abs(dir.z) < 1e-8) return null;
  const t = (z - origin.z) / dir.z;
  if (!Number.isFinite(t) || t < 0) return null;
  return { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z };
}

/** 投影仪视锥与板面 z=0 的交点四边形 */
export function coveragePolygon(rig: ProjectorRig, z = 0): Vec2[] {
  const corners: Vec2[] = [];
  const ndcs: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ];
  for (const [nx, ny] of ndcs) {
    const near = unprojectNdc(rig.invVp, { x: nx, y: ny, z: -1 });
    const far = unprojectNdc(rig.invVp, { x: nx, y: ny, z: 1 });
    const hit = rayPlaneZ(rig.eye, normalize(sub(far, near)), z);
    if (hit) corners.push({ x: hit.x, y: hit.y });
  }
  return corners;
}

export function pixelDensity(rig: ProjectorRig, p: Vec3): { ppmm: number; ppi: number; ok: boolean } {
  const e = 1;
  const p0 = projectPoint(rig, p);
  const px = projectPoint(rig, { ...p, x: p.x + e });
  const py = projectPoint(rig, { ...p, y: p.y + e });
  if (!p0 || !px || !py || !p0.inFrustum) return { ppmm: 0, ppi: 0, ok: false };
  const ax = (px.x - p0.x) / e;
  const ay = (px.y - p0.y) / e;
  const bx = (py.x - p0.x) / e;
  const by = (py.y - p0.y) / e;
  const det = Math.abs(ax * by - ay * bx);
  const ppmm = Math.sqrt(det);
  return { ppmm, ppi: ppmm * 25.4, ok: ppmm > 0.001 };
}

export function projectorIlluminanceLux(rig: ProjectorRig, p: Vec3): number {
  const d = Math.max(100, distance(rig.eye, p));
  const width = d / rig.device.throwRatio;
  const height = width / rig.aspect;
  const areaM2 = Math.max(0.1, (width * height) / 1e6);
  // 光通量/面积，再给 0.72 光学利用率
  return (rig.device.lumens * 0.72) / areaM2;
}

export function contrastRatioAt(rig: ProjectorRig, p: Vec3, ambientLux: number): number {
  const projLux = projectorIlluminanceLux(rig, p);
  const blackFloor = projLux / Math.max(100, rig.device.nativeContrast);
  const boardReflectedAmbient = ambientLux * 0.055;
  const whiteSymbol = boardReflectedAmbient + projLux;
  const blackBoard = boardReflectedAmbient + blackFloor;
  return whiteSymbol / Math.max(0.01, blackBoard);
}

export function setDepressionAngle(device: ProjectorDevice, depressionDeg: number): ProjectorDevice {
  const deg = clamp(depressionDeg, 20, 89.5);
  const azimuth = Math.atan2(device.pos.y - device.target.y, device.pos.x - device.target.x);
  const dz = Math.max(300, device.pos.z - device.target.z);
  const horiz = deg >= 89 ? 20 : dz / Math.tan((deg * Math.PI) / 180);
  return {
    ...device,
    pos: {
      ...device.pos,
      x: device.target.x + Math.cos(azimuth || 0) * horiz,
      y: device.target.y + Math.sin(azimuth || 0) * horiz
    }
  };
}

export function setMountHeight(device: ProjectorDevice, z: number): ProjectorDevice {
  return { ...device, pos: { ...device.pos, z: clamp(z, 900, 3200) } };
}

// ---------- CPU 遮挡几何：与 WebGL 深度图使用同一套胶囊/盒体近似 ----------

export interface CapsuleOccluder {
  kind: 'capsule';
  a: Vec3;
  b: Vec3;
  radius: number;
  tag: string;
}

export interface BoxOccluder {
  kind: 'box';
  min: Vec3;
  max: Vec3;
  tag: string;
}

export type Occluder = CapsuleOccluder | BoxOccluder;

export interface RayHit {
  t: number;
  point: Vec3;
  tag: string;
}

function raySphere(origin: Vec3, dir: Vec3, c: Vec3, r: number): number | null {
  const oc = sub(origin, c);
  const b = 2 * dotMaybe(oc, dir);
  const cc = dotMaybe(oc, oc) - r * r;
  const disc = b * b - 4 * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / 2;
  if (t < 1e-5) t = (-b + sq) / 2;
  return t > 1e-5 ? t : null;
}

function dotMaybe(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function rayCapsule(origin: Vec3, dir: Vec3, cap: CapsuleOccluder): number | null {
  const a = cap.a;
  const b = cap.b;
  const ba = sub(b, a);
  const l2 = dotMaybe(ba, ba);
  let best: number | null = null;
  const consider = (t: number | null) => {
    if (t !== null && t > 1e-4 && (best === null || t < best)) best = t;
  };
  consider(raySphere(origin, dir, a, cap.radius));
  consider(raySphere(origin, dir, b, cap.radius));
  if (l2 < 1e-6) return best;

  const oa = sub(origin, a);
  const axis = { x: ba.x / Math.sqrt(l2), y: ba.y / Math.sqrt(l2), z: ba.z / Math.sqrt(l2) };
  const oaAxis = dotMaybe(oa, axis);
  const dAxis = dotMaybe(dir, axis);
  const p = { x: oa.x - axis.x * oaAxis, y: oa.y - axis.y * oaAxis, z: oa.z - axis.z * oaAxis };
  const dp = { x: dir.x - axis.x * dAxis, y: dir.y - axis.y * dAxis, z: dir.z - axis.z * dAxis };
  const A = dotMaybe(dp, dp);
  const B = 2 * dotMaybe(p, dp);
  const C = dotMaybe(p, p) - cap.radius * cap.radius;
  if (A > 1e-10) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t > 1e-4) {
        const q = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
        const s = dotMaybe(sub(q, a), ba) / l2;
        if (s >= 0 && s <= 1) consider(t);
      }
    }
  }
  return best;
}

function rayBox(origin: Vec3, dir: Vec3, box: BoxOccluder): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  for (const ax of axes) {
    const o = origin[ax];
    const d = dir[ax];
    const lo = box.min[ax];
    const hi = box.max[ax];
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  if (tmax < 1e-4) return null;
  return tmin > 1e-4 ? tmin : tmax;
}

export function nearestOccluderHit(eye: Vec3, target: Vec3, occluders: Occluder[]): RayHit | null {
  const d = sub(target, eye);
  const travel = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  if (travel < 1e-6) return null;
  const dir = { x: d.x / travel, y: d.y / travel, z: d.z / travel };
  let best: RayHit | null = null;
  for (const o of occluders) {
    const t = o.kind === 'capsule' ? rayCapsule(eye, dir, o) : rayBox(eye, dir, o);
    if (t !== null && t < travel && (!best || t < best.t)) {
      best = {
        t,
        point: { x: eye.x + dir.x * t, y: eye.y + dir.y * t, z: eye.z + dir.z * t },
        tag: o.tag
      };
    }
  }
  return best;
}

export interface LineOfSightResult {
  visible: boolean;
  landingErrorMm: number;
  hit: RayHit | null;
  travelMm: number;
}

/**
 * 判定投影仪到目标点的视线。若最近遮挡面在目标点之前，
 * 返回投影像素实际落点与期望点的三维偏差，供 3mm 精度校验使用。
 */
export function lineOfSight(eye: Vec3, p: Vec3, occluders: Occluder[], allowedLandingErrorMm = 3): LineOfSightResult {
  const travel = distance(eye, p);
  const hit = nearestOccluderHit(eye, p, occluders);
  if (!hit) return { visible: true, landingErrorMm: 0, hit: null, travelMm: travel };
  const landingErrorMm = distance(hit.point, p);
  return {
    visible: landingErrorMm <= allowedLandingErrorMm,
    landingErrorMm,
    hit,
    travelMm: travel
  };
}

export function identityMat(): Mat4 {
  return mat4Identity();
}

// transformMat4 保留给后续像素/矩阵调试使用
export { transformMat4 };
