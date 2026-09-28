'use client';
import { useEffect, useRef } from 'react';
import type { Kinflow } from './use-kinflow';
import { api } from '@/lib/offline';
import { currentSubscription } from '@/lib/push-client';
import type { Family } from '@/lib/model';

export function usePush(app: Kinflow) {
  const current = useRef({ app });
  current.current = { app };
  useEffect(() => {
    if (!app.user || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    let subscriptionId: string | null = null;
    let polling = false;
    const tabId = crypto.randomUUID();
    const poll = async () => {
      if (cancelled || polling || !navigator.onLine) return;
      polling = true;
      try {
        if (!subscriptionId) {
          const subscription = await currentSubscription();
          if (!subscription || cancelled) return;
          subscriptionId = (
            await api<{ id: string | null }>('push/status', 'POST', {
              endpoint: subscription.endpoint,
            })
          ).id;
        }
        if (!subscriptionId || cancelled) return;
        const visible = document.visibilityState === 'visible';
        const result = await api<{ families: Family[] }>('push/presence', 'POST', {
          subscriptionId,
          tabId,
          visible,
        });
        if (cancelled || !visible) return;
        const active = current.current.app;
        const family = result.families.find((f) => f.id === active.activeId);
        if (
          family &&
          active.snapshot?.family.id === family.id &&
          family.version > active.snapshot.cursor
        )
          void active.sync();
        if (!family && active.activeId) void active.reload();
      } catch {
        /* Ordinary synchronization owns offline and session-expiry UI. */
      } finally {
        if (cancelled || document.visibilityState !== 'visible') hide();
        polling = false;
      }
    };
    const changed = () => {
      subscriptionId = null;
      void poll();
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') void poll();
      else hide();
    };
    const message = (event: MessageEvent) => {
      if (
        event.data?.type === 'PUSH_REFRESH' &&
        event.data.familyId === current.current.app.activeId
      )
        void current.current.app.sync();
    };
    const hide = () => {
      if (subscriptionId)
        void fetch('/api/push/presence', {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscriptionId, tabId, visible: false }),
        }).catch(() => {});
    };
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, 5000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('online', visibility);
    window.addEventListener('kinflow-push-device', changed);
    navigator.serviceWorker.addEventListener('message', message);
    return () => {
      cancelled = true;
      clearInterval(timer);
      hide();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('online', visibility);
      window.removeEventListener('kinflow-push-device', changed);
      navigator.serviceWorker.removeEventListener('message', message);
    };
  }, [app.user?.id]);
}
