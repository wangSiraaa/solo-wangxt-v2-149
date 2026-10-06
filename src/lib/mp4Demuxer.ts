import { createFile } from 'mp4box';
import type { FrameGeometry, MediaMetadata, Orientation } from '../types';

type Mp4Sample = Omit<SampleLike, 'data'> & {
  data: Uint8Array<ArrayBuffer>;
};

type SampleLike = {
  dts: number;
  cts: number;
  pts?: number;
  duration: number;
  is_sync: boolean;
  description_index: number;
  data?: Uint8Array<ArrayBufferLike>;
};

type AvcParameterSet = {
  data: Uint8Array<ArrayBufferLike>;
};

export type AvcSampleEntry = {
  avcC?: {
    SPS: AvcParameterSet[];
    PPS: AvcParameterSet[];
    lengthSizeMinusOne: number;
  };
  pasp?: {
    hSpacing: number;
    vSpacing: number;
  };
};

export type DemuxedSample = {
  ptsSec: number;
  dtsSec: number;
  durationSec: number;
  isKeyframe: boolean;
  data: Uint8Array<ArrayBuffer>;
  naluLengthSize: number;
};

export type Mp4Info = {
  media: Omit<MediaMetadata, 'mediaId' | 'originalName' | 'sizeBytes' | 'mimeType' | 'createdAt'>;
  samples: DemuxedSample[];
  description: Uint8Array;
};

function orientationFromMatrix(matrix: Int32Array | number[] | undefined): Orientation {
  if (!matrix || matrix.length < 4) return 0;
  const a = matrix[0] / 65536;
  const b = matrix[1] / 65536;
  const angle = Math.round((Math.atan2(b, a) * 180) / Math.PI) % 360;
  if (angle === 90 || angle === -270) return 90;
  if (Math.abs(angle) === 180) return 180;
  if (angle === -90 || angle === 270) return 270;
  return 0;
}

function prependStartCode(parameterSet: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(4 + parameterSet.length));
  output.set([0, 0, 0, 1], 0);
  output.set(parameterSet, 4);
  return output;
}

function concatBytes(parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function toOwnedBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(input.length));
  output.set(input);
  return output;
}

export function buildAvcDescription(sampleEntry: AvcSampleEntry): Uint8Array<ArrayBuffer> {
  const avcC = sampleEntry.avcC;
  if (!avcC) throw new Error('视频轨道缺少 avcC 参数集，WebCodecs 无法初始化解码器');
  const sps = avcC.SPS.map((item) => prependStartCode(toOwnedBytes(new Uint8Array(item.data))));
  const pps = avcC.PPS.map((item) => prependStartCode(toOwnedBytes(new Uint8Array(item.data))));
  return concatBytes([...sps, ...pps]) as Uint8Array<ArrayBuffer>;
}

export function parseMp4(buffer: ArrayBuffer): Mp4Info {
  const file = createFile();
  const input = buffer.slice(0) as ArrayBuffer & { fileStart: number };
  input.fileStart = 0;

  let samples: Mp4Sample[] = [];
  let geometry: FrameGeometry | null = null;
  let timescale = 1;
  let durationSec = 0;
  let frameCount = 0;
  let codec = '';
  let description: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  let avcLengthSize = 4;
  let sampleEntries: AvcSampleEntry[] = [];
  let parseError: Error | null = null;

  file.onError = (message: string) => {
    parseError = new Error(`MP4Box 解析失败: ${message}`);
  };

  file.onReady = () => {
    const info = file.getInfo() as unknown as {
      videoTracks: Array<{
        id: number;
        codec: string;
        timescale: number;
        duration: number;
        nb_samples: number;
        track_width: number;
        track_height: number;
        matrix?: number[];
      }>;
    };
    const track = info.videoTracks[0];
    if (!track) {
      parseError = new Error('文件中没有视频轨道');
      return;
    }
    if (!track.codec.startsWith('avc1') && !track.codec.startsWith('avc3')) {
      parseError = new Error(`仅支持 MP4/H.264(AVC)，实际编码为 ${track.codec || '未知'}`);
      return;
    }

    timescale = track.timescale;
    durationSec = track.duration / track.timescale;
    frameCount = track.nb_samples;
    codec = track.codec;

    const trak = (file as unknown as { getTrackById?: (id: number) => unknown }).getTrackById?.(track.id) as
      | {
          mdia?: {
            minf?: {
              stbl?: {
                stsd?: { entries: AvcSampleEntry[] };
              };
            };
          };
        }
      | undefined;
    sampleEntries = trak?.mdia?.minf?.stbl?.stsd?.entries ?? [];
    const entry = sampleEntries[0];
    if (!entry?.avcC) {
      parseError = new Error('视频样本入口缺少 AVC 配置');
      return;
    }
    description = buildAvcDescription(entry);
    avcLengthSize = entry.avcC.lengthSizeMinusOne + 1;

    geometry = {
      codedWidth: Math.round(track.track_width),
      codedHeight: Math.round(track.track_height),
      rotationDegrees: orientationFromMatrix(track.matrix),
      pixelAspectWidth: entry.pasp?.hSpacing ?? 1,
      pixelAspectHeight: entry.pasp?.vSpacing ?? 1
    };

    file.setExtractionOptions(track.id, null as never, { nbSamples: track.nb_samples });
    file.start();
  };

  file.onSamples = (_trackId: number, _user: unknown, extracted: SampleLike[]) => {
    samples = extracted.map((sample) => ({
      ...sample,
      data: toOwnedBytes(new Uint8Array(sample.data ?? new Uint8Array(0)))
    }));
  };

  file.appendBuffer(input);
  file.flush();

  if (parseError) throw parseError;
  if (!geometry) throw new Error('未能读取 MP4 视频几何信息');
  if (samples.length === 0) throw new Error('MP4Box 没有解出视频样本');

  const demuxed: DemuxedSample[] = samples
    .map((sample) => ({
      ptsSec: (sample.pts ?? sample.cts) / timescale,
      dtsSec: sample.dts / timescale,
      durationSec: sample.duration / timescale,
      isKeyframe: sample.is_sync,
      data: sample.data,
      naluLengthSize: avcLengthSize
    }))
    .sort((a, b) => a.ptsSec - b.ptsSec);

  const parsedGeometry: FrameGeometry = geometry;
  return {
    media: {
      codec,
      timescale,
      durationSec,
      frameCount,
      ...parsedGeometry
    },
    samples: demuxed,
    description
  };
}
