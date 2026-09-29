import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { AiDraft, AiStatus } from '../../src/lib/ai';
import type { Snapshot } from '../../src/lib/model';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});
const ready: AiStatus = {
  available: true,
  reason: null,
  accepted: true,
  remaining: 999,
  resetsAt: '2026-10-01T00:00:00Z',
};
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const me = await (await fetch('/api/me')).json();
    return (await fetch(`/api/families/${me.families[0].id}/sync`)).json();
  });
}
function draft(s: Snapshot, extra: Partial<AiDraft> = {}): AiDraft {
  return {
    type: 'expense',
    accountId: s.entities.find((e) => e.name === 'Everyday card')!.id,
    categoryId: s.entities.find((e) => e.name === 'Groceries')!.id,
    toAccountId: '',
    amount: '12.50',
    currency: 'GEL',
    accountAmount: '',
    toAmount: '',
    baseAmount: '',
    date: '2026-09-29',
    comment: 'AI browser entry',
    ...extra,
  };
}
test.beforeEach(async ({ page, context }) => {
  if (test.info().project.use.baseURL?.includes('3100')) {
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
  if (!test.info().project.use.baseURL?.includes('3100'))
    await page.getByRole('button', { name: 'Explore with sample data' }).click();
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date', {
    timeout: 30000,
  });
});

test('first-use notice, editable batch, duplicates, exclusion, offline review and atomic save', async ({
  page,
  context,
}) => {
  const s = await snapshot(page);
  const existing = s.transactions.find((t) => t.type === 'expense' && !t.redacted)!;
  let accepted = false;
  await page.route('**/ai/status', (route) => route.fulfill({ json: { ...ready, accepted } }));
  await page.route('**/ai/accept', (route) => {
    accepted = true;
    return route.fulfill({ json: ready });
  });
  await page.route('**/ai/prepare', (route) =>
    route.fulfill({
      json: {
        status: ready,
        drafts: [
          draft(s, { amount: '' }),
          draft(s, {
            accountId: existing.accountId,
            categoryId: existing.categoryId,
            amount: existing.amount,
            currency: existing.currency,
            date: existing.date,
            comment: 'Potential duplicate',
          }),
        ],
      },
    }),
  );
  await page.getByRole('button', { name: 'Add with AI', exact: true }).click();
  await expect(
    page.getByText('Your text, audio and eligible account/category names', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'I understand — continue' }).click();
  await page.getByLabel('Describe your transactions').fill('Купил продукты, and add my coffee');
  await page.getByRole('button', { name: 'Prepare entries' }).click();
  await expect(page.getByRole('dialog', { name: 'Review AI entries' })).toBeVisible();
  const first = page.getByRole('region', { name: 'Entry 1', exact: true });
  const second = page.getByRole('region', { name: 'Entry 2', exact: true });
  await expect(second.getByText('Possible duplicate:', { exact: false })).toBeVisible();
  await first.getByLabel('Amount', { exact: true }).fill('13.25');
  await first.getByLabel('Note (optional)').fill('AI verified browser batch');
  await second.getByLabel('Include entry').uncheck();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.locator('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: 'test-results/ai-review-mobile.png', fullPage: true });
  await context.setOffline(true);
  await expect(page.getByText('Your review stays here', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save all', exact: true })).toBeDisabled();
  await expect(first.getByLabel('Amount', { exact: true })).toHaveValue('13.25');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Save all', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await snapshot(page);
  expect(after.transactions.filter((t) => t.comment === 'AI verified browser batch')).toHaveLength(
    1,
  );
  expect(after.transactions.filter((t) => t.comment === 'Potential duplicate')).toHaveLength(0);
  await page.getByRole('button', { name: 'Add with AI', exact: true }).click();
  await expect(page.getByLabel('Describe your transactions')).toBeVisible();
  await expect(page.getByLabel('Describe your transactions')).toHaveValue('');
});

test('retains an ambiguous save for idempotent retry after the server committed', async ({
  page,
}) => {
  const s = await snapshot(page);
  await page.route('**/ai/status', (route) => route.fulfill({ json: ready }));
  await page.route('**/ai/prepare', (route) =>
    route.fulfill({
      json: { status: ready, drafts: [draft(s, { comment: 'Lost response test' })] },
    }),
  );
  let attempts = 0;
  const requests: unknown[] = [];
  await page.route('**/ai/save', async (route) => {
    requests.push(route.request().postDataJSON());
    if (attempts++ === 0) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else if (attempts === 2)
      await route.fulfill({ status: 401, json: { error: 'Please sign in again.' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Add with AI', exact: true }).click();
  await page.getByLabel('Describe your transactions').fill('coffee');
  await page.getByRole('button', { name: 'Prepare entries' }).click();
  await page.getByRole('button', { name: 'Save all', exact: true }).click();
  await expect(page.getByText('The save could not be confirmed.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Amount', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save all' }).click();
  await expect(page.getByRole('link', { name: 'Sign in in another tab' })).toBeVisible();
  await expect(page.getByLabel('Amount', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save all' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requests).toHaveLength(3);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toEqual(requests[2]);
  expect(
    (await snapshot(page)).transactions.filter((t) => t.comment === 'Lost response test'),
  ).toHaveLength(1);
});

test('records a real browser audio clip, sends it with text and releases the microphone', async ({
  page,
  context,
}) => {
  const s = await snapshot(page);
  await context.grantPermissions(['microphone']);
  await page.route('**/ai/status', (route) => route.fulfill({ json: ready }));
  let input: { text: string; audio: { mimeType: string; data: string } } | undefined;
  await page.route('**/ai/prepare', (route) => {
    input = route.request().postDataJSON();
    return route.fulfill({ json: { status: ready, drafts: [draft(s)] } });
  });
  await page.getByRole('button', { name: 'Add with AI', exact: true }).click();
  await page.getByLabel('Describe your transactions').fill('Добавь только последнюю операцию');
  await page.getByRole('button', { name: 'Record voice note' }).click();
  await expect(page.getByText('1s / 60s', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByLabel('Recorded voice note')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare entries' }).click();
  await expect(page.getByRole('dialog', { name: 'Review AI entries' })).toBeVisible();
  expect(input!.text).toContain('последнюю');
  expect(input!.audio.mimeType).toBe('audio/wav');
  const wav = Buffer.from(input!.audio.data, 'base64');
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.length).toBeGreaterThan(32000);
  expect(wav.length).toBeLessThanOrEqual(1920044);
});

test('offers manual entry when offline or the monthly quota is exhausted', async ({
  page,
  context,
}) => {
  await page.route('**/ai/status', (route) =>
    route.fulfill({ json: { ...ready, available: false, reason: 'quota', remaining: 0 } }),
  );
  await page.getByRole('button', { name: 'Add with AI', exact: true }).click();
  await expect(
    page.getByText('The monthly AI limit has been reached.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Use manual entry' }).click();
  await expect(page.getByRole('dialog', { name: 'Add transaction', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Add with AI', exact: true }).click();
  await expect(
    page.getByText('AI entry needs an internet connection.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Use manual entry' }).click();
  await expect(page.getByRole('dialog', { name: 'Add transaction', exact: true })).toBeVisible();
});
