import type { ProjectState, Wire } from '../types';
import { ensureCavities } from './fixtures';
import { ensureAutoRoutes } from './routing';

export function wiresToCsv(state: ProjectState): string {
  const header = ['线号', '回路', '截面mm2', '颜色HEX', '颜色名', '起点插件', '起点孔位', '终点插件', '终点孔位', '长度mm'];
  const rows = state.wires.map((w) => {
    const ff = state.fixtures.find((f) => f.id === w.from.fixtureId);
    const tf = state.fixtures.find((f) => f.id === w.to.fixtureId);
    return [
      w.lineNo,
      w.circuit,
      w.crossSection,
      w.color,
      w.colorName,
      ff?.code ?? '',
      w.from.cavityId,
      tf?.code ?? '',
      w.to.cavityId,
      w.lengthMm
    ];
  });
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
}

function csvEscape(value: unknown): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quote = false;
      else cell += ch;
    } else if (ch === '"') quote = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const NAMED_COLORS: Record<string, string> = {
  红: '#e53935',
  红色: '#e53935',
  red: '#e53935',
  蓝: '#1e88e5',
  蓝色: '#1e88e5',
  blue: '#1e88e5',
  黄: '#fdd835',
  黄色: '#fdd835',
  yellow: '#fdd835',
  绿: '#43a047',
  绿色: '#43a047',
  green: '#43a047',
  白: '#f5f5f5',
  白色: '#f5f5f5',
  white: '#f5f5f5',
  黑: '#15171c',
  黑色: '#15171c',
  black: '#15171c',
  橙: '#fb8c00',
  orange: '#fb8c00',
  紫: '#8e24aa',
  purple: '#8e24aa',
  棕: '#6d4c41',
  brown: '#6d4c41',
  灰: '#90a4ae',
  gray: '#90a4ae',
  grey: '#90a4ae',
  粉: '#ec407a',
  pink: '#ec407a'
};

function findCavityId(fixture: ProjectState['fixtures'][number], raw: string): string {
  ensureCavities(fixture);
  const q = raw.trim();
  if (!q) return fixture.cavities?.[0]?.id ?? 'C01';
  const direct = fixture.cavities?.find((c) => c.id.toLowerCase() === q.toLowerCase() || c.label === q);
  if (direct) return direct.id;
  const digits = Number.parseInt(q.replace(/\D/g, ''), 10);
  if (Number.isFinite(digits) && fixture.cavities?.[digits - 1]) return fixture.cavities[digits - 1].id;
  return fixture.cavities?.[0]?.id ?? 'C01';
}

export function importWiresFromCsv(state: ProjectState, text: string): { count: number; warnings: string[] } {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('CSV 没有数据行');
  const header = table[0].map((h) => h.trim());
  const idx = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iLine = idx('线号', 'line');
  const iCircuit = idx('回路', 'circuit');
  const iSection = idx('截面', 'section');
  const iColor = idx('颜色HEX', '颜色', 'color');
  const iColorName = idx('颜色名');
  const iFromF = idx('起点插件', '起点接插件', 'from');
  const iFromC = idx('起点孔', 'from cavity');
  const iToF = idx('终点插件', '终点接插件', 'to');
  const iToC = idx('终点孔', 'to cavity');

  const warnings: string[] = [];
  const wires: Wire[] = [];
  table.slice(1).forEach((row, n) => {
    const get = (i: number) => (i >= 0 ? row[i]?.trim() ?? '' : '');
    const fromCode = get(iFromF);
    const toCode = get(iToF);
    const fromF = state.fixtures.find((f) => f.code === fromCode || f.name === fromCode || f.id === fromCode);
    const toF = state.fixtures.find((f) => f.code === toCode || f.name === toCode || f.id === toCode);
    if (!fromF || !toF) {
      warnings.push(`第 ${n + 2} 行找不到接插件 ${fromCode}→${toCode}，已跳过`);
      return;
    }
    const colorRaw = get(iColor);
    const color = colorRaw.startsWith('#') ? colorRaw : NAMED_COLORS[colorRaw.toLowerCase()] ?? NAMED_COLORS[colorRaw] ?? '#60a5fa';
    wires.push({
      id: `imported-wire-${Date.now().toString(36)}-${n}`,
      lineNo: get(iLine) || `IMP-${String(n + 1).padStart(4, '0')}`,
      circuit: get(iCircuit) || 'IMPORT',
      crossSection: Number.parseFloat(get(iSection)) || 0.75,
      color,
      colorName: get(iColorName) || colorRaw || '自定义',
      from: { fixtureId: fromF.id, cavityId: findCavityId(fromF, get(iFromC)) },
      to: { fixtureId: toF.id, cavityId: findCavityId(toF, get(iToC)) },
      fixturePath: [],
      route: [],
      lengthMm: 0,
      sequence: n + 1,
      branchPointIds: [],
      tiePointIds: []
    });
  });

  if (!wires.length) throw new Error(warnings[0] ?? '未解析到有效导线');
  state.wires = wires;
  state.steps = wires.map((w, i) => ({
    id: `step-import-${i + 1}`,
    order: i + 1,
    wireId: w.id,
    title: `第 ${i + 1} 步：${w.lineNo} ${w.colorName} ${w.crossSection}mm²`,
    workSeconds: 70
  }));
  ensureAutoRoutes(state);
  return { count: wires.length, warnings };
}

export function csvTemplate(): string {
  return '线号,回路,截面mm2,颜色HEX,颜色名,起点插件,起点孔位,终点插件,终点孔位\nWL-2401,SIG-101,0.5,#e53935,红色,C01,C01,C02,C01\n';
}
