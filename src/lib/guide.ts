import type {
  AccuracyReport,
  Fixture,
  GuideStep,
  ID,
  ProjectState,
  Recommendation,
  StepReport,
  Vec3
} from '../types';
import { cavityWorld, ensureCavities } from './fixtures';
import { buildSceneOccluders, getStepWorkerRig } from './occlusion';
import { clamp, distance, unprojectNdc } from './math';
import { densifyPath, wireOuterRadius } from './routing';
import {
  contrastRatioAt,
  createRig,
  lineOfSight,
  pixelDensity,
  projectPoint,
  type ProjectorRig
} from './projectors';
import type { Occluder } from './projectors';

export interface PointEvaluation {
  point: Vec3;
  visible: boolean;
  visibleBy: ID[];
  bestProjectorId: ID | null;
  geometricBestId: ID | null;
  landingErrorMm: number;
  densityPpi: number;
  contrast: number;
  blockedTag?: string;
  outside?: boolean;
}

export interface AssignedSegment {
  projectorId: ID | null;
  a: Vec3;
  b: Vec3;
  color: string;
  widthMm: number;
}

export interface AssignedFrameEdge {
  projectorId: ID | null;
  a: Vec3;
  b: Vec3;
}

export interface GuidePlan {
  step: GuideStep;
  segments: AssignedSegment[];
  frameEdges: AssignedFrameEdge[];
  pathTop: Vec3[];
  targetCorners: Vec3[];
  evaluations: PointEvaluation[];
  usedProjectorIds: ID[];
  failover: boolean;
}

export function targetFrameCorners(f: Fixture, cavityId: string, halfW = 12, halfH = 8): Vec3[] {
  const c = cavityWorld(f, cavityId);
  const a = ((f.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const z = c.z + 1.5;
  return [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH]
  ].map(([x, y]) => ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos, z }));
}

export function topPathForWire(state: ProjectState, wireId: ID): Vec3[] {
  const w = state.wires.find((x) => x.id === wireId);
  if (!w) return [];
  const r = wireOuterRadius(w);
  return w.route.map((p, i) => {
    if (i === 0 || i === w.route.length - 1) return { ...p };
    return { ...p, z: p.z + r + 0.6 };
  });
}

function evaluatePoint(
  rigs: ProjectorRig[],
  p: Vec3,
  occluders: Occluder[],
  ambientLux: number,
  toleranceMm: number
): PointEvaluation {
  const visibleBy: ID[] = [];
  let best: { id: ID; score: number; landing: number; ppi: number; contrast: number } | null = null;
  let geometricBest: { id: ID; score: number } | null = null;
  let blockedTag: string | undefined;
  let outside = false;
  let minLanding = Infinity;

  for (const rig of rigs) {
    const pp = projectPoint(rig, p);
    if (!pp || !pp.inFrustum) {
      outside = true;
      continue;
    }
    const density = pixelDensity(rig, p);
    const contrast = contrastRatioAt(rig, p, ambientLux);
    const los = lineOfSight(rig.eye, p, occluders, toleranceMm);
    minLanding = Math.min(minLanding, los.landingErrorMm);
    const geomScore = density.ppmm * Math.min(12, contrast) * 10;
    if (!geometricBest || geomScore > geometricBest.score) geometricBest = { id: rig.device.id, score: geomScore };

    if (los.hit && !los.visible) blockedTag = los.hit.tag;
    if (los.visible) {
      visibleBy.push(rig.device.id);
      const score = geomScore - los.landingErrorMm * 2;
      if (!best || score > best.score) {
        best = { id: rig.device.id, score, landing: los.landingErrorMm, ppi: density.ppi, contrast };
      }
    }
  }

  return {
    point: p,
    visible: visibleBy.length > 0,
    visibleBy,
    bestProjectorId: best?.id ?? null,
    geometricBestId: geometricBest?.id ?? null,
    landingErrorMm: Number.isFinite(minLanding) ? minLanding : 999,
    densityPpi: best?.ppi ?? 0,
    contrast: best?.contrast ?? 0,
    blockedTag,
    outside: outside && visibleBy.length === 0
  };
}

function ambientFor(state: ProjectState): number {
  return state.settings.ceilingLightsOn ? state.settings.ambientLux : 18;
}

