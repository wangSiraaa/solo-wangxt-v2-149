import { parseMp4 } from './mp4Demuxer';
import { TimedVideoDecoder } from './videoDecoder';
import { frameToDisplayCanvas } from './renderFrame';
import { readMedia, writeMedia } from './opfs';
import type { MediaMetadata, Orientation } from '../types';
import { uid } from './geometry';

export type LoadedMedia = {
  metadata: MediaMetadata;
  frames: Array<{
    timeSec: number;
    durationSec: number;
    canvas: HTMLCanvasElement;
  }>;
};

export type GeometryOverride = {
  rotationDegrees?: Orientation;
  pixelAspectWidth?: number;
  pixelAspectHeight?: number;
};

export async function importVideoFile(file: File, override: GeometryOverride = {}): Promise<LoadedMedia> {
  const buffer = await file.arrayBuffer();
  const mediaId = uid('media');
  await writeMedia(mediaId, buffer);
  return decodeMedia(mediaId, file.name, file.size, file.type || 'video/mp4', buffer, undefined, override);
}

export async function loadMediaFromOpfs(metadata: MediaMetadata): Promise<LoadedMedia> {
  const buffer = await readMedia(metadata.mediaId);
  return decodeMedia(
    metadata.mediaId,
    metadata.originalName,
    metadata.sizeBytes,
    metadata.mimeType,
    buffer,
    metadata,
    {
      rotationDegrees: metadata.rotationDegrees,
      pixelAspectWidth: metadata.pixelAspectWidth,
      pixelAspectHeight: metadata.pixelAspectHeight
    }
  );
}

async function decodeMedia(
  mediaId: string,
  originalName: string,
  sizeBytes: number,
  mimeType: string,
  buffer: ArrayBuffer,
  existingMetadata?: MediaMetadata,
  override: GeometryOverride = {}
): Promise<LoadedMedia> {
  const parsed = parseMp4(buffer);
  const shouldApplyOverride = override.rotationDegrees !== undefined
    || override.pixelAspectWidth !== undefined
    || override.pixelAspectHeight !== undefined;
  const geometry = {
    ...parsed.media,
    rotationDegrees: shouldApplyOverride ? (override.rotationDegrees ?? parsed.media.rotationDegrees) : parsed.media.rotationDegrees,
    pixelAspectWidth: shouldApplyOverride ? (override.pixelAspectWidth ?? parsed.media.pixelAspectWidth) : parsed.media.pixelAspectWidth,
    pixelAspectHeight: shouldApplyOverride ? (override.pixelAspectHeight ?? parsed.media.pixelAspectHeight) : parsed.media.pixelAspectHeight
  };
  const decoder = new TimedVideoDecoder(
    parsed.samples,
    parsed.description,
    parsed.media.codec,
    parsed.media.codedWidth,
    parsed.media.codedHeight
  );

  try {
    const decodedFrames = await decoder.decodeAll();
    const frames = decodedFrames.map((frame, index) => {
      const sample = parsed.samples[index];
      // Prefer the decoded container timestamp even if a frame is delayed/reordered.
      const timeSec = frame.timestamp / 1_000_000;
      const canvas = frameToDisplayCanvas(frame, geometry);
      return {
        timeSec,
        durationSec: sample?.durationSec ?? parsed.media.durationSec / Math.max(1, parsed.media.frameCount),
        canvas
      };
    });

    for (const frame of decodedFrames) frame.close();

    const metadata: MediaMetadata = {
      ...geometry,
      ...(existingMetadata
        ? {
            mediaId: existingMetadata.mediaId,
            originalName: existingMetadata.originalName,
            sizeBytes: existingMetadata.sizeBytes,
            mimeType: existingMetadata.mimeType,
            createdAt: existingMetadata.createdAt
          }
        : {
            mediaId,
            originalName,
            sizeBytes,
            mimeType,
            createdAt: new Date().toISOString()
          })
    };

    return { metadata, frames };
  } finally {
    decoder.close();
  }
}
