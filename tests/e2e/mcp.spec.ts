import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:3100';
const redirect = 'http://localhost:8976/callback';

test('an assistant connects through the consent page and can be disconnected', async ({
  page,
  context,
  request,
}) => {
  test.skip(!test.info().project.use.baseURL?.includes('3100'), 'Needs the isolated server');
  const { mcpToken } = JSON.parse(await readFile('.local/e2e-session.json', 'utf8'));
  await context.addCookies([
    { name: 'kinflow_session', value: mcpToken, url: base, httpOnly: true, sameSite: 'Lax' },
  ]);

  const metadata = await (
    await request.get('/.well-known/oauth-protected-resource/api/mcp')
  ).json();
  expect(metadata).toMatchObject({ resource: base + '/api/mcp', authorization_servers: [base] });
  expect((await request.get('/.well-known/oauth-authorization-server')).ok()).toBe(true);
  const challenge = await request.post('/api/mcp', { data: {} });
  expect(challenge.status()).toBe(401);
  expect(challenge.headers()['www-authenticate']).toContain('resource_metadata=');

  const client = await (
    await request.post('/api/oauth/register', {
      data: { client_name: 'Test Assistant', redirect_uris: [redirect], token_endpoint_auth_method: 'none' },
    })
  ).json();
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'e2e-state',
    scope: 'read write',
    resource: base + '/api/mcp',
  });
  await page.route('http://localhost:8976/**', (route) => route.fulfill({ body: 'connected' }));
  await page.goto('/oauth/authorize?' + query);
  await expect(
    page.getByRole('heading', { name: 'Test Assistant wants to access your KinFlow' }),
  ).toBeVisible();
  await expect(page.getByText('Your financial data will be sent to Test Assistant')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Allow changes/ })).toBeChecked();
  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL(/localhost:8976/);
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  expect(back.searchParams.get('iss')).toBe(base);

  const tokens = await (
    await request.post('/api/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code: back.searchParams.get('code')!,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: redirect,
        resource: base + '/api/mcp',
      },
    })
  ).json();
  expect(tokens.scope).toBe('read write');
  const initialize = await request.post('/api/mcp', {
    headers: {
      authorization: 'Bearer ' + tokens.access_token,
      accept: 'application/json, text/event-stream',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1.0.0' },
      },
    },
  });
  expect(initialize.status()).toBe(200);
  expect(await initialize.text()).toContain('KinFlow');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little clarity, every day.' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation', exact: true })
    .getByRole('button', { name: 'More', exact: true })
    .click();
  await page.getByRole('button', { name: 'Connected assistants', exact: true }).click();
  await expect(page.getByText('Test Assistant')).toBeVisible();
  await expect(page.getByText(/localhost:8976 · Can make changes/)).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('No assistants are connected.')).toBeVisible();
  const revoked = await request.post('/api/mcp', {
    headers: { authorization: 'Bearer ' + tokens.access_token },
    data: {},
  });
  expect(revoked.status()).toBe(401);
});
