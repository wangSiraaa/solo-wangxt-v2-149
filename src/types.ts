export type Point = {
  x: number;
  y: number;
};

export type Polygon = Point[];

export type Orientation = 0 | 90 | 180 | 270;

export type FrameGeometry = {
  codedWidth: number;
  codedHeight: number;
  rotationDegrees: Orientation;
  pixelAspectWidth: number;
  pixelAspectHeight: number;
};

export type MediaMetadata = {
  mediaId: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  codec: string;
  timescale: number;
  durationSec: number;
  frameCount: number;
  createdAt: string;
} & FrameGeometry;

export type Keyframe = {
  id: string;
  timeSec: number;
  polygon: Polygon;
};

export type TrackedPolygon = {
  timeSec: number;
  polygon: Polygon;
  confidence: number;
  inlierCount: number;
  backwardError: number;
};

export type TrackingGap = {
  startSec: number;
  endSec: number;
  reason: string;
};

export type Project = {
  version: 1;
  id: string;
  name: string;
  mediaId: string;
  media: MediaMetadata;
  keyframes: Keyframe[];
  trackedPolygons: TrackedPolygon[];
  gaps: TrackingGap[];
  updatedAt: string;
};

export type TrackingStatus =
  | { kind: 'idle' }
  | { kind: 'running'; fromSec: number; processedSec: number; toSec: number }
  | {
      kind: 'paused';
      atSec: number;
      reason: string;
      confidence: number;
      fromSec: number;
    }
  | { kind: 'ready-to-continue'; atSec: number; reason: string }
  | { kind: 'complete'; toSec: number; gaps: TrackingGap[] };

export type TrackFrame = {
  timeSec: number;
  canvas: HTMLCanvasElement;
};
