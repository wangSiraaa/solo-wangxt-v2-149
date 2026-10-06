import type { DemuxedSample } from './mp4Demuxer';

export function avcSampleToAnnexB(sample: Uint8Array, lengthSize = 4): Uint8Array {
  const output: number[] = [];
  let offset = 0;
  while (offset + lengthSize <= sample.length) {
    let naluLength = 0;
    for (let i = 0; i < lengthSize; i += 1) {
      naluLength = (naluLength << 8) | sample[offset + i];
    }
    offset += lengthSize;
    if (offset + naluLength > sample.length) {
      throw new Error('H.264 样本长度字段与数据不一致');
    }
    output.push(0, 0, 0, 1);
    for (let i = 0; i < naluLength; i += 1) output.push(sample[offset + i]);
    offset += naluLength;
  }
  return new Uint8Array(output);
}

export class TimedVideoDecoder {
  private readonly decoder: VideoDecoder;
  private readonly queue: DemuxedSample[];
  private readonly frames: VideoFrame[] = [];
  private rejectDecode: ((error: Error) => void) | null = null;
  private decodeSettled = false;

  constructor(samples: DemuxedSample[], description: Uint8Array, codec: string, codedWidth: number, codedHeight: number) {
    this.queue = [...samples].sort((a, b) => a.dtsSec - b.dtsSec);
    this.decoder = new VideoDecoder({
      output: (frame) => this.frames.push(frame),
      error: (error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!this.decodeSettled && this.rejectDecode) {
          this.decodeSettled = true;
          this.rejectDecode(normalized);
          this.rejectDecode = null;
        }
      }
    });
    this.decoder.configure({
      codec,
      codedWidth,
      codedHeight,
      description,
      optimizeForLatency: true
    });
  }

  private enqueueAll(): void {
    for (const sample of this.queue) {
      if (this.decoder.state !== 'configured') throw new Error('解码器未处于 configured 状态');
      const chunk = new EncodedVideoChunk({
        type: sample.isKeyframe ? 'key' : 'delta',
        timestamp: Math.round(sample.ptsSec * 1_000_000),
        duration: Math.max(1, Math.round(sample.durationSec * 1_000_000)),
        data: avcSampleToAnnexB(sample.data, sample.naluLengthSize)
      });
      this.decoder.decode(chunk);
    }
  }

  async decodeAll(): Promise<VideoFrame[]> {
    this.enqueueAll();
    await new Promise<void>((resolve, reject) => {
      this.rejectDecode = (error) => reject(error);
      this.decoder.flush().then(() => {
        if (!this.decodeSettled) {
          this.decodeSettled = true;
          resolve();
        }
      }, (error) => {
        if (!this.decodeSettled) {
          this.decodeSettled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    const sorted = this.frames.sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length !== this.queue.length) {
      throw new Error(`解码帧数不一致：${sorted.length}/${this.queue.length}`);
    }
    return sorted;
  }

  close(): void {
    for (const frame of this.frames) frame.close();
    if (this.decoder.state !== 'closed') this.decoder.close();
  }
}
