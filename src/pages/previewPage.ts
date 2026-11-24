import type { AppContext, PageHandle } from '../ui/context';
import { h, toast } from '../ui/dom';
import { Badge, Card, CheckRow, RangeRow, Stat } from '../ui/components';
import { ProjectionViewer } from '../webgl/Renderer';
import { buildSceneOccluders, getStepWorkerRig } from '../lib/occlusion';
import { contrastRatioAt, createRig, lineOfSight, projectPoint } from '../lib/projectors';

interface ContrastStats {
  failRate: number;
  worst: number;
  average: number;
  failPoints: Array<{ x: number; y: number; cr: number }>;
}

function computeContrastStats(ctx: AppContext, stepOrder?: number): ContrastStats {
  const state = ctx.state;
  const rigs = state.projectors.filter((p) => p.enabled).map(createRig);
  const worker = getStepWorkerRig(state, stepOrder);
  const occluders = buildSceneOccluders(state, { worker });
  let fail = 0;
  let total = 0;
  let sum = 0;
  let worst = Infinity;
  const failPoints: ContrastStats['failPoints'] = [];
  const ambient = state.settings.ceilingLightsOn ? state.settings.ambientLux : 24;

  for (let x = 35; x < state.board.width; x += 70) {
    for (let y = 35; y < state.board.height; y += 70) {
      total++;
      const p = { x, y, z: 0 };
      let best = 0;
      for (const rig of rigs) {
        const pp = projectPoint(rig, p);
        if (!pp?.inFrustum) continue;
        const los = lineOfSight(rig.eye, p, occluders, 3);
        if (!los.visible) continue;
        best = Math.max(best, contrastRatioAt(rig, p, ambient));
      }
      sum += best;
      worst = Math.min(worst, best);
      if (best < state.settings.contrastThreshold) {
        fail++;
        failPoints.push({ x, y, cr: best });
      }
    }
  }
  failPoints.sort((a, b) => a.cr - b.cr);
  return { failRate: fail / total, worst: Number.isFinite(worst) ? worst : 0, average: sum / total, failPoints: failPoints.slice(0, 8) };
}

