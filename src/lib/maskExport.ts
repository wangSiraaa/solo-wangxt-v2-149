import type { Keyframe, MediaMetadata, Polygon, TrackedPolygon, TrackingGap } from '../types';
import { closestByTime, polygonArea, sortedByTime } from './geometry';
import { readMedia } from './opfs';

export type MaskExport = {
  schema: 'browser-mask-tracker/mask-project-v1';
  exportedAt: string;
  source: {
    originalName: string;
    mediaId: string;
    sizeBytes: number;
    sha256?: string;
    mimeType: string;
    durationSec: number;
    frameCount: number;
  };
  geometry: {
    codedWidth: number;
    codedHeight: number;
    rotationDegrees: 0 | 90 | 180 | 270;
    pixelAspectWidth: number;
    pixelAspectHeight: number;
  };
  timebase: {
    units: 'seconds';
    timestamps: 'WebCodecs VideoFrame.timestamp / 1_000_000 (container PTS)'
  };
  shape: '2D-polygon';
  motionModel: 'affine-2D';
  coordinates: 'normalized-display-coordinates-after-container-rotation-and-pixel-aspect-ratio';
  keyframes: Keyframe[];
  trackedPolygons: TrackedPolygon[];
  gaps: TrackingGap[];
};

export function buildMaskExport(project: {
  media: MediaMetadata;
  keyframes: Keyframe[];
  trackedPolygons: TrackedPolygon[];
  gaps: TrackingGap[];
}, sha256?: string): MaskExport {
  return {
    schema: 'browser-mask-tracker/mask-project-v1',
    exportedAt: new Date().toISOString(),
    source: {
      originalName: project.media.originalName,
      mediaId: project.media.mediaId,
      sizeBytes: project.media.sizeBytes,
      sha256,
      mimeType: project.media.mimeType,
      durationSec: project.media.durationSec,
      frameCount: project.media.frameCount
    },
    geometry: {
      codedWidth: project.media.codedWidth,
      codedHeight: project.media.codedHeight,
      rotationDegrees: project.media.rotationDegrees,
      pixelAspectWidth: project.media.pixelAspectWidth,
      pixelAspectHeight: project.media.pixelAspectHeight
    },
    timebase: {
      units: 'seconds',
      timestamps: 'WebCodecs VideoFrame.timestamp / 1_000_000 (container PTS)'
    },
    shape: '2D-polygon',
    motionModel: 'affine-2D',
    coordinates: 'normalized-display-coordinates-after-container-rotation-and-pixel-aspect-ratio',
    keyframes: sortedByTime(project.keyframes),
    trackedPolygons: sortedByTime(project.trackedPolygons),
    gaps: [...project.gaps].sort((a, b) => a.startSec - b.startSec)
  };
}

