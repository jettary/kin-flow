import { openDB, type DBSchema } from 'idb';
import type { Pending, Snapshot, User, Family } from './model';
interface CacheSchema extends DBSchema {
  snapshots: { key: string; value: Snapshot };
  pending: { key: string; value: Pending };
  session: { key: string; value: { user: User; families: Family[]; demo: boolean } };
}
const db = () =>
  openDB<CacheSchema>('kinflow-v1', 1, {
    upgrade(db) {
      db.createObjectStore('snapshots');
      db.createObjectStore('pending', { keyPath: 'id' });
      db.createObjectStore('session');
    },
  });
export const cacheEpoch = () => localStorage.getItem('kinflow-cache-reset');
export async function saveSnapshot(userId: string, s: Snapshot, epoch = cacheEpoch()) {
  const connection = await db();
  if (epoch !== cacheEpoch()) return false;
  await connection.put('snapshots', s, userId + ':' + s.family.id);
  return true;
}
export async function loadSnapshot(userId: string, familyId: string) {
  return (await db()).get('snapshots', userId + ':' + familyId);
}
export async function queue(p: Pending, epoch = cacheEpoch()) {
  const connection = await db();
  if (epoch !== cacheEpoch()) return;
  const tx = connection.transaction('pending', 'readwrite');
  const existing = await tx.store.get(p.id);
  const items = await tx.store.getAll();
  const queuedAt =
    existing?.queuedAt ??
    p.queuedAt ??
    Math.max(Date.now(), ...items.map((item) => (item.queuedAt || 0) + 1));
  if (epoch === cacheEpoch()) await tx.store.put({ ...p, queuedAt });
  await tx.done;
}
export async function pending(userId: string, familyId: string) {
  return (await (await db()).getAll('pending'))
    .filter((p) => p.userId === userId && p.familyId === familyId)
    .sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
}
export async function dequeue(id: string) {
  return (await db()).delete('pending', id);
}
export async function cacheSession(
  session: { user: User; families: Family[]; demo: boolean },
  epoch = cacheEpoch(),
) {
  const connection = await db();
  if (epoch !== cacheEpoch()) return false;
  await connection.put('session', session, 'current');
  return true;
}
export async function cachedSession() {
  return (await db()).get('session', 'current');
}
export async function clearFamily(userId: string, familyId: string) {
  const d = await db();
  await d.delete('snapshots', userId + ':' + familyId);
  for (const p of await pending(userId, familyId)) await d.delete('pending', p.id);
}
export async function clearCache() {
  // Other open tabs must stop in-flight syncs before this transaction clears the cache.
  localStorage.setItem('kinflow-cache-reset', crypto.randomUUID());
  const d = await db();
  const tx = d.transaction(['snapshots', 'pending', 'session'], 'readwrite');
  await Promise.all(Array.from(tx.objectStoreNames).map((n) => tx.objectStore(n).clear()));
  await tx.done;
}
export async function pendingCount() {
  return (await (await db()).getAll('pending')).length;
}
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(
  url: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch('/api/' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new APIError(response.status, result.error || 'Request failed.');
  return result;
}
