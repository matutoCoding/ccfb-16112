import type { ProjectorDevice } from '../types';
import type { GuidePlan } from '../lib/guide';
import { createRig, projectPoint, type ProjectorRig } from '../lib/projectors';

export interface ProjectorSlide {
  projectorId: string;
  canvas: HTMLCanvasElement;
  rig: ProjectorRig;
  version: number;
}

export function createSlides(projectors: ProjectorDevice[]): ProjectorSlide[] {
  return projectors
    .filter((p) => p.enabled)
    .map((p) => {
      const canvas = document.createElement('canvas');
      canvas.width = p.resolutionW;
      canvas.height = p.resolutionH;
      return { projectorId: p.id, canvas, rig: createRig(p), version: 0 };
    });
}

function projectedScale(rig: ProjectorRig, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const pa = projectPoint(rig, a);
  const pb = projectPoint(rig, b);
  if (!pa || !pb) return 1;
  const pxLen = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  const mmLen = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  return pxLen / mmLen;
}

function drawArrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size * 1.25, 0);
  ctx.lineTo(-size * 0.75, -size * 0.72);
  ctx.lineTo(-size * 0.35, 0);
  ctx.lineTo(-size * 0.75, size * 0.72);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.96)';
  ctx.lineWidth = Math.max(2, size * 0.18);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function paintSlide(slide: ProjectorSlide, plan: GuidePlan | null, timeMs: number): void {
  const { canvas, rig } = slide;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!plan) return;

  const pulse = 0.78 + 0.22 * Math.sin(timeMs * 0.008);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 当前导线流动箭头
  for (const seg of plan.segments) {
    if (seg.projectorId !== slide.projectorId) continue;
    const pa = projectPoint(rig, seg.a);
    const pb = projectPoint(rig, seg.b);
    if (!pa || !pb || !pa.inFrustum || !pb.inFrustum) continue;
    const scale = projectedScale(rig, seg.a, seg.b);
    const width = Math.max(7, seg.widthMm * scale);

    ctx.save();
    ctx.shadowColor = seg.color;
    ctx.shadowBlur = width * 0.9;
    ctx.strokeStyle = 'rgba(255,255,255,0.96)';
    ctx.lineWidth = width * 1.85;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();

    ctx.shadowBlur = width * 0.55;
    ctx.strokeStyle = seg.color;
    ctx.globalAlpha = 0.98;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();

    // 高亮光流
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * pulse})`;
    ctx.lineWidth = Math.max(2, width * 0.24);
    ctx.setLineDash([width * 1.25, width * 1.05]);
    ctx.lineDashOffset = -(timeMs / 28) % (width * 2.3);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;
    const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    drawArrowHead(ctx, mx, my, ang, width * 1.05, seg.color);
    ctx.restore();
  }

  // 线号文字
  const first = plan.segments.find((s) => s.projectorId === slide.projectorId);
  if (first) {
    const pa = projectPoint(rig, first.a);
    if (pa?.inFrustum) {
      const ppm = projectedScale(rig, first.a, first.b);
      const fontSize = Math.max(24, 34 * ppm);
      ctx.save();
      ctx.font = `800 ${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.textBaseline = 'middle';
      const text = plan.step.title.split('：')[1]?.split(' ')[0] ?? plan.step.title;
      ctx.lineWidth = fontSize * 0.18;
      ctx.strokeStyle = 'rgba(0,0,0,0.72)';
      ctx.strokeText(text, pa.x + fontSize * 0.5, pa.y - fontSize * 0.9);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, pa.x + fontSize * 0.5, pa.y - fontSize * 0.9);
      ctx.restore();
    }
  }

  // 目标孔位闪框
  for (const edge of plan.frameEdges) {
    if (edge.projectorId !== slide.projectorId) continue;
    const pa = projectPoint(rig, edge.a);
    const pb = projectPoint(rig, edge.b);
    if (!pa || !pb || !pa.inFrustum || !pb.inFrustum) continue;
    const scale = projectedScale(rig, edge.a, edge.b);
    const lw = Math.max(5, 3.2 * scale);
    const flash = 0.55 + 0.45 * Math.abs(Math.sin(timeMs * 0.011));
    ctx.save();
    ctx.globalAlpha = flash;
    ctx.shadowColor = '#ff2d55';
    ctx.shadowBlur = lw * 2.4;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = lw * 2.1;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.strokeStyle = '#ff2d55';
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.restore();
  }

  slide.version++;
}
