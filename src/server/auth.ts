import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { NextRequest, NextResponse } from 'next/server';
import type { DB } from './db';
import type { User } from '../lib/model';
import { requireThat } from './errors';
export const sessionCookie = 'kinflow_session';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const demoEnabled = () =>
  process.env.NODE_ENV === 'development' &&
  !process.env.VERCEL &&
  process.env.DEMO_MODE !== 'false';
export function appURL(request: NextRequest) {
  return (
    process.env.APP_URL?.replace(/\/$/, '') ||
    (process.env.NODE_ENV !== 'production'
      ? `http://${request.headers.get('host') || '127.0.0.1:3000'}`
      : '')
  );
}
function oauth(request: NextRequest) {
  requireThat(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && appURL(request),
    'Google sign-in has not been configured.',
    503,
  );
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    appURL(request) + '/api/auth/callback',
  );
}
export function sameOrigin(request: NextRequest) {
  requireThat(
    request.headers.get('origin') === appURL(request),
    'Request origin is not allowed.',
    403,
  );
}
export async function currentUser(db: DB, request: NextRequest): Promise<User | null> {
  const token = request.cookies.get(sessionCookie)?.value;
  if (!token) return null;
  const u = (
    await db.query<{ id: string; name: string; avatar: string; preferences: Partial<User> }>(
      'SELECT u.id,u.name,u.avatar,u.preferences FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
      [hash(token)],
    )
  ).rows[0];
  return u ? { ...u.preferences, id: u.id, name: u.name, avatar: u.avatar } : null;
}
export async function setSession(db: DB, userId: string, response: NextResponse) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",
    [hash(token), userId],
  );
  response.cookies.set(sessionCookie, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 86400,
  });
}
export async function beginGoogle(db: DB, request: NextRequest) {
  const client = oauth(request),
    state = randomBytes(32).toString('base64url'),
    nonce = randomBytes(32).toString('base64url');
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  await db.query('DELETE FROM oauth_states WHERE expires_at<now()');
  await db.query(
    "INSERT INTO oauth_states(state_hash,verifier,nonce,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [hash(state), codeVerifier, nonce],
  );
  const response = NextResponse.redirect(
    client.generateAuthUrl({
      scope: ['openid', 'profile', 'email'],
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: 'select_account',
    }),
  );
  response.cookies.set('kinflow_oauth', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return response;
}
export async function finishGoogle(db: DB, request: NextRequest) {
  const state = request.nextUrl.searchParams.get('state') || '',
    cookie = request.cookies.get('kinflow_oauth')?.value || '';
  requireThat(
    state &&
      cookie &&
      state.length === cookie.length &&
      timingSafeEqual(Buffer.from(state), Buffer.from(cookie)),
    'Invalid sign-in state.',
    400,
  );
  const row = (
    await db.query<{ verifier: string; nonce: string }>(
      'DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING verifier,nonce',
      [hash(state)],
    )
  ).rows[0];
  requireThat(row, 'Sign-in expired. Please try again.');
  const code = request.nextUrl.searchParams.get('code');
  requireThat(code, 'Google sign-in was cancelled.');
  const client = oauth(request);
  const { tokens } = await client.getToken({ code, codeVerifier: row.verifier });
  requireThat(tokens.id_token, 'Google did not return an identity.');
  const payload = (
    await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID })
  ).getPayload();
  requireThat(
    payload?.sub &&
      payload.email_verified &&
      (payload as unknown as { nonce: string }).nonce === row.nonce,
    'Invalid Google identity.',
    401,
  );
  const u = (
    await db.query<{ id: string }>(
      'INSERT INTO users(id,google_id,name,avatar) VALUES($1,$2,$3,$4) ON CONFLICT(google_id) DO UPDATE SET avatar=EXCLUDED.avatar RETURNING id',
      [randomUUID(), payload.sub, payload.name || 'Family member', payload.picture || null],
    )
  ).rows[0];
  const response = NextResponse.redirect(appURL(request) + '/');
  response.cookies.delete('kinflow_oauth');
  await setSession(db, u.id, response);
  return response;
}
