import type { Project } from '../types';

const DB_NAME = 'mask-tracker-projects';
const DB_VERSION = 1;
const STORE = 'projects';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
  });
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(STORE, 'readwrite');
    await requestToPromise(transaction.objectStore(STORE).put({ ...project, updatedAt: new Date().toISOString() }));
  } finally {
    db.close();
  }
}

export async function loadProject(id: string): Promise<Project | null> {
  const db = await openDb();
  try {
    return requestToPromise<Project | undefined>(db.transaction(STORE).objectStore(STORE).get(id)).then(
      (project) => project ?? null
    );
  } finally {
    db.close();
  }
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDb();
  try {
    return requestToPromise<Project[]>(db.transaction(STORE).objectStore(STORE).getAll());
  } finally {
    db.close();
  }
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}
