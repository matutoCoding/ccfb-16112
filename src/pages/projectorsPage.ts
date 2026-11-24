import type { AppContext, PageHandle } from '../ui/context';
import { h, toast } from '../ui/dom';
import { Badge, Card, CheckRow, NumberRow, RangeRow, Stat } from '../ui/components';
import type { ProjectorDevice } from '../types';
import { coveragePolygon, createRig, pixelDensity, setDepressionAngle, setMountHeight } from '../lib/projectors';
import { clamp } from '../lib/math';

interface DragState {
  id: string;
  part: 'pos' | 'target';
  plane: 'top' | 'side';
}

export function renderProjectorsPage(root: HTMLElement, ctx: AppContext): PageHandle {
  const state = ctx.state;
  let drag: DragState | null = null;
  const topCanvas = h<HTMLCanvasElement>('canvas.proj-canvas');
  const sideCanvas = h<HTMLCanvasElement>('canvas.proj-canvas side-canvas');
  const cardsHost = h('div.projector-cards');
  const summaryHost = h('div.stat-grid');

  function edit(id: string, fn: (p: ProjectorDevice) => void, rerender = false): void {
    ctx.update((s) => {
      const p = s.projectors.find((x) => x.id === id);
      if (p) fn(p);
    });
    drawAll();
    updateSummary();
    if (rerender) renderCards();
  }

  function addProjector(): void {
    if (state.projectors.length >= 4) {
      toast('WebGL 深度图数组当前最多支持 4 台投影仪', 'error');
      return;
    }
    const n = state.projectors.length + 1;
    const p: ProjectorDevice = {
      id: `pj-${Date.now().toString(36)}`,
      name: `投影仪 ${n}`,
      model: 'WUXGA Laser 6000lm / 0.8',
      resolutionW: 1920,
      resolutionH: 1200,
      throwRatio: 0.82,
      lensShiftX: 0,
      lensShiftY: 0.06,
      lumens: 6000,
      nativeContrast: 5000,
      enabled: true,
      pos: { x: state.board.width / 2 + (n - 2) * 360, y: -520, z: 1950 },
      target: { x: state.board.width / 2, y: state.board.height / 2, z: 0 },
      roll: 0
    };
    ctx.update((s) => s.projectors.push(p));
    renderCards();
    drawAll();
    updateSummary();
    toast('已添加投影仪，可在侧视图拖动吊装位置', 'success');
  }

  function renderCards(): void {
    cardsHost.replaceChildren();
    for (const p of state.projectors) {
      const rig = createRig(p);
      const statLine = h('div.pj-card-stats', { dataset: { id: p.id } }, `${rig.depressionDeg.toFixed(1)}° 俯角 · ${rig.imageWidthMm.toFixed(0)}×${rig.imageHeightMm.toFixed(0)} mm 参考画面`);
      const enabledCheck = h<HTMLInputElement>('input', {
        type: 'checkbox',
        checked: p.enabled,
        onchange: () => edit(p.id, (q) => { q.enabled = enabledCheck.checked; }, true)
      });
      const card = h('article.device-card', {}, [
        h('header.device-head', {}, [
          h('div', {}, [
            h<HTMLInputElement>('input.device-name', {
              value: p.name,
              onchange: (e: Event) => edit(p.id, (q) => { q.name = (e.target as HTMLInputElement).value; })
            }),
            h<HTMLInputElement>('input.device-model', {
              value: p.model,
              onchange: (e: Event) => edit(p.id, (q) => { q.model = (e.target as HTMLInputElement).value; })
            })
          ]),
          h('div.device-head-right', {}, [
            h('label.inline-check', {}, [enabledCheck, '启用']),
            h('button.btn.btn-mini.btn-danger', {
              onclick: () => {
                ctx.update((s) => { s.projectors = s.projectors.filter((x) => x.id !== p.id); });
                renderCards();
                drawAll();
                updateSummary();
              }
            }, '删除')
          ])
        ]),
        h('div.device-grid', {}, [
          NumberRow('分辨率 W', p.resolutionW, 800, 7680, 2, 'px', (v) => edit(p.id, (q) => { q.resolutionW = Math.round(v); })),
          NumberRow('分辨率 H', p.resolutionH, 600, 4320, 2, 'px', (v) => edit(p.id, (q) => { q.resolutionH = Math.round(v); })),
          NumberRow('投射比', p.throwRatio, 0.35, 2.2, 0.01, 'D/W', (v) => edit(p.id, (q) => { q.throwRatio = v; })),
          NumberRow('亮度', p.lumens, 1000, 20000, 100, 'lm', (v) => edit(p.id, (q) => { q.lumens = v; })),
          NumberRow('原生对比度', p.nativeContrast, 500, 20000, 100, ':1', (v) => edit(p.id, (q) => { q.nativeContrast = v; })),
          NumberRow('水平位移', p.lensShiftX, -0.5, 0.5, 0.01, 'W', (v) => edit(p.id, (q) => { q.lensShiftX = v; })),
          NumberRow('垂直位移', p.lensShiftY, -0.5, 0.8, 0.01, 'H', (v) => edit(p.id, (q) => { q.lensShiftY = v; })),
          NumberRow('X 吊装坐标', p.pos.x, -300, state.board.width + 300, 10, 'mm', (v) => edit(p.id, (q) => { q.pos.x = v; })),
          NumberRow('Y 吊装坐标', p.pos.y, -1200, state.board.height + 300, 10, 'mm', (v) => edit(p.id, (q) => { q.pos.y = v; })),
          NumberRow('Z 吊装高度', p.pos.z, 900, 3200, 10, 'mm', (v) => edit(p.id, (q) => Object.assign(q, setMountHeight(q, v)))),
          NumberRow('瞄准 X', p.target.x, 0, state.board.width, 10, 'mm', (v) => edit(p.id, (q) => { q.target.x = v; })),
          NumberRow('瞄准 Y', p.target.y, 0, state.board.height, 10, 'mm', (v) => edit(p.id, (q) => { q.target.y = v; }))
        ]),
        RangeRow('俯角（相对水平面）', Math.round(rig.depressionDeg * 10) / 10, 25, 89.5, 0.1, '{v}°', (v) =>
          edit(p.id, (q) => Object.assign(q, setDepressionAngle(q, v)))
        ),
        statLine
      ]);
      cardsHost.appendChild(card);
    }
  }

  function topTransform(): { s: number; ox: number; oy: number; w: number; h: number } {
    const rect = topCanvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    topCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
    topCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const w = topCanvas.width;
    const h = topCanvas.height;
    const s = Math.min((w - 90 * dpr) / state.board.width, (h - 90 * dpr) / state.board.height);
    return { s, ox: (w - state.board.width * s) / 2, oy: (h - state.board.height * s) / 2, w, h };
  }
  const tx = (x: number, y: number, t = topTransform()) => ({ x: t.ox + x * t.s, y: t.oy + (state.board.height - y) * t.s });
  const invTop = (cx: number, cy: number) => {
    const r = topCanvas.getBoundingClientRect();
    const dpr = topCanvas.width / r.width;
    const sx = (cx - r.left) * dpr;
    const sy = (cy - r.top) * dpr;
    const t = topTransform();
    return { x: (sx - t.ox) / t.s, y: state.board.height - (sy - t.oy) / t.s };
  };

  function drawTop(): void {
    const c = topCanvas.getContext('2d');
    if (!c) return;
    const t = topTransform();
    const dpr = topCanvas.width / Math.max(1, topCanvas.getBoundingClientRect().width);
    c.clearRect(0, 0, t.w, t.h);
    c.fillStyle = '#0b1220';
    c.fillRect(0, 0, t.w, t.h);
    const a = tx(0, 0, t);
    const b = tx(state.board.width, state.board.height, t);
    c.fillStyle = state.board.color;
    c.fillRect(a.x, b.y, b.x - a.x, a.y - b.y);

    c.save();
    c.beginPath();
    c.rect(a.x, b.y, b.x - a.x, a.y - b.y);
    c.clip();

    // 像素密度网格
    const rigs = state.projectors.filter((p) => p.enabled).map(createRig);
    if (state.settings.showDensityHeatmap) {
      const cell = 50;
      for (let x = 0; x < state.board.width; x += cell) {
        for (let y = 0; y < state.board.height; y += cell) {
          let best = 0;
          for (const rig of rigs) {
            const d = pixelDensity(rig, { x: x + cell / 2, y: y + cell / 2, z: 0 });
            if (d.ok) best = Math.max(best, d.ppi);
          }
          if (best > 0) {
            const s0 = tx(x, y + cell, t);
            c.fillStyle = `hsla(${clamp(120 * best / 55, 0, 135)},75%,48%,0.28)`;
            c.fillRect(s0.x, s0.y, cell * t.s + 1, cell * t.s + 1);
          }
        }
      }
    }

    // 覆盖多边形
    if (state.settings.showCoverage) {
      rigs.forEach((rig, i) => {
      const poly = coveragePolygon(rig, 0);
      if (poly.length < 2) return;
      c.beginPath();
      poly.forEach((p, j) => {
        const s = tx(p.x, p.y, t);
        if (j === 0) c.moveTo(s.x, s.y); else c.lineTo(s.x, s.y);
      });
      c.closePath();
      const colors = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24'];
      c.fillStyle = `${colors[i % 4]}18`;
      c.strokeStyle = colors[i % 4];
      c.lineWidth = 2.4 * dpr;
      c.fill();
      c.stroke();
      });
    }
    c.restore();

    // 投影仪/瞄准点
    state.projectors.forEach((p, i) => {
      const pos = tx(p.pos.x, p.pos.y, t);
      const tar = tx(p.target.x, p.target.y, t);
      c.strokeStyle = 'rgba(226,232,240,.55)';
      c.setLineDash([6 * dpr, 5 * dpr]);
      c.beginPath(); c.moveTo(pos.x, pos.y); c.lineTo(tar.x, tar.y); c.stroke(); c.setLineDash([]);
      c.fillStyle = '#fde047';
      c.beginPath(); c.arc(tar.x, tar.y, 6 * dpr, 0, Math.PI * 2); c.fill();
      c.fillStyle = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24'][i % 4];
      c.beginPath(); c.arc(pos.x, pos.y, 11 * dpr, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 2 * dpr; c.stroke();
      c.fillStyle = '#e5e7eb';
      c.font = `${13 * dpr}px Segoe UI, Microsoft YaHei`;
      c.fillText(p.name, pos.x + 15 * dpr, pos.y - 12 * dpr);
      c.fillStyle = '#fde047';
      c.fillText('瞄准点', tar.x + 9 * dpr, tar.y + 4 * dpr);
    });

    c.fillStyle = '#cbd5e1';
    c.font = `${12 * dpr}px Segoe UI`;
    c.fillText('俯视图：色块=最佳像素密度，描边=视锥与板面交面；可拖投影仪或瞄准点', 18 * dpr, 24 * dpr);
  }

  function sideTransform(): { s: number; x0: number; z0: number; w: number; h: number } {
    const rect = sideCanvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    sideCanvas.width = Math.floor(Math.max(1, rect.width) * dpr);
    sideCanvas.height = Math.floor(Math.max(1, rect.height) * dpr);
    const w = sideCanvas.width;
    const h = sideCanvas.height;
    const yMin = -1000;
    const yMax = state.board.height + 350;
    const zMin = -80;
    const zMax = 2400;
    const s = Math.min((w - 110 * dpr) / (yMax - yMin), (h - 90 * dpr) / (zMax - zMin));
    return { s, x0: 55 * dpr - yMin * s, z0: h - 45 * dpr + zMin * s, w, h };
  }
  const sidePoint = (y: number, z: number, t = sideTransform()) => ({ x: t.x0 + y * t.s, y: t.z0 - z * t.s });
  const invSide = (cx: number, cy: number) => {
    const r = sideCanvas.getBoundingClientRect();
    const dpr = sideCanvas.width / r.width;
    const sx = (cx - r.left) * dpr;
    const sy = (cy - r.top) * dpr;
    const t = sideTransform();
    return { y: (sx - t.x0) / t.s, z: (t.z0 - sy) / t.s };
  };

  function drawSide(): void {
    const c = sideCanvas.getContext('2d');
    if (!c) return;
    const t = sideTransform();
    const dpr = sideCanvas.width / Math.max(1, sideCanvas.getBoundingClientRect().width);
    c.clearRect(0, 0, t.w, t.h);
    c.fillStyle = '#0b1220'; c.fillRect(0, 0, t.w, t.h);
    const a = sidePoint(0, 0, t);
    const b = sidePoint(state.board.height, 0, t);
    c.fillStyle = state.board.color;
    c.fillRect(a.x, a.y - 8 * dpr, b.x - a.x, 16 * dpr);
    c.strokeStyle = '#64748b'; c.strokeRect(a.x, a.y - 8 * dpr, b.x - a.x, 16 * dpr);
    c.fillStyle = '#94a3b8'; c.font = `${12 * dpr}px Segoe UI`;
    c.fillText('板前边 Y=0', a.x - 30 * dpr, a.y + 34 * dpr);
    c.fillText('板后边 Y=H', b.x - 30 * dpr, b.y + 34 * dpr);

    // 工人示意
    const wy = state.settings.workerY;
    const ws = sidePoint(wy, 0, t);
    c.strokeStyle = '#f97316'; c.lineWidth = 8 * dpr;
    c.beginPath(); c.moveTo(ws.x, ws.y); c.lineTo(ws.x, ws.y - 360 * t.s); c.stroke();
    c.beginPath(); c.arc(ws.x, ws.y - 430 * t.s, 28 * dpr, 0, Math.PI * 2); c.stroke();

    state.projectors.forEach((p, i) => {
      const pos = sidePoint(p.pos.y, p.pos.z, t);
      const tar = sidePoint(p.target.y, p.target.z, t);
      const colors = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24'];
      c.strokeStyle = `${colors[i % 4]}88`;
      c.lineWidth = 2 * dpr;
      c.beginPath(); c.moveTo(pos.x, pos.y); c.lineTo(tar.x, tar.y); c.stroke();
      c.fillStyle = colors[i % 4];
      c.fillRect(pos.x - 18 * dpr, pos.y - 10 * dpr, 36 * dpr, 20 * dpr);
      c.beginPath(); c.arc(tar.x, tar.y, 6 * dpr, 0, Math.PI * 2); c.fillStyle = '#fde047'; c.fill();
      c.fillStyle = '#e5e7eb';
      c.fillText(`${p.name} ${createRig(p).depressionDeg.toFixed(0)}°`, pos.x + 24 * dpr, pos.y - 12 * dpr);
    });
    c.fillStyle = '#cbd5e1';
    c.fillText('侧视图：上下拖投影仪调吊装高度，前后拖改变俯角；黄点为瞄准点', 18 * dpr, 24 * dpr);
  }

  function drawAll(): void {
    drawTop();
    drawSide();
    updateCardStats();
  }

  function updateCardStats(): void {
    for (const p of state.projectors) {
      const host = cardsHost.querySelector<HTMLElement>(`[data-id="${p.id}"]`);
      if (host) {
        const rig = createRig(p);
        host.textContent = `${rig.depressionDeg.toFixed(1)}° 俯角 · ${rig.imageWidthMm.toFixed(0)}×${rig.imageHeightMm.toFixed(0)} mm 参考画面`;
      }
    }
  }

  function computeSummary() {
    const rigs = state.projectors.filter((p) => p.enabled).map(createRig);
    let covered = 0;
    let total = 0;
    let minPpi = Infinity;
    let sumPpi = 0;
    for (let x = 40; x < state.board.width; x += 80) {
      for (let y = 40; y < state.board.height; y += 80) {
        total++;
        let best = 0;
        for (const rig of rigs) {
          const d = pixelDensity(rig, { x, y, z: 0 });
          if (d.ok) best = Math.max(best, d.ppi);
        }
        if (best > 0) {
          covered++;
          minPpi = Math.min(minPpi, best);
          sumPpi += best;
        }
      }
    }
    return { coverage: covered / total, minPpi: Number.isFinite(minPpi) ? minPpi : 0, avgPpi: covered ? sumPpi / covered : 0 };
  }

  function updateSummary(): void {
    const s = computeSummary();
    summaryHost.replaceChildren(
      Stat('投影仪', `${state.projectors.length} 台`, 'info', `${state.projectors.filter((p) => p.enabled).length} 台启用`),
      Stat('板面覆盖率', `${(s.coverage * 100).toFixed(1)}%`, s.coverage > 0.98 ? 'good' : 'warn'),
      Stat('最低像素密度', `${s.minPpi.toFixed(1)} PPI`, s.minPpi >= 20 ? 'good' : 'warn', '斜射边缘采样'),
      Stat('平均像素密度', `${s.avgPpi.toFixed(1)} PPI`, 'info')
    );
  }

  function hitTop(p: { x: number; y: number }): DragState | null {
    for (const proj of state.projectors) {
      if (Math.hypot(proj.pos.x - p.x, proj.pos.y - p.y) < 55) return { id: proj.id, part: 'pos', plane: 'top' };
      if (Math.hypot(proj.target.x - p.x, proj.target.y - p.y) < 45) return { id: proj.id, part: 'target', plane: 'top' };
    }
    return null;
  }
  topCanvas.addEventListener('pointerdown', (e) => {
    topCanvas.setPointerCapture(e.pointerId);
    const p = invTop(e.clientX, e.clientY);
    drag = hitTop(p);
  });
  topCanvas.addEventListener('pointermove', (e) => {
    const p = invTop(e.clientX, e.clientY);
    if (!drag || drag.plane !== 'top') return;
    const proj = state.projectors.find((x) => x.id === drag!.id);
    if (!proj) return;
    if (drag.part === 'pos') {
      proj.pos.x = Math.round(clamp(p.x, -300, state.board.width + 300) / 10) * 10;
      proj.pos.y = Math.round(clamp(p.y, -1200, state.board.height + 400) / 10) * 10;
    } else {
      proj.target.x = Math.round(clamp(p.x, 0, state.board.width) / 10) * 10;
      proj.target.y = Math.round(clamp(p.y, 0, state.board.height) / 10) * 10;
    }
    drawAll();
  });
  topCanvas.addEventListener('pointerup', () => { if (drag?.plane === 'top') { drag = null; ctx.update(() => undefined); ctx.saveNow(); renderCards(); } });

  sideCanvas.addEventListener('pointerdown', (e) => {
    sideCanvas.setPointerCapture(e.pointerId);
    const p = invSide(e.clientX, e.clientY);
    for (const proj of state.projectors) {
      if (Math.hypot(proj.pos.y - p.y, proj.pos.z - p.z) < 90) { drag = { id: proj.id, part: 'pos', plane: 'side' }; return; }
      if (Math.hypot(proj.target.y - p.y, proj.target.z - p.z) < 70) { drag = { id: proj.id, part: 'target', plane: 'side' }; return; }
    }
  });
  sideCanvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.plane !== 'side') return;
    const p = invSide(e.clientX, e.clientY);
    const proj = state.projectors.find((x) => x.id === drag!.id);
    if (!proj) return;
    if (drag.part === 'pos') {
      proj.pos.y = Math.round(clamp(p.y, -1200, state.board.height + 500) / 10) * 10;
      proj.pos.z = Math.round(clamp(p.z, 900, 3200) / 10) * 10;
    } else {
      proj.target.y = Math.round(clamp(p.y, 0, state.board.height) / 10) * 10;
      proj.target.z = 0;
    }
    drawAll();
  });
  sideCanvas.addEventListener('pointerup', () => { if (drag?.plane === 'side') { drag = null; ctx.update(() => undefined); ctx.saveNow(); renderCards(); } });

  const blendCard = Card('边缘融合', h('div', {}, [
    RangeRow('融合带宽度（投影仪原生像素）', state.settings.blendWidthPx, 0, 420, 2, '{v} px', (v) =>
      ctx.update((s) => { s.settings.blendWidthPx = v; })
    ),
    CheckRow('显示覆盖视锥', state.settings.showCoverage, (v) => {
      ctx.update((s) => { s.settings.showCoverage = v; }, { silent: true });
      drawAll();
    }),
    CheckRow('显示像素密度热力', state.settings.showDensityHeatmap, (v) => {
      ctx.update((s) => { s.settings.showDensityHeatmap = v; }, { silent: true });
      drawAll();
    }),
    h('p.help', {}, '重叠区使用互补 smoothstep 权重并按权重归一化，避免两台设备叠加出白带。'),
    h('div.button-row', {}, [Badge(`${state.projectors.length} 台设备`, 'info'), Badge('深度图 1536²', 'muted')])
  ]), h('button.btn.btn-primary', { onclick: addProjector }, '＋ 添加设备'));

  root.appendChild(h('div.page projector-page', {}, [
    summaryHost,
    h('div.projector-layout', {}, [
      h('div.canvas-stack', {}, [
        Card('板面覆盖范围与像素密度', topCanvas),
        Card('吊装高度 / 俯角侧视图（可拖拽）', sideCanvas)
      ]),
      h('div.right-stack', {}, [blendCard, h('div.cards-scroll', {}, cardsHost)])
    ])
  ]));

  renderCards();
  updateSummary();
  requestAnimationFrame(drawAll);
  const ro = new ResizeObserver(drawAll);
  ro.observe(topCanvas);
  ro.observe(sideCanvas);
  return { destroy: () => ro.disconnect() };
}
