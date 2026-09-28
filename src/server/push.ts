import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { z } from 'zod';
import type { DB, Database } from './db';
import { requireThat } from './errors';
import { defaultPushPreferences, type PushEvent, type PushPreferences } from '../lib/push';

const preferencesSchema = z
  .object({
    expenseCreated: z.boolean(),
    expenseChanged: z.boolean(),
    transfer: z.boolean(),
    income: z.boolean(),
  })
  .strict();

export function pushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

export async function pushPreferences(db: DB, userId: string, familyId: string, input?: unknown) {
  z.string().uuid().parse(familyId);
  const preferences = input === undefined ? undefined : preferencesSchema.parse(input);
  const result = preferences
    ? await db.query<{ push_preferences: PushPreferences }>(
        'UPDATE memberships SET push_preferences=$3 WHERE family_id=$1 AND user_id=$2 RETURNING push_preferences',
        [familyId, userId, JSON.stringify(preferences)],
      )
    : await db.query<{ push_preferences: PushPreferences }>(
        'SELECT push_preferences FROM memberships WHERE family_id=$1 AND user_id=$2',
        [familyId, userId],
      );
  requireThat(result.rows[0], 'You no longer have access to this family.', 403);
  return { ...defaultPushPreferences, ...result.rows[0].push_preferences };
}

// A subscription is a capability URL. Restrict outbound requests to platform push services
// to prevent an authenticated client from turning this API into an arbitrary HTTP proxy.
export const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      const host = url.hostname;
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.hash &&
        (host === 'fcm.googleapis.com' ||
          host === 'updates.push.services.mozilla.com' ||
          host.endsWith('.push.apple.com') ||
          host.endsWith('.notify.windows.com'))
      );
    }, 'Unsupported push service.'),
  keys: z.object({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]+={0,2}$/)
      .refine((s) => {
        const key = Buffer.from(s, 'base64url');
        return key.length === 65 && key[0] === 4;
      }),
    auth: z
      .string()
      .regex(/^[A-Za-z0-9_-]+={0,2}$/)
      .refine((s) => Buffer.from(s, 'base64url').length === 16),
  }),
});

export async function subscribe(db: Database, userId: string, sessionHash: string, input: unknown) {
  requireThat(pushConfig(), 'Notifications are not configured on this server.', 503);
  const value = subscriptionSchema.parse(input);
  return db.transaction(async (connection) => {
    // Serialize device registrations per user, including the device limit.
    await connection.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    const session = await connection.query(
      'SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',
      [sessionHash, userId],
    );
    requireThat(session.rows.length, 'Please sign in again.', 401);
    const count = await connection.query<{ count: string }>(
      'SELECT count(*) FROM push_subscriptions WHERE user_id=$1 AND endpoint<>$2',
      [userId, value.endpoint],
    );
    requireThat(
      Number(count.rows[0].count) < 20,
      'Too many subscribed devices. Disable an unused device.',
    );
    const result = await connection.query<{ id: string }>(
      `INSERT INTO push_subscriptions(id,user_id,session_hash,endpoint,keys) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(endpoint) DO UPDATE SET session_hash=$3,keys=$5
       WHERE push_subscriptions.user_id=$2 RETURNING id`,
      [randomUUID(), userId, sessionHash, value.endpoint, JSON.stringify(value.keys)],
    );
    requireThat(
      result.rows[0],
      'Disable notifications on this device before changing accounts.',
      409,
    );
    return result.rows[0];
  });
}

export async function unsubscribe(db: DB, userId: string, input: unknown) {
  const { endpoint } = z.object({ endpoint: z.string().max(2048) }).parse(input);
  await db.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [
    userId,
    endpoint,
  ]);
}

export async function deviceStatus(db: DB, userId: string, input: unknown) {
  const { endpoint } = z.object({ endpoint: z.string().max(2048) }).parse(input);
  const result = await db.query<{ id: string }>(
    `SELECT p.id FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash
     WHERE p.user_id=$1 AND p.endpoint=$2 AND s.expires_at>now()`,
    [userId, endpoint],
  );
  return { id: result.rows[0]?.id || null };
}

export async function presence(db: DB, userId: string, input: unknown) {
  const v = z
    .object({ subscriptionId: z.string().uuid(), tabId: z.string().uuid(), visible: z.boolean() })
    .parse(input);
  // A hidden tab must not clear the presence of another visible tab on the same device.
  await db.query(
    `INSERT INTO push_presence(subscription_id,tab_id,until_at)
     SELECT id,$3,CASE WHEN $4 THEN now()+interval '20 seconds' ELSE now() END
     FROM push_subscriptions WHERE id=$1 AND user_id=$2
     ON CONFLICT(subscription_id,tab_id) DO UPDATE SET until_at=EXCLUDED.until_at`,
    [v.subscriptionId, userId, v.tabId, v.visible],
  );
}

