import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { writeMedia } from './opfs';
import { uid } from './geometry';
import type { MediaMetadata, Orientation } from '../types';
import { loadMediaFromOpfs } from './mediaService';

export type SampleKind = 'movement' | 'motion-blur' | 'exit-frame';
export type GeneratedSample = Awaited<ReturnType<typeof generateSample>>;

const WIDTH = 480;
const HEIGHT = 270;
const FPS = 30;
const FRAME_COUNT = 96;
const DURATION = FRAME_COUNT / FPS;

const SAMPLE_INFO: Record<SampleKind, { name: string; rotation: Orientation; par: [number, number] }> = {
  movement: { name: '自制样本-清晰移动-旋转PAR.mp4', rotation: 90, par: [3, 4] },
  'motion-blur': { name: '自制样本-运动模糊.mp4', rotation: 0, par: [1, 1] },
  'exit-frame': { name: '自制样本-短暂出画.mp4', rotation: 0, par: [1, 1] }
};

function drawScene(ctx: CanvasRenderingContext2D, kind: SampleKind, frame: number): void {
  const t = frame / (FRAME_COUNT - 1);
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, '#172033');
  gradient.addColorStop(1, '#32435f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let x = 0; x < WIDTH; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y < HEIGHT; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WIDTH, y);
    ctx.stroke();
  }

  let centerX = 80 + t * 310;
  let centerY = 138 + Math.sin(t * Math.PI * 2) * 34;
  if (kind === 'exit-frame') {
    if (frame > 44 && frame < 74) centerX += (frame - 44) * 18;
    if (frame >= 74) centerX -= (frame - 74) * 18;
  }

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(Math.sin(t * Math.PI * 1.5) * 0.08);
  const signWidth = 126;
  const signHeight = 58;
  const blur = kind === 'motion-blur' ? Math.exp(-Math.pow((t - 0.54) / 0.11, 2)) * 13 : 0;
  if (blur > 0.3) {
    ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.globalAlpha = 0.82;
  }
  ctx.fillStyle = '#f2453d';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(-signWidth / 2, -signHeight / 2, signWidth, signHeight, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('标牌 A', 0, -6);
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText('LOCAL SIGN', 0, 17);
  ctx.restore();

  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`pts=${frame / FPS}s  frame=${frame}`, 10, HEIGHT - 12);
}

async function encodeSample(kind: SampleKind): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建样本绘制上下文');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: WIDTH, height: HEIGHT, rotation: 0 },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'strict'
  });

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => {
      throw error;
    }
  });
  const config: VideoEncoderConfig = {
    codec: 'avc1.42001F',
    width: WIDTH,
    height: HEIGHT,
    bitrate: 2_500_000,
    framerate: FPS,
    avc: { format: 'annexb' }
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('当前 WebCodecs 不支持生成 AVC 自制样本');
  encoder.configure(config);

  const frameDuration = 1_000_000 / FPS;
  for (let frameIndex = 0; frameIndex < FRAME_COUNT; frameIndex += 1) {
    drawScene(ctx, kind, frameIndex);
    const videoFrame = new VideoFrame(canvas, {
      timestamp: Math.round(frameIndex * frameDuration),
      duration: Math.round(frameDuration)
    });
    encoder.encode(videoFrame, { keyFrame: frameIndex % 24 === 0 });
    videoFrame.close();
    if (encoder.encodeQueueSize > 8) await encoder.flush();
  }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  return target.buffer;
}

export async function generateSample(kind: SampleKind): Promise<{
  loaded: Awaited<ReturnType<typeof loadMediaFromOpfs>>;
  metadata: MediaMetadata;
}> {
  const info = SAMPLE_INFO[kind];
  const buffer = await encodeSample(kind);
  const mediaId = uid('sample-media');
  await writeMedia(mediaId, buffer);
  const provisional: MediaMetadata = {
    mediaId,
    originalName: info.name,
    sizeBytes: buffer.byteLength,
    mimeType: 'video/mp4',
    codec: 'avc1.42001F',
    timescale: FPS,
    durationSec: DURATION,
    frameCount: FRAME_COUNT,
    createdAt: new Date().toISOString(),
    codedWidth: WIDTH,
    codedHeight: HEIGHT,
    rotationDegrees: info.rotation,
    pixelAspectWidth: info.par[0],
    pixelAspectHeight: info.par[1]
  };
  const loaded = await loadMediaFromOpfs(provisional);
  return { loaded, metadata: loaded.metadata };
}
