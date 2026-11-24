import type { DxfDocument, DxfEntity, Vec2 } from '../types';

interface Pair {
  code: number;
  value: string;
}

function tokenizeDxf(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) {
      i -= 1;
      continue;
    }
    pairs.push({ code, value: lines[i + 1] ?? '' });
  }
  return pairs;
}

function updateBounds(b: DxfDocument['bounds'], p: Vec2): void {
  b.minX = Math.min(b.minX, p.x);
  b.minY = Math.min(b.minY, p.y);
  b.maxX = Math.max(b.maxX, p.x);
  b.maxY = Math.max(b.maxY, p.y);
}

/**
 * 轻量 DXF 解析：支持 LINE / LWPOLYLINE / POLYLINE-VERTEX / CIRCLE / ARC。
 * 坐标按 DXF 原样读入；若 $INSUNITS 显示英寸则换算 mm。
 */
export function parseDxf(text: string, fileName: string): DxfDocument {
  const pairs = tokenizeDxf(text);
  let unitsCode = 4;
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim().toUpperCase() === '$INSUNITS' && pairs[i + 1].code === 70) {
      unitsCode = Number.parseInt(pairs[i + 1].value.trim(), 10) || 4;
      break;
    }
  }
  const unitScale = unitsCode === 1 ? 25.4 : unitsCode === 2 ? 304.8 : 1;
  const units = unitsCode === 1 ? 'inch→mm' : unitsCode === 2 ? 'feet→mm' : 'mm';

  const entities: DxfEntity[] = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let id = 0;
  const nextId = (type: string) => `${type}-${++id}`;

  let inEntities = false;
  let current: DxfEntity | null = null;
  let currentLayer = '0';
  let polyPoints: Vec2[] = [];

  const addPoint = (x?: number, y?: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = { x: (x as number) * unitScale, y: (y as number) * unitScale };
    polyPoints.push(p);
    updateBounds(bounds, p);
  };

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    const upper = value.trim().toUpperCase();

    if (code === 2 && upper === 'ENTITIES') inEntities = true;
    if (code === 0 && upper === 'ENDSEC' && inEntities) {
      if (current && current.type === 'polyline' && polyPoints.length > 1) {
        current.points = polyPoints;
        entities.push(current);
      }
      current = null;
      inEntities = false;
      continue;
    }
    if (!inEntities) continue;

    if (code === 8) currentLayer = value.trim();

    if (code === 0) {
      if (current && current.type === 'polyline' && polyPoints.length > 1) {
        current.points = polyPoints;
        entities.push(current);
      }
      current = null;

      if (upper === 'LINE') {
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0, layer = currentLayer;
        for (let j = i + 1; j < Math.min(i + 40, pairs.length); j++) {
          if (pairs[j].code === 0) break;
          if (pairs[j].code === 8) layer = pairs[j].value.trim();
          if (pairs[j].code === 10) x1 = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 20) y1 = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 11) x2 = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 21) y2 = Number.parseFloat(pairs[j].value);
        }
        const a = { x: x1 * unitScale, y: y1 * unitScale };
        const b = { x: x2 * unitScale, y: y2 * unitScale };
        updateBounds(bounds, a);
        updateBounds(bounds, b);
        entities.push({ id: nextId('line'), type: 'line', layer, points: [a, b] });
      } else if (upper === 'LWPOLYLINE') {
        const pts: Vec2[] = [];
        let layer = currentLayer;
        let x: number | null = null;
        for (let j = i + 1; j < Math.min(i + 20000, pairs.length); j++) {
          if (pairs[j].code === 0) break;
          if (pairs[j].code === 8) layer = pairs[j].value.trim();
          if (pairs[j].code === 10) x = Number.parseFloat(pairs[j].value) * unitScale;
          if (pairs[j].code === 20 && x !== null) {
            const p = { x, y: Number.parseFloat(pairs[j].value) * unitScale };
            pts.push(p);
            updateBounds(bounds, p);
            x = null;
          }
        }
        if (pts.length > 1) entities.push({ id: nextId('poly'), type: 'polyline', layer, points: pts });
      } else if (upper === 'POLYLINE') {
        current = { id: nextId('poly'), type: 'polyline', layer: currentLayer, points: [] };
        polyPoints = [];
      } else if (upper === 'VERTEX') {
        let x = 0, y = 0;
        for (let j = i + 1; j < Math.min(i + 20, pairs.length); j++) {
          if (pairs[j].code === 0) break;
          if (pairs[j].code === 10) x = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 20) y = Number.parseFloat(pairs[j].value);
        }
        addPoint(x, y);
      } else if (upper === 'CIRCLE' || upper === 'ARC') {
        let cx = 0, cy = 0, radius = 0;
        let startAngle = 0, endAngle = 360;
        let layer = currentLayer;
        for (let j = i + 1; j < Math.min(i + 40, pairs.length); j++) {
          if (pairs[j].code === 0) break;
          if (pairs[j].code === 8) layer = pairs[j].value.trim();
          if (pairs[j].code === 10) cx = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 20) cy = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 40) radius = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 50) startAngle = Number.parseFloat(pairs[j].value);
          if (pairs[j].code === 51) endAngle = Number.parseFloat(pairs[j].value);
        }
        const center = { x: cx * unitScale, y: cy * unitScale };
        radius *= unitScale;
        updateBounds(bounds, { x: center.x - radius, y: center.y - radius });
        updateBounds(bounds, { x: center.x + radius, y: center.y + radius });
        entities.push({
          id: nextId(upper.toLowerCase()),
          type: upper === 'ARC' ? 'arc' : 'circle',
          layer,
          center,
          radius,
          startAngle,
          endAngle
        });
      }
    }
  }

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = 0;
    bounds.minY = 0;
    bounds.maxX = 2400;
    bounds.maxY = 1200;
  }
  return { fileName, importedAt: Date.now(), units, entities, bounds };
}

export async function readDxfFile(file: File): Promise<DxfDocument> {
  const text = await file.text();
  return parseDxf(text, file.name);
}
