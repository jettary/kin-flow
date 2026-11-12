import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db';
import { hash } from './auth';
import type { User } from '../lib/model';

// OAuth 2.1 authorization server for the MCP connector (Claude, ChatGPT, Gemini).
export const SCOPES = ['read', 'write'] as const;
export const ACCESS_TTL = 3600;
const REFRESH_DAYS = 90;
const CIMD_CACHE_HOURS = 24;
// DCR clients can only send codes to these hosts; CIMD clients are identified by their own domain.
const DCR_REDIRECT_HOSTS = ['claude.ai', 'chatgpt.com', 'oauth-redirect.googleusercontent.com'];

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
  body() {
    return { error: this.code, error_description: this.message };
  }
}
const fail = (code: string, message: string, status = 400): never => {
  throw new OAuthError(code, message, status);
};

export const resourceURL = (base: string) => base + '/api/mcp';
export const resourceMetadataPath = '/.well-known/oauth-protected-resource/api/mcp';
export const protectedResourceMetadata = (base: string) => ({
  resource: resourceURL(base),
  authorization_servers: [base],
  scopes_supported: [...SCOPES],
  bearer_methods_supported: ['header'],
  resource_name: 'KinFlow',
});
export const authorizationServerMetadata = (base: string) => ({
  issuer: base,
  authorization_endpoint: base + '/oauth/authorize',
  token_endpoint: base + '/api/oauth/token',
  registration_endpoint: base + '/api/oauth/register',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  scopes_supported: [...SCOPES],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
});

export interface Client {
  id: string;
  kind: 'cimd' | 'dcr';
  name: string;
  redirectUris: string[];
  secretHash: string | null;
}
const isLoopback = (u: URL) =>
  u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
function parseURL(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
/** Exact match, except loopback redirects may use any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string[], uri: string) {
  const u = parseURL(uri);
  if (!u || u.hash) return false;
  return registered.some((r) => {
    if (r === uri) return true;
    const v = parseURL(r);
    return (
      !!v &&
      isLoopback(u) &&
      isLoopback(v) &&
      u.hostname === v.hostname &&
      u.pathname === v.pathname &&
      u.search === v.search
    );
  });
}
export function dcrRedirectAllowed(uri: string) {
  const u = parseURL(uri);
  if (!u || u.hash || u.username || u.password) return false;
  return isLoopback(u) || (u.protocol === 'https:' && DCR_REDIRECT_HOSTS.includes(u.hostname));
}
/** Host shown on the consent screen: the domain that vouches for this client. */
export function clientHost(client: Client) {
  return new URL(client.kind === 'cimd' ? client.id : client.redirectUris[0]).host;
}
const cleanName = (name: string | undefined, fallback: string) =>
  (name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || fallback;

const registration = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z
    .enum(['none', 'client_secret_post', 'client_secret_basic'])
    .default('client_secret_basic'),
});
export async function registerClient(db: DB, input: unknown) {
  const parsed = registration.safeParse(input);
  if (!parsed.success) fail('invalid_client_metadata', 'Invalid client registration.');
  const v = parsed.data!;
  if (!v.redirect_uris.every(dcrRedirectAllowed))
    fail('invalid_redirect_uri', 'This redirect URI is not allowed.');
  const id = randomUUID();
  const secret = v.token_endpoint_auth_method === 'none' ? null : randomBytes(32).toString('base64url');
  const name = cleanName(v.client_name, new URL(v.redirect_uris[0]).host);
  // shortcut: DCR rows are never pruned; add cleanup if the table grows past a few thousand rows.
  await db.query(
    "INSERT INTO oauth_clients(id,kind,name,redirect_uris,secret_hash) VALUES($1,'dcr',$2,$3,$4)",
    [id, name, JSON.stringify(v.redirect_uris), secret && hash(secret)],
  );
  return {
    client_id: id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: v.redirect_uris,
    token_endpoint_auth_method: v.token_endpoint_auth_method,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

const metadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
});
/** Only public https hostnames; TLS hostname verification blocks rebinding to internal services. */
export function cimdURLAllowed(value: string) {
  const u = parseURL(value);
  return (
    !!u &&
    u.protocol === 'https:' &&
    !u.hash &&
    !u.username &&
    !u.password &&
    u.pathname !== '/' &&
    u.hostname.includes('.') &&
    !u.hostname.endsWith('.localhost') &&
    !/^[\d.]+$/.test(u.hostname) &&
    !u.hostname.startsWith('[')
  );
}
async function readLimited(response: Response, limit: number) {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Client metadata is too large.');
      }
      chunks.push(value);
    }
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchMetadataDocument(db: DB, url: string): Promise<Client> {
  let doc: z.infer<typeof metadataDocument>;
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Client metadata is unavailable.');
    doc = metadataDocument.parse(JSON.parse(await readLimited(response, 65536)));
  } catch {
    return fail('invalid_client', 'Client metadata document could not be loaded.', 401);
  }
  if (doc.client_id !== url) fail('invalid_client', 'Client metadata does not match its URL.', 401);
  const client: Client = {
    id: url,
    kind: 'cimd',
    name: cleanName(doc.client_name, new URL(url).host),
    redirectUris: doc.redirect_uris,
    secretHash: null,
  };
  await db.query(
    `INSERT INTO oauth_clients(id,kind,name,redirect_uris) VALUES($1,'cimd',$2,$3)
     ON CONFLICT(id) DO UPDATE SET name=$2,redirect_uris=$3,fetched_at=now()`,
    [url, client.name, JSON.stringify(client.redirectUris)],
  );
  return client;
}
export async function resolveClient(db: DB, clientId: string): Promise<Client> {
  if (!clientId || clientId.length > 2000) fail('invalid_client', 'Unknown client.', 401);
  const cimd = clientId.startsWith('https://');
  if (cimd && !cimdURLAllowed(clientId)) fail('invalid_client', 'Unknown client.', 401);
  const row = (
    await db.query<{
      id: string;
      kind: 'cimd' | 'dcr';
      name: string;
      redirect_uris: string[];
      secret_hash: string | null;
      fresh: boolean;
    }>(
      `SELECT *,fetched_at>now()-interval '${CIMD_CACHE_HOURS} hours' fresh FROM oauth_clients WHERE id=$1`,
      [clientId],
    )
  ).rows[0];
  if (row && (row.kind === 'dcr' || row.fresh))
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      redirectUris: row.redirect_uris,
      secretHash: row.secret_hash,
    };
  if (cimd) return fetchMetadataDocument(db, clientId);
  return fail('invalid_client', 'Unknown client.', 401);
}

