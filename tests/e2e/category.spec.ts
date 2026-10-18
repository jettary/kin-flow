import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import type { Snapshot } from '../../src/lib/model';

test.beforeEach(async ({ page, context }) => {
  if (test.info().project.use.baseURL?.includes('3100')) {
    const { supportToken } = JSON.parse(await readFile('.local/e2e-session.json', 'utf8'));
    await context.addCookies([
      {
        name: 'kinflow_session',
        value: supportToken,
        url: 'http://127.0.0.1:3100',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  }
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    if (session.user) {
      session.user.theme = test.info().title.includes('320px') ? 'dark' : 'light';
    }
    await route.fulfill({ response, json: session });
  });
  // Exercise the real sign-in and sync flow with extra transaction states.
  await page.route('**/api/families/*/sync?*', async (route) => {
    const response = await route.fetch();
    const s: Snapshot = await response.json();
    const category = s.entities.find((e) => e.kind === 'expense' && e.name === 'Groceries')!;
    const expense = s.transactions.find(
      (t) => t.categoryId === category.id && t.type === 'expense',
    );
    if (expense) {
      s.transactions.push(
        { ...expense, id: 'category-refund', type: 'refund', comment: 'Category refund' },
        { ...expense, id: 'category-deleted', deleted: true, comment: 'Deleted category expense' },
        {
          ...expense,
          id: 'category-private',
          ownerId: expense.authorId,
          comment: 'Private category expense',
        },
        { ...expense, id: 'category-redacted', redacted: true, comment: 'Redacted expense' },
      );
    }
    await route.fulfill({ response, json: s });
  });
  await page.goto('/');
  if (!test.info().project.use.baseURL?.includes('3100')) {
    await page.getByRole('button', { name: 'Explore with sample data' }).click();
  }
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date', {
    timeout: 30000,
  });
});

for (const width of [1440, 390, 320]) {
  test(`category transactions, months, scope and budget editing at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const openCategory = () => page.getByRole('button', { name: /^Groceries budget:/ }).click();
    const category = page.getByRole('dialog', { name: 'Groceries', exact: true });
    await openCategory();
    const rows = category.locator('.transaction-row');
    await expect(rows.filter({ hasText: 'Weekly groceries · Carrefour' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Category refund' })).toContainText('Refund');
    await expect(rows.filter({ hasText: 'Saturday brunch' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Previous month groceries' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Deleted category expense' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Private category expense' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'Redacted expense' })).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    expect(await category.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await category.screenshot({ path: `test-results/category-${width}.png` });

    await category.getByRole('button', { name: 'Previous month' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Previous month groceries');
    await category.getByRole('button', { name: 'Next month' }).click();
    await category.getByRole('button', { name: 'Next month' }).click();
    await expect(
      category.getByRole('heading', { name: 'No transactions this month' }),
    ).toBeVisible();
    await category.getByRole('button', { name: 'Previous month' }).click();

    await rows.filter({ hasText: 'Weekly groceries · Carrefour' }).click();
    const detail = page.getByRole('dialog');
    await expect(detail).toContainText('186.40 GEL');
    await detail.getByRole('button', { name: 'Close', exact: true }).click();
    await openCategory();
    await category.getByRole('button', { name: 'Edit budget', exact: true }).click();
    const budget = page.getByRole('dialog', { name: 'Groceries budget', exact: true });
    await expect(budget.getByLabel('Monthly limit')).toHaveValue('900');
    await budget.getByRole('button', { name: 'Save budget', exact: true }).click();
    await expect(budget).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date');

    await page.getByRole('button', { name: 'Shared + mine', exact: true }).click();
    await openCategory();
    await expect(rows.filter({ hasText: 'Private category expense' })).toHaveCount(1);
  });
}

test('a regular member can view category transactions without budget editing', async ({ page }) => {
  await page.route('**/api/families/*/sync?*', async (route) => {
    const response = await route.fetch();
    const s: Snapshot = await response.json();
    s.family.role = 'member';
    await route.fulfill({ response, json: s });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Synchronize' })).toHaveText('Up to date');
  await page.getByRole('button', { name: /^Groceries budget:/ }).click();
  const category = page.getByRole('dialog', { name: 'Groceries', exact: true });
  await expect(category.locator('.transaction-row').first()).toBeVisible();
  await expect(category.getByRole('button', { name: 'Edit budget' })).toHaveCount(0);
});
