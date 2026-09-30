import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ context, page }) => {
  if (test.info().project.use.baseURL?.includes('3100')) {
    const { supportToken: token } = JSON.parse(await readFile('.local/e2e-session.json', 'utf8'));
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
  // Control only the optional public setting; authentication and app data stay real.
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), kofiUrl: null } });
  });
});

test('support stays hidden when no Ko-fi page is configured', async ({ page }) => {
  await page.goto('/');
  if (!test.info().project.use.baseURL?.includes('3100')) {
    await page.getByRole('button', { name: 'Explore with sample data' }).click();
  }
  // Terms of Use also exists on the sign-in screen; require an authenticated app.
  await expect(page.getByRole('heading', { name: 'A little clarity, every day.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Buy the developer a coffee/ })).toHaveCount(0);
});

test('support works on desktop and mobile without navigating away from KinFlow', async ({
  page,
  context,
}) => {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), kofiUrl: 'https://ko-fi.com/kinflow_test' },
    });
  });
  await context.route('https://ko-fi.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Ko-fi test destination</h1>' }),
  );
  await page.goto('/');
  if (!test.info().project.use.baseURL?.includes('3100')) {
    await page.getByRole('button', { name: 'Explore with sample data' }).click();
  }
  const link = page.getByRole('link', { name: /Buy the developer a coffee/ });
  await expect(page.getByRole('heading', { name: 'A little clarity, every day.' })).toBeVisible();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.setViewportSize({ width: 375, height: 812 });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://ko-fi.com/kinflow_test');
  await expect(page.getByRole('heading', { name: 'A little clarity, every day.' })).toBeVisible();
  await popup.close();
});
