import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { getDB } from '@/server/db';
import { AppError, requireThat } from '@/server/errors';
import {
  appURL,
  beginGoogle,
  currentUser,
  demoEnabled,
  finishGoogle,
  hash,
  sameOrigin,
  sessionCookie,
  setSession,
} from '@/server/auth';
import {
  createFamily,
  deleteUser,
  getAudit,
  inspectInvite,
  invite,
  join,
  leave,
  listFamilies,
  mutate,
  readSnapshot,
} from '@/server/service';
import { refreshRates } from '@/server/rates';
import { seedDemo } from '@/server/demo';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' },
  });
async function body(request: NextRequest) {
  requireThat(
    Number(request.headers.get('content-length') || 0) <= 262144,
    'Request is too large.',
    413,
  );
  const text = await request.text();
  requireThat(Buffer.byteLength(text) <= 262144, 'Request is too large.', 413);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new AppError(400, 'Invalid JSON.');
  }
}
async function handle(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const path = (await params).path;
    const key = path.join('/'),
      method = request.method;
    if (method !== 'GET') sameOrigin(request);
    if (key === 'config')
      return json({ demo: demoEnabled(), google: !!process.env.GOOGLE_CLIENT_ID });
    const db = await getDB();
    if (key === 'cron/rates' && method === 'GET') {
      const expected = 'Bearer ' + process.env.CRON_SECRET,
        actual = request.headers.get('authorization') || '';
      requireThat(
        process.env.CRON_SECRET &&
          expected.length === actual.length &&
          timingSafeEqual(Buffer.from(expected), Buffer.from(actual)),
        'Unauthorized.',
        401,
      );
      const result = await refreshRates(db);
      return json({ updated: !!result, date: result?.date }, result ? 200 : 503);
    }
    if (key === 'auth/google' && method === 'GET') return beginGoogle(db, request);
    if (key === 'auth/callback' && method === 'GET') {
      try {
        return await finishGoogle(db, request);
      } catch {
        return NextResponse.redirect(
          appURL(request) + '/?authError=Sign-in%20failed.%20Please%20try%20again.',
        );
      }
    }
    if (key === 'auth/demo' && method === 'POST') {
      requireThat(demoEnabled(), 'Not found.', 404);
      const user = await seedDemo(db);
      const response = json({ user });
      await setSession(db, user.id, response);
      return response;
    }
    const user = await currentUser(db, request);
    requireThat(user, 'Please sign in again.', 401);
    if (key === 'auth/logout' && method === 'POST') {
      const token = request.cookies.get(sessionCookie)?.value;
      await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash(token || '')]);
      const response = json({ ok: true });
      response.cookies.delete(sessionCookie);
      return response;
    }
    if (key === 'me' && method === 'GET')
      return json({ user, families: await listFamilies(db, user.id), demo: demoEnabled() });
    if (key === 'me' && method === 'PATCH') {
      const v = z
        .object({
          name: z.string().trim().min(1).max(100),
          theme: z.enum(['light', 'dark', 'system']),
          dateFormat: z.enum(['dmy', 'mdy', 'iso']),
        })
        .parse(await body(request));
      await db.query('UPDATE users SET name=$1,preferences=$2 WHERE id=$3', [
        v.name,
        JSON.stringify({ theme: v.theme, dateFormat: v.dateFormat }),
        user.id,
      ]);
      return json({ ...user, ...v });
    }
    if (key === 'me' && method === 'DELETE') {
      await deleteUser(db, user.id);
      const response = json({ ok: true });
      response.cookies.delete(sessionCookie);
      return response;
    }
    if (key === 'families' && method === 'POST')
      return json(await createFamily(db, user, await body(request)), 201);
    if (key === 'join' && method === 'POST')
      return json(
        await join(
          db,
          user.id,
          z
            .object({ code: z.string().max(50) })
            .parse(await body(request))
            .code.trim()
            .toUpperCase(),
        ),
      );
    if (path[0] === 'invites' && method === 'GET')
      return json(await inspectInvite(db, user.id, path[1].toUpperCase()));
    if (path[0] === 'families' && path[1]) {
      const familyId = path[1],
        action = path[2];
      if (action === 'sync' && method === 'GET') {
        await refreshRates(db);
        return json(
          await readSnapshot(
            db,
            user.id,
            familyId,
            Number(request.nextUrl.searchParams.get('after') || 0),
            request.nextUrl.searchParams.has('until')
              ? Number(request.nextUrl.searchParams.get('until'))
              : undefined,
            request.nextUrl.searchParams.get('page') || '',
          ),
        );
      }
      if (action === 'mutate' && method === 'POST')
        return json(await mutate(db, user, familyId, await body(request)));
      if (action === 'audit' && path[3] && method === 'GET')
        return json(await getAudit(db, user.id, familyId, path[3]));
      if (action === 'invitations' && method === 'POST')
        return json(await invite(db, user.id, familyId, await body(request)), 201);
      if (action === 'leave' && method === 'POST') {
        await leave(db, user.id, familyId);
        return json({ ok: true });
      }
      if (!action && method === 'DELETE') {
        await leave(db, user.id, familyId, true);
        return json({ ok: true });
      }
    }
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        400,
      );
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    // Financial payloads and SQL error details never go to ordinary application logs.
    console.error('KinFlow request failed', error instanceof Error ? error.name : 'UnknownError');
    return json({ error: 'The request could not be completed. Please try again.' }, 500);
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
