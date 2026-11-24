import type {
  Fixture,
  ProjectState,
  ProjectorDevice,
  Wire
} from '../types';
import { ensureCavities } from './fixtures';
import { ensureAutoRoutes } from './routing';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = [
  { hex: '#e53935', name: '红色' },
  { hex: '#1e88e5', name: '蓝色' },
  { hex: '#fdd835', name: '黄色' },
  { hex: '#43a047', name: '绿色' },
  { hex: '#f5f5f5', name: '白色' },
  { hex: '#fb8c00', name: '橙色' },
  { hex: '#8e24aa', name: '紫色' },
  { hex: '#6d4c41', name: '棕色' },
  { hex: '#00acc1', name: '青色' },
  { hex: '#ec407a', name: '粉色' },
  { hex: '#90a4ae', name: '灰色' },
  { hex: '#15171c', name: '黑色' }
];

const SECTIONS = [0.35, 0.5, 0.5, 0.75, 0.75, 1.0, 1.0, 1.5, 2.0, 2.5];

export function createSeedProject(): ProjectState {
  const rand = mulberry32(16112026);
  const fixtures: Fixture[] = [];

  // 12 × 5 叉子网，180mm 间距，形成正交布线通道
  const xs = Array.from({ length: 12 }, (_, i) => 180 + i * 180);
  const ys = [240, 420, 600, 780, 960];
  let forkNo = 1;
  ys.forEach((y, r) => {
    xs.forEach((x, c) => {
      fixtures.push({
        id: `fork-${r + 1}-${c + 1}`,
        kind: 'fork',
        code: `F${String(forkNo++).padStart(3, '0')}`,
        name: `走线叉 ${r + 1}-${c + 1}`,
        x,
        y,
        rotation: 0,
        height: 42 + ((r + c) % 3) * 3,
        radius: 6
      });
    });
  });

  // 16 个 32 孔接插件座，上下两排
  const connectorXs = Array.from({ length: 8 }, (_, i) => 210 + i * 283);
  let connNo = 1;
  for (const y of [110, 1090]) {
    for (const x of connectorXs) {
      const f: Fixture = {
        id: `conn-${String(connNo).padStart(2, '0')}`,
        kind: 'connector',
        code: `C${String(connNo).padStart(2, '0')}`,
        name: y < 600 ? '下摆仪表接插件' : '上梁仪表接插件',
        x,
        y,
        rotation: 0,
        height: 25,
        width: 146,
        depth: 44,
        cavityCount: 32,
        pitch: 8,
        rows: 2
      };
      ensureCavities(f);
      fixtures.push(f);
      connNo++;
    }
  }

  // 托架、线托和胶带点
  for (let i = 0; i < 14; i++) {
    const col = i % 7;
    const row = Math.floor(i / 7);
    fixtures.push({
      id: `bracket-${i + 1}`,
      kind: i % 3 === 0 ? 'cradle' : 'bracket',
      code: `B${String(i + 1).padStart(2, '0')}`,
      name: i % 3 === 0 ? `线托 B${i + 1}` : `托架 B${i + 1}`,
      x: 300 + col * 285,
      y: row === 0 ? 330 : 870,
      rotation: col % 2 ? 90 : 0,
      height: 26,
      width: 92,
      depth: 42,
      radius: 15
    });
  }
  for (let i = 0; i < 22; i++) {
    fixtures.push({
      id: `tape-${i + 1}`,
      kind: 'tape',
      code: `T${String(i + 1).padStart(2, '0')}`,
      name: `胶带点 T${String(i + 1).padStart(2, '0')}`,
      x: 160 + Math.floor(i / 2) * 100 + (i % 2) * 38,
      y: 520 + (i % 5) * 42,
      rotation: 0,
      height: 3,
      radius: 17
    });
  }

  // 400 个不重复孔位，配成 200 根导线
  type Endpoint = { fixtureId: string; cavityId: string };
  const endpoints: Endpoint[] = [];
  for (const f of fixtures.filter((x) => x.kind === 'connector')) {
    for (const cav of f.cavities ?? []) endpoints.push({ fixtureId: f.id, cavityId: cav.id });
  }
  // 确定性洗牌
  for (let i = endpoints.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [endpoints[i], endpoints[j]] = [endpoints[j], endpoints[i]];
  }

  const wires: Wire[] = [];
  const used = new Set<number>();
  let guard = 0;
  while (wires.length < 200 && guard++ < 20000) {
    const i = Math.floor(rand() * endpoints.length);
    let j = Math.floor(rand() * endpoints.length);
    if (i === j) continue;
    if (endpoints[i].fixtureId === endpoints[j].fixtureId) continue;
    const key = i * endpoints.length + j;
    const key2 = j * endpoints.length + i;
    if (used.has(key) || used.has(key2)) continue;
    used.add(key);
    used.add(key2);
    const color = COLORS[Math.floor(rand() * COLORS.length)];
    const cs = SECTIONS[Math.floor(rand() * SECTIONS.length)];
    const n = wires.length + 1;
    wires.push({
      id: `wire-${String(n).padStart(4, '0')}`,
      lineNo: `WL-${String(2400 + n)}`,
      circuit: `${['IP', 'ECU', 'BODY', 'PWR', 'SIG'][n % 5]}-${String(100 + (n % 80))}`,
      crossSection: cs,
      color: color.hex,
      colorName: color.name,
      from: endpoints[i],
      to: endpoints[j],
      fixturePath: [],
      route: [],
      lengthMm: 0,
      sequence: n,
      branchPointIds: [],
      tiePointIds: []
    });
  }

  const projectors: ProjectorDevice[] = [
    {
      id: 'pj-left',
      name: '左工位投影仪',
      model: 'Laser WUXGA 6500lm / 0.72',
      resolutionW: 1920,
      resolutionH: 1200,
      throwRatio: 1.04,
      lensShiftX: 0,
      lensShiftY: 0.08,
      lumens: 6500,
      nativeContrast: 5000,
      enabled: true,
      pos: { x: 430, y: -180, z: 2580 },
      target: { x: 820, y: 610, z: 0 },
      roll: 0
    },
    {
      id: 'pj-center',
      name: '中梁投影仪',
      model: '4K Laser 7000lm / 0.82',
      resolutionW: 3840,
      resolutionH: 2160,
      throwRatio: 1.28,
      lensShiftX: 0,
      lensShiftY: 0.04,
      lumens: 7000,
      nativeContrast: 6000,
      enabled: true,
      pos: { x: 1200, y: 40, z: 2720 },
      target: { x: 1200, y: 620, z: 0 },
      roll: 0
    },
    {
      id: 'pj-right',
      name: '右工位投影仪',
      model: 'Laser WUXGA 6000lm / 0.76',
      resolutionW: 1920,
      resolutionH: 1200,
      throwRatio: 1.08,
      lensShiftX: 0,
      lensShiftY: 0.08,
      lumens: 6000,
      nativeContrast: 4500,
      enabled: true,
      pos: { x: 1970, y: -180, z: 2560 },
      target: { x: 1580, y: 610, z: 0 },
      roll: 0
    }
  ];

  const state: ProjectState = {
    schema: 1,
    id: 'current',
    name: '某车型仪表板线束 · 投影布线验证',
    board: {
      id: 'board-default',
      name: '仪表板线束布线板 A0',
      material: '多层酚醛胶合板 / 黑色防火面',
      width: 2400,
      height: 1200,
      thickness: 24,
      color: '#17191d',
      dxf: null
    },
    fixtures,
    wires,
    tiePoints: [],
    projectors,
    steps: wires.map((w, i) => ({
      id: `step-${i + 1}`,
      order: i + 1,
      wireId: w.id,
      title: `第 ${i + 1} 步：${w.lineNo} ${w.colorName} ${w.crossSection}mm²`,
      workSeconds: 55 + ((i * 37) % 110)
    })),
    settings: {
      visibilityThreshold: 0.9,
      accuracyToleranceMm: 3,
      calibrationResidualMm: 0.22,
      blendWidthPx: 170,
      ceilingLightsOn: true,
      ambientLux: 680,
      workerEnabled: true,
      workerFollowStep: true,
      workerX: 1200,
      workerY: -280,
      contrastThreshold: 4.5,
      showCoverage: true,
      showDensityHeatmap: true,
      showContrastHeatmap: false,
      camera: 'axon'
    },
    updatedAt: Date.now()
  };

  ensureAutoRoutes(state);
  return state;
}
