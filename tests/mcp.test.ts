import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { embedded, migrate, type Database } from '../src/server/db';
import { createFamily, deleteUser, invite, join, mutate } from '../src/server/service';
import {
  authorizationServerMetadata,
  exchangeToken,
  issueCode,
  OAuthError,
  parseAuthorize,
  registerClient,
  resolveClient,
  revokeGrant,
  listGrants,
  UntrustedRedirect,
  verifyAccess,
} from '../src/server/oauth';
import { handleMcp } from '../src/server/mcp';
import type { Family, User } from '../src/lib/model';

const base = 'https://kinflow.test';
const resource = base + '/api/mcp';
const claudeRedirect = 'https://claude.ai/api/mcp/auth_callback';
let pg: PGlite, db: Database, owner: User, member: User, family: Family;
let shared: string, personal: string, food: string, privateCategory: string;

async function user(name: string) {
  const u = { id: randomUUID(), name };
  await db.query('INSERT INTO users(id,google_id,name) VALUES($1,$2,$3)', [u.id, u.id, name]);
  return u;
}
const save = async (as: User, command: string, input: Record<string, unknown>) =>
  (await mutate(db, as, family.id, { id: randomUUID(), command, input })).id;
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
async function authorize(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return parseAuthorize(
    db,
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: claudeRedirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource,
      ...extra,
    }),
    base,
  );
}
async function connect(as: User, scope = ['read', 'write']) {
  const client = await registerClient(db, {
    redirect_uris: [claudeRedirect],
    client_name: 'Claude',
    token_endpoint_auth_method: 'none',
  });
  const { verifier, challenge } = pkce();
  const request = await authorize(client.client_id, challenge);
  const code = await issueCode(db, { ...request, scope }, as.id);
  const tokens = await exchangeToken(
    db,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: claudeRedirect,
      resource,
    }),
    null,
    base,
  );
  return { ...tokens, clientId: client.client_id };
}
const mcpFetch = (url: string | URL, init?: RequestInit) =>
  handleMcp(new Request(url, init), base);
async function mcp(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
      fetch: mcpFetch,
    }),
  );
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  const text = result.content[0].text;
  return { error: result.isError ? text : undefined, data: result.isError ? null : JSON.parse(text) };
}

