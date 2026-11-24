import type { AppContext, PageHandle } from '../ui/context';
import { h, toast, pct } from '../ui/dom';
import { Badge, Card, CheckRow, NumberRow, RangeRow, Stat, progressBar } from '../ui/components';
import { ProjectionViewer } from '../webgl/Renderer';
import { buildRecommendations, computeAccuracy, computeAllReports, planGuide, type GuidePlan } from '../lib/guide';
import type { AccuracyReport, Recommendation, StepReport } from '../types';

export function renderGuidePage(root: HTMLElement, ctx: AppContext): PageHandle {
  const state = ctx.state;
  const initialWireId = ctx.params.wireId;
  let selectedOrder = Math.max(1, state.steps.find((s) => s.wireId === initialWireId)?.order ?? 1);
  let reports: StepReport[] = [];
  let accuracy: AccuracyReport | null = null;
  let recommendations: Recommendation[] = [];
  let plan: GuidePlan = planGuide(state, state.steps[selectedOrder - 1]);
  let playing = false;
  let showAllWires = false;
  let timer: number | null = null;
  let viewer: ProjectionViewer | null = null;
  let destroyed = false;

  const canvas = h<HTMLCanvasElement>('canvas.viewer-canvas');
  const viewerHost = h('div.viewer-host', {}, [
    canvas,
    h('div.viewer-overlay', {}, [h('span#gl-stats', {}, 'WebGL2 初始化中…'), h('span', {}, '拖拽旋转 · 滚轮缩放')])
  ]);
  const listHost = h('div.step-list');
  const currentHost = h('div.current-host');
  const accuracyHost = h('div.accuracy-host');
  const recommendHost = h('div.recommend-host');
  const reportHost = h('div.report-host');
  const topStats = h('div.stat-grid');
  const progressHost = h('div.progress-host');

  try {
    viewer = new ProjectionViewer(canvas);
    viewer.onStats = (s) => {
      const el = viewerHost.querySelector('#gl-stats');
      if (el) el.textContent = `WebGL2 · ${s.fps} FPS · ${(s.triangles / 1000).toFixed(1)}k 三角面 · 3×1536² 深度图`;
    };
    viewer.onContextLost = () => {
      viewerHost.appendChild(h('div.webgl-error', {}, [
        h('strong', {}, 'WebGL 上下文已被浏览器回收'),
        h('p', {}, '常见于显卡资源紧张、长时间调试或多个 WebGL 页面共存。数据已保存在 IndexedDB，刷新即可恢复视图。'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => window.location.reload() }, '刷新恢复')
      ]));
    };
    viewer.setCameraPreset('axon', state);
    viewer.setProject(state, plan);
  } catch (e) {
    console.error(e);
    viewerHost.appendChild(h('div.webgl-error', {}, [
      h('strong', {}, 'WebGL2 渲染器启动失败'),
      h('p', {}, (e as Error).message),
      h('p.help', {}, '请使用最新版 Chrome/Edge，并确认已开启硬件加速。数据和计算报告仍可使用。')
    ]));
  }

  function selectStep(order: number): void {
    selectedOrder = Math.min(state.steps.length, Math.max(1, order));
    const step = state.steps[selectedOrder - 1];
    plan = planGuide(state, step);
    viewer?.setPlan(plan);
    renderList();
    renderCurrent();
  }

  function togglePlay(): void {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 连续校验';
    if (playing) {
      timer = window.setInterval(() => {
        if (selectedOrder >= state.steps.length) selectStep(1);
        else selectStep(selectedOrder + 1);
      }, 1800);
    } else if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  const playBtn = h('button.btn.btn-primary', { onclick: togglePlay }, '▶ 连续校验');

  function renderList(): void {
    listHost.replaceChildren();
    for (const s of state.steps) {
      const r = reports.find((x) => x.order === s.order);
      const vis = r?.visibility ?? 1;
      const tone = !r ? '' : r.passed ? 'good' : vis >= state.settings.visibilityThreshold ? 'warn' : 'bad';
      listHost.appendChild(h('button.step-row', {
        class: s.order === selectedOrder ? 'active' : '',
        onclick: () => selectStep(s.order)
      }, [
        h('span.step-order', {}, String(s.order).padStart(3, '0')),
        h('span.step-main', {}, [
          h('strong', {}, s.title.split('：')[1] ?? s.title),
          progressBar(vis, `bar-${tone}`),
        ]),
        h('span.step-pct', { class: `text-${tone}` }, r ? pct(vis, 0) : '—')
      ]));
    }
    const active = listHost.querySelector('.active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  function renderCurrent(): void {
    const step = state.steps[selectedOrder - 1];
    const wire = state.wires.find((w) => w.id === step.wireId);
    if (!wire) return;
    const report = reports.find((r) => r.order === selectedOrder);
    const visible = plan.evaluations.filter((e) => e.visible).length;
    currentHost.replaceChildren(
      h('div.current-title', {}, [
        h('span.color-chip.large', { style: `background:${wire.color}` }),
        h('div', {}, [h('h3', {}, step.title), h('p', {}, `工时 ${step.workSeconds}s · ${wire.crossSection}mm² · 路径 ${wire.route.length} 点`)])
      ]),
      h('div.button-row', {}, [
        h('button.btn', { onclick: () => selectStep(selectedOrder - 1) }, '上一步'),
        h('button.btn.btn-primary', { onclick: () => selectStep(selectedOrder + 1) }, '下一步'),
        playBtn,
        h('button.btn', { onclick: () => ctx.go('preview', { stepId: step.id }) }, '工位视角')
      ]),
      h('div.plan-badges', {}, [
        Badge(`可见采样 ${visible}/${plan.evaluations.length}`, visible / plan.evaluations.length >= state.settings.visibilityThreshold ? 'good' : 'bad'),
        Badge(plan.failover || plan.usedProjectorIds.length > 1 ? `已切换/分摊 ${plan.usedProjectorIds.length} 台` : `主投 ${plan.usedProjectorIds[0] ?? '无'}`, plan.usedProjectorIds.length ? 'info' : 'bad'),
        report?.blockedByArms ? Badge(`手臂遮挡 ${report.blockedByArms}`, 'warn') : null,
        report?.blockedByHarness ? Badge(`线束遮挡 ${report.blockedByHarness}`, 'warn') : null
      ]),
      report ? h('dl.kv', {}, [
        kv('步骤可见率', pct(report.visibility, 2)),
        kv('最低对比度', `${report.minContrast.toFixed(2)}:1`),
        kv('最低像素密度', `${report.minDensityPpi.toFixed(1)} PPI`),
        kv('最大落点偏差', `${report.maxAccuracyErrorMm.toFixed(2)} mm`)
      ]) : h('p.help', {}, '全量报告计算中，当前步骤已可实时预览。'),
      h('div.button-row', {}, [
        CheckRow('显示全部成品线束（否则只显示本步之前）', showAllWires, (v) => {
          showAllWires = v;
          viewer?.setAllWiresVisible(v);
        }),
      ])
    );
  }

  function kv(k: string, v: string): HTMLElement {
    return h('div.kv-row', {}, [h('dt', {}, k), h('dd.mono', {}, v)]);
  }

  function renderAccuracy(): void {
    accuracyHost.replaceChildren();
    if (!accuracy) {
      accuracyHost.appendChild(h('p.help', {}, '正在逐孔反投影并做射线落点校验…'));
      return;
    }
    accuracyHost.append(
      h('div.accuracy-hero', { class: accuracy.passed ? 'good' : 'bad' }, [
        h('strong', {}, accuracy.passed ? '≤ 3 mm 校验通过' : '存在超差点'),
        h('span', {}, `最坏 ${accuracy.maxHoleErrorMm > accuracy.maxStackErrorMm ? accuracy.maxHoleErrorMm.toFixed(2) : accuracy.maxStackErrorMm.toFixed(2)} mm / 公差 ${accuracy.toleranceMm} mm`)
      ]),
      h('dl.kv', {}, [
        kv('任意孔位框最大偏差', `${accuracy.maxHoleErrorMm.toFixed(3)} mm`),
        kv('堆高箭头最大偏差', `${accuracy.maxStackErrorMm.toFixed(3)} mm`),
        kv('校验样本', `${accuracy.sampleCount.toLocaleString()} 个孔框角点/可见堆高点`),
        accuracy.occludedStackSamples ? kv('无视线堆高点', `${accuracy.occludedStackSamples} 个（转入可见率建议）`) : null,
        accuracy.worst ? kv('最差点', `${accuracy.worst.label} · ${accuracy.worst.errorMm.toFixed(3)}mm`) : kv('最差点', '—')
      ]),
      NumberRow('录入现场标定残差', state.settings.calibrationResidualMm, 0, 2, 0.01, 'mm', (v) => {
        ctx.update((s) => { s.settings.calibrationResidualMm = v; });
        accuracy = computeAccuracy(state);
        renderAccuracy();
      }),
      h('p.help', {}, '偏差由矩阵反投影误差、投影像素量化、深度遮挡面到期望点的三维距离和标定残差组成。')
    );
  }

  function renderRecommendations(): void {
    recommendHost.replaceChildren();
    if (!recommendations.length) {
      recommendHost.appendChild(h('p.help', {}, '完成全量计算后给出加机/挪机建议。'));
      return;
    }
    for (const r of recommendations) {
      recommendHost.appendChild(h(`div.reco reco-${r.severity}`, {}, [
        h('header', {}, [Badge(r.severity === 'add' ? '建议加机' : r.severity === 'move' ? '建议挪机' : '标定', r.severity === 'add' ? 'good' : 'warn'), h('strong', {}, r.title)]),
        h('p', {}, r.detail),
        r.suggestedPos ? h('button.btn.btn-mini', {
          onclick: () => {
            if (r.projectorId) {
              ctx.update((s) => {
                const p = s.projectors.find((x) => x.id === r.projectorId);
                if (p && r.suggestedPos) p.pos = { ...r.suggestedPos };
              });
            } else {
              ctx.go('projectors');
              toast('可在投影仪页点击添加，并输入建议坐标', 'info', 3600);
            }
          }
        }, r.projectorId ? '应用建议位置' : '去投影仪页添加') : null
      ]));
    }
  }

  function renderTopStats(): void {
    const threshold = state.settings.visibilityThreshold;
    const failed = reports.filter((r) => r.visibility < threshold);
    const avg = reports.length ? reports.reduce((s, r) => s + r.visibility, 0) / reports.length : 0;
    topStats.replaceChildren(
      Stat('校验步骤', `${reports.length}/${state.steps.length}`, 'info'),
      Stat('平均可见率', reports.length ? pct(avg, 2) : '—', avg >= state.settings.visibilityThreshold ? 'good' : 'warn'),
      Stat('低于阈值', String(failed.length), failed.length ? 'bad' : 'good'),
      Stat('精度结论', accuracy ? (accuracy.passed ? 'PASS ≤3mm' : 'FAIL') : '计算中', accuracy?.passed ? 'good' : accuracy ? 'bad' : 'info')
    );
  }

  function renderReport(): void {
    const threshold = state.settings.visibilityThreshold;
    const bad = reports.filter((r) => r.visibility < threshold).sort((a, b) => a.visibility - b.visibility);
    reportHost.replaceChildren(
      h('div.report-toolbar', {}, [
        RangeRow('可见率阈值', threshold * 100, 80, 100, 0.5, '{v}%', (v) => {
          ctx.update((s) => { s.settings.visibilityThreshold = v / 100; }, { silent: true });
          renderTopStats();
          renderList();
        }),
        h('div.spacer'),
        h('button.btn', { onclick: runReports }, '重新计算全部步骤'),
        h('button.btn.btn-primary', {
          onclick: () => {
            const rows: Array<Array<string | number>> = [['步序', '线号', '可见率', '手臂遮挡', '线束遮挡', '视锥外', '最低对比度', '最大偏差mm', '问题']];
            for (const r of reports) rows.push([r.order, r.lineNo, pct(r.visibility, 2), r.blockedByArms, r.blockedByHarness, r.outsideCoverage, r.minContrast.toFixed(2), r.maxAccuracyErrorMm.toFixed(2), r.issues.join('；')]);
            const csv = rows.map((row) => row.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
            const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'projection-visibility-report.csv';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }
        }, '导出报告 CSV')
      ]),
      progressHost,
      bad.length ? h('div.bad-list', {}, bad.slice(0, 30).map((r) => h('button.bad-row', {
        onclick: () => selectStep(r.order)
      }, [
        h('strong.mono', {}, `#${r.order} ${r.lineNo}`),
        h('span', {}, pct(r.visibility, 1)),
        h('span.bad-issues', {}, r.issues[0] ?? '')
      ]))) : reports.length ? h('div.all-good', {}, '所有步骤均高于阈值。') : h('p.help', {}, '报告尚未生成。'),
      h('details.report-table-details', {}, [
        h('summary', {}, `查看全部 ${reports.length} 步明细`),
        h('div.table-scroll compact', {}, h('table.data-table', {}, [
          h('thead', {}, h('tr', {}, ['步序', '线号', '可见率', '对比度', 'PPI', '偏差', '状态'].map((x) => h('th', {}, x)))),
          h('tbody', {}, reports.map((r) => h('tr', { onclick: () => selectStep(r.order) }, [
            h('td.mono', {}, r.order),
            h('td.mono', {}, r.lineNo),
            h('td', {}, pct(r.visibility, 1)),
            h('td.num', {}, r.minContrast.toFixed(1)),
            h('td.num', {}, r.minDensityPpi.toFixed(0)),
            h('td.num', {}, r.maxAccuracyErrorMm.toFixed(2)),
            h('td', {}, Badge(r.passed ? '通过' : '偏低', r.passed ? 'good' : 'bad'))
          ])))
        ]))
      ])
    );
  }

  async function runReports(): Promise<void> {
    progressHost.replaceChildren(h('div.loading-bar', {}, h('i', { style: 'width:0%' }), h('span', {}, '正在逐根导线计算深度遮挡与可见率…')));
    reports = await computeAllReports(state, (done, total) => {
      const bar = progressHost.querySelector('i');
      const label = progressHost.querySelector('span');
      const p = done / total;
      if (bar) (bar as HTMLElement).style.width = `${p * 100}%`;
      if (label) label.textContent = `正在计算 ${done}/${total}…`;
    });
    if (destroyed) return;
    progressHost.replaceChildren(h('div.loading-done', {}, `已完成 ${reports.length} 个步骤校验`));
    try {
      accuracy = computeAccuracy(state);
    } catch (e) {
      console.error('精度校验失败', e);
      toast('精度校验计算异常，可见率报告仍可用', 'error');
    }
    try {
      recommendations = buildRecommendations(state, reports);
    } catch (e) {
      console.error('建议生成失败', e);
    }
    if (destroyed) return;
    renderTopStats();
    renderList();
    renderCurrent();
    renderAccuracy();
    renderRecommendations();
    renderReport();
    toast('全流程投影可见率与 3mm 精度校验完成', 'success');
  }

  root.appendChild(h('div.page guide-page', {}, [
    h('div.guide-head', {}, [
      h('div', {}, [h('h1.page-title', {}, '指引编排与逐步骤校验'), h('p.page-subtitle', {}, '当前导线流动箭头、目标孔位闪框、多机自动切换、深度遮挡与边缘融合均在 WebGL2 中实时计算。')]),
      h('div.button-row', {}, [
        h('button.btn', { onclick: () => viewer?.setCameraPreset('axon', state) }, '轴测视角'),
        h('button.btn', { onclick: () => viewer?.setCameraPreset('top', state) }, '俯视'),
        h('button.btn', { onclick: () => viewer?.setCameraPreset('worker', state) }, '工人视角')
      ])
    ]),
    topStats,
    h('div.guide-layout', {}, [
      Card('布线顺序（200 步）', listHost, h('span.header-meta', {}, '点击步骤预览')),
      h('div.center-stack', {}, [
        Card('投影贴花 / 深度遮挡 / 多机切换', viewerHost, h('div.card-actions', {}, [
          CheckRow('对比度热力图', state.settings.showContrastHeatmap, (v) => ctx.update((s) => { s.settings.showContrastHeatmap = v; })),
        ])),
        Card('当前步骤', currentHost)
      ]),
      h('div.right-stack', {}, [
        Card('3mm 落点精度', accuracyHost),
        Card('加机 / 挪机建议', recommendHost)
      ])
    ]),
    Card('整套线束可见率清单', reportHost)
  ]));

  renderList();
  renderCurrent();
  renderAccuracy();
  renderRecommendations();
  renderTopStats();
  renderReport();
  void runReports();

  return {
    destroy: () => {
      destroyed = true;
      if (timer !== null) clearInterval(timer);
      playing = false;
      viewer?.dispose();
    }
  };
}
