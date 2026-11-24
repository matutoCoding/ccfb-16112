import type { AppContext, PageHandle } from '../ui/context';
import { h, toast } from '../ui/dom';
import { Card, NumberRow } from '../ui/components';
import { readDxfFile } from '../lib/dxf';
import { defaultFixture, FIXTURE_LABEL, ensureCavities } from '../lib/fixtures';
import { recalculateStacks } from '../lib/routing';
import type { Fixture, FixtureKind } from '../types';

function fitDxfToBoard(dxf: NonNullable<AppContext['state']['board']['dxf']>, width: number, height: number): void {
  const b = dxf.bounds;
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const scale = Math.min((width - 100) / bw, (height - 100) / bh);
  const ox = (width - bw * scale) / 2 - b.minX * scale;
  const oy = (height - bh * scale) / 2 - b.minY * scale;
  const tx = (x: number) => x * scale + ox;
  const ty = (y: number) => y * scale + oy;
  for (const e of dxf.entities) {
    if (e.points) e.points = e.points.map((p) => ({ x: tx(p.x), y: ty(p.y) }));
    if (e.center) e.center = { x: tx(e.center.x), y: ty(e.center.y) };
    if (e.radius) e.radius *= scale;
  }
  dxf.bounds = {
    minX: tx(b.minX),
    minY: ty(b.minY),
    maxX: tx(b.maxX),
    maxY: ty(b.maxY)
  };
}