export function planGuide(state: ProjectState, step: GuideStep, dense = true): GuidePlan {
  const wire = state.wires.find((w) => w.id === step.wireId)!;
  const rigs = state.projectors.filter((p) => p.enabled).map(createRig);
  const worker = getStepWorkerRig(state, step.order);
  const occluders = buildSceneOccluders(state, { beforeSequence: step.order, worker });
  const ambient = ambientFor(state);
  const tolerance = state.settings.accuracyToleranceMm;

  const top = topPathForWire(state, wire.id);
  const samplePath = dense ? densifyPath(top, 55) : densifyPath(top, 130);
  const toFixture = state.fixtures.find((f) => f.id === wire.to.fixtureId)!;
  const fromFixture = state.fixtures.find((f) => f.id === wire.from.fixtureId)!;
  const targetCorners = targetFrameCorners(toFixture, wire.to.cavityId);
  const fromCorners = targetFrameCorners(fromFixture, wire.from.cavityId, 10, 7);
  const frameSamplePoints = [...targetCorners, ...fromCorners];
  for (let i = 0; i < targetCorners.length; i++) {
    const a = targetCorners[i];
    const b = targetCorners[(i + 1) % targetCorners.length];
    frameSamplePoints.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: a.z });
  }

  const evaluations = [...samplePath, ...frameSamplePoints].map((p) =>
    evaluatePoint(rigs, p, occluders, ambient, tolerance)
  );

  const segments: AssignedSegment[] = [];
  for (let i = 1; i < top.length; i++) {
    const a = top[i - 1];
    const b = top[i];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const q1 = { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, z: a.z * 0.25 + b.z * 0.75 };
    const q2 = { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, z: a.z * 0.75 + b.z * 0.25 };
    const evals = [m, q1, q2].map((p) => evaluatePoint(rigs, p, occluders, ambient, tolerance));
    const counts = new Map<ID, number>();
    for (const e of evals) if (e.bestProjectorId) counts.set(e.bestProjectorId, (counts.get(e.bestProjectorId) ?? 0) + 1);
    let projectorId: ID | null = null;
    let count = -1;
    counts.forEach((n, id) => {
      if (n > count) {
        count = n;
        projectorId = id;
      }
    });
    segments.push({ projectorId, a, b, color: wire.color, widthMm: 13 });
  }

  const frameEdges: AssignedFrameEdge[] = [];
  const allCorners = targetCorners;
  for (let i = 0; i < allCorners.length; i++) {
    const a = allCorners[i];
    const b = allCorners[(i + 1) % allCorners.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: a.z };
    const ev = evaluatePoint(rigs, mid, occluders, ambient, tolerance);
    frameEdges.push({ projectorId: ev.bestProjectorId, a, b });
  }

  const usedProjectorIds = Array.from(
    new Set([...segments.map((s) => s.projectorId), ...frameEdges.map((e) => e.projectorId)].filter(Boolean) as ID[])
  );
  const failover = evaluations.some((e) => e.bestProjectorId && e.geometricBestId && e.bestProjectorId !== e.geometricBestId);

  return { step, segments, frameEdges, pathTop: top, targetCorners, evaluations, usedProjectorIds, failover };
}

export function summarizeStep(state: ProjectState, step: GuideStep): StepReport {
  const plan = planGuide(state, step, false);
  const evals = plan.evaluations;
  const visible = evals.filter((e) => e.visible).length;
  const wire = state.wires.find((w) => w.id === step.wireId)!;
  const blockedByArms = evals.filter((e) => !e.visible && e.blockedTag?.startsWith('worker')).length;
  const blockedByHarness = evals.filter((e) => !e.visible && e.blockedTag?.startsWith('harness')).length;
  const outsideCoverage = evals.filter((e) => e.outside).length;
  const densities = evals.filter((e) => e.densityPpi > 0).map((e) => e.densityPpi);
  const contrasts = evals.filter((e) => e.contrast > 0).map((e) => e.contrast);
  const errors = evals.map((e) => e.landingErrorMm).filter((n) => Number.isFinite(n) && n < 900);
  const assigned = plan.usedProjectorIds[0] ?? null;
  const visibility = evals.length ? visible / evals.length : 0;
  const issues: string[] = [];
  if (visibility < state.settings.visibilityThreshold) issues.push(`可见率 ${(visibility * 100).toFixed(1)}% 低于阈值`);
  if (blockedByArms) issues.push(`${blockedByArms} 个采样点被工人手臂/身体遮挡`);
  if (blockedByHarness) issues.push(`${blockedByHarness} 个采样点被已布线束遮挡`);
  if (outsideCoverage) issues.push(`${outsideCoverage} 个采样点在所有视锥外`);
  if (plan.usedProjectorIds.length > 1) issues.push(`箭头分段切换至 ${plan.usedProjectorIds.length} 台投影仪`);
  if (Math.min(...contrasts, 99) < state.settings.contrastThreshold) issues.push('部分位置环境光下对比度不足');

  return {
    stepId: step.id,
    order: step.order,
    wireId: wire.id,
    lineNo: wire.lineNo,
    totalSamples: evals.length,
    visibleSamples: visible,
    visibility,
    assignedProjectorId: assigned,
    failover: plan.failover || plan.usedProjectorIds.length > 1,
    blockedByArms,
    blockedByHarness,
    outsideCoverage,
    minContrast: contrasts.length ? Math.min(...contrasts) : 0,
    minDensityPpi: densities.length ? Math.min(...densities) : 0,
    maxAccuracyErrorMm: Math.max(state.settings.calibrationResidualMm, errors.length ? Math.max(...errors) : 0),
    passed: visibility >= state.settings.visibilityThreshold,
    issues
  };
}

