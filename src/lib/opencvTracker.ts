import type { Polygon, Point } from '../types';
import { clipPolygonToUnitSquare } from './geometry';

type CvModule = any;

let cvPromise: Promise<CvModule> | null = null;

export async function loadOpenCv(): Promise<unknown> {
  const module = await import('@techstark/opencv-js');
  // The package's UMD/ESM interop exposes the Emscripten runtime as a thenable default export.
  return module.default;
}

export async function getOpenCv(): Promise<CvModule> {
  if (!cvPromise) cvPromise = loadOpenCv() as Promise<CvModule>;
  return cvPromise;
}

export type OpticalFlowResult = {
  ok: true;
  polygon: Polygon;
  confidence: number;
  inlierCount: number;
  backwardError: number;
  trackedFeatureCount: number;
  blurVariance: number;
  retainedAreaRatio: number;
} | {
  ok: false;
  reason: string;
  confidence: number;
  inlierCount: number;
  backwardError: number;
  trackedFeatureCount: number;
  blurVariance: number;
  retainedAreaRatio: number;
};

type StrongPoint = Point & { response: number };

function scaledPoints(polygon: Polygon, scaleX: number, scaleY: number): Point[] {
  return polygon.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }));
}

function normalizedPoints(points: Point[], scaleX: number, scaleY: number): Polygon {
  return points.map((point) => ({ x: point.x / scaleX, y: point.y / scaleY }));
}

function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function transformWithAffine(polygon: Polygon, matrix: { data64F: Float64Array }): Polygon {
  const m = matrix.data64F;
  return polygon.map((point) => ({
    x: m[0] * point.x + m[1] * point.y + m[2],
    y: m[3] * point.x + m[4] * point.y + m[5]
  }));
}

function makeGray(cv: CvModule, canvas: HTMLCanvasElement): { gray: InstanceType<typeof cv.Mat>; rgba: InstanceType<typeof cv.Mat> } {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法读取跟踪帧画布');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  return { gray, rgba };
}

function makePolygonMask(cv: CvModule, polygon: Polygon, width: number, height: number): InstanceType<typeof cv.Mat> {
  const pixels = scaledPoints(polygon, width, height);
  const flat: number[] = [];
  for (const point of pixels) flat.push(Math.round(point.x), Math.round(point.y));
  const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
  const poly = cv.matFromArray(1, polygon.length, cv.CV_32SC2, flat);
  const polygons = new cv.MatVector();
  polygons.push_back(poly);
  cv.fillPoly(mask, polygons, new cv.Scalar(255));
  polygons.delete();
  poly.delete();
  return mask;
}

function readUint8(mat: { rows: number; ucharPtr(row: number, col: number): Uint8Array; data8?: Uint8Array }): number[] {
  const values: number[] = [];
  if (typeof mat.data8 !== 'undefined') return Array.from(mat.data8);
  for (let row = 0; row < mat.rows; row += 1) values.push(mat.ucharPtr(row, 0)[0]);
  return values;
}

function readPointMat(cv: CvModule, mat: InstanceType<typeof cv.Mat>): Point[] {
  const data = mat.data32F;
  const points: Point[] = [];
  for (let i = 0; i < data.length; i += 2) points.push({ x: data[i], y: data[i + 1] });
  return points;
}

function pointsToMat(cv: CvModule, points: Point[]): InstanceType<typeof cv.Mat> {
  const flat: number[] = [];
  for (const point of points) flat.push(point.x, point.y);
  return cv.matFromArray(points.length, 2, cv.CV_32F, flat);
}

