import type { AppContext, PageHandle } from '../ui/context';
import { h, toast, downloadText } from '../ui/dom';
import { Badge, Card, Stat } from '../ui/components';
import { csvTemplate, importWiresFromCsv, wiresToCsv } from '../lib/wireTable';
import { ensureAutoRoutes, recalculateStacks } from '../lib/routing';
import { cavityWorld } from '../lib/fixtures';

export function renderWiresPage(root: HTMLElement, ctx: AppContext): PageHandle {
  const state = ctx.state;
  let query = '';
  let selectedId = ctx.params.wireId ?? state.wires[0]?.id ?? null;
  const fileInput = h<HTMLInputElement>('input', {
    type: 'file',
    accept: '.csv,text/csv',
    style: 'display:none',
    onchange: async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const result = importWiresFromCsv(state, text);
        ctx.update(() => undefined);
        toast(`已导入并自动布线 ${result.count} 根导线`, 'success', 3600);
        if (result?.warnings.length) toast(result.warnings.slice(0, 3).join('；'), 'info', 4200);
        selectedId = state.wires[0]?.id ?? null;
        renderTable();
        renderDetail();
      } catch (e) {
        console.error(e);
        toast(`导线表导入失败：${(e as Error).message}`, 'error', 4200);
      } finally {
        fileInput.value = '';
      }
    }
  });

  const search = h<HTMLInputElement>('input.input-search', {
    placeholder: '搜索线号 / 回路 / 接插件 / 颜色…',
    oninput: () => {
      query = search.value.trim().toLowerCase();
      renderTable();
    }
  });

  const tableHost = h('div.table-scroll');
  function filteredWires() {
    if (!query) return state.wires;
    return state.wires.filter((w) => {
      const ff = state.fixtures.find((f) => f.id === w.from.fixtureId);
      const tf = state.fixtures.find((f) => f.id === w.to.fixtureId);
      return [w.lineNo, w.circuit, w.colorName, w.crossSection, ff?.code, tf?.code, w.from.cavityId, w.to.cavityId]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  function endpointLabel(fixtureId: string, cavityId: string): string {
    const f = state.fixtures.find((x) => x.id === fixtureId);
    if (!f) return '?';
    return `${f.code}/${cavityId}`;
  }

  function renderTable(): void {
    const rows = filteredWires();
    tableHost.replaceChildren(
      h('table.data-table.wire-table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', {}, '步序'),
          h('th', {}, '线号'),
          h('th', {}, '截面'),
          h('th', {}, '颜色'),
          h('th', {}, '起点'),
          h('th', {}, '终点'),
          h('th.num', {}, '长度'),
          h('th', {}, '路径')
        ])),
        h('tbody', {}, rows.map((w) => h('tr', {
          class: w.id === selectedId ? 'selected' : '',
          onclick: () => { selectedId = w.id; renderTable(); renderDetail(); }
        }, [
          h('td.mono', {}, String(w.sequence).padStart(3, '0')),
          h('td', {}, [h('strong', {}, w.lineNo), h('div.sub', {}, w.circuit)]),
          h('td.num', {}, `${w.crossSection} mm²`),
          h('td', {}, [h('span.color-chip', { style: `background:${w.color}` }), w.colorName]),
          h('td.mono', {}, endpointLabel(w.from.fixtureId, w.from.cavityId)),
          h('td.mono', {}, endpointLabel(w.to.fixtureId, w.to.cavityId)),
          h('td.num', {}, `${(w.lengthMm / 1000).toFixed(2)} m`),
          h('td', {}, Badge(`${w.fixturePath.length} 个叉点`, w.fixturePath.length ? 'good' : 'bad'))
        ])))
      ])
    );
    const count = tableHost.querySelector('.table-count');
    if (count) count.textContent = `${rows.length} / ${state.wires.length}`;
  }

  const detailHost = h('div.detail-host');
  function renderDetail(): void {
    const w = state.wires.find((x) => x.id === selectedId);
    detailHost.replaceChildren();
    if (!w) {
      detailHost.appendChild(h('div.empty-hint', {}, '选择一根导线查看孔位与路径。'));
      return;
    }
    const ff = state.fixtures.find((f) => f.id === w.from.fixtureId);
    const tf = state.fixtures.find((f) => f.id === w.to.fixtureId);
    const pFrom = ff ? cavityWorld(ff, w.from.cavityId) : null;
    const pTo = tf ? cavityWorld(tf, w.to.cavityId) : null;
    const ties = state.tiePoints.filter((t) => w.fixturePath.some(() => t.kind === 'tie')).slice(0, 6);
    detailHost.append(
      h('div.wire-detail-head', {}, [
        h('span.color-chip.large', { style: `background:${w.color}` }),
        h('div', {}, [h('h3', {}, w.lineNo), h('p', {}, `${w.colorName} · ${w.crossSection} mm² · ${w.circuit}`)])
      ]),
      h('dl.kv', {}, [
        kv('起点孔位', endpointLabel(w.from.fixtureId, w.from.cavityId)),
        kv('终点孔位', endpointLabel(w.to.fixtureId, w.to.cavityId)),
        kv('路径长度', `${(w.lengthMm / 1000).toFixed(2)} m`),
        kv('经过叉/托', `${w.fixturePath.length} 个`),
        kv('三维路径点', `${w.route.length} 个（含堆高）`),
        pFrom ? kv('起点坐标', `(${pFrom.x.toFixed(1)}, ${pFrom.y.toFixed(1)}, z${pFrom.z.toFixed(1)})`) : null,
        pTo ? kv('终点坐标', `(${pTo.x.toFixed(1)}, ${pTo.y.toFixed(1)}, z${pTo.z.toFixed(1)})`) : null
      ]),
      h('div', {}, [
        h('h4', {}, '沿叉路径顺序'),
        h('div.path-chips', {}, [
          Badge(w.from.cavityId, 'info'),
          ...w.fixturePath.map((id) => {
            const f = state.fixtures.find((x) => x.id === id);
            return Badge(f?.code ?? id, 'muted');
          }),
          Badge(w.to.cavityId, 'good')
        ])
      ]),
      h('div', {}, [
        h('h4', {}, '分支 / 捆扎标记'),
        state.tiePoints.length
          ? h('div.path-chips', {}, [
            Badge(`全局分支点 ${state.tiePoints.filter((t) => t.kind === 'branch').length}`, 'info'),
            Badge(`捆扎点 ${state.tiePoints.filter((t) => t.kind === 'tie').length}`, 'warn'),
            ...ties.map((t) => Badge(`${t.kind === 'tie' ? '扎' : '分'} ${t.wireCount}根`, t.kind === 'tie' ? 'warn' : 'info'))
          ])
          : h('p.help', {}, '暂无共享段捆扎点。')
      ]),
      h('div.button-row', {}, [
        h('button.btn.btn-primary', { onclick: () => ctx.go('guide', { wireId: w.id }) }, '去编排这一步'),
        h('button.btn', {
          onclick: () => {
            navigator.clipboard?.writeText(`${w.lineNo},${w.from.cavityId},${w.to.cavityId}`).catch(() => toast('剪贴板不可用', 'error'));
            toast('线号与孔位已复制', 'success');
          }
        }, '复制孔位')
      ])
    );
  }

  function kv(k: string, v: string): HTMLElement {
    return h('div.kv-row', {}, [h('dt', {}, k), h('dd.mono', {}, v)]);
  }

  const stats = h('div.stat-grid', {}, [
    Stat('导线总数', String(state.wires.length), 'info'),
    Stat('总长度', `${(state.wires.reduce((s, w) => s + w.lengthMm, 0) / 1000).toFixed(1)} m`, 'good'),
    Stat('分支点', String(state.tiePoints.filter((t) => t.kind === 'branch').length), 'info'),
    Stat('捆扎点', String(state.tiePoints.filter((t) => t.kind === 'tie').length), 'warn')
  ]);

  const toolbar = h('div.toolbar-wrap', {}, [
    search,
    h('span.table-count header-meta', {}, `${state.wires.length} / ${state.wires.length}`),
    h('div.spacer'),
    h('button.btn', { onclick: () => downloadText('wire-table-template.csv', csvTemplate(), 'text/csv;charset=utf-8') }, '下载 CSV 模板'),
    h('button.btn', { onclick: () => fileInput.click() }, '导入导线表 CSV'),
    h('button.btn.btn-primary', {
      onclick: () => {
        ensureAutoRoutes(state);
        recalculateStacks(state);
        ctx.update(() => undefined);
        renderTable();
        renderDetail();
        toast('已按叉子网络重新生成全部路径和堆高', 'success');
      }
    }, '重新沿叉布线'),
    h('button.btn', { onclick: () => downloadText('wire-table.csv', '﻿' + wiresToCsv(state), 'text/csv;charset=utf-8') }, '导出 CSV'),
    fileInput
  ]);

  root.appendChild(h('div.page wires-page', {}, [
    stats,
    h('div.wire-layout', {}, [
      Card('导线表（线号 / 截面 / 颜色 / 两端孔位）', h('div', {}, [toolbar, tableHost]), null, 'table-card'),
      Card('导线与路径详情', detailHost, null, 'detail-card')
    ])
  ]));

  renderTable();
  renderDetail();
  return {};
}