export interface AuthorizeRequest {
  client: Client;
  redirectUri: string;
  state?: string;
  challenge: string;
  scope: string[];
}
/** Errors before the redirect URI is trusted are shown to the user, never redirected. */
export class UntrustedRedirect extends Error {}
export async function parseAuthorize(db: DB, params: URLSearchParams, base: string) {
  let client: Client;
  try {
    client = await resolveClient(db, params.get('client_id') || '');
  } catch {
    throw new UntrustedRedirect('This app is not recognised.');
  }
  const redirectUri =
    params.get('redirect_uri') || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
  if (!redirectMatches(client.redirectUris, redirectUri))
    throw new UntrustedRedirect('This app sent an invalid return address.');
  const state = params.get('state') || undefined;
  const reject = (code: string, message: string): never => {
    throw Object.assign(new OAuthError(code, message), { redirect: redirectUri, state });
  };
  if (params.get('response_type') !== 'code')
    reject('unsupported_response_type', 'Only the authorization code flow is supported.');
  const challenge = params.get('code_challenge') || '';
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
    reject('invalid_request', 'PKCE with S256 is required.');
  const resource = params.get('resource');
  if (resource && resource !== resourceURL(base))
    reject('invalid_target', 'Unknown resource.');
  const requested = (params.get('scope') || '').split(' ').filter(Boolean);
  const scope = SCOPES.filter((s) => requested.includes(s));
  return {
    client,
    redirectUri,
    state,
    challenge,
    scope: scope.length ? scope : [...SCOPES],
  } satisfies AuthorizeRequest;
}
export function authorizeRedirect(
  redirectUri: string,
  base: string,
  values: Record<string, string | undefined>,
) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...values, iss: base }))
    if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}
export async function issueCode(db: DB, request: AuthorizeRequest, userId: string) {
  const code = randomBytes(32).toString('base64url');
  await db.query('DELETE FROM oauth_codes WHERE expires_at<now()');
  await db.query(
    "INSERT INTO oauth_codes(code_hash,client_id,user_id,scope,code_challenge,redirect_uri,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '60 seconds')",
    [hash(code), request.client.id, userId, request.scope.join(' '), request.challenge, request.redirectUri],
  );
  return code;
}

