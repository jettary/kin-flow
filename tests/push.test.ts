import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { embedded, migrate, type Database } from '../src/server/db';
import { createFamily, mutate, leave } from '../src/server/service';
import {
  deliverPush,
  enqueuePush,
  presence,
  pushPreferences,
  subscribe,
  subscriptionSchema,
  unsubscribe,
} from '../src/server/push';
import { defaultPushPreferences, pushEvent } from '../src/lib/push';
import type { Family, User } from '../src/lib/model';
let pg: PGlite, db: Database, actor: User, recipient: User, family: Family;
let accountId: string, categoryId: string, device: { id: string }, endpoint: string;
const subscription = (endpoint: string) => ({
  endpoint,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth: Buffer.alloc(16, 1).toString('base64url'),
  },
});
async function addUser(name: string) {
  const user = { id: randomUUID(), name };
  await db.query('INSERT INTO users(id,google_id,name) VALUES($1,$2,$3)', [user.id, user.id, name]);
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [user.id, user.id],
  );
  return user;
}
const write = (command: string, input: Record<string, unknown>, id = randomUUID(), as = actor) =>
  mutate(db, as, family.id, { id, command, input });
const expense = (extra = {}) => ({
  type: 'expense',
  date: '2026-09-28',
  amount: '10',
  currency: 'GEL',
  accountId,
  categoryId,
  comment: 'secret details',
  ...extra,
});
const queue = async () =>
  (await db.query<{ changed: boolean; events: string[] }>('SELECT * FROM push_outbox')).rows;
const send = () => vi.fn().mockResolvedValue({ statusCode: 201 });
beforeAll(async () => {
  pg = new PGlite();
  db = embedded(pg);
  await migrate(db);
  const keys = webpush.generateVAPIDKeys();
  vi.stubEnv('VAPID_PUBLIC_KEY', keys.publicKey);
  vi.stubEnv('VAPID_PRIVATE_KEY', keys.privateKey);
  vi.stubEnv('VAPID_SUBJECT', 'mailto:test@example.com');
});
beforeEach(async () => {
  await db.query('DELETE FROM families');
  await db.query('DELETE FROM users');
  actor = await addUser('Actor');
  recipient = await addUser('Recipient');
  family = await createFamily(db, actor, {
    name: 'Private family name',
    currency: 'GEL',
    timezone: 'UTC',
  });
  await db.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'member')", [
    family.id,
    recipient.id,
  ]);
  accountId = (
    await write('entity.save', {
      kind: 'account',
      name: 'Secret bank',
      currency: 'GEL',
      openingBalance: '100',
    })
  ).id;
  categoryId = (await write('entity.save', { kind: 'expense', name: 'Secret category' })).id;
  endpoint = 'https://fcm.googleapis.com/fcm/send/' + randomUUID();
  device = await subscribe(db, recipient.id, recipient.id, subscription(endpoint));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

