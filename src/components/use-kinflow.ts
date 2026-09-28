'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entity, Family, Mutation, Pending, Snapshot, Transaction, User } from '@/lib/model';
import { D, convert } from '@/lib/money';
import * as local from '@/lib/offline';
function applyPending(snapshot: Snapshot, queue: Pending[]): Snapshot {
  const entities = structuredClone(snapshot.entities),
    transactions = structuredClone(snapshot.transactions);
  const effect = (t: Transaction, sign: number) => {
    const a = entities.find((e) => e.id === t.accountId),
      b = entities.find((e) => e.id === t.toAccountId);
    if (a)
      a.balance = D(a.balance || '0')
        .plus(
          D(t.accountAmount || '0').mul(['expense', 'transfer'].includes(t.type) ? -sign : sign),
        )
        .toFixed();
    if (b)
      b.balance = D(b.balance || '0')
        .plus(D(t.toAmount || '0').mul(sign))
        .toFixed();
  };
  for (const p of queue) {
    const input = p.input as unknown as Transaction,
      id = input.id || p.id,
      index = transactions.findIndex((t) => t.id === id),
      old = transactions[index];
    if (old && !old.deleted) effect(old, -1);
    if (p.command === 'transaction.delete') {
      if (old) transactions[index] = { ...old, deleted: true, pending: true };
      continue;
    }
    if (p.command !== 'transaction.save') continue;
    const original = transactions.find((t) => t.id === input.originalId);
    const a = entities.find(
        (e) => e.id === (input.type === 'refund' ? original?.accountId : input.accountId),
      ),
      b = entities.find((e) => e.id === input.toAccountId),
      c = entities.find((e) => e.id === input.categoryId);
    if (!a) continue;
    const currency = input.type === 'refund' ? a.currency! : input.currency!;
    const amount = input.amount!,
      accountAmount = currency === a.currency ? amount : input.accountAmount!;
    const tx: Transaction = {
      ...input,
      id,
      familyId: snapshot.family.id,
      ownerId: a.ownerId || b?.ownerId || null,
      authorId: old?.authorId || p.userId,
      authorName: old?.authorName || 'You',
      accountId: a.id,
      categoryId: original?.categoryId || input.categoryId,
      currency,
      amount,
      accountAmount,
      accountCurrency: a.currency,
      baseCurrency: snapshot.family.currency,
      toAmount: b ? (b.currency === a.currency ? accountAmount : input.toAmount) : undefined,
      baseAmount:
        convert(
          accountAmount,
          a.currency!,
          snapshot.family.currency,
          old?.rates || snapshot.rates,
        ) ||
        input.baseAmount ||
        '0',
      rates: old?.rates || snapshot.rates || undefined,
      deleted: false,
      version: old?.version || 0,
      pending: true,
      notice:
        (input.type === 'income' && !!a.ownerId && !c?.ownerId) ||
        (input.type === 'transfer' && a.ownerId !== b?.ownerId),
    };
    effect(tx, 1);
    if (index >= 0) transactions[index] = tx;
    else transactions.push(tx);
  }
  return { ...snapshot, entities, transactions };
}
export function useKinflow() {
  const [user, setUser] = useState<User | null>(null),
    [families, setFamilies] = useState<Family[]>([]),
    [activeId, setActiveId] = useState(''),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [queue, setQueue] = useState<Pending[]>([]),
    [loading, setLoading] = useState(true),
    [online, setOnline] = useState(true),
    [syncing, setSyncing] = useState(false),
    [error, setError] = useState(''),
    [expired, setExpired] = useState(false),
    [demo, setDemo] = useState(false);
  const refs = useRef({ user, activeId, snapshot });
  refs.current = { user, activeId, snapshot };
  const running = useRef(false);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current += 1;
    refs.current = { user: null, activeId: '', snapshot: null };
    setUser(null);
    setFamilies([]);
    setSnapshot(null);
    setQueue([]);
    setActiveId('');
  }, []);
  const reload = useCallback(async () => {
    let epoch = generation.current;
    let cacheEpoch = local.cacheEpoch();
    const current = () => epoch === generation.current && cacheEpoch === local.cacheEpoch();
    try {
      if (localStorage.getItem('kinflow-logout-pending')) {
        if (!navigator.onLine) {
          invalidate();
          return;
        }
        try {
          await local.api('auth/logout', 'POST', {});
        } catch (error) {
          if (!(error instanceof local.APIError && error.status === 401)) throw error;
        }
        localStorage.removeItem('kinflow-logout-pending');
      }
      const session = await local.api<{ user: User; families: Family[]; demo: boolean }>('me');
      const previous = await local.cachedSession();
      if (!current()) return;
      if (previous && previous.user.id !== session.user.id) {
        generation.current += 1;
        epoch = generation.current;
        const cleared = local.clearCache();
        cacheEpoch = local.cacheEpoch();
        await cleared;
        if (!current()) return;
      }
      for (const family of previous?.families || []) {
        if (!session.families.some((current) => current.id === family.id)) {
          await local.clearFamily(previous!.user.id, family.id);
        }
      }
      if (!current() || !(await local.cacheSession(session, cacheEpoch)) || !current()) return;
      setUser(session.user);
      setFamilies(session.families);
      setDemo(session.demo);
      setExpired(false);
      setActiveId((current) =>
        session.families.some((f) => f.id === current)
          ? current
          : session.families.find((f) => f.id === localStorage.getItem('kinflow-family'))?.id ||
            session.families[0]?.id ||
            '',
      );
    } catch (e) {
      if (!current()) return;
      if (e instanceof local.APIError && e.status === 401) {
        invalidate();
      } else {
        const cached = await local.cachedSession();
        if (!current()) return;
        if (cached) {
          setUser(cached.user);
          setFamilies(cached.families);
          setDemo(cached.demo);
          setActiveId(
            cached.families.find((f) => f.id === localStorage.getItem('kinflow-family'))?.id ||
              cached.families[0]?.id ||
              '',
          );
        } else setError('Connect to the internet to sign in for the first time.');
      }
    } finally {
      setLoading(false);
    }
  }, [invalidate]);
  useEffect(() => {
    const reset = (event: StorageEvent) => {
      if (event.key === 'kinflow-cache-reset') invalidate();
    };
    window.addEventListener('storage', reset);
    return () => window.removeEventListener('storage', reset);
  }, [invalidate]);
  useEffect(() => {
    void reload();
    setOnline(navigator.onLine);
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker
        .register('/sw.js')
        .then(async () => {
          const registration = await navigator.serviceWorker.ready;
          const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
          registration.active?.postMessage({ type: 'CACHE_ASSETS', urls });
        })
        .catch(() => {});
  }, [reload]);
  const sync = useCallback(async () => {
    const { user, activeId, snapshot } = refs.current;
    if (!user || !activeId || !navigator.onLine) return;
    if (running.current) {
      setTimeout(() => void sync(), 300);
      return;
    }
    running.current = true;
    setSyncing(true);
    const epoch = generation.current;
    const cacheEpoch = local.cacheEpoch();
    const current = () => epoch === generation.current && cacheEpoch === local.cacheEpoch();
    try {
      const pending = await local.pending(user.id, activeId);
      for (const p of pending) {
        if (!current()) return;
        try {
          await local.api(`families/${activeId}/mutate`, 'POST', p);
          await local.dequeue(p.id);
        } catch (e) {
          if (!current()) return;
          if (e instanceof local.APIError && e.status === 401) throw e;
          if (e instanceof local.APIError && e.status === 403) {
            const session = await local.api<{ families: Family[] }>('me');
            if (!session.families.some((family) => family.id === activeId)) throw e;
          }
          if (e instanceof local.APIError) {
            await local.queue({ ...p, error: e.message }, cacheEpoch);
          }
          break;
        }
      }
      const base =
        snapshot?.family.id === activeId ? snapshot : await local.loadSnapshot(user.id, activeId);
      let page = '',
        until: number | undefined;
      let next: Snapshot | undefined;
      const rows = new Map((base?.transactions || []).map((t) => [t.id, t]));
      do {
        const result = await local.api<Snapshot & { next: string | null }>(
          `families/${activeId}/sync?after=${base?.cursor || 0}${until !== undefined ? '&until=' + until : ''}${page ? '&page=' + encodeURIComponent(page) : ''}`,
        );
        next ??= result;
        until = result.cursor;
        for (const t of result.transactions) rows.set(t.id, t);
        page = result.next || '';
      } while (page);
      if (next) {
        if (!current()) return;
        const data = { ...next, transactions: [...rows.values()] };
        if (!(await local.saveSnapshot(user.id, data, cacheEpoch)) || !current()) return;
        if (refs.current.activeId === activeId) {
          setSnapshot(data);
          setQueue(await local.pending(user.id, activeId));
          setError('');
          setExpired(false);
        }
      }
    } catch (e) {
      if (!current()) return;
      if (e instanceof local.APIError && e.status === 403) {
        await local.clearFamily(user.id, activeId);
        if (refs.current.activeId === activeId) {
          setSnapshot(null);
          setQueue([]);
        }
        await reload();
        setError('Your access to this family ended. Its local data was cleared.');
      } else if (e instanceof local.APIError && e.status === 401) {
        setExpired(true);
        setError('Your session expired. Sign in again to sync the changes saved on this device.');
      } else
        setError(
          e instanceof Error
            ? e.message
            : 'Could not synchronize. Your changes are safe on this device.',
        );
    } finally {
      running.current = false;
      setSyncing(false);
    }
  }, [reload]);
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setQueue([]);
    if (!user || !activeId) return;
    localStorage.setItem('kinflow-family', activeId);
    void (async () => {
      const cached = await local.loadSnapshot(user.id, activeId);
      if (cancelled) return;
      if (cached) setSnapshot(cached);
      setQueue(await local.pending(user.id, activeId));
      await sync();
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, user?.id, sync]);
  useEffect(() => {
    const connected = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) {
        if (localStorage.getItem('kinflow-logout-pending')) void reload();
        else void sync();
      }
    };
    window.addEventListener('online', connected);
    window.addEventListener('offline', connected);
    window.addEventListener('focus', connected);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void sync();
    }, 60000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', connected);
      window.removeEventListener('focus', connected);
    };
  }, [sync, reload]);
  const save = async (command: string, input: Record<string, unknown>, baseVersion?: number) => {
    if (!user || !activeId) throw new Error('Choose a family.');
    const m: Mutation = { id: crypto.randomUUID(), command, input, baseVersion };
    if (command.startsWith('transaction.')) {
      await local.queue({ ...m, userId: user.id, familyId: activeId });
      setQueue(await local.pending(user.id, activeId));
      void sync();
      return !navigator.onLine || expired
        ? 'Saved on this device · waiting to sync'
        : 'Saved on this device · syncing';
    }
    await local.api(`families/${activeId}/mutate`, 'POST', m);
    await sync();
    return 'Saved';
  };
  const logout = async () => {
    if (
      (await local.pendingCount()) &&
      !window.confirm(
        'Signing out permanently removes unsynced changes from this device. Sign out and discard them?',
      )
    )
      return;
    localStorage.setItem('kinflow-logout-pending', '1');
    invalidate();
    await local.clearCache();
    if (navigator.onLine) {
      try {
        await local.api('auth/logout', 'POST', {});
        localStorage.removeItem('kinflow-logout-pending');
      } catch (error) {
        if (error instanceof local.APIError && error.status === 401)
          localStorage.removeItem('kinflow-logout-pending');
      }
    }
    localStorage.removeItem('kinflow-family');
    setUser(null);
    setFamilies([]);
    setSnapshot(null);
    setQueue([]);
    setActiveId('');
  };
  return {
    user,
    setUser,
    families,
    activeId,
    setActiveId,
    snapshot: snapshot ? applyPending(snapshot, queue) : null,
    queue,
    loading,
    online,
    syncing,
    error,
    setError,
    expired,
    demo,
    reload,
    sync,
    save,
    logout,
    invalidate,
    discard: async (id: string) => {
      await local.dequeue(id);
      if (user) setQueue(await local.pending(user.id, activeId));
    },
  };
}
export type Kinflow = ReturnType<typeof useKinflow>;
