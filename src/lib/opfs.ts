const ROOT_DIR = 'mask-tracker-media';

async function root(): Promise<FileSystemDirectoryHandle> {
  const directory = await navigator.storage.getDirectory();
  return directory.getDirectoryHandle(ROOT_DIR, { create: true });
}

export async function writeMedia(mediaId: string, data: ArrayBuffer | Uint8Array): Promise<void> {
  const directory = await root();
  const fileHandle = await directory.getFileHandle(mediaId, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
      copy.set(data);
      await writable.write(copy.buffer);
    } else {
      await writable.write(data);
    }
  } finally {
    await writable.close();
  }
}

export async function readMedia(mediaId: string): Promise<ArrayBuffer> {
  const directory = await root();
  const fileHandle = await directory.getFileHandle(mediaId);
  const file = await fileHandle.getFile();
  return file.arrayBuffer();
}

export async function deleteMedia(mediaId: string): Promise<void> {
  const directory = await root();
  await directory.removeEntry(mediaId, { recursive: false });
}

export async function estimateStorage(): Promise<{ quota: number; usage: number }> {
  const estimate = await navigator.storage.estimate();
  return { quota: estimate.quota ?? 0, usage: estimate.usage ?? 0 };
}
