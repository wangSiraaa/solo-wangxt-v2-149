export type CapabilityReport = {
  supported: boolean;
  webCodecs: boolean;
  opfs: boolean;
  indexedDb: boolean;
  wasm: boolean;
  webCodecsH264: boolean;
  messages: string[];
};

export async function detectCapabilities(): Promise<CapabilityReport> {
  const messages: string[] = [];
  const webCodecs = typeof globalThis.VideoDecoder === 'function' && 'VideoFrame' in globalThis;
  const opfs = typeof navigator.storage?.getDirectory === 'function';
  const indexedDb = typeof globalThis.indexedDB !== 'undefined';
  const wasm = typeof WebAssembly?.instantiate === 'function';

  let webCodecsH264 = false;
  if (webCodecs) {
    try {
      const probeConfigs: VideoDecoderConfig[] = [
        {
          codec: 'avc1.42001E',
          codedWidth: 320,
          codedHeight: 180,
          description: undefined
        },
        {
          codec: 'avc1.4D401F',
          codedWidth: 320,
          codedHeight: 180
        }
      ];
      const checks = await Promise.all(
        probeConfigs.map(async (config) => {
          try {
            const support = await VideoDecoder.isConfigSupported(config);
            return Boolean(support.supported);
          } catch {
            return false;
          }
        })
      );
      webCodecsH264 = checks.some(Boolean);
    } catch {
      webCodecsH264 = false;
    }
  }

  if (!webCodecs) messages.push('当前浏览器没有可用的 WebCodecs VideoDecoder，不能在本地解码 MP4/H.264。');
  if (!webCodecsH264) messages.push('WebCodecs 未报告支持本工作台限定的 MP4/H.264（AVC）配置。');
  if (!opfs) messages.push('浏览器不支持 OPFS / FileSystemAccess，无法把媒体持久保存在本地。');
  if (!indexedDb) messages.push('浏览器不支持 IndexedDB，无法保存遮罩工程。');
  if (!wasm) messages.push('浏览器不支持 WebAssembly，无法运行 OpenCV.js 光流。');

  return {
    supported: webCodecs && opfs && indexedDb && wasm && webCodecsH264,
    webCodecs,
    opfs,
    indexedDb,
    wasm,
    webCodecsH264,
    messages
  };
}