beforeAll(async () => {
  pg = new PGlite();
  db = embedded(pg);
  await migrate(db);
  (globalThis as { kinflowDB?: Promise<Database> }).kinflowDB = Promise.resolve(db);
  owner = await user('Olga');
  member = await user('Max');
  family = await createFamily(db, owner, {
    name: 'Home',
    currency: 'GEL',
    timezone: 'Asia/Tbilisi',
    templates: [],
  });
  const { code } = await invite(db, owner.id, family.id, {});
  await join(db, member.id, code);
  shared = await save(owner, 'entity.save', {
    kind: 'account',
    name: 'Joint card',
    currency: 'GEL',
    openingBalance: '1000',
  });
  food = await save(owner, 'entity.save', { kind: 'expense', name: 'Food' });
  personal = await save(member, 'entity.save', {
    kind: 'account',
    name: 'Max cash',
    currency: 'GEL',
    openingBalance: '500',
    ownerId: member.id,
  });
  privateCategory = await save(member, 'entity.save', {
    kind: 'expense',
    name: 'Max hobby',
    ownerId: member.id,
  });
  await save(member, 'transaction.save', {
    type: 'expense',
    date: '2026-11-02',
    accountId: personal,
    categoryId: privateCategory,
    amount: '40',
    currency: 'GEL',
    comment: 'secret gift',
  });
  await save(member, 'transaction.save', {
    type: 'transfer',
    date: '2026-11-03',
    accountId: shared,
    toAccountId: personal,
    amount: '25',
    currency: 'GEL',
    comment: 'secret pocket money',
  });
});
afterAll(async () => {
  await pg.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authorization server', () => {
  it('advertises CIMD, DCR, PKCE and RFC 9207', () => {
    const m = authorizationServerMetadata(base);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('registers DCR clients only with allowlisted redirect hosts', async () => {
    await expect(
      registerClient(db, { redirect_uris: ['https://evil.example/callback'] }),
    ).rejects.toMatchObject({ code: 'invalid_redirect_uri' });
    await expect(
      registerClient(db, { redirect_uris: ['https://claude.ai.evil.example/cb'] }),
    ).rejects.toBeInstanceOf(OAuthError);
    const confidential = await registerClient(db, {
      redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/x'],
    });
    expect(confidential.client_secret).toBeTruthy();
    const local = await registerClient(db, {
      redirect_uris: ['http://localhost/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(local).not.toHaveProperty('client_secret');
    // Loopback redirects match on any port.
    const request = await parseAuthorize(
      db,
      new URLSearchParams({
        response_type: 'code',
        client_id: local.client_id,
        redirect_uri: 'http://localhost:51234/callback',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      }),
      base,
    );
    expect(request.redirectUri).toBe('http://localhost:51234/callback');
  });

  it('loads Client ID Metadata Documents from public https URLs only', async () => {
    const url = 'https://assistant.example/oauth/client.json';
    const fetch = vi.fn(async () =>
      Response.json({ client_id: url, client_name: 'Assistant', redirect_uris: [claudeRedirect] }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = await resolveClient(db, url);
    expect(client).toMatchObject({ kind: 'cimd', name: 'Assistant' });
    await resolveClient(db, url);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const bad of [
      'https://127.0.0.1/client.json',
      'https://localhost/client.json',
      'https://[::1]/client.json',
      'https://assistant.example/',
    ])
      await expect(resolveClient(db, bad)).rejects.toMatchObject({ code: 'invalid_client' });
    const forged = 'https://forged.example/client.json';
    vi.stubGlobal('fetch', async () =>
      Response.json({ client_id: url, redirect_uris: [claudeRedirect] }),
    );
    await expect(resolveClient(db, forged)).rejects.toMatchObject({ code: 'invalid_client' });
  });

  it('never redirects to an unregistered address and redirects other errors with iss', async () => {
    const client = await registerClient(db, {
      redirect_uris: [claudeRedirect],
      token_endpoint_auth_method: 'none',
    });
    await expect(
      authorize(client.client_id, pkce().challenge, { redirect_uri: 'https://claude.ai/other' }),
    ).rejects.toBeInstanceOf(UntrustedRedirect);
    await expect(
      authorize(client.client_id, pkce().challenge, { code_challenge_method: 'plain' }),
    ).rejects.toMatchObject({ code: 'invalid_request', redirect: claudeRedirect, state: 'xyz' });
    await expect(
      authorize(client.client_id, pkce().challenge, { resource: 'https://other.test/mcp' }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('checks PKCE, single use of codes, client and refresh rotation with reuse detection', async () => {
    const client = await registerClient(db, {
      redirect_uris: [claudeRedirect],
      token_endpoint_auth_method: 'none',
    });
    const { verifier, challenge } = pkce();
    const request = await authorize(client.client_id, challenge);
    const exchange = (code: string, v: string, clientId = client.client_id) =>
      exchangeToken(
        db,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: v,
          client_id: clientId,
          redirect_uri: claudeRedirect,
        }),
        null,
        base,
      );
    const wrong = await issueCode(db, { ...request, scope: ['read'] }, owner.id);
    await expect(exchange(wrong, pkce().verifier)).rejects.toMatchObject({ code: 'invalid_grant' });
    const other = await registerClient(db, {
      redirect_uris: [claudeRedirect],
      token_endpoint_auth_method: 'none',
    });
    const stolen = await issueCode(db, { ...request, scope: ['read'] }, owner.id);
    await expect(exchange(stolen, verifier, other.client_id)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    const code = await issueCode(db, { ...request, scope: ['read'] }, owner.id);
    const tokens = await exchange(code, verifier);
    expect(tokens.scope).toBe('read');
    await expect(exchange(code, verifier)).rejects.toMatchObject({ code: 'invalid_grant' });

    const refresh = (token: string) =>
      exchangeToken(
        db,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token,
          client_id: client.client_id,
        }),
        null,
        base,
      );
    const rotated = await refresh(tokens.refresh_token);
    expect(await verifyAccess(db, tokens.access_token)).toBeNull();
    expect((await verifyAccess(db, rotated.access_token))?.user.via).toBe('claude.ai');
    // The old refresh token coming back ends the connection, including the new tokens.
    await expect(refresh(tokens.refresh_token)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(await verifyAccess(db, rotated.access_token)).toBeNull();
    await expect(refresh(rotated.refresh_token)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('requires the secret of confidential clients', async () => {
    const client = await registerClient(db, {
      redirect_uris: [claudeRedirect],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    const { verifier, challenge } = pkce();
    const request = await authorize(client.client_id, challenge);
    const code = await issueCode(db, { ...request, scope: ['read'] }, owner.id);
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: claudeRedirect,
    });
    await expect(
      exchangeToken(db, new URLSearchParams({ ...Object.fromEntries(params), client_id: client.client_id }), null, base),
    ).rejects.toMatchObject({ code: 'invalid_client' });
    const basic = 'Basic ' + Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    expect((await exchangeToken(db, params, basic, base)).access_token).toBeTruthy();
  });
});

describe('MCP endpoint', () => {
  it('challenges requests without a valid token', async () => {
    for (const auth of [undefined, 'Bearer nope']) {
      const response = await handleMcp(
        new Request(resource, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(auth && { authorization: auth }),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
        base,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(
        `resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`,
      );
    }
  });

  it('exposes tools with annotations and prompts', async () => {
    const client = await mcp((await connect(owner)).access_token);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(23);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_family.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_family.annotations?.destructiveHint).toBe(true);
    expect(byName.save_transaction.annotations?.readOnlyHint).toBe(false);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['log_expenses', 'monthly_review']);
  });

  it('records transactions as the user, idempotently, marked with the assistant', async () => {
    const client = await mcp((await connect(owner)).access_token);
    const key = randomUUID();
    const args = {
      idempotency_key: key,
      type: 'expense',
      date: '2026-11-05',
      accountId: shared,
      categoryId: food,
      amount: '12.50',
      comment: 'bread and cheese',
    };
    const first = await call(client, 'save_transaction', args);
    expect(first.error).toBeUndefined();
    const again = await call(client, 'save_transaction', args);
    expect(again.data.id).toBe(first.data.id);
    const { data } = await call(client, 'list_transactions', { search: 'bread' });
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]).toMatchObject({
      amount: '12.50',
      currency: 'GEL',
      account: { name: 'Joint card' },
      category: { name: 'Food' },
      author: 'Olga',
    });
    const audit = await call(client, 'get_audit', { objectId: first.data.id });
    expect(audit.data[0].action).toBe('Transaction recorded via Claude');
    // Partial edit keeps the other fields.
    await call(client, 'save_transaction', { id: first.data.id, comment: 'bread' });
    const edited = await call(client, 'list_transactions', { search: 'bread' });
    expect(edited.data.transactions[0]).toMatchObject({ amount: '12.50', comment: 'bread' });
    const batch = await call(client, 'save_transactions', {
      operations: [
        { type: 'expense', accountId: shared, categoryId: food, amount: '3', date: '2026-11-06' },
        { type: 'expense', accountId: shared, categoryId: food, amount: '4', date: '2026-11-06' },
      ],
    });
    expect(batch.data.ids).toHaveLength(2);
  });

  it('keeps other members’ personal data private', async () => {
    const client = await mcp((await connect(owner)).access_token);
    const family = await call(client, 'get_family');
    expect(family.data.accounts.map((a: { name: string }) => a.name)).not.toContain('Max cash');
    expect(JSON.stringify(family.data)).not.toContain('Max hobby');
    const { data } = await call(client, 'list_transactions', { month: '2026-11' });
    const text = JSON.stringify(data);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('"40"');
    expect(data.transactions.some((t: { private?: string }) => t.private)).toBe(true);
    for (const filter of [{ search: 'secret' }, { accountId: shared, search: 'pocket' }]) {
      const found = await call(client, 'list_transactions', filter);
      expect(found.data.transactions).toHaveLength(0);
    }
    const memberClient = await mcp((await connect(member)).access_token);
    const own = await call(memberClient, 'list_transactions', { search: 'secret' });
    expect(own.data.transactions).toHaveLength(2);
  });

  it('computes budgets and insights on the server', async () => {
    const client = await mcp((await connect(owner)).access_token);
    await call(client, 'save_budget', { categoryId: food, limit: '100' });
    const budgets = await call(client, 'get_budgets', { month: '2026-11' });
    expect(budgets.data.budgets[0]).toMatchObject({ category: 'Food', limit: '100', spent: '19.5' });
    const insights = await call(client, 'get_insights', { month: '2026-11' });
    expect(insights.data).toMatchObject({ currency: 'GEL', spent: '19.5' });
    expect(insights.data.byCategory[0]).toMatchObject({ name: 'Food', spent: '19.5' });
  });

  it('refuses changes on read-only connections and unconfirmed destructive actions', async () => {
    const reader = await mcp((await connect(owner, ['read'])).access_token);
    expect((await call(reader, 'get_family')).error).toBeUndefined();
    const denied = await call(reader, 'save_entity', { kind: 'expense', name: 'Pets' });
    expect(denied.error).toContain('read-only');
    const writer = await mcp((await connect(owner)).access_token);
    const unconfirmed = await call(writer, 'delete_family', { confirmName: 'Wrong' });
    expect(unconfirmed.error).toContain('"Home"');
    const blocked = await call(writer, 'delete_family', { confirmName: 'home' });
    expect(blocked.error).toContain('Other members must leave');
    const memberWriter = await mcp((await connect(member)).access_token);
    const forbidden = await call(memberWriter, 'set_member_role', { userId: owner.id, role: 'member' });
    expect(forbidden.error).toBeTruthy();
  });

  it('disconnects on revoke and on account deletion', async () => {
    const tokens = await connect(member);
    const grants = await listGrants(db, member.id);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants[0]).toMatchObject({ name: 'Claude', host: 'claude.ai' });
    expect(await verifyAccess(db, tokens.access_token)).not.toBeNull();
    await revokeGrant(db, owner.id, grants[0].id);
    expect(await listGrants(db, member.id)).toHaveLength(grants.length);
    for (const g of grants) await revokeGrant(db, member.id, g.id);
    expect(await verifyAccess(db, tokens.access_token)).toBeNull();
    const again = await connect(member);
    await deleteUser(db, member.id);
    expect(await verifyAccess(db, again.access_token)).toBeNull();
    expect(await listGrants(db, member.id)).toHaveLength(0);
  });
});