function same(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function authenticateClient(db: DB, params: URLSearchParams, authorization: string | null) {
  let id = params.get('client_id') || '',
    secret = params.get('client_secret') || '';
  if (authorization?.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    id = decodeURIComponent(decoded.slice(0, at));
    secret = decodeURIComponent(decoded.slice(at + 1));
  }
  const client = await resolveClient(db, id);
  if (client.secretHash && !same(hash(secret), client.secretHash))
    fail('invalid_client', 'Client authentication failed.', 401);
  return client;
}
function newTokens() {
  return {
    access: randomBytes(32).toString('base64url'),
    refresh: randomBytes(32).toString('base64url'),
  };
}
const tokenResponse = (t: { access: string; refresh: string }, scope: string) => ({
  access_token: t.access,
  token_type: 'Bearer',
  expires_in: ACCESS_TTL,
  refresh_token: t.refresh,
  scope,
});
const ACCESS_EXPIRY = `now()+interval '${ACCESS_TTL} seconds'`;
const REFRESH_EXPIRY = `now()+interval '${REFRESH_DAYS} days'`;
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export async function exchangeToken(
  db: DB,
  params: URLSearchParams,
  authorization: string | null,
  base: string,
) {
  const client = await authenticateClient(db, params, authorization);
  const resource = params.get('resource');
  if (resource && resource !== resourceURL(base)) fail('invalid_target', 'Unknown resource.');
  const grantType = params.get('grant_type');
  if (grantType === 'authorization_code') {
    const row = (
      await db.query<{
        client_id: string;
        user_id: string;
        scope: string;
        code_challenge: string;
        redirect_uri: string;
      }>(
        'DELETE FROM oauth_codes WHERE code_hash=$1 AND expires_at>now() RETURNING *',
        [hash(params.get('code') || '')],
      )
    ).rows[0];
    if (
      !row ||
      row.client_id !== client.id ||
      row.redirect_uri !== (params.get('redirect_uri') || row.redirect_uri) ||
      !same(s256(params.get('code_verifier') || ''), row.code_challenge)
    )
      fail('invalid_grant', 'The authorization code is invalid or expired.');
    const t = newTokens();
    await db.query(
      `INSERT INTO oauth_grants(id,user_id,client_id,scope,access_hash,access_expires_at,refresh_hash,refresh_expires_at) VALUES($1,$2,$3,$4,$5,${ACCESS_EXPIRY},$6,${REFRESH_EXPIRY})`,
      [randomUUID(), row!.user_id, client.id, row!.scope, hash(t.access), hash(t.refresh)],
    );
    return tokenResponse(t, row!.scope);
  }
  if (grantType === 'refresh_token') {
    const token = hash(params.get('refresh_token') || '');
    const t = newTokens();
    // Atomic rotation: of two concurrent refreshes with the same token only one wins.
    const grant = (
      await db.query<{ scope: string }>(
        `UPDATE oauth_grants SET access_hash=$1,refresh_hash=$2,previous_refresh_hash=$3,access_expires_at=${ACCESS_EXPIRY},refresh_expires_at=${REFRESH_EXPIRY},last_used_at=now()
         WHERE client_id=$4 AND refresh_hash=$3 AND refresh_expires_at>now() RETURNING scope`,
        [hash(t.access), hash(t.refresh), token, client.id],
      )
    ).rows[0];
    if (grant) return tokenResponse(t, grant.scope);
    // A rotated-out refresh token coming back means it leaked: end the whole connection.
    await db.query('DELETE FROM oauth_grants WHERE client_id=$1 AND previous_refresh_hash=$2', [
      client.id,
      token,
    ]);
    return fail('invalid_grant', 'The refresh token is invalid or expired.');
  }
  return fail('unsupported_grant_type', 'Unsupported grant type.');
}

export interface Access {
  user: User;
  grantId: string;
  scopes: string[];
  clientId: string;
  expiresAt: number;
}
export async function verifyAccess(db: DB, token: string): Promise<Access | null> {
  const row = (
    await db.query<{
      id: string;
      scope: string;
      client_id: string;
      expires: string;
      stale: boolean;
      client_name: string;
      user_id: string;
      name: string;
      avatar: string;
      preferences: Partial<User>;
    }>(
      `SELECT g.id,g.scope,g.client_id,extract(epoch from g.access_expires_at)::bigint::text expires,g.last_used_at<now()-interval '1 minute' stale,
       c.name client_name,u.id user_id,u.name,u.avatar,u.preferences
       FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id JOIN users u ON u.id=g.user_id
       WHERE g.access_hash=$1 AND g.access_expires_at>now()`,
      [hash(token)],
    )
  ).rows[0];
  if (!row) return null;
  if (row.stale) await db.query('UPDATE oauth_grants SET last_used_at=now() WHERE id=$1', [row.id]);
  return {
    user: { ...row.preferences, id: row.user_id, name: row.name, avatar: row.avatar, via: row.client_name },
    grantId: row.id,
    scopes: row.scope.split(' '),
    clientId: row.client_id,
    expiresAt: Number(row.expires),
  };
}

export async function listGrants(db: DB, userId: string) {
  return (
    await db.query<{ id: string; name: string; host: string; scope: string; createdAt: string; lastUsedAt: string }>(
      `SELECT g.id,c.name,CASE WHEN c.kind='cimd' THEN c.id ELSE c.redirect_uris->>0 END host,g.scope,g.created_at AS "createdAt",g.last_used_at AS "lastUsedAt"
       FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE g.user_id=$1 ORDER BY g.created_at`,
      [userId],
    )
  ).rows.map((g) => ({ ...g, host: parseURL(g.host)?.host || '', scope: g.scope.split(' ') }));
}
export async function revokeGrant(db: DB, userId: string, grantId: string) {
  z.string().uuid().parse(grantId);
  await db.query('DELETE FROM oauth_grants WHERE id=$1 AND user_id=$2', [grantId, userId]);
}
