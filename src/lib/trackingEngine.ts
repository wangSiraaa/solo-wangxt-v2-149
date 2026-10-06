import type { Keyframe, Polygon, TrackedPolygon, TrackingGap } from '../types';
import { getOpenCv, trackPolygon } from './opencvTracker';
import { validatePolygon } from './geometry';

export type MediaFrame = {
  timeSec: number;
  canvas: HTMLCanvasElement;
};

export type RunTrackingOptions = {
  frames: MediaFrame[];
  startKeyframe: Keyframe;
  endSec: number;
  onProgress?: (processedSec: number, result: TrackedPolygon) => void;
  signal?: { cancelled: boolean };
};

export type RunTrackingResult = {
  tracked: TrackedPolygon[];
  pause: {
    atSec: number;
    reason: string;
    confidence: number;
  } | null;
};

export async function runForwardTracking(options: RunTrackingOptions): Promise<RunTrackingResult> {
  const cv = await getOpenCv();
  const validation = validatePolygon(options.startKeyframe.polygon);
  if (validation) throw new Error(validation);

  const startingAtOrAfter = options.frames.findIndex((frame) => frame.timeSec >= options.startKeyframe.timeSec - 1e-6);
  if (startingAtOrAfter < 0) throw new Error('起始关键帧时间不在媒体范围内');

  const tracked: TrackedPolygon[] = [];
  let previousCanvas = options.frames[startingAtOrAfter].canvas;
  let previousPolygon: Polygon = options.startKeyframe.polygon;

  for (let index = startingAtOrAfter + 1; index < options.frames.length; index += 1) {
    const frame = options.frames[index];
    if (frame.timeSec > options.endSec + 1e-6) break;
    if (options.signal?.cancelled) break;

    // Yield to the UI thread per decoded frame. Tracking remains time-ordered: frame.timeSec
    // comes from frame.timestamp and is never inferred from array index.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (options.signal?.cancelled) break;

    const result = trackPolygon(cv, previousCanvas, frame.canvas, previousPolygon);
    if (!result.ok) {
      return {
        tracked,
        pause: {
          atSec: frame.timeSec,
          reason: result.reason,
          confidence: result.confidence
        }
      };
    }

    const trackedPolygon: TrackedPolygon = {
      timeSec: frame.timeSec,
      polygon: result.polygon,
      confidence: result.confidence,
      inlierCount: result.inlierCount,
      backwardError: result.backwardError
    };
    tracked.push(trackedPolygon);
    options.onProgress?.(frame.timeSec, trackedPolygon);
    previousCanvas = frame.canvas;
    previousPolygon = result.polygon;
  }

  return { tracked, pause: null };
}

export function mergeTrackedPolygons(existing: TrackedPolygon[], additions: TrackedPolygon[]): TrackedPolygon[] {
  const byTime = new Map<number, TrackedPolygon>();
  for (const item of existing) byTime.set(item.timeSec, item);
  for (const item of additions) byTime.set(item.timeSec, item);
  return [...byTime.values()].sort((a, b) => a.timeSec - b.timeSec);
}

export function mergeGaps(existing: TrackingGap[], gap: TrackingGap): TrackingGap[] {
  const merged = [...existing];
  let current = { ...gap };
  for (let i = 0; i < merged.length; i += 1) {
    const item = merged[i];
    const overlappingOrAdjacent = current.startSec <= item.endSec + 0.05 && item.startSec <= current.endSec + 0.05;
    if (overlappingOrAdjacent) {
      const reasons = new Set([...current.reason.split('；'), ...item.reason.split('；')].filter(Boolean));
      current = {
        startSec: Math.min(current.startSec, item.startSec),
        endSec: Math.max(current.endSec, item.endSec),
        reason: [...reasons].join('；')
      };
      merged.splice(i, 1);
      i -= 1;
    }
  }
  merged.push(current);
  return merged.sort((a, b) => a.startSec - b.startSec);
}
