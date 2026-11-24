import type { ProjectState } from '../types';

const DB_NAME = 'harness-projection-studio';
const DB_VERSION = 1;

const STORES = ['meta', 'board', 'fixtures', 'wires', 'projectors', 'steps', 'tiePoints'] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function getAll<T>(db: IDBDatabase, store: StoreName): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

async function replaceStore(db: IDBDatabase, store: StoreName, values: any[]): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  os.clear();
  for (const value of values) os.put(value);
  await txDone(tx);
}

export async function loadProject(): Promise<ProjectState | null> {
  const db = await openDb();
  const [metaRows, boardRows, fixtures, wires, projectors, steps, tiePoints] = await Promise.all([
    getAll<any>(db, 'meta'),
    getAll<any>(db, 'board'),
    getAll<any>(db, 'fixtures'),
    getAll<any>(db, 'wires'),
    getAll<any>(db, 'projectors'),
    getAll<any>(db, 'steps'),
    getAll<any>(db, 'tiePoints')
  ]);
  if (!boardRows.length || !wires.length) return null;
  const projectMeta = metaRows.find((r) => r.id === 'project') ?? {};
  const settings = metaRows.find((r) => r.id === 'settings')?.value;
  return {
    schema: 1,
    id: 'current',
    name: projectMeta.name ?? '仪表板线束投影指引项目',
    updatedAt: projectMeta.updatedAt ?? Date.now(),
    board: boardRows[0],
    fixtures,
    wires,
    projectors,
    steps,
    tiePoints,
    settings: settings ?? undefined
  } as ProjectState;
}

export async function saveProject(state: ProjectState): Promise<void> {
  const db = await openDb();
  const settings = state.settings;
  await Promise.all([
    replaceStore(db, 'meta', [
      { id: 'project', name: state.name, updatedAt: state.updatedAt },
      { id: 'settings', value: settings }
    ]),
    replaceStore(db, 'board', [state.board]),
    replaceStore(db, 'fixtures', state.fixtures),
    replaceStore(db, 'wires', state.wires),
    replaceStore(db, 'projectors', state.projectors),
    replaceStore(db, 'steps', state.steps),
    replaceStore(db, 'tiePoints', state.tiePoints)
  ]);
}

export async function clearAndSave(state: ProjectState): Promise<void> {
  await saveProject(state);
}

export function storageInfo(): { name: string; stores: readonly string[] } {
  return { name: DB_NAME, stores: STORES };
}
