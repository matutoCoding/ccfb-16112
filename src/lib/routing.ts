import type { Fixture, ProjectState, TiePoint, Vec3, Wire } from '../types';
import { cavityWorld } from './fixtures';
import { distance } from './math';

export function wireOuterRadius(w: Pick<Wire, 'crossSection'>): number {
  // 含绝缘皮的近似外半径
  return 0.72 + 0.58 * Math.sqrt(Math.max(0.05, w.crossSection));
}

export function edgeKey(a: string, b: string): string {
  return [a, b].sort().join('::');
}

export function stackTopFromSum(sumRadiusSq: number): number {
  // 排布系数 0.72；1.18 为压扁/多层修正
  return 5 + 1.18 * Math.sqrt(sumRadiusSq / 0.72);
}

interface RouteNode extends Vec3 {
  nodeId: string;
}

interface Graph {
  ids: string[];
  byId: Map<string, Fixture>;
  adjacency: Map<string, string[]>;
}

function routingFixtures(fixtures: Fixture[]): Fixture[] {
  return fixtures.filter((f) => f.kind === 'fork' || f.kind === 'bracket' || f.kind === 'cradle');
}

export function buildGraph(fixtures: Fixture[]): Graph {
  const nodes = routingFixtures(fixtures);
  const byId = new Map(nodes.map((f) => [f.id, f]));
  const adjacency = new Map<string, string[]>();
  for (const f of nodes) adjacency.set(f.id, []);

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ortho = Math.abs(a.x - b.x) < 38 || Math.abs(a.y - b.y) < 38;
      const maxLink = ortho ? 230 : 185;
      if (d <= maxLink) {
        adjacency.get(a.id)!.push(b.id);
        adjacency.get(b.id)!.push(a.id);
      }
    }
  }

  // 防止拖动后局部断网：每个节点补最近的两个可达邻居
  for (const f of nodes) {
    const neigh = adjacency.get(f.id)!;
    if (neigh.length < 2) {
      const nearest = nodes
        .filter((o) => o.id !== f.id && !neigh.includes(o.id))
        .map((o) => ({ id: o.id, d: Math.hypot(o.x - f.x, o.y - f.y) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2 - neigh.length);
      for (const n of nearest) {
        if (n.d <= 520) {
          neigh.push(n.id);
          adjacency.get(n.id)?.push(f.id);
        }
      }
    }
  }
  return { ids: nodes.map((f) => f.id), byId, adjacency };
}

function nearestNodes(graph: Graph, p: Vec3, count = 6): string[] {
  return graph.ids
    .map((id) => {
      const f = graph.byId.get(id)!;
      return { id, d: Math.hypot(f.x - p.x, f.y - p.y) };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((x) => x.id);
}

function aStar(graph: Graph, start: string, goal: string): string[] | null {
  if (start === goal) return [start];
  const open = new Set<string>([start]);
  const came = new Map<string, string>();
  const g = new Map<string, number>([[start, 0]]);
  const startF = graph.byId.get(start)!;
  const goalF = graph.byId.get(goal)!;
  const h = (id: string) => {
    const f = graph.byId.get(id)!;
    return Math.hypot(f.x - goalF.x, f.y - goalF.y);
  };
  const fScore = new Map<string, number>([[start, Math.hypot(startF.x - goalF.x, startF.y - goalF.y)]]);

  while (open.size) {
    let current = '';
    let best = Infinity;
    for (const id of open) {
      const f = fScore.get(id) ?? Infinity;
      if (f < best) {
        best = f;
        current = id;
      }
    }
    if (current === goal) {
      const path = [current];
      while (came.has(current)) {
        current = came.get(current)!;
        path.unshift(current);
      }
      return path;
    }
    open.delete(current);
    const cf = graph.byId.get(current)!;
    for (const next of graph.adjacency.get(current) ?? []) {
      const nf = graph.byId.get(next)!;
      const step = Math.hypot(cf.x - nf.x, cf.y - nf.y);
      const tentative = (g.get(current) ?? Infinity) + step;
      if (tentative < (g.get(next) ?? Infinity)) {
        came.set(next, current);
        g.set(next, tentative);
        fScore.set(next, tentative + h(next));
        open.add(next);
      }
    }
  }
  return null;
}

export function autoRouteWire(fixtures: Fixture[], wire: Wire): string[] {
  const graph = buildGraph(fixtures);
  const fromF = fixtures.find((f) => f.id === wire.from.fixtureId);
  const toF = fixtures.find((f) => f.id === wire.to.fixtureId);
  if (!fromF || !toF) return wire.fixturePath;
  const from = cavityWorld(fromF, wire.from.cavityId);
  const to = cavityWorld(toF, wire.to.cavityId);
  const starts = nearestNodes(graph, from, 8);
  const goals = nearestNodes(graph, to, 8);
  let best: string[] | null = null;
  let bestLen = Infinity;
  for (const s of starts) {
    for (const g of goals) {
      const path = aStar(graph, s, g);
      if (!path) continue;
      const sf = graph.byId.get(s)!;
      const gf = graph.byId.get(g)!;
      const len =
        Math.hypot(from.x - sf.x, from.y - sf.y) +
        path.reduce((sum, id, i) => {
          if (i === 0) return 0;
          const a = graph.byId.get(path[i - 1])!;
          const b = graph.byId.get(id)!;
          return sum + Math.hypot(a.x - b.x, a.y - b.y);
        }, 0) +
        Math.hypot(to.x - gf.x, to.y - gf.y);
      if (len < bestLen) {
        bestLen = len;
        best = path;
      }
    }
  }
  return best ?? [starts[0], goals[0]].filter(Boolean);
}

function planarRouteNodes(wire: Wire, fixtures: Fixture[]): RouteNode[] {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const fromF = byId.get(wire.from.fixtureId);
  const toF = byId.get(wire.to.fixtureId);
  const start = fromF ? cavityWorld(fromF, wire.from.cavityId) : { x: 0, y: 0, z: 20 };
  const end = toF ? cavityWorld(toF, wire.to.cavityId) : { x: 2400, y: 600, z: 20 };
  const nodes: RouteNode[] = [{ ...start, nodeId: `${wire.id}-from-cavity` }];

  if (fromF) nodes.push({ x: fromF.x, y: fromF.y, z: fromF.height, nodeId: fromF.id });
  for (const id of wire.fixturePath) {
    const f = byId.get(id);
    if (!f || id === wire.from.fixtureId || id === wire.to.fixtureId) continue;
    const last = nodes[nodes.length - 1];
    if (last && Math.hypot(last.x - f.x, last.y - f.y) < 1) continue;
    nodes.push({ x: f.x, y: f.y, z: f.height, nodeId: id });
  }
  if (toF) nodes.push({ x: toF.x, y: toF.y, z: toF.height, nodeId: toF.id });
  nodes.push({ ...end, nodeId: `${wire.id}-to-cavity` });

  const deduped: RouteNode[] = [];
  for (const n of nodes) {
    const last = deduped[deduped.length - 1];
    if (!last || distance(last, n) > 0.8) deduped.push(n);
  }
  return deduped;
}

export interface RoutingStats {
  edgeLoad: Map<string, number>;
  edgeCounts: Map<string, number>;
  nodeCounts: Map<string, number>;
}

export function recalculateStacks(state: ProjectState): RoutingStats {
  const load = new Map<string, number>();
  const edgeCounts = new Map<string, number>();
  const nodeCounts = new Map<string, number>();
  const ordered = [...state.wires].sort((a, b) => a.sequence - b.sequence);

  for (const [wireIndex, wire] of ordered.entries()) {
    const r = wireOuterRadius(wire);
    const nodes = planarRouteNodes(wire, state.fixtures);
    const keys: string[] = [];
    for (let i = 1; i < nodes.length; i++) keys.push(edgeKey(nodes[i - 1].nodeId, nodes[i].nodeId));

    for (let i = 0; i < nodes.length; i++) {
      if (i === 0 || i === nodes.length - 1) continue; // 孔位高度不能被堆高覆盖
      const node = nodes[i];
      if (node.nodeId === wire.from.fixtureId || node.nodeId === wire.to.fixtureId) {
        const connector = state.fixtures.find((f) => f.id === node.nodeId);
        node.z = connector?.height ?? 24;
        continue;
      }
      const support = state.fixtures.find((f) => f.id === node.nodeId);
      if (support?.kind === 'bracket' || support?.kind === 'cradle') {
        // 托架/线托把整束线抬到托面以上，不能再按板面低层路径绘制
        node.z = Math.max(node.z, (support.height ?? 26) + r);
        continue;
      }
      const prevKey = i > 0 ? keys[i - 1] : undefined;
      const nextKey = i < keys.length ? keys[i] : undefined;
      const hPrev = prevKey ? stackTopFromSum(load.get(prevKey) ?? 0) : 5;
      const hNext = nextKey ? stackTopFromSum(load.get(nextKey) ?? 0) : 5;
      nodes[i].z = Math.max(hPrev, hNext) + r;
    }

    // 叉点级折线即可同时用于圆管渲染和胶囊遮挡；过密采样会让 200 步报告变慢。
    wire.route = nodes.map(({ x, y, z }) => ({ x, y, z }));
    let len = 0;
    for (let i = 1; i < wire.route.length; i++) len += distance(wire.route[i - 1], wire.route[i]);
    wire.lengthMm = Math.round(len);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      load.set(key, (load.get(key) ?? 0) + r * r);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      const a = nodes[i].nodeId;
      const b = nodes[i + 1].nodeId;
      // 只统计真实夹具节点
      if (!a.includes('-cavity')) nodeCounts.set(a, (nodeCounts.get(a) ?? 0) + 1);
      if (!b.includes('-cavity')) nodeCounts.set(b, (nodeCounts.get(b) ?? 0) + 1);
    }
  }

  state.tiePoints = buildTiePoints(state, { edgeLoad: load, edgeCounts, nodeCounts });
  return { edgeLoad: load, edgeCounts, nodeCounts };
}

function buildTiePoints(state: ProjectState, stats: RoutingStats): TiePoint[] {
  const byId = new Map(state.fixtures.map((f) => [f.id, f]));
  const points: TiePoint[] = [];
  const seenTie = new Set<string>();

  for (const [key, count] of stats.edgeCounts) {
    if (count < 6) continue;
    const [aId, bId] = key.split('::');
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b) continue;
    const id = `tie-${key}`;
    if (seenTie.has(id)) continue;
    seenTie.add(id);
    points.push({
      id,
      kind: 'tie',
      edgeKey: key,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      z: stackTopFromSum(stats.edgeLoad.get(key) ?? 0) + 3,
      wireCount: count
    });
  }

  for (const f of state.fixtures) {
    const count = stats.nodeCounts.get(f.id) ?? 0;
    if (f.kind !== 'fork' || count < 10) continue;
    const wireIds = new Set(
      state.wires.filter((w) => w.fixturePath.includes(f.id)).map((w) => w.id)
    );
    const neighborIds = new Set<string>();
    for (const w of state.wires) {
      const idx = w.fixturePath.indexOf(f.id);
      if (idx > 0) neighborIds.add(w.fixturePath[idx - 1]);
      if (idx >= 0 && idx < w.fixturePath.length - 1) neighborIds.add(w.fixturePath[idx + 1]);
    }
    if (wireIds.size >= 10 && neighborIds.size >= 3) {
      points.push({
        id: `branch-${f.id}`,
        kind: 'branch',
        x: f.x,
        y: f.y,
        z: (f.height ?? 40) + 4,
        wireCount: wireIds.size
      });
    }
  }
  return points.sort((a, b) => b.wireCount - a.wireCount).slice(0, 180);
}

export function ensureAutoRoutes(state: ProjectState): void {
  for (const w of state.wires) {
    if (!w.fixturePath || w.fixturePath.length === 0) {
      w.fixturePath = autoRouteWire(state.fixtures, w);
    }
  }
  attachCollidingSupports(state);
  recalculateStacks(state);
}

/** 若生成的线段穿过托架/线托实体，就把该支撑点按沿线顺序插入路径。 */
export function attachCollidingSupports(state: ProjectState): void {
  for (const wire of state.wires) {
    const nodes = planarRouteNodes(wire, state.fixtures);
    if (nodes.length < 2) continue;
    const cumulative = [0];
    for (let i = 1; i < nodes.length; i++) cumulative.push(cumulative[i - 1] + distance(nodes[i - 1], nodes[i]));
    const alongAt = (x: number, y: number): number => {
      let best = 0;
      let bestD = Infinity;
      let acc = 0;
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1];
        const b = nodes[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
        const px = a.x + dx * t;
        const py = a.y + dy * t;
        const d = Math.hypot(x - px, y - py);
        if (d < bestD) {
          bestD = d;
          best = acc + Math.sqrt(len2) * t;
        }
        acc += Math.sqrt(len2);
      }
      return best;
    };

    const entries = wire.fixturePath
      .map((id) => state.fixtures.find((f) => f.id === id))
      .filter((f): f is Fixture => Boolean(f))
      .map((f) => ({ id: f.id, along: alongAt(f.x, f.y) }));
    const existing = new Set(entries.map((e) => e.id));

    for (const f of state.fixtures) {
      if (f.kind !== 'bracket' && f.kind !== 'cradle') continue;
      if (existing.has(f.id)) continue;
      const radius = Math.hypot(f.width ?? 80, f.depth ?? 38) * 0.42 + 5;
      let hit = false;
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1];
        const b = nodes[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((f.x - a.x) * dx + (f.y - a.y) * dy) / len2));
        const d = Math.hypot(f.x - (a.x + dx * t), f.y - (a.y + dy * t));
        if (d < radius) {
          hit = true;
          break;
        }
      }
      if (hit) entries.push({ id: f.id, along: alongAt(f.x, f.y) });
    }

    entries.sort((a, b) => a.along - b.along);
    wire.fixturePath = Array.from(new Set(entries.map((e) => e.id)));
  }
}

export function densifyPath(points: Vec3[], stepMm = 45): Vec3[] {
  if (points.length < 2) return points;
  const out: Vec3[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = distance(a, b);
    const n = Math.max(1, Math.ceil(len / stepMm));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}