export function renderBoardPage(root: HTMLElement, ctx: AppContext): PageHandle {
  const state = ctx.state;
  let selectedId: string | null = ctx.params.fixtureId ?? state.fixtures[0]?.id ?? null;
  let pendingKind: FixtureKind | null = null;
  let showWires = true;
  let drag: { id: string; dx: number; dy: number } | null = null;

  const canvas = h<HTMLCanvasElement>('canvas.board-canvas', { tabindex: '0' });
  const fileInput = h<HTMLInputElement>('input', {
    type: 'file',
    accept: '.dxf',
    style: 'display:none',
    onchange: async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const dxf = await readDxfFile(file);
        fitDxfToBoard(dxf, state.board.width, state.board.height);
        ctx.update((s) => {
          s.board.dxf = dxf;
        });
        toast(`DXF 已导入并按板面适配：${dxf.entities.length} 个图元`, 'success');
        draw();
      } catch (err) {
        console.error(err);
        toast('DXF 解析失败，请确认文件为 ASCII DXF', 'error', 4200);
      } finally {
        fileInput.value = '';
      }
    }
  });

  const palette: FixtureKind[] = ['fork', 'bracket', 'cradle', 'tape', 'connector'];
  const paletteBar = h('div.palette-bar', {}, palette.map((kind) =>
    h('button.btn.btn-mini', {
      type: 'button',
      onclick: (ev: MouseEvent) => {
        pendingKind = pendingKind === kind ? null : kind;
        canvas.style.cursor = pendingKind ? 'crosshair' : 'default';
        [...paletteBar.children].forEach((b) => b.classList.remove('active'));
        if (pendingKind) (ev.currentTarget as HTMLElement)?.classList.add('active');
        hint.textContent = pendingKind ? `在板面上点击放置${FIXTURE_LABEL[kind]}，再次点击按钮取消` : '拖动已有叉子/座体调整位置';
      }
    }, `＋ ${FIXTURE_LABEL[kind]}`)
  ));
  const hint = h('div.canvas-hint', {}, '拖动已有叉子/座体调整位置；也可先选左侧工装再点击板面放置。');

  const propsHost = h('div.props-host');
  function renderProps(): void {
    const f = state.fixtures.find((x) => x.id === selectedId) ?? null;
    propsHost.replaceChildren();
    if (!f) {
      propsHost.appendChild(h('div.empty-hint', {}, '未选择工装。点击板面上的叉子、胶带点或接插件座。'));
      return;
    }
    const codeInput = h<HTMLInputElement>('input', {
      value: f.code,
      onchange: () => ctx.update((s) => {
        const sf = s.fixtures.find((x) => x.id === f.id);
        if (sf) sf.code = codeInput.value;
      })
    });
    const nameInput = h<HTMLInputElement>('input', {
      value: f.name,
      onchange: () => ctx.update((s) => {
        const sf = s.fixtures.find((x) => x.id === f.id);
        if (sf) sf.name = nameInput.value;
      })
    });
    const wrap = h('div.props-form', {}, [
      h('div.props-title', {}, [h('strong', {}, `${FIXTURE_LABEL[f.kind]} · ${f.id}`)]),
      h('label.field-text', {}, [h('span', {}, '设备编号'), codeInput]),
      h('label.field-text', {}, [h('span', {}, '名称'), nameInput]),
      NumberRow('X 坐标', f.x, -200, state.board.width + 200, 1, 'mm', (v) => mutateFixture(f.id, (q) => { q.x = v; })),
      NumberRow('Y 坐标', f.y, -200, state.board.height + 200, 1, 'mm', (v) => mutateFixture(f.id, (q) => { q.y = v; })),
      NumberRow('旋转角', f.rotation, -180, 180, 1, '°', (v) => mutateFixture(f.id, (q) => { q.rotation = v; })),
      NumberRow('高度', f.height, 1, 160, 1, 'mm', (v) => mutateFixture(f.id, (q) => { q.height = v; if (q.kind === 'connector') q.cavities = ensureCavities(q); })),
      f.kind === 'connector'
        ? NumberRow('孔位数', f.cavityCount ?? 24, 2, 96, 2, '孔', (v) => mutateFixture(f.id, (q) => { q.cavityCount = Math.round(v); q.cavities = []; ensureCavities(q); }))
        : null,
      f.kind === 'connector'
        ? NumberRow('孔间距', f.pitch ?? 8, 4, 16, 0.5, 'mm', (v) => mutateFixture(f.id, (q) => { q.pitch = v; q.cavities = []; ensureCavities(q); }))
        : null,
      h('div.props-actions', {}, [
        h('button.btn', {
          onclick: () => {
            const copy = structuredClone(f);
            copy.id = `${f.kind}-${Math.random().toString(36).slice(2, 8)}`;
            copy.x += 40;
            copy.y += 40;
            ctx.update((s) => s.fixtures.push(copy), { reroute: true });
            selectedId = copy.id;
            renderProps();
            draw();
            toast('已复制工装', 'success');
          }
        }, '复制'),
        h('button.btn.btn-danger', {
          onclick: () => {
            ctx.update((s) => {
              s.fixtures = s.fixtures.filter((x) => x.id !== f.id);
              for (const w of s.wires) w.fixturePath = w.fixturePath.filter((id) => id !== f.id);
            }, { reroute: true });
            selectedId = null;
            renderProps();
            draw();
          }
        }, '删除')
      ])
    ]);
    propsHost.appendChild(wrap);
  }

  function mutateFixture(id: string, fn: (f: Fixture) => void): void {
    ctx.update((s) => {
      const f = s.fixtures.find((x) => x.id === id);
      if (f) fn(f);
    }, { reroute: true });
    renderProps();
    draw();
  }

  const boardWidth = NumberRow('板宽', state.board.width, 800, 4200, 10, 'mm', (v) => {
    ctx.update((s) => { s.board.width = v; });
    draw();
  });
  const boardHeight = NumberRow('板高', state.board.height, 600, 2400, 10, 'mm', (v) => {
    ctx.update((s) => { s.board.height = v; });
    draw();
  });

  const side = h('div.side-stack', {}, [
    Card('板面尺寸 / DXF', h('div.form-grid', {}, [
      boardWidth,
      boardHeight,
      h('label.field-text', {}, [
        h('span', {}, '板面材料'),
        h<HTMLInputElement>('input', { value: state.board.material, onchange: (e: Event) => ctx.update((s) => { s.board.material = (e.target as HTMLInputElement).value; }) })
      ]),
      h('div.button-row', {}, [
        h('button.btn.btn-primary', { type: 'button', onclick: () => fileInput.click() }, '导入工装板 DXF'),
        state.board.dxf ? h('button.btn', {
          onclick: () => {
            ctx.update((s) => { s.board.dxf = null; });
            draw();
            toast('已移除 DXF 参考图');
          }
        }, '移除 DXF') : null
      ]),
      state.board.dxf ? h('div.dxf-meta', {}, [
        h('strong', {}, state.board.dxf.fileName),
        h('span', {}, `${state.board.dxf.entities.length} 图元 · ${state.board.dxf.units}`)
      ]) : h('p.help', {}, '支持 LINE / LWPOLYLINE / CIRCLE / ARC；导入时自动居中适配到当前板面。')
    ]), fileInput),
    Card('放置工装', h('div', {}, [paletteBar, hint])),
    Card('属性', propsHost, null, 'props-card')
  ]);

  const canvasCard = Card('工装板 1:1 坐标布局（单位 mm）', h('div.canvas-wrap', {}, [canvas]), h('div.card-actions', {}, [
    h('label.inline-check', {}, [
      h<HTMLInputElement>('input', { type: 'checkbox', checked: showWires, onchange: (e: Event) => { showWires = (e.target as HTMLInputElement).checked; draw(); } }),
      '显示走线路径'
    ]),
    h('span.header-meta', {}, `${state.fixtures.length} 个工装 · ${state.board.width}×${state.board.height}`)
  ]), 'canvas-card');

  root.appendChild(h('div.page-grid board-page', {}, [h('div.canvas-column', {}, canvasCard), side]));

  const ro = new ResizeObserver(draw);
  ro.observe(canvas);

  function transform(): { scale: number; ox: number; oy: number; cw: number; ch: number } {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
      canvas.width = Math.floor(Math.max(1, rect.width) * dpr);
      canvas.height = Math.floor(Math.max(1, rect.height) * dpr);
    }
    const cw = canvas.width;
    const ch = canvas.height;
    const margin = 56 * dpr;
    const scale = Math.min((cw - margin * 2) / state.board.width, (ch - margin * 2) / state.board.height);
    const ox = (cw - state.board.width * scale) / 2;
    const oy = (ch - state.board.height * scale) / 2;
    return { scale, ox, oy, cw, ch };
  }

  function toScreen(x: number, y: number, t = transform()): { x: number; y: number } {
    return { x: t.ox + x * t.scale, y: t.oy + (state.board.height - y) * t.scale };
  }
  function toBoard(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / Math.max(1, rect.width);
    const sx = (clientX - rect.left) * dpr;
    const sy = (clientY - rect.top) * dpr;
    const t = transform();
    return { x: (sx - t.ox) / t.scale, y: state.board.height - (sy - t.oy) / t.scale };
  }

  function draw(): void {
    if (!canvas.isConnected) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const t = transform();
    ctx2d.clearRect(0, 0, t.cw, t.ch);
    ctx2d.fillStyle = '#0b1220';
    ctx2d.fillRect(0, 0, t.cw, t.ch);
    const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    ctx2d.font = `${12 * dpr}px Segoe UI, Microsoft YaHei`;

    // 网格
    ctx2d.strokeStyle = 'rgba(148,163,184,0.16)';
    ctx2d.lineWidth = 1 * dpr;
    for (let x = 0; x <= state.board.width; x += 100) {
      const a = toScreen(x, 0, t);
      const b = toScreen(x, state.board.height, t);
      ctx2d.beginPath(); ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y); ctx2d.stroke();
    }
    for (let y = 0; y <= state.board.height; y += 100) {
      const a = toScreen(0, y, t);
      const b = toScreen(state.board.width, y, t);
      ctx2d.beginPath(); ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y); ctx2d.stroke();
    }

    // 板面
    const p0 = toScreen(0, 0, t);
    const p1 = toScreen(state.board.width, state.board.height, t);
    ctx2d.fillStyle = state.board.color;
    ctx2d.fillRect(p0.x, p1.y, p1.x - p0.x, p0.y - p1.y);
    ctx2d.strokeStyle = '#64748b';
    ctx2d.lineWidth = 3 * dpr;
    ctx2d.strokeRect(p0.x, p1.y, p1.x - p0.x, p0.y - p1.y);

    // DXF
    const dxf = state.board.dxf;
    if (dxf) {
      ctx2d.strokeStyle = 'rgba(34,211,238,0.72)';
      ctx2d.lineWidth = 1.4 * dpr;
      for (const e of dxf.entities) {
        if (e.points && (e.type === 'line' || e.type === 'polyline') && e.points.length > 1) {
          ctx2d.beginPath();
          e.points.forEach((p, i) => {
            const s = toScreen(p.x, p.y, t);
            if (i === 0) ctx2d.moveTo(s.x, s.y); else ctx2d.lineTo(s.x, s.y);
          });
          ctx2d.stroke();
        } else if (e.center && e.radius) {
          const c = toScreen(e.center.x, e.center.y, t);
          ctx2d.beginPath();
          const ry = e.radius * t.scale;
          if (e.type === 'arc') ctx2d.arc(c.x, c.y, e.radius * t.scale, -(e.endAngle ?? 0) * Math.PI / 180, -(e.startAngle ?? 0) * Math.PI / 180, true);
          else ctx2d.arc(c.x, c.y, ry, 0, Math.PI * 2);
          ctx2d.stroke();
        }
      }
    }

    // 导线
    if (showWires) {
      ctx2d.lineWidth = 1.5 * dpr;
      for (const w of state.wires) {
        ctx2d.strokeStyle = `${w.color}55`;
        ctx2d.beginPath();
        w.route.forEach((p, i) => {
          const s = toScreen(p.x, p.y, t);
          if (i === 0) ctx2d.moveTo(s.x, s.y); else ctx2d.lineTo(s.x, s.y);
        });
        ctx2d.stroke();
      }
    }

    // 捆扎/分支点
    for (const tp of state.tiePoints) {
      const s = toScreen(tp.x, tp.y, t);
      ctx2d.fillStyle = tp.kind === 'branch' ? '#22d3ee' : '#facc15';
      ctx2d.beginPath();
      ctx2d.arc(s.x, s.y, (tp.kind === 'branch' ? 5 : 3.5) * dpr, 0, Math.PI * 2);
      ctx2d.fill();
    }

    // 工装
    for (const f of state.fixtures) {
      const s = toScreen(f.x, f.y, t);
      const selected = f.id === selectedId;
      ctx2d.save();
      ctx2d.translate(s.x, s.y);
      ctx2d.rotate(-((f.rotation || 0) * Math.PI) / 180);
      const mm = t.scale;
      if (f.kind === 'fork') {
        ctx2d.fillStyle = selected ? '#fde047' : '#cbd5e1';
        ctx2d.strokeStyle = '#0f172a';
        ctx2d.lineWidth = 1.5 * dpr;
        ctx2d.beginPath(); ctx2d.arc(0, 0, 7 * dpr, 0, Math.PI * 2); ctx2d.fill(); ctx2d.stroke();
        ctx2d.strokeStyle = selected ? '#fde047' : '#e2e8f0';
        ctx2d.lineWidth = 3 * dpr;
        ctx2d.beginPath(); ctx2d.moveTo(-6 * mm, -5 * mm); ctx2d.lineTo(-6 * mm, 7 * mm); ctx2d.moveTo(6 * mm, -5 * mm); ctx2d.lineTo(6 * mm, 7 * mm); ctx2d.stroke();
      } else if (f.kind === 'tape') {
        ctx2d.fillStyle = 'rgba(245,158,11,0.72)';
        ctx2d.strokeStyle = '#fbbf24';
        ctx2d.lineWidth = 2 * dpr;
        ctx2d.beginPath(); ctx2d.arc(0, 0, (f.radius ?? 17) * mm, 0, Math.PI * 2); ctx2d.fill(); ctx2d.stroke();
      } else {
        const w = (f.width ?? 80) * mm;
        const h = (f.depth ?? 36) * mm;
        ctx2d.fillStyle = f.kind === 'connector' ? '#334155' : f.kind === 'cradle' ? '#0f766e' : '#64748b';
        ctx2d.strokeStyle = selected ? '#fde047' : '#cbd5e1';
        ctx2d.lineWidth = selected ? 3 * dpr : 1.5 * dpr;
        ctx2d.fillRect(-w / 2, -h / 2, w, h);
        ctx2d.strokeRect(-w / 2, -h / 2, w, h);
        if (f.kind === 'connector') {
          ctx2d.fillStyle = '#020617';
          for (const c of f.cavities ?? []) {
            ctx2d.fillRect(c.dx * mm - 1.6 * dpr, -c.dy * mm - 1.2 * dpr, 3.2 * dpr, 2.4 * dpr);
          }
        }
      }
      ctx2d.restore();
      if (selected || t.scale > 0.16) {
        ctx2d.fillStyle = selected ? '#fde047' : '#e2e8f0';
        ctx2d.font = `${11 * dpr}px Segoe UI, Microsoft YaHei`;
        ctx2d.fillText(f.code, s.x + 9 * dpr, s.y - 9 * dpr);
      }
      if (selected) {
        ctx2d.strokeStyle = '#fde047';
        ctx2d.setLineDash([6 * dpr, 4 * dpr]);
        ctx2d.lineWidth = 1.5 * dpr;
        ctx2d.beginPath(); ctx2d.arc(s.x, s.y, 20 * dpr, 0, Math.PI * 2); ctx2d.stroke();
        ctx2d.setLineDash([]);
      }
    }
  }

  function hit(p: { x: number; y: number }): Fixture | null {
    let best: Fixture | null = null;
    let bestD = 26;
    for (const f of state.fixtures) {
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      const threshold = f.kind === 'connector' ? Math.max((f.width ?? 100) / 2, (f.depth ?? 40) / 2, 28) : Math.max(22, f.radius ?? 0 + 12);
      if (d < threshold && d < bestD + threshold * 0.2) {
        best = f;
        bestD = d;
      }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = toBoard(e.clientX, e.clientY);
    if (pendingKind) {
      const prefix = pendingKind === 'fork' ? 'F' : pendingKind === 'connector' ? 'C' : pendingKind === 'tape' ? 'T' : 'B';
      const num = state.fixtures.filter((f) => f.code.startsWith(prefix)).length + 1;
      const f = defaultFixture(pendingKind, Math.round(p.x / 5) * 5, Math.round(p.y / 5) * 5, `${prefix}${String(num).padStart(2, '0')}`);
      ctx.update((s) => s.fixtures.push(f), { reroute: true });
      selectedId = f.id;
      pendingKind = null;
      canvas.style.cursor = 'default';
      paletteBar.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      hint.textContent = '已放置；可直接拖动调整位置。';
      renderProps();
      draw();
      ctx.saveNow();
      return;
    }
    const f = hit(p);
    selectedId = f?.id ?? null;
    if (f) {
      drag = { id: f.id, dx: p.x - f.x, dy: p.y - f.y };
      canvas.style.cursor = 'grabbing';
    }
    renderProps();
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toBoard(e.clientX, e.clientY);
    if (!drag) {
      const f = hit(p);
      canvas.style.cursor = f ? 'grab' : pendingKind ? 'crosshair' : 'default';
      return;
    }
    const f = state.fixtures.find((x) => x.id === drag!.id);
    if (!f) return;
    f.x = Math.round(Math.max(-120, Math.min(state.board.width + 120, p.x - drag.dx)));
    f.y = Math.round(Math.max(-120, Math.min(state.board.height + 120, p.y - drag.dy)));
    recalculateStacks(state);
    draw();
  });

  canvas.addEventListener('pointerup', () => {
    if (drag) {
      drag = null;
      canvas.style.cursor = 'grab';
      ctx.update(() => undefined, { silent: false });
      ctx.saveNow();
      renderProps();
    }
  });

  renderProps();
  draw();
  requestAnimationFrame(draw);
  return { destroy: () => ro.disconnect() };
}