export function renderPreviewPage(root: HTMLElement, ctx: AppContext): PageHandle {
  const state = ctx.state;
  state.settings.showContrastHeatmap = true;
  const initialStep = state.steps.find((s) => s.id === ctx.params.stepId)?.order ?? 42;
  let stepOrder = initialStep;
  let viewer: ProjectionViewer | null = null;
  let stats: ContrastStats | null = null;

  const canvas = h<HTMLCanvasElement>('canvas.viewer-canvas preview-canvas');
  const overlay = h('div.viewer-overlay', {}, [h('span#preview-stats', {}, '工位 WebGL2 启动中…'), h('span', {}, '人眼高度 1610mm · 拖拽环视')]);
  const viewerHost = h('div.viewer-host preview-host', {}, [canvas, overlay]);
  const statsHost = h('div.stat-grid');
  const regionHost = h('div.region-host');

  try {
    viewer = new ProjectionViewer(canvas);
    viewer.onStats = (s) => {
      const el = overlay.querySelector('#preview-stats');
      if (el) el.textContent = `工人视角 · ${s.fps} FPS · ${(s.triangles / 1000).toFixed(1)}k 面`;
    };
    viewer.onContextLost = () => {
      viewerHost.appendChild(h('div.webgl-error', {}, [
        h('strong', {}, 'WebGL 上下文已丢失'),
        h('p', {}, '数据和对比度计算不受影响；刷新页面可恢复三维预览。'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => window.location.reload() }, '刷新恢复')
      ]));
    };
    viewer.setProject(state, null);
    viewer.setAllWiresVisible(true);
    viewer.setWorkerStep(state.settings.workerFollowStep ? stepOrder : undefined);
    viewer.setCameraPreset('worker', state);
  } catch (e) {
    console.error(e);
    viewerHost.appendChild(h('div.webgl-error', {}, [(e as Error).message]));
  }

  function refreshScene(): void {
    viewer?.setProject(state, null);
    viewer?.setAllWiresVisible(true);
    viewer?.setWorkerStep(state.settings.workerFollowStep ? stepOrder : undefined);
  }

  function renderStats(): void {
    statsHost.replaceChildren(
      Stat('低对比区域', stats ? `${(stats.failRate * 100).toFixed(1)}%` : '计算中', stats && stats.failRate < 0.08 ? 'good' : 'bad', `阈值 ${state.settings.contrastThreshold}:1`),
      Stat('最差对比度', stats ? `${stats.worst.toFixed(2)}:1` : '—', stats && stats.worst >= state.settings.contrastThreshold ? 'good' : 'warn'),
      Stat('平均对比度', stats ? `${stats.average.toFixed(1)}:1` : '—', 'info'),
      Stat('车间照度', state.settings.ceilingLightsOn ? `${state.settings.ambientLux} lx` : '顶灯关', state.settings.ceilingLightsOn ? 'warn' : 'good')
    );
    regionHost.replaceChildren();
    if (!stats) {
      regionHost.appendChild(h('p.help', {}, '正在按投影仪光通量、投射距离、环境顶灯和遮挡计算对比度网格…'));
      return;
    }
    if (!stats.failPoints.length) {
      regionHost.appendChild(h('div.all-good', {}, '板面采样网格均满足对比度阈值。'));
      return;
    }
    regionHost.appendChild(h('h4', {}, '优先补光 / 调整投影仪的区域'));
    for (const p of stats.failPoints.slice(0, 6)) {
      regionHost.appendChild(h('div.region-row', {}, [
        Badge(`${p.cr.toFixed(1)}:1`, 'bad'),
        h('span.mono', {}, `X ${p.x.toFixed(0)} / Y ${p.y.toFixed(0)}`),
        h('button.btn.btn-mini', {
          onclick: () => {
            ctx.update((s) => {
              const pj = s.projectors[0];
              if (pj) {
                pj.target.x = p.x;
                pj.target.y = p.y;
              }
            });
            toast('已让左投影仪瞄准该低对比区域', 'success');
          }
        }, '瞄准')
      ]));
    }
  }

  function runContrast(): void {
    stats = computeContrastStats(ctx, state.settings.workerFollowStep ? stepOrder : undefined);
    renderStats();
  }

  const controls = h('div.controls-stack', {}, [
    Card('视角', h('div.button-row wrap', {}, [
      h('button.btn.btn-primary', { onclick: () => viewer?.setCameraPreset('worker', state) }, '人站板前'),
      h('button.btn', { onclick: () => viewer?.setCameraPreset('axon', state) }, '轴测'),
      h('button.btn', { onclick: () => viewer?.setCameraPreset('top', state) }, '俯视')
    ])),
    Card('车间灯光与对比度', h('div', {}, [
      CheckRow('车间顶灯开启', state.settings.ceilingLightsOn, (v) => ctx.update((s) => { s.settings.ceilingLightsOn = v; }), '开启后黑位抬升，投影对比度下降'),
      RangeRow('顶灯照度', state.settings.ambientLux, 0, 1600, 20, '{v} lx', (v) => ctx.update((s) => { s.settings.ambientLux = v; }, { silent: true })),
      RangeRow('对比度合格阈值', state.settings.contrastThreshold, 2, 7, 0.1, '{v}:1', (v) => ctx.update((s) => { s.settings.contrastThreshold = v; }, { silent: true })),
      CheckRow('显示低对比红色热力覆盖', state.settings.showContrastHeatmap, (v) => ctx.update((s) => { s.settings.showContrastHeatmap = v; })),
      h('button.btn.btn-primary', { onclick: runContrast }, '重新计算对比度区域')
    ])),
    Card('工人与挡光', h('div', {}, [
      CheckRow('显示工人 / 胳膊', state.settings.workerEnabled, (v) => {
        ctx.update((s) => { s.settings.workerEnabled = v; });
        refreshScene();
      }),
      CheckRow('手臂跟随当前布线步骤', state.settings.workerFollowStep, (v) => {
        ctx.update((s) => { s.settings.workerFollowStep = v; });
        refreshScene();
      }),
      RangeRow('模拟步骤', stepOrder, 1, state.steps.length, 1, '第 {v} 步', (v) => {
        stepOrder = Math.round(v);
        if (state.settings.workerFollowStep) viewer?.setWorkerStep(stepOrder);
      }),
      RangeRow('工人左右位置 X', state.settings.workerX, 250, state.board.width - 250, 10, '{v} mm', (v) => {
        ctx.update((s) => { s.settings.workerX = v; }, { silent: true });
        refreshScene();
      }),
      RangeRow('站位 Y（板前为负）', state.settings.workerY, -700, -80, 10, '{v} mm', (v) => {
        ctx.update((s) => { s.settings.workerY = v; }, { silent: true });
        refreshScene();
      })
    ])),
    Card('低对比区域清单', regionHost)
  ]);

  root.appendChild(h('div.page preview-page', {}, [
    h('div.guide-head', {}, [
      h('div', {}, [h('h1.page-title', {}, '工位预览与环境光校验'), h('p.page-subtitle', {}, '人眼视角、顶灯照度、工人手臂深度遮挡和对比度热力图；红色脉冲区为不满足阈值的位置。')]),
      h('div.button-row', {}, [Badge('WebGL2 自定义着色器', 'good'), Badge('投影仪深度图判遮挡', 'info')])
    ]),
    statsHost,
    h('div.preview-layout', {}, [
      Card('板前真人比例预览', viewerHost),
      controls
    ])
  ]));

  renderStats();
  setTimeout(runContrast, 300);
  return { destroy: () => viewer?.dispose() };
}