// Call inside the financial transaction. An array supports one notification per device
// for a future atomic AI batch, without implementing AI entry here.
export async function enqueuePush(
  db: DB,
  familyId: string,
  actorId: string,
  mutationId: string,
  operations: { event: PushEvent; changed: boolean }[],
) {
  if (!operations.length) return;
  const recipients = await db.query<{
    id: string;
    user_id: string;
    push_preferences: PushPreferences;
  }>(
    `SELECT p.id,p.user_id,m.push_preferences FROM push_subscriptions p
     JOIN memberships m ON m.user_id=p.user_id AND m.family_id=$1
     JOIN sessions s ON s.token_hash=p.session_hash
     WHERE p.user_id<>$2 AND s.expires_at>now()`,
    [familyId, actorId],
  );
  for (const recipient of recipients.rows) {
    const matching = operations.filter((op) => recipient.push_preferences[op.event]);
    if (!matching.length) continue;
    await db.query(
      `INSERT INTO push_outbox(id,family_id,user_id,subscription_id,mutation_id,events,changed)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(family_id,mutation_id,subscription_id) DO NOTHING`,
      [
        randomUUID(),
        familyId,
        recipient.user_id,
        recipient.id,
        mutationId,
        [...new Set(matching.map((op) => op.event))],
        matching.every((op) => op.changed),
      ],
    );
  }
}

type Delivery = {
  id: string;
  family_id: string;
  subscription_id: string;
  events: PushEvent[];
  changed: boolean;
  attempts: number;
  lease_id: string;
};
export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export async function deliverPush(db: Database, send: PushSender = webpush.sendNotification) {
  const config = pushConfig();
  if (!config) return;
  await db.query('DELETE FROM push_outbox WHERE expires_at<=now()');
  await db.query("DELETE FROM push_presence WHERE until_at<now()-interval '1 day'");
  const started = Date.now();
  for (let batch = 0; batch < 5; batch++) {
    const lease = randomUUID();
    const claimed = await db.query<Delivery>(
      `UPDATE push_outbox SET lease_id=$1,lease_until=now()+interval '60 seconds'
     WHERE id IN (SELECT id FROM push_outbox WHERE next_attempt_at<=now()
     AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
      [lease],
    );
    if (!claimed.rows.length) return;
    await Promise.all(
      claimed.rows.map(async (job) => {
        try {
          // Recheck membership, preferences, session and foreground status immediately before sending.
          const result = await db.query<{
            endpoint: string;
            keys: webpush.PushSubscription['keys'];
            push_preferences: PushPreferences;
            foreground: boolean;
          }>(
            `SELECT p.endpoint,p.keys,m.push_preferences,
         EXISTS(SELECT 1 FROM push_presence WHERE subscription_id=p.id AND until_at>now()) foreground
         FROM push_subscriptions p JOIN memberships m ON m.user_id=p.user_id AND m.family_id=$2
         JOIN sessions s ON s.token_hash=p.session_hash
         WHERE p.id=$1 AND s.expires_at>now()`,
            [job.subscription_id, job.family_id],
          );
          const target = result.rows[0];
          if (
            target &&
            !target.foreground &&
            job.events.some((event) => target.push_preferences[event])
          ) {
            await send(
              { endpoint: target.endpoint, keys: target.keys },
              JSON.stringify({
                familyId: job.family_id,
                notificationId: job.id,
                title: job.changed ? 'Изменение в семейных финансах' : 'Новая транзакция',
              }),
              { vapidDetails: config, TTL: 3600, urgency: 'normal', timeout: 10000 },
            );
          }
          await db.query('DELETE FROM push_outbox WHERE id=$1 AND lease_id=$2', [job.id, lease]);
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await db.query('DELETE FROM push_subscriptions WHERE id=$1', [job.subscription_id]);
          } else {
            // Retry provider/network failures; never log capability endpoints or key material.
            const delay = Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
            await db.query(
              `UPDATE push_outbox SET attempts=attempts+1,next_attempt_at=now()+($3 * interval '1 second'),
           lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2`,
              [job.id, lease, delay],
            );
          }
        }
      }),
    );
    if (claimed.rows.length < 20 || Date.now() - started > 40000) return;
  }
}