function median(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isInsidePolygon(point: Point, polygon: Polygon): boolean {
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

function dedupeNearbyPoints(points: StrongPoint[], minimumDistance: number, limit: number): Point[] {
  const output: Point[] = [];
  for (const candidate of points) {
    if (output.every((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) >= minimumDistance)) {
      output.push({ x: candidate.x, y: candidate.y });
      if (output.length >= limit) break;
    }
  }
  return output;
}

function seedCandidates(
  cv: CvModule,
  polygon: Polygon,
  width: number,
  height: number,
  mask: InstanceType<typeof cv.Mat>,
  features: StrongPoint[]
): Point[] {
  const pixels = scaledPoints(polygon, width, height);
  const bounds = {
    minX: Math.max(1, Math.floor(Math.min(...pixels.map((p) => p.x)))),
    maxX: Math.min(width - 2, Math.ceil(Math.max(...pixels.map((p) => p.x)))),
    minY: Math.max(1, Math.floor(Math.min(...pixels.map((p) => p.y)))),
    maxY: Math.min(height - 2, Math.ceil(Math.max(...pixels.map((p) => p.y))))
  };
  const seeds: StrongPoint[] = features.map((point) => ({ ...point, response: 1000 + point.response }));

  // Deterministic jittered grid and polygon edge seeds matter for smooth signs, where FAST may
  // return very few corners. LK still verifies every seed with forward/backward tracking.
  let salt = 1;
  const pseudoRandom = () => {
    salt = (salt * 1664525 + 1013904223) >>> 0;
    return salt / 4294967296;
  };
  const gridX = Math.max(5, Math.round((bounds.maxX - bounds.minX) / 18));
  const gridY = Math.max(4, Math.round((bounds.maxY - bounds.minY) / 18));
  for (let gy = 0; gy < gridY; gy += 1) {
    for (let gx = 0; gx < gridX; gx += 1) {
      const x = bounds.minX + ((gx + 0.5) / gridX) * (bounds.maxX - bounds.minX) + (pseudoRandom() - 0.5) * 5;
      const y = bounds.minY + ((gy + 0.5) / gridY) * (bounds.maxY - bounds.minY) + (pseudoRandom() - 0.5) * 5;
      const normalized = { x: x / width, y: y / height };
      if (x >= 0 && y >= 0 && x < width && y < height && isInsidePolygon(normalized, polygon) && mask.ucharPtr(Math.round(y), Math.round(x))[0] > 0) {
        seeds.push({ x, y, response: 50 + pseudoRandom() * 20 });
      }
    }
  }
  for (let i = 0; i < polygon.length; i += 1) {
    const a = pixels[i];
    const b = pixels[(i + 1) % polygon.length];
    for (const t of [0.22, 0.5, 0.78]) {
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const nx = Math.min(width - 2, Math.max(1, x + 2));
      const ny = Math.min(height - 2, Math.max(1, y + 2));
      seeds.push({ x: nx, y: ny, response: 80 });
    }
  }
  return dedupeNearbyPoints(seeds, 4.5, 220);
}

export function trackPolygon(
  cv: CvModule,
  previousCanvas: HTMLCanvasElement,
  currentCanvas: HTMLCanvasElement,
  previousPolygon: Polygon
): OpticalFlowResult {
  if (previousCanvas.width !== currentCanvas.width || previousCanvas.height !== currentCanvas.height) {
    throw new Error('连续跟踪帧尺寸不一致，不能估计仿射变换');
  }
  const width = currentCanvas.width;
  const height = currentCanvas.height;
  const allocations: Array<{ delete: () => void }> = [];
  const track = <T extends { delete: () => void }>(value: T): T => {
    allocations.push(value);
    return value;
  };

  try {
    const previous = makeGray(cv, previousCanvas);
    const current = makeGray(cv, currentCanvas);
    allocations.push(previous.gray, previous.rgba, current.gray, current.rgba);

    const mask = track(makePolygonMask(cv, previousPolygon, width, height));
    const detector = track(new cv.FastFeatureDetector(18, true));
    const keyPoints = track(new cv.KeyPointVector());
    detector.detect(previous.gray, keyPoints, mask);
    const features: StrongPoint[] = [];
    for (let i = 0; i < keyPoints.size(); i += 1) {
      const keyPoint = keyPoints.get(i);
      features.push({ x: keyPoint.pt.x, y: keyPoint.pt.y, response: keyPoint.response });
    }
    features.sort((a, b) => b.response - a.response);

    const candidates = seedCandidates(cv, previousPolygon, width, height, mask, features.slice(0, 120));
    const corners = pointsToMat(cv, candidates);
    allocations.push(corners);
    const detectedCount = candidates.length;
    if (detectedCount < 8) {
      return fail('多边形内可跟踪角点不足，可能是模糊、纯色表面或出画', 0, 0, Number.POSITIVE_INFINITY, detectedCount, 0, 1);
    }

    const nextCorners = track(new cv.Mat());
    const forwardStatus = track(new cv.Mat());
    const forwardError = track(new cv.Mat());
    const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01);
    allocations.push(criteria);
    cv.calcOpticalFlowPyrLK(
      previous.gray,
      current.gray,
      corners,
      nextCorners,
      forwardStatus,
      forwardError,
      new cv.Size(21, 21),
      3,
      criteria,
      0,
      1e-4
    );

    const previousPoints = readPointMat(cv, corners);
    const nextPointsRaw = readPointMat(cv, nextCorners);
    const forwardOkay = readUint8(forwardStatus);
    const trackedPairs: Array<{ from: Point; to: Point }> = [];
    for (let i = 0; i < previousPoints.length; i += 1) {
      if (forwardOkay[i] === 1 && Number.isFinite(nextPointsRaw[i].x) && Number.isFinite(nextPointsRaw[i].y)) {
        trackedPairs.push({ from: previousPoints[i], to: nextPointsRaw[i] });
      }
    }
    const trackedRatio = trackedPairs.length / previousPoints.length;
    if (trackedPairs.length < 8) {
      return fail('前向 Lucas–Kanade 光流几乎全部丢失，目标可能被遮挡或出画', 0, 0, Number.POSITIVE_INFINITY, trackedPairs.length, 0, trackedRatio);
    }

    const backCorners = track(new cv.Mat());
    const backwardStatus = track(new cv.Mat());
    const backwardErrorMat = track(new cv.Mat());
    const backwardSource = track(pointsToMat(cv, trackedPairs.map((pair) => pair.to)));
    cv.calcOpticalFlowPyrLK(
      current.gray,
      previous.gray,
      backwardSource,
      backCorners,
      backwardStatus,
      backwardErrorMat,
      new cv.Size(21, 21),
      3,
      criteria,
      0,
      1e-4
    );
    const backPoints = readPointMat(cv, backCorners);
    const backOkay = readUint8(backwardStatus);
    const consistentPairs: Array<{ from: Point; to: Point }> = [];
    const backErrors: number[] = [];
    for (let i = 0; i < trackedPairs.length; i += 1) {
      if (backOkay[i] !== 1) continue;
      const error = Math.hypot(backPoints[i].x - trackedPairs[i].from.x, backPoints[i].y - trackedPairs[i].from.y);
      const normalizedError = error / Math.hypot(width, height);
      backErrors.push(normalizedError);
      if (normalizedError <= 0.008) consistentPairs.push(trackedPairs[i]);
    }
    const backwardMedian = median(backErrors);
    if (consistentPairs.length < 8) {
      return fail('前向—反向光流不一致，无法确认移动标牌位置', 0.15, consistentPairs.length, backwardMedian, trackedPairs.length, 0, trackedRatio);
    }

    const source = track(pointsToMat(cv, consistentPairs.map((pair) => pair.from)));
    const destination = track(pointsToMat(cv, consistentPairs.map((pair) => pair.to)));
    const inliers = track(new cv.Mat());
    const affine = cv.estimateAffine2D(
      source,
      destination,
      inliers,
      cv.RANSAC,
      3,
      0.99,
      2000,
      0.95,
      10
    );
    if (!affine) {
      return fail('RANSAC 仿射模型为空，运动不符合二维仿射假设', 0.2, 0, backwardMedian, trackedPairs.length, 0, trackedRatio);
    }
    allocations.push(affine);
    const inlierData = readUint8(inliers);
    let inlierCount = 0;
    for (const value of inlierData) if (value) inlierCount += 1;
    const inlierRatio = inlierCount / consistentPairs.length;
    const m = affine.data64F;
    const scaleX = Math.hypot(m[0], m[1]);
    const scaleY = Math.hypot(m[3], m[4]);
    const determinant = m[0] * m[4] - m[1] * m[3];
    const normalizedTranslation = Math.hypot(m[2], m[5]) / Math.hypot(width, height);
    if (
      Math.abs(determinant) < 0.02
      || scaleX < 0.5
      || scaleX > 1.8
      || scaleY < 0.5
      || scaleY > 1.8
      || normalizedTranslation > 0.2
      || Math.abs(Math.atan2(m[1], m[0])) > Math.PI / 8
    ) {
      return fail('单帧仿射矩阵出现异常缩放、翻转、旋转或跳变，拒绝漂移候选', 0.2, inlierCount, backwardMedian, trackedPairs.length, 0, 1);
    }

    const nextPolygon = clipPolygonToUnitSquare(normalizedPoints(transformWithAffine(scaledPoints(previousPolygon, width, height), affine), width, height));
    const originalArea = polygonArea(previousPolygon);
    const retainedAreaRatio = polygonArea(nextPolygon) / Math.max(originalArea, 1e-9);
    if (retainedAreaRatio < 0.72) {
      return fail('候选遮罩大面积越出画面，按“短暂出画”暂停等待人工关键帧', 0.25, inlierCount, backwardMedian, trackedPairs.length, 0, retainedAreaRatio);
    }

    const nextMask = track(makePolygonMask(cv, nextPolygon, width, height));
    const laplacian = track(new cv.Mat());
    const mean = track(new cv.Mat());
    const stdDev = track(new cv.Mat());
    cv.Laplacian(current.gray, laplacian, cv.CV_64F, 3, 1, 0, cv.BORDER_DEFAULT);
    cv.meanStdDev(laplacian, mean, stdDev, nextMask);
    const blurVariance = stdDev.data64F[0] ** 2;
    if (!Number.isFinite(blurVariance) || blurVariance < 18) {
      return fail('当前帧锐度不足，疑似运动模糊；不允许凭漂移遮罩继续', 0.2, inlierCount, backwardMedian, trackedPairs.length, blurVariance, retainedAreaRatio);
    }

    const sharpnessScore = Math.max(0, Math.min(1, (blurVariance - 18) / 80));
    const forwardScore = Math.min(1, trackedRatio);
    const backScore = Math.max(0, 1 - backwardMedian / 0.01);
    const areaScore = Math.min(1, retainedAreaRatio);
    const confidence = Math.max(
      0,
      Math.min(1, 0.32 * inlierRatio + 0.22 * forwardScore + 0.16 * backScore + 0.2 * areaScore + 0.1 * sharpnessScore)
    );

    if (inlierCount < 10 || inlierRatio < 0.55 || backwardMedian > 0.01 || confidence < 0.58) {
      return fail('综合追踪置信度低于阈值，已暂停以防止遮罩漂离目标', confidence, inlierCount, backwardMedian, trackedPairs.length, blurVariance, retainedAreaRatio);
    }

    return {
      ok: true,
      polygon: nextPolygon,
      confidence,
      inlierCount,
      backwardError: backwardMedian,
      trackedFeatureCount: trackedPairs.length,
      blurVariance,
      retainedAreaRatio
    };
  } finally {
    for (const resource of allocations.reverse()) {
      try {
        resource.delete();
      } catch {
        // OpenCV occasionally raises on partially initialized Emscripten handles; shutdown can continue.
      }
    }
  }
}

function fail(
  reason: string,
  confidence: number,
  inlierCount: number,
  backwardError: number,
  trackedFeatureCount: number,
  blurVariance: number,
  retainedAreaRatio: number
): OpticalFlowResult & { ok: false } {
  return {
    ok: false,
    reason,
    confidence,
    inlierCount,
    backwardError,
    trackedFeatureCount,
    blurVariance,
    retainedAreaRatio
  };
}
