import './styles.css';
import type { PageKey } from './ui/context';
import type { ProjectState } from './types';
import { createSeedProject } from './lib/seed';
import { loadProject, saveProject, storageInfo } from './lib/db';
import { recalculateStacks } from './lib/routing';
import { h, toast } from './ui/dom';
import { renderBoardPage } from './pages/boardPage';
import { renderWiresPage } from './pages/wiresPage';
import { renderProjectorsPage } from './pages/projectorsPage';
import { renderGuidePage } from './pages/guidePage';
import { renderPreviewPage } from './pages/previewPage';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = '<div class="app-loading"><div class="loader"></div><p>正在打开 IndexedDB 项目并生成 200 根仪表板线束…</p></div>';

let state: ProjectState;
let fromDb = true;
try {
  const loaded = await loadProject();
  if (loaded && loaded.board && loaded.wires?.length) {
    state = loaded;
    const seedSettings = createSeedProject().settings;
    state.settings = { ...seedSettings, ...(state.settings ?? {}) };
    if (!state.tiePoints?.length) recalculateStacks(state);
  } else {
    fromDb = false;
    state = createSeedProject();
    await saveProject(state);
  }
} catch (err) {
  console.error('IndexedDB 不可用，改用内存示例：', err);
  fromDb = false;
  state = createSeedProject();
}

const navItems: Array<{ key: PageKey; label: string; icon: string; desc: string }> = [
  { key: 'board', label: '工装板', icon: '▦', desc: '实际尺寸 / DXF / 拖拽工装' },
  { key: 'wires', label: '导线表', icon: '⌁', desc: '200 根导线 / 孔位 / 自动路径' },
  { key: 'projectors', label: '投影仪布置', icon: '◳', desc: '设备卡 / 覆盖 / PPI / 融合' },
  { key: 'guide', label: '指引编排', icon: '➤', desc: '步骤 / 切换 / 可见率 / 精度' },
  { key: 'preview', label: '工位预览', icon: '👁', desc: '人眼视角 / 顶灯 / 手臂遮挡' }
];

let currentPage: PageKey = 'board';
let params: Record<string, string> = {};
let pageHandle: { destroy?: () => void } | null = null;
let saveTimer: number | null = null;
let saveState: 'saved' | 'saving' | 'error' = 'saved';

function scheduleSave(): void {
  saveState = 'saving';
  updateSaveBadge();
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      state.updatedAt = Date.now();
      await saveProject(state);
      saveState = 'saved';
    } catch (e) {
      console.error(e);
      saveState = 'error';
    }
    updateSaveBadge();
  }, 450);
}

async function saveNow(): Promise<void> {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  state.updatedAt = Date.now();
  try {
    await saveProject(state);
    saveState = 'saved';
  } catch {
    saveState = 'error';
  }
  updateSaveBadge();
}

function updateSaveBadge(): void {
  const el = document.querySelector('#save-badge');
  if (!el) return;
  el.className = `save-badge save-${saveState}`;
  el.textContent = saveState === 'saving' ? '● 保存中…' : saveState === 'saved' ? `✓ IndexedDB 已保存 · ${storageInfo().name}` : '! IndexedDB 写入失败（仅内存）';
}

const ctx = {
  get state() {
    return state;
  },
  get params() {
    return params;
  },
  update(mutator: (draft: ProjectState) => void, options?: { reroute?: boolean; silent?: boolean }) {
    mutator(state);
    if (options?.reroute) recalculateStacks(state);
    scheduleSave();
  },
  saveNow,
  resetDemo() {
    if (!window.confirm('恢复内置 200 根导线示例将覆盖当前 IndexedDB 项目，确定继续？')) return;
    state = createSeedProject();
    void saveNow().then(() => {
      params = {};
      navigate('board');
      toast('已恢复三台投影仪的标准示例方案', 'success');
    });
  },
  go(page: PageKey, nextParams: Record<string, string> = {}) {
    params = nextParams;
    navigate(page);
  }
};

function navigate(page: PageKey): void {
  currentPage = page;
  pageHandle?.destroy?.();
  pageHandle = null;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.page === page));
  const content = document.querySelector<HTMLElement>('#page-content')!;
  content.replaceChildren();
  try {
    if (page === 'board') pageHandle = renderBoardPage(content, ctx);
    else if (page === 'wires') pageHandle = renderWiresPage(content, ctx);
    else if (page === 'projectors') pageHandle = renderProjectorsPage(content, ctx);
    else if (page === 'guide') pageHandle = renderGuidePage(content, ctx);
    else pageHandle = renderPreviewPage(content, ctx);
  } catch (e) {
    console.error(e);
    content.appendChild(h('div.page-error card', {}, [
      h('h2', {}, '页面渲染异常'),
      h('pre', {}, (e as Error).stack ?? (e as Error).message),
      h('button.btn.btn-primary', { onclick: () => location.reload() }, '重新加载')
    ]));
  }
}

function renderShell(): void {
  app.replaceChildren(
    h('div.app-shell', {}, [
      h('aside.sidebar', {}, [
        h('div.brand', {}, [
          h('div.brand-mark', {}, '投'),
          h('div', {}, [h('strong', {}, '线束投影工艺台'), h('span', {}, 'Projection Guide Studio')])
        ]),
        h('nav.nav-list', {}, navItems.map((item) =>
          h('button.nav-item', {
            dataset: { page: item.key },
            onclick: () => { params = {}; navigate(item.key); }
          }, [h('span.nav-icon', {}, item.icon), h('span', {}, [h('strong', {}, item.label), h('em', {}, item.desc)])])
        )),
        h('div.sidebar-foot', {}, [
          h('div.mini-card', {}, [h('strong', {}, '精度红线'), h('span', {}, '任意孔位框 ≤ 3 mm'), h('p', {}, '矩阵反投影 + 像素量化 + 深度面落点 + 标定残差')]),
          h('div.mini-card', {}, [h('strong', {}, '本地数据'), h('span', {}, fromDb ? 'IndexedDB 已连接' : '新建设备并写入 IndexedDB'), h('p', {}, '工装板、导线表、投影仪和步骤均离线保存')])
        ])
      ]),
      h('div.main-shell', {}, [
        h('header.topbar', {}, [
          h('div.project-title', {}, [
            h('input.project-name', {
              value: state.name,
              onchange: (e: Event) => ctx.update((s) => { s.name = (e.target as HTMLInputElement).value; })
            }),
            h('span', {}, `Schema ${state.schema} · ${state.wires.length} wires · ${state.projectors.length} projectors`)
          ]),
          h('div.top-actions', {}, [
            h('span#save-badge.save-badge', {}, '✓ IndexedDB'),
            h('button.btn', { onclick: () => ctx.resetDemo() }, '恢复 200 线示例')
          ])
        ]),
        h('main#page-content.page-content', {})
      ])
    ])
  );
  updateSaveBadge();
  navigate(currentPage);
}

renderShell();
