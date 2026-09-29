import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';

test('notification opt-in, family preferences, device lifecycle and shared-history link', async ({
  page,
  context,
}) => {
  test.skip(
    !test.info().project.use.baseURL?.includes('3100'),
    'Uses isolated production sessions and VAPID keys.',
  );
  const { pushToken: token } = JSON.parse(await readFile('.local/e2e-session.json', 'utf8'));
  await context.addCookies([
    {
      name: 'kinflow_session',
      value: token,
      url: 'http://127.0.0.1:3100',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  // Exercise the real API and service worker registration with a deterministic native
  // PushManager substitute. No real provider subscription or permission prompt in CI.
  await context.addInitScript(() => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/e2e-device';
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    const subscription = {
      endpoint,
      options: {},
      toJSON: () => ({
        endpoint,
        keys: {
          p256dh: encode(new Uint8Array([4, ...Array(64).fill(1)])),
          auth: encode(new Uint8Array(16).fill(1)),
        },
      }),
      unsubscribe: async () => {
        localStorage.removeItem('test-push-subscribed');
        return true;
      },
    };
    Object.defineProperty(Notification, 'permission', {
      get: () => localStorage.getItem('test-permission') || 'default',
    });
    Notification.requestPermission = async () => {
      localStorage.setItem(
        'test-permission-calls',
        String(Number(localStorage.getItem('test-permission-calls') || 0) + 1),
      );
      localStorage.setItem('test-permission', 'granted');
      return 'granted';
    };
    PushManager.prototype.getSubscription = async () =>
      localStorage.getItem('test-push-subscribed')
        ? (subscription as unknown as PushSubscription)
        : null;
    PushManager.prototype.subscribe = async () => {
      localStorage.setItem('test-push-subscribed', 'yes');
      return subscription as unknown as PushSubscription;
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little clarity, every day.' })).toBeVisible();
  const openSettings = async () => {
    await page
      .getByRole('navigation', { name: 'Main navigation', exact: true })
      .getByRole('button', { name: 'More', exact: true })
      .click();
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enable notifications', exact: true }),
    ).toBeVisible();
  };
  await openSettings();
  expect(await page.evaluate(() => localStorage.getItem('test-permission-calls'))).toBeNull();
  await expect(page.getByLabel('New shared purchases', { exact: true })).toBeChecked();
  for (const label of [
    'Purchase edits, deletions & refunds',
    'Transfers & currency exchanges',
    'Income deposits',
  ])
    await expect(page.getByLabel(label, { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable on this device' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('test-permission-calls'))).toBe('1');
  await page.getByLabel('Transfers & currency exchanges', { exact: true }).check();
  await expect(page.getByLabel('Transfers & currency exchanges', { exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/kinflow-notifications-desktop.png', fullPage: true });
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    accessibility.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
    })),
  ).toEqual([]);
  const me = await (await context.request.get('/api/me')).json();
  const familyId = me.families[0].id;
  const settings = await (
    await context.request.get(`/api/families/${familyId}/notifications`)
  ).json();
  expect(settings.preferences.transfer).toBe(true);
  expect((await context.request.get('/api/cron/push')).status()).toBe(401);
  const origin = { Origin: 'http://127.0.0.1:3100' };
  const status = await (
    await context.request.post('/api/push/status', {
      headers: origin,
      data: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device' },
    })
  ).json();
  expect(status.id).toBeTruthy();
  await expect
    .poll(async () => {
      const response = await context.request.post('/api/push/presence', {
        headers: origin,
        data: { subscriptionId: status.id, tabId: crypto.randomUUID(), visible: false },
      });
      return response.status();
    })
    .toBe(200);
  await page.getByRole('button', { name: 'Disable on this device' }).click();
  await expect(
    page.getByRole('button', { name: 'Enable notifications', exact: true }),
  ).toBeVisible();
  const disabled = await (
    await context.request.post('/api/push/status', {
      headers: origin,
      data: { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device' },
    })
  ).json();
  expect(disabled.id).toBeNull();
  await expect(page.getByLabel('Transfers & currency exchanges', { exact: true })).toBeChecked();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.screenshot({ path: 'test-results/kinflow-notifications-mobile.png', fullPage: true });
  await page.goto(`/?view=shared-history&family=${familyId}`);
  await expect(page.getByRole('textbox', { name: 'Search transactions' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Shared', exact: true })).toHaveClass(/active/);
  await expect(page).toHaveURL('http://127.0.0.1:3100/');
});
