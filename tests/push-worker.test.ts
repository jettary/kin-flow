import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync('public/sw.js', 'utf8');
const familyId = '11111111-1111-4111-8111-111111111111';
function worker(visible = false, existing = true) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const client = {
    url: 'https://kinflow.example/',
    visibilityState: visible ? 'visible' : 'hidden',
    postMessage: vi.fn(),
    focus: vi.fn(),
    navigate: vi.fn(),
  };
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
    location: { origin: 'https://kinflow.example' },
    clients: { matchAll: vi.fn().mockResolvedValue(existing ? [client] : []), openWindow: vi.fn() },
    registration: { showNotification: vi.fn() },
  };
  runInNewContext(source, { self, URL });
  const dispatch = async (type: string, event: object) => {
    let pending: Promise<unknown> | undefined;
    handlers[type]({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    await pending;
  };
  return { self, client, dispatch };
}
describe('service worker push behavior', () => {
  it('shows generic lock-screen text and ignores arbitrary title/body content', async () => {
    const w = worker();
    await w.dispatch('push', {
      data: {
        json: () => ({
          familyId,
          notificationId: 'event',
          title: 'secret account',
          body: '100 GEL',
        }),
      },
    });
    expect(w.self.registration.showNotification).toHaveBeenCalledWith('Новая транзакция', {
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'event',
      data: { familyId },
    });
    expect(w.client.postMessage).toHaveBeenCalledWith({ type: 'PUSH_REFRESH', familyId });
  });
  it('refreshes visible clients without showing a system notification', async () => {
    const w = worker(true);
    await w.dispatch('push', { data: { json: () => ({ familyId }) } });
    expect(w.client.postMessage).toHaveBeenCalled();
    expect(w.self.registration.showNotification).not.toHaveBeenCalled();
  });
  it('opens shared history in an existing or new window using a safe same-origin URL', async () => {
    for (const existing of [true, false]) {
      const w = worker(false, existing);
      const close = vi.fn();
      await w.dispatch('notificationclick', { notification: { close, data: { familyId } } });
      expect(close).toHaveBeenCalled();
      expect(existing ? w.client.navigate : w.self.clients.openWindow).toHaveBeenCalledWith(
        '/?view=shared-history&family=' + familyId,
      );
      if (existing) expect(w.client.focus).toHaveBeenCalled();
    }
  });
  it('ignores malformed data and untrusted click destinations', async () => {
    const w = worker();
    await w.dispatch('push', {
      data: {
        json: () => {
          throw new Error('invalid');
        },
      },
    });
    await w.dispatch('push', { data: { json: () => ({ familyId: 'https://evil.example' }) } });
    await w.dispatch('notificationclick', {
      notification: { close: vi.fn(), data: { familyId: '//evil.example' } },
    });
    expect(w.self.registration.showNotification).not.toHaveBeenCalled();
    expect(w.client.navigate).not.toHaveBeenCalled();
  });
});
