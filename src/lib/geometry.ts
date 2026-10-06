import type { FrameGeometry, Point, Polygon } from '../types';

export function uid(prefix = 'id'): string {
  if ('randomUUID' in crypto) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function polygonBounds(polygon: Polygon): { x: number; y: number; width: number; height: number } | null {
  if (polygon.length < 3) return null;
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function polygonArea(polygon: Polygon): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function pointInPolygon(point: Point, polygon: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = a.y > point.y !== b.y > point.y
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function displaySize(geometry: Pick<FrameGeometry, 'codedWidth' | 'codedHeight' | 'rotationDegrees' | 'pixelAspectWidth' | 'pixelAspectHeight'>): {
  width: number;
  height: number;
} {
  const squareWidth = geometry.codedWidth * (geometry.pixelAspectWidth / geometry.pixelAspectHeight);
  const rotated = geometry.rotationDegrees === 90 || geometry.rotationDegrees === 270;
  return rotated
    ? { width: geometry.codedHeight, height: squareWidth }
    : { width: squareWidth, height: geometry.codedHeight };
}

/** Convert normalized display coordinates to coded-buffer coordinates after undoing PAR and rotation. */
export function normalizedDisplayToCoded(point: Point, geometry: FrameGeometry): Point {
  const display = displaySize(geometry);
  const dx = point.x * display.width;
  const dy = point.y * display.height;
  const squareWidth = geometry.codedWidth * (geometry.pixelAspectWidth / geometry.pixelAspectHeight);

  switch (geometry.rotationDegrees) {
    case 90:
      return { x: clamp(dy / (geometry.pixelAspectWidth / geometry.pixelAspectHeight), 0, geometry.codedWidth), y: clamp(geometry.codedHeight - dx, 0, geometry.codedHeight) };
    case 180:
      return { x: clamp((squareWidth - dx) / (geometry.pixelAspectWidth / geometry.pixelAspectHeight), 0, geometry.codedWidth), y: clamp(geometry.codedHeight - dy, 0, geometry.codedHeight) };
    case 270:
      return { x: clamp((squareWidth - dy) / (geometry.pixelAspectWidth / geometry.pixelAspectHeight), 0, geometry.codedWidth), y: clamp(dx, 0, geometry.codedHeight) };
    case 0:
    default:
      return { x: clamp(dx / (geometry.pixelAspectWidth / geometry.pixelAspectHeight), 0, geometry.codedWidth), y: clamp(dy, 0, geometry.codedHeight) };
  }
}

export function codedToNormalizedDisplay(point: Point, geometry: FrameGeometry): Point {
  const display = displaySize(geometry);
  const sx = point.x * (geometry.pixelAspectWidth / geometry.pixelAspectHeight);
  const sy = point.y;

  let dx: number;
  let dy: number;
  switch (geometry.rotationDegrees) {
    case 90:
      dx = geometry.codedHeight - sy;
      dy = sx;
      break;
    case 180:
      dx = geometry.codedWidth * (geometry.pixelAspectWidth / geometry.pixelAspectHeight) - sx;
      dy = geometry.codedHeight - sy;
      break;
    case 270:
      dx = sy;
      dy = geometry.codedWidth * (geometry.pixelAspectWidth / geometry.pixelAspectHeight) - sx;
      break;
    case 0:
    default:
      dx = sx;
      dy = sy;
  }
  return { x: dx / display.width, y: dy / display.height };
}

export function transformPolygon(polygon: Polygon, transform: (point: Point) => Point): Polygon {
  return polygon.map(transform);
}

export function averagePointDistance(a: Polygon, b: Polygon): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  }
  return total / a.length;
}

function clipLine(polygon: Polygon, a: Point, b: Point): [Point, Point] {
  let start = a;
  let end = b;
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return [start, end];
  return [start, end];
}

export function nearestPointOnPolygonBoundary(point: Point, polygon: Polygon): { point: Point; distance: number; index: number } {
  let best = { point: polygon[0], distance: Number.POSITIVE_INFINITY, index: 0 };
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lengthSquared = abx * abx + aby * aby;
    const t = lengthSquared === 0 ? 0 : clamp(((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSquared, 0, 1);
    const projected = { x: a.x + abx * t, y: a.y + aby * t };
    const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
    if (distance < best.distance) best = { point: projected, distance, index: i };
  }
  return best;
}

export function clipPolygonToUnitSquare(polygon: Polygon): Polygon {
  // Sutherland–Hodgman clipping. It keeps every tracked point inside legal normalized image coordinates.
  const edges: Array<[Point, Point]> = [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }],
    [{ x: 1, y: 1 }, { x: 0, y: 1 }],
    [{ x: 0, y: 1 }, { x: 0, y: 0 }]
  ];
  let output = polygon;
  for (const [edgeA, edgeB] of edges) {
    if (output.length === 0) break;
    const input = output;
    output = [];
    const inside = (p: Point) => edgeA.x === edgeB.x
      ? edgeA.x === 0 ? p.x >= 0 : p.x <= 1
      : edgeA.y === 0 ? p.y >= 0 : p.y <= 1;
    const intersect = (p: Point, q: Point): Point => {
      if (edgeA.y === edgeB.y) {
        const y = edgeA.y;
        return { x: p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y), y };
      }
      const x = edgeA.x;
      return { x, y: p.y + ((x - p.x) * (q.y - p.y)) / (q.x - p.x) };
    };
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(intersect(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(intersect(previous, current));
      }
    }
  }
  return output.length >= 3 ? output : polygon.map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }));
}

export function validatePolygon(polygon: Polygon): string | null {
  if (polygon.length < 3) return '多边形至少需要 3 个顶点';
  if (polygon.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return '多边形包含无效坐标';
  if (polygonArea(polygon) < 0.00001) return '多边形面积过小';
  if (polygon.some((p) => p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return '多边形必须位于画面内';
  return null;
}

export function formatTime(seconds: number): string {
  const value = Math.max(0, seconds);
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  const millis = Math.round((value - Math.floor(value)) * 1000);
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

export function closestByTime<T extends { timeSec: number }>(items: T[], timeSec: number): T | null {
  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const delta = Math.abs(item.timeSec - timeSec);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = item;
    }
  }
  return best;
}

export function sortedByTime<T extends { timeSec: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.timeSec - b.timeSec);
}