export async function computeAllReports(
  state: ProjectState,
  onProgress?: (done: number, total: number) => void
): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  const steps = [...state.steps].sort((a, b) => a.order - b.order);
  for (let i = 0; i < steps.length; i++) {
    reports.push(summarizeStep(state, steps[i]));
    onProgress?.(i + 1, steps.length);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  return reports;
}

function matrixRoundTripError(rig: ProjectorRig, p: Vec3): number {
  const pp = projectPoint(rig, p);
  if (!pp) return 9999;
  const q = unprojectNdc(rig.invVp, { x: pp.ndcX, y: pp.ndcY, z: pp.ndcZ });
  return distance(p, q);
}

export function computeAccuracy(state: ProjectState): AccuracyReport {
  const rigs = state.projectors.filter((p) => p.enabled).map(createRig);
  const occluders = buildSceneOccluders(state);
  const tolerance = state.settings.accuracyToleranceMm;
  let max = 0;
  let maxHole = 0;
  let maxStack = 0;
  let count = 0;
  let occludedStackSamples = 0;
  let worst: AccuracyReport['worst'] = null;

  const consider = (p: Vec3, label: string, isHole: boolean, activeOccluders: Occluder[] = occluders): void => {
    let bestError = Infinity;
    let anyLineOfSight = false;
    for (const rig of rigs) {
      const pp = projectPoint(rig, p);
      if (!pp || !pp.inFrustum) continue;
      const matrixErr = matrixRoundTripError(rig, p);
      const los = lineOfSight(rig.eye, p, activeOccluders, tolerance + 1);
      if (!los.visible) continue;
      anyLineOfSight = true;
      const density = pixelDensity(rig, p);
      const pixelErr = density.ppmm > 0 ? 0.5 / density.ppmm : 2;
      const err = matrixErr + los.landingErrorMm + pixelErr + state.settings.calibrationResidualMm;
      if (err < bestError) bestError = err;
    }
    if (!anyLineOfSight) {
      // 完全无视线属于可见率/加机问题，不应和投影矩阵落点偏差混为一谈。
      if (!isHole) occludedStackSamples++;
      else {
        count++;
        maxHole = Math.max(maxHole, 999);
        max = Math.max(max, 999);
        worst = { label, errorMm: 999, x: p.x, y: p.y, z: p.z };
      }
      return;
    }
    count++;
    max = Math.max(max, bestError);
    if (isHole) maxHole = Math.max(maxHole, bestError);
    else maxStack = Math.max(maxStack, bestError);
    if (!worst || bestError > worst.errorMm) worst = { label, errorMm: bestError, x: p.x, y: p.y, z: p.z };
  };

  for (const f of state.fixtures) {
    if (f.kind !== 'connector') continue;
    ensureCavities(f);
    for (const cav of f.cavities ?? []) {
      const corners = targetFrameCorners(f, cav.id);
      corners.forEach((p, i) => consider(p, `${f.code}/${cav.label}/角${i + 1}`, true));
    }
  }

  for (const w of state.wires) {
    const top = topPathForWire(state, w.id);
    // 按弧长每 150mm 取一个跨中样本；叉/托包络区属于贴附工装表面的特殊段，
    // 不把“路径中心线在销柱内部”的抽象点误判成线束上表面落点。
    const stepOccluders = buildSceneOccluders(state, { beforeSequence: w.sequence });
    let sinceSample = 60;
    for (let i = 1; i < top.length; i++) {
      const a = top[i - 1];
      const b = top[i];
      const segLen = distance(a, b);
      sinceSample += segLen;
      if (sinceSample < 150) continue;
      sinceSample = 0;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 + 1.2 };
      const nearFixture = state.fixtures.some((f) => {
        const radius =
          f.kind === 'fork'
            ? 34
            : f.kind === 'connector'
              ? Math.max(f.width ?? 120, f.depth ?? 44) * 0.75
              : Math.max(f.width ?? 80, f.depth ?? 40) * 1.15;
        return Math.hypot(f.x - mid.x, f.y - mid.y) < radius;
      });
      if (nearFixture) continue;
      consider(mid, `${w.lineNo}/跨中${i}`, false, stepOccluders);
    }
  }

  return {
    maxHoleErrorMm: maxHole,
    maxStackErrorMm: maxStack,
    sampleCount: count,
    occludedStackSamples,
    toleranceMm: tolerance,
    passed: max <= tolerance,
    worst
  };
}