describe('push event selection and atomic outbox', () => {
  it('defaults per member and family; forbids access outside membership', async () => {
    expect(await pushPreferences(db, recipient.id, family.id)).toEqual(defaultPushPreferences);
    await pushPreferences(db, recipient.id, family.id, {
      ...defaultPushPreferences,
      expenseCreated: false,
    });
    expect(await pushPreferences(db, actor.id, family.id)).toEqual(defaultPushPreferences);
    const other = await createFamily(db, recipient, {
      name: 'Other',
      currency: 'GEL',
      timezone: 'UTC',
    });
    expect(await pushPreferences(db, recipient.id, other.id)).toEqual(defaultPushPreferences);
    await expect(pushPreferences(db, actor.id, other.id)).rejects.toThrow('access');
    await expect(
      pushPreferences(db, recipient.id, family.id, { expenseCreated: true }),
    ).rejects.toThrow();
  });
  it('classifies all events and excludes private operations and adjustments', () => {
    for (const type of ['expense', 'income', 'transfer', 'adjustment', 'refund'] as const)
      expect(pushEvent({ type, ownerId: actor.id, notice: false }, false)).toBeNull();
    expect(pushEvent({ type: 'adjustment', ownerId: null }, false)).toBeNull();
    expect(pushEvent({ type: 'expense', ownerId: null }, false)).toBe('expenseCreated');
    expect(pushEvent({ type: 'expense', ownerId: null }, true)).toBe('expenseChanged');
    expect(pushEvent({ type: 'refund', ownerId: null }, false)).toBe('expenseChanged');
    expect(pushEvent({ type: 'transfer', ownerId: actor.id, notice: true }, false)).toBe(
      'transfer',
    );
    expect(pushEvent({ type: 'income', ownerId: actor.id, notice: true }, false)).toBe('income');
  });
  it('queues only after valid save, excludes actor and deduplicates offline retries', async () => {
    await subscribe(
      db,
      actor.id,
      actor.id,
      subscription('https://fcm.googleapis.com/fcm/send/actor'),
    );
    const mutationId = randomUUID();
    await expect(
      write('transaction.save', expense({ amount: '-1' }), mutationId),
    ).rejects.toThrow();
    expect(await queue()).toHaveLength(0);
    await write('transaction.save', expense(), mutationId);
    await write('transaction.save', expense(), mutationId);
    expect(await queue()).toHaveLength(1);
    const sender = send();
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(sender.mock.calls[0][1]);
    expect(payload).toEqual({
      familyId: family.id,
      notificationId: expect.any(String),
      title: 'Новая транзакция',
    });
    expect(sender.mock.calls[0][0].endpoint).toBe(endpoint);
    await write('transaction.save', expense(), mutationId);
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('honors optional edit, deletion and refund preferences', async () => {
    const tx = await write('transaction.save', expense());
    await db.query('DELETE FROM push_outbox');
    await write('transaction.save', expense({ id: tx.id, amount: '12' }));
    expect(await queue()).toHaveLength(0);
    await pushPreferences(db, recipient.id, family.id, {
      ...defaultPushPreferences,
      expenseChanged: true,
    });
    const refund = await write(
      'transaction.save',
      expense({ type: 'refund', originalId: tx.id, amount: '2' }),
    );
    expect((await queue())[0]).toMatchObject({ changed: true, events: ['expenseChanged'] });
    await write('transaction.delete', { id: refund.id });
    await write('transaction.delete', { id: tx.id });
    expect(await queue()).toHaveLength(3);
    const sender = send();
    await deliverPush(db, sender);
    expect(
      sender.mock.calls.every(
        (call) => JSON.parse(call[1]).title === 'Изменение в семейных финансах',
      ),
    ).toBe(true);
  });
  it('redacts mixed transfers and source deposits and never queues solely personal records', async () => {
    const personalAccount = (
      await write('entity.save', {
        kind: 'account',
        name: 'Private',
        currency: 'GEL',
        openingBalance: '20',
        ownerId: actor.id,
      })
    ).id;
    const personalCategory = (
      await write('entity.save', { kind: 'expense', name: 'Private', ownerId: actor.id })
    ).id;
    await write(
      'transaction.save',
      expense({ accountId: personalAccount, categoryId: personalCategory }),
    );
    await write('transaction.save', expense({ type: 'adjustment', comment: 'reason' }));
    await write('transaction.save', expense({ type: 'transfer', toAccountId: personalAccount }));
    expect(await queue()).toHaveLength(0);
    await pushPreferences(db, recipient.id, family.id, {
      ...defaultPushPreferences,
      transfer: true,
      income: true,
    });
    await write('transaction.save', expense({ type: 'transfer', toAccountId: personalAccount }));
    const sourceId = (await write('entity.save', { kind: 'source', name: 'Salary' })).id;
    await write(
      'transaction.save',
      expense({ type: 'income', accountId: personalAccount, categoryId: sourceId }),
    );
    expect(await queue()).toHaveLength(2);
    const sender = send();
    await deliverPush(db, sender);
    for (const call of sender.mock.calls) {
      expect(Object.keys(JSON.parse(call[1])).sort()).toEqual([
        'familyId',
        'notificationId',
        'title',
      ]);
      expect(call[1]).not.toContain('secret');
    }
  });
  it('rolls back outbox entries and groups a future atomic batch per device', async () => {
    await expect(
      db.transaction(async (connection) => {
        await enqueuePush(connection, family.id, actor.id, randomUUID(), [
          { event: 'expenseCreated', changed: false },
        ]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await queue()).toHaveLength(0);
    await db.transaction((connection) =>
      enqueuePush(connection, family.id, actor.id, randomUUID(), [
        { event: 'expenseCreated', changed: false },
        { event: 'expenseCreated', changed: false },
        { event: 'income', changed: false },
      ]),
    );
    expect(await queue()).toHaveLength(1);
  });
});

describe('device delivery and lifecycle', () => {
  it('delivers to all recipient devices and revokes only the selected device', async () => {
    const second = 'https://web.push.apple.com/' + randomUUID();
    await subscribe(db, recipient.id, recipient.id, subscription(second));
    await write('transaction.save', expense());
    const sender = send();
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(2);
    await unsubscribe(db, actor.id, { endpoint }); // Cannot revoke somebody else's device.
    expect((await db.query('SELECT id FROM push_subscriptions')).rows).toHaveLength(2);
    await unsubscribe(db, recipient.id, { endpoint });
    await write('transaction.save', expense());
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(3);
    expect(sender.mock.calls[2][0].endpoint).toBe(second);
    expect(await pushPreferences(db, recipient.id, family.id)).toEqual(defaultPushPreferences);
  });
  it('suppresses only the foreground device and preserves other visible tabs', async () => {
    await subscribe(
      db,
      recipient.id,
      recipient.id,
      subscription('https://fcm.googleapis.com/fcm/send/second'),
    );
    const tabId = randomUUID();
    await presence(db, recipient.id, { subscriptionId: device.id, tabId, visible: true });
    await presence(db, recipient.id, {
      subscriptionId: device.id,
      tabId: randomUUID(),
      visible: false,
    });
    await write('transaction.save', expense());
    const sender = send();
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0].endpoint).not.toBe(endpoint);
    await presence(db, recipient.id, { subscriptionId: device.id, tabId, visible: false });
    await write('transaction.save', expense());
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(3);
  });
  it('expires stale presence and rejects spoofed presence from another user', async () => {
    await presence(db, actor.id, { subscriptionId: device.id, tabId: randomUUID(), visible: true });
    expect((await db.query('SELECT * FROM push_presence')).rows).toHaveLength(0);
    await presence(db, recipient.id, {
      subscriptionId: device.id,
      tabId: randomUUID(),
      visible: true,
    });
    await db.query("UPDATE push_presence SET until_at=now()-interval '1 second'");
    await write('transaction.save', expense());
    const sender = send();
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(1);
  });
  it('rechecks preferences, membership and sessions before sending', async () => {
    await write('transaction.save', expense());
    await pushPreferences(db, recipient.id, family.id, {
      ...defaultPushPreferences,
      expenseCreated: false,
    });
    const sender = send();
    await deliverPush(db, sender);
    expect(sender).not.toHaveBeenCalled();
    await pushPreferences(db, recipient.id, family.id, defaultPushPreferences);
    await write('transaction.save', expense());
    await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [
      recipient.id,
    ]);
    await deliverPush(db, sender);
    expect(sender).not.toHaveBeenCalled();
    await db.query("UPDATE sessions SET expires_at=now()+interval '1 day' WHERE user_id=$1", [
      recipient.id,
    ]);
    await write('transaction.save', expense());
    await leave(db, recipient.id, family.id);
    expect(await queue()).toHaveLength(0);
    await deliverPush(db, sender);
    expect(sender).not.toHaveBeenCalled();
  });
  it('cascades local-session sign-out and user deletion without affecting other devices', async () => {
    const secondSession = randomUUID();
    await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '1 day')", [
      secondSession,
      recipient.id,
    ]);
    await subscribe(
      db,
      recipient.id,
      secondSession,
      subscription('https://fcm.googleapis.com/fcm/send/second'),
    );
    await write('transaction.save', expense());
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [recipient.id]);
    expect(await queue()).toHaveLength(1);
    await db.query('DELETE FROM users WHERE id=$1', [recipient.id]);
    expect(await queue()).toHaveLength(0);
    expect((await db.query('SELECT * FROM push_subscriptions')).rows).toHaveLength(0);
  });
  it('removes expired subscriptions on 404/410 and retries transient failures', async () => {
    await write('transaction.save', expense());
    const failure = vi.fn().mockRejectedValue({ statusCode: 503 });
    await deliverPush(db, failure);
    expect(await queue()).toHaveLength(1);
    await deliverPush(db, failure);
    expect(failure).toHaveBeenCalledTimes(1);
    await db.query("UPDATE push_outbox SET next_attempt_at=now()-interval '1 second'");
    const sender = send();
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await queue()).toHaveLength(0);
    await write('transaction.save', expense());
    await deliverPush(db, vi.fn().mockRejectedValue({ statusCode: 410 }));
    expect((await db.query('SELECT * FROM push_subscriptions')).rows).toHaveLength(0);
    expect(await queue()).toHaveLength(0);
  });
  it('drains more than one delivery page and expires stale jobs', async () => {
    for (let i = 0; i < 25; i++) await write('transaction.save', expense());
    const sender = send();
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(25);
    expect(await queue()).toHaveLength(0);
    await write('transaction.save', expense());
    await db.query("UPDATE push_outbox SET expires_at=now()-interval '1 second'");
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(25);
    expect(await queue()).toHaveLength(0);
  });
  it('leases concurrent dispatchers and recovers abandoned leases', async () => {
    await write('transaction.save', expense());
    const sender = send();
    await Promise.all([deliverPush(db, sender), deliverPush(db, sender)]);
    expect(sender).toHaveBeenCalledTimes(1);
    await write('transaction.save', expense());
    await db.query("UPDATE push_outbox SET lease_until=now()+interval '1 minute'");
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(1);
    await db.query("UPDATE push_outbox SET lease_until=now()-interval '1 second'");
    await deliverPush(db, sender);
    expect(sender).toHaveBeenCalledTimes(2);
  });
  it('rejects arbitrary endpoints, invalid keys, account takeover and wrong sessions', async () => {
    for (const url of [
      'http://fcm.googleapis.com/a',
      'https://127.0.0.1/a',
      'https://fcm.googleapis.com.evil.test/a',
      'https://fcm.googleapis.com:123/a',
      'https://user@fcm.googleapis.com/a',
    ])
      expect(subscriptionSchema.safeParse(subscription(url)).success).toBe(false);
    expect(
      subscriptionSchema.safeParse({
        ...subscription(endpoint),
        keys: { auth: 'bad', p256dh: 'bad' },
      }).success,
    ).toBe(false);
    await expect(subscribe(db, actor.id, actor.id, subscription(endpoint))).rejects.toThrow(
      'changing accounts',
    );
    await expect(
      subscribe(db, actor.id, recipient.id, subscription(endpoint + '/new')),
    ).rejects.toThrow('sign in');
    const same = await subscribe(db, recipient.id, recipient.id, subscription(endpoint));
    expect(same.id).toBe(device.id);
  });
});
