import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
test('desktop, entry, editing, offline sync, mobile and dark theme', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const production = test.info().project.use.baseURL?.includes('3100');
  if (production) {
    const { token } = JSON.parse(await readFile('.local/e2e-session.json', 'utf8'));
    await context.addCookies([
      {
        name: 'kinflow_session',
        value: token,
        url: 'http://127.0.0.1:3100',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }
  await page.goto('/');
  if (!production) await page.getByRole('button', { name: 'Explore with sample data' }).click();
  await expect(page.getByRole('heading', { name: 'A little clarity, every day.' })).toBeVisible();
  await expect(page.getByText('Available now', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date', {
    timeout: 30000,
  });
  await page.screenshot({ path: 'test-results/kinflow-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('23.45');
  await page.getByLabel('Note (optional)').fill('Browser test expense');
  const formAccessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect
    .soft(
      formAccessibility.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
    )
    .toEqual([]);
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByText('Browser test expense', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date');
  await page.getByText('Browser test expense', { exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('20.00');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date');
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'Activity', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Search transactions' }).fill('Browser test expense');
  await expect(page.locator('.transaction-row')).toHaveCount(1);
  await expect(page.locator('.transaction-row')).toContainText('20.00 GEL');
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'Home', exact: true })
    .click();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      registration.active!.postMessage(
        { type: 'CACHE_ASSETS', urls: performance.getEntriesByType('resource').map((e) => e.name) },
        [channel.port2],
      );
    });
  });
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();
  await page
    .getByLabel('From account')
    .selectOption({ label: 'My personal card · USD · Only you' });
  await page.getByLabel('To account').selectOption({ label: 'Everyday card · GEL · Shared' });
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('-');
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('100');
  await page.getByLabel(/^Amount received/).fill('258.50');
  await page.getByLabel('Note (optional)').fill('Browser test exchange');
  await expect(page.getByText('Only you can see the details.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date');
  await page.getByRole('button', { name: 'Shared + mine', exact: true }).click();
  await page.getByText('Browser test exchange', { exact: true }).click();
  await expect(page.getByText('258.50 GEL', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Shared', exact: true }).click();
  await context.setOffline(true);
  await expect(page.getByText('You’re offline.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption({ label: 'Everyday card · GEL · Shared' });
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('17.25');
  await page.getByLabel('Note (optional)').fill('Offline expense');
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page.getByText('Offline expense', { exact: false }).first()).toBeVisible();
  await page.getByText('Offline expense', { exact: false }).first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('15.50');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  if (production) {
    await page.reload();
    await expect(page.getByText('Offline expense', { exact: false }).first()).toBeVisible();
  }
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date', {
    timeout: 30000,
  });
  await expect(
    page.locator('.transaction-row').filter({ hasText: 'Offline expense' }),
  ).toContainText('15.50 GEL');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['Home', 'Activity', 'Accounts', 'Insights', 'More']) {
      await page
        .getByRole('navigation', { name: 'Mobile navigation', exact: true })
        .getByRole('button', { name, exact: true })
        .click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} overflows at ${width}`,
      ).toBe(true);
      if (width === 390) {
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        expect
          .soft(
            results.violations.map((v) => ({
              page: name,
              id: v.id,
              nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
            })),
          )
          .toEqual([]);
      }
    }
    await page
      .getByRole('navigation', { name: 'Mobile navigation', exact: true })
      .getByRole('button', { name: 'Home', exact: true })
      .click();
    await page.screenshot({ path: `test-results/kinflow-mobile-${width}.png`, fullPage: true });
  }
  await page
    .getByRole('navigation', { name: 'Mobile navigation', exact: true })
    .getByRole('button', { name: 'More', exact: true })
    .click();
  await page.getByRole('button', { name: 'Your preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page
    .getByRole('navigation', { name: 'Mobile navigation', exact: true })
    .getByRole('button', { name: 'Home', exact: true })
    .click();
  await page.screenshot({ path: 'test-results/kinflow-dark.png', fullPage: true });
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect
    .soft(
      accessibility.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
    )
    .toEqual([]);
  expect(errors).toEqual([]);
  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await expect(
    otherTab.getByRole('heading', { name: 'A little clarity, every day.' }),
  ).toBeVisible();
  const loadingTab = await context.newPage();
  let releaseSession!: () => void;
  let sessionReceived!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const received = new Promise<void>((resolve) => {
    sessionReceived = resolve;
  });
  await loadingTab.route('**/api/me', async (route) => {
    const response = await route.fetch();
    sessionReceived();
    await release;
    await route.fulfill({ response });
  });
  await loadingTab.goto('/');
  await received;
  await page
    .getByRole('navigation', { name: 'Mobile navigation', exact: true })
    .getByRole('button', { name: 'More', exact: true })
    .click();
  await page.getByRole('button', { name: 'Your preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  releaseSession();
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(otherTab.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(loadingTab.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  const counts = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('kinflow-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return Promise.all(
      ['snapshots', 'pending', 'session'].map(
        (name) =>
          new Promise<number>((resolve) => {
            const request = db.transaction(name).objectStore(name).count();
            request.onsuccess = () => resolve(request.result);
          }),
      ),
    );
  });
  expect(counts).toEqual([0, 0, 0]);
});
