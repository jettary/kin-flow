import { after, NextRequest, NextResponse } from 'next/server';
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
import {
  deliverPush,
  deviceStatus,
  presence,
  pushConfig,
  pushPreferences,
  subscribe,
  unsubscribe,
} from '@/server/push';
const schedulePush = (db: Awaited<ReturnType<typeof getDB>>) =>
  after(async () => {
    try {
      await deliverPush(db);
    } catch {
      console.error('KinFlow push delivery failed');
    }
  });
export const runtime = 'nodejs';
export const maxDuration = 60;
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
    if ((key === 'cron/rates' || key === 'cron/push') && method === 'GET') {
      const expected = 'Bearer ' + process.env.CRON_SECRET,
        actual = request.headers.get('authorization') || '';
      requireThat(
        process.env.CRON_SECRET &&
          expected.length === actual.length &&
          timingSafeEqual(Buffer.from(expected), Buffer.from(actual)),
        'Unauthorized.',
        401,
      );
      if (key === 'cron/push') {
        await deliverPush(db);
        return json({ ok: true });
      }
      schedulePush(db);
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
    if (key === 'push/subscription' && method === 'POST')
      return json(
        await subscribe(
          db,
          user.id,
          hash(request.cookies.get(sessionCookie)?.value || ''),
          await body(request),
        ),
      );
    if (key === 'push/subscription' && method === 'DELETE') {
      await unsubscribe(db, user.id, await body(request));
      return json({ ok: true });
    }
    if (key === 'push/status' && method === 'POST')
      return json(await deviceStatus(db, user.id, await body(request)));
    if (key === 'push/presence' && method === 'POST') {
      await presence(db, user.id, await body(request));
      schedulePush(db);
      return json({ families: await listFamilies(db, user.id) });
    }
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
      if (action === 'notifications' && (method === 'GET' || method === 'PATCH'))
        return json({
          publicKey: pushConfig()?.publicKey || null,
          preferences: await pushPreferences(
            db,
            user.id,
            familyId,
            method === 'PATCH' ? await body(request) : undefined,
          ),
        });
      if (action === 'sync' && method === 'GET') {
        schedulePush(db);
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
      if (action === 'mutate' && method === 'POST') {
        const result = await mutate(db, user, familyId, await body(request));
        schedulePush(db);
        return json(result);
      }
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