export function buildRecommendations(state: ProjectState, reports: StepReport[]): Recommendation[] {
  const bad = reports.filter((r) => !r.passed).sort((a, b) => a.visibility - b.visibility);
  const recs: Recommendation[] = [];
  if (!bad.length) {
    recs.push({
      severity: 'add',
      title: '当前阈值下无需增加设备',
      detail: `${reports.length} 个步骤均达到 ${(state.settings.visibilityThreshold * 100).toFixed(0)}% 可见率。可保留三台方案并做现场标定。`,
      expectedGain: 0
    });
    return recs;
  }

  const badSteps = new Set(bad.slice(0, 24).map((r) => r.stepId));
  const badPoints: Vec3[] = [];
  for (const step of state.steps) {
    if (!badSteps.has(step.id)) continue;
    const plan = planGuide(state, step, false);
    for (const e of plan.evaluations) if (!e.visible) badPoints.push(e.point);
  }
  if (!badPoints.length) {
    recs.push({
      severity: 'calibrate',
      title: '提高融合带或降低阈值',
      detail: '失败主要来自对比度/阈值，而非几何遮挡。可加宽边缘融合带、提高环境光补偿或更换高亮度机型。',
      expectedGain: 0
    });
    return recs;
  }

  const centroid = badPoints.reduce((a, p) => ({ x: a.x + p.x / badPoints.length, y: a.y + p.y / badPoints.length, z: 0 }), {
    x: 0,
    y: 0,
    z: 0
  });
  const fullOccluders = buildSceneOccluders(state);
  const testCandidate = (pos: Vec3): number => {
    const candidate = createRig({
      ...state.projectors[0],
      id: 'candidate',
      enabled: true,
      pos,
      target: { x: centroid.x, y: centroid.y, z: 0 }
    });
    let gain = 0;
    for (const p of badPoints) {
      const pp = projectPoint(candidate, p);
      if (!pp?.inFrustum) continue;
      const los = lineOfSight(candidate.eye, p, fullOccluders, 3);
      if (los.visible) gain++;
    }
    return gain / badPoints.length;
  };

  const addPos = { x: clamp(centroid.x, 250, state.board.width - 250), y: clamp(centroid.y - 180, -500, 500), z: 2050 };
  const addGain = testCandidate(addPos);
  recs.push({
    severity: 'add',
    title: `在 (${addPos.x.toFixed(0)}, ${addPos.y.toFixed(0)}, ${addPos.z.toFixed(0)}) mm 增加一台投影仪`,
    detail: `针对 ${bad.length} 个低可见率步骤的遮挡簇，预计可恢复约 ${(addGain * 100).toFixed(0)}% 的丢失采样。建议选用 ≥5000 lm、投射比 0.65–0.85 的 WUXGA 机型。`,
    suggestedPos: addPos,
    expectedGain: addGain
  });

  for (const p of state.projectors.filter((x) => x.enabled)) {
    let bestGain = 0;
    let bestPos = p.pos;
    for (const dx of [-420, -220, 220, 420]) {
      for (const dy of [-260, 0, 260]) {
        const candidatePos = { x: clamp(p.pos.x + dx, 150, state.board.width - 150), y: p.pos.y + dy, z: clamp(p.pos.z + (dx === 0 ? 160 : 0), 1200, 2800) };
        const rig = createRig({ ...p, pos: candidatePos });
        let gain = 0;
        for (const bp of badPoints) {
          const pp = projectPoint(rig, bp);
          if (pp?.inFrustum) {
            const los = lineOfSight(rig.eye, bp, fullOccluders, 3);
            if (los.visible) gain++;
          }
        }
        const g = gain / badPoints.length;
        if (g > bestGain + 0.02) {
          bestGain = g;
          bestPos = candidatePos;
        }
      }
    }
    if (bestGain > 0.18) {
      recs.push({
        severity: 'move',
        projectorId: p.id,
        title: `挪动 ${p.name} 至 (${bestPos.x.toFixed(0)}, ${bestPos.y.toFixed(0)}, ${bestPos.z.toFixed(0)}) mm`,
        detail: `该位置能避开更多线束/手臂深度遮挡，预计恢复约 ${(bestGain * 100).toFixed(0)}% 的问题采样。`,
        suggestedPos: bestPos,
        expectedGain: bestGain
      });
    }
  }

  if (state.settings.calibrationResidualMm > 1.2) {
    recs.push({
      severity: 'calibrate',
      title: '重新做孔位标定',
      detail: '当前录入的标定残差已占用较多 3mm 公差。建议用板面 9 点基准和堆高试块重新标定。',
      expectedGain: 0
    });
  }
  return recs.slice(0, 5);
}