export async function downloadMaskExport(project: Parameters<typeof buildMaskExport>[0]): Promise<void> {
  const sourceBuffer = await readMedia(project.media.mediaId);
  const digestBuffer = await crypto.subtle.digest('SHA-256', sourceBuffer);
  const sha256 = Array.from(new Uint8Array(digestBuffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  const exportData = buildMaskExport(project, sha256);
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${project.media.originalName.replace(/\.[^.]+$/, '')}-mask-v1.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolatePolygons(a: Polygon, b: Polygon, t: number): Polygon {
  if (a.length !== b.length) return a;
  return a.map((point, index) => ({
    x: lerp(point.x, b[index].x, t),
    y: lerp(point.y, b[index].y, t)
  }));
}

export type ReplayMaskResult = {
  polygon: Polygon | null;
  status: 'human-keyframe' | 'tracked' | 'interpolated' | 'gap' | 'no-data';
  confidence: number | null;
  segmentStartSec: number | null;
};

function insideGap(timeSec: number, gaps: TrackingGap[], toleranceSec: number): boolean {
  return gaps.some((gap) => timeSec + toleranceSec >= gap.startSec && timeSec - toleranceSec <= gap.endSec);
}

/** Resolve a mask from actual seconds. Unknown intervals intentionally return null; no mask is guessed across a gap. */
export function replayMaskAtTime(
  timeSec: number,
  keyframesInput: Keyframe[],
  trackedInput: TrackedPolygon[],
  gapsInput: TrackingGap[],
  toleranceSec = 1 / 30
): ReplayMaskResult {
  const keyframes = sortedByTime(keyframesInput);
  const tracked = sortedByTime(trackedInput);
  const gaps = [...gapsInput].sort((a, b) => a.startSec - b.startSec);
  if (keyframes.length === 0) return { polygon: null, status: 'no-data', confidence: null, segmentStartSec: null };

  const exactKey = closestByTime(keyframes.filter((item) => Math.abs(item.timeSec - timeSec) <= toleranceSec), timeSec);
  if (exactKey) return { polygon: exactKey.polygon, status: 'human-keyframe', confidence: 1, segmentStartSec: exactKey.timeSec };

  let startKey: Keyframe | null = null;
  for (const key of keyframes) if (key.timeSec <= timeSec + toleranceSec) startKey = key;
  if (!startKey) return { polygon: null, status: 'no-data', confidence: null, segmentStartSec: null };

  if (insideGap(timeSec, gaps, toleranceSec)) {
    return { polygon: null, status: 'gap', confidence: null, segmentStartSec: startKey.timeSec };
  }

  const priorTracked = [...tracked].reverse().find((item) => item.timeSec <= timeSec + toleranceSec && item.timeSec >= startKey.timeSec - toleranceSec);
  const nextTracked = tracked.find((item) => item.timeSec >= timeSec - toleranceSec && item.timeSec >= startKey.timeSec - toleranceSec);
  if (!priorTracked) return { polygon: startKey.polygon, status: 'human-keyframe', confidence: 1, segmentStartSec: startKey.timeSec };
  if (insideGap(priorTracked.timeSec, gaps, toleranceSec) || (nextTracked && insideGap(nextTracked.timeSec, gaps, toleranceSec))) {
    return { polygon: null, status: 'gap', confidence: null, segmentStartSec: startKey.timeSec };
  }

  if (Math.abs(priorTracked.timeSec - timeSec) <= toleranceSec) {
    return { polygon: priorTracked.polygon, status: 'tracked', confidence: priorTracked.confidence, segmentStartSec: startKey.timeSec };
  }
  if (!nextTracked || nextTracked === priorTracked) {
    return { polygon: null, status: 'no-data', confidence: null, segmentStartSec: startKey.timeSec };
  }
  const span = nextTracked.timeSec - priorTracked.timeSec;
  if (span <= 0 || span > 0.2) return { polygon: null, status: 'no-data', confidence: null, segmentStartSec: startKey.timeSec };
  const t = (timeSec - priorTracked.timeSec) / span;
  return {
    polygon: interpolatePolygons(priorTracked.polygon, nextTracked.polygon, t),
    status: 'interpolated',
    confidence: Math.min(priorTracked.confidence, nextTracked.confidence),
    segmentStartSec: startKey.timeSec
  };
}

export function coverageSummary(tracked: TrackedPolygon[], durationSec: number): { meanConfidence: number; lowConfidenceCount: number; trackedCount: number } {
  if (tracked.length === 0 || durationSec <= 0) return { meanConfidence: 0, lowConfidenceCount: 0, trackedCount: 0 };
  const meanConfidence = tracked.reduce((sum, item) => sum + item.confidence, 0) / tracked.length;
  return {
    meanConfidence,
    lowConfidenceCount: tracked.filter((item) => item.confidence < 0.7).length,
    trackedCount: tracked.length
  };
}

export function assertExportPlayable(exportData: MaskExport): string[] {
  const errors: string[] = [];
  if (exportData.schema !== 'browser-mask-tracker/mask-project-v1') errors.push('导出版本不匹配');
  if (exportData.keyframes.length === 0) errors.push('没有人工关键帧');
  for (const key of exportData.keyframes) {
    if (key.polygon.length < 3 || polygonArea(key.polygon) === 0) errors.push(`时间 ${key.timeSec} 的关键帧不是有效多边形`);
  }
  if (exportData.source.durationSec <= 0) errors.push('源视频时长无效');
  return errors;
}
