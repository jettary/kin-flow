import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { embedded, migrate, type Database } from '../src/server/db';
import {
  createFamily,
  mutate,
  readSnapshot,
  getAudit,
  invite,
  join,
  leave,
  deleteUser,
} from '../src/server/service';
import { D } from '../src/lib/money';
import { comparison, totals } from '../src/lib/analytics';
import type { User, Family, Mutation } from '../src/lib/model';
let pg: PGlite, db: Database, owner: User, member: User, outsider: User, family: Family;
async function user(name: string) {
  const u = { id: randomUUID(), name };
  await db.query('INSERT INTO users(id,google_id,name) VALUES($1,$2,$3)', [u.id, u.id, name]);
  return u;
}
const save = (as: User, command: string, input: Record<string, unknown>, baseVersion?: number) =>
  mutate(db, as, family.id, { id: randomUUID(), command, input, baseVersion });
const account = async (as = owner, personal = false, currency = 'GEL', balance = '1000') =>
  (
    await save(as, 'entity.save', {
      kind: 'account',
      name: 'Account ' + randomUUID(),
      currency,
      openingBalance: balance,
      ownerId: personal ? as.id : null,
    })
  ).id;
const label = async (as = owner, personal = false, kind = 'expense') =>
  (
    await save(as, 'entity.save', {
      kind,
      name: 'Label ' + randomUUID(),
      ownerId: personal ? as.id : null,
    })
  ).id;
const balance = async (id: string, as = owner) =>
  D(
    (await readSnapshot(db, as.id, family.id)).entities.find((e) => e.id === id)!.balance!,
  ).toFixed();
const expense = (accountId: string, categoryId: string, amount = '100', extra = {}) => ({
  type: 'expense',
  accountId,
  categoryId,
  amount,
  currency: 'GEL',
  date: '2026-09-10',
  comment: 'Groceries',
  ...extra,
});
beforeAll(async () => {
  pg = new PGlite();
  db = embedded(pg);
  await migrate(db);
  owner = await user('Owner');
  member = await user('Member');
  outsider = await user('Outsider');
  family = await createFamily(db, owner, {
    name: 'Family',
    currency: 'GEL',
    timezone: 'Asia/Tbilisi',
  });
  await db.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'member')", [
    family.id,
    member.id,
  ]);
  await db.query('INSERT INTO exchange_rates(id,data) VALUES(1,$1)', [
    JSON.stringify({
      date: '2026-09-01',
      fetchedAt: new Date().toISOString(),
      provider: 'Test',
      rates: { USD: '1', GEL: '2.7', EUR: '0.9' },
    }),
  ]);
});
afterAll(async () => {
  await pg.close();
});
describe('money and transaction lifecycle', () => {
  it('recalculates 1000 - 70 - 200 = 730 when an earlier expense is edited', async () => {
    const a = await account(),
      c = await label();
    const tx = await save(owner, 'transaction.save', expense(a, c));
    await save(owner, 'transaction.save', expense(a, c, '200'));
    await save(owner, 'transaction.save', { ...expense(a, c, '70'), id: tx.id }, tx.version);
    expect(await balance(a)).toBe('730');
  });
  it('does decimal-safe arithmetic, including JPY minor units', async () => {
    const a = await account(owner, false, 'GEL', '0.3'),
      c = await label();
    await save(owner, 'transaction.save', expense(a, c, '0.1'));
    await save(owner, 'transaction.save', expense(a, c, '0.2'));
    expect(await balance(a)).toBe('0');
    const yen = await account(owner, false, 'JPY', '1');
    await expect(
      save(owner, 'transaction.save', expense(yen, c, '0.1', { currency: 'JPY' })),
    ).rejects.toThrow('valid amount');
  });
  it('deduplicates retried mutations and concurrent retries', async () => {
    const a = await account(),
      c = await label();
    const m: Mutation = {
      id: randomUUID(),
      command: 'transaction.save',
      input: expense(a, c, '15'),
    };
    const result = await Promise.all([
      mutate(db, owner, family.id, m),
      mutate(db, owner, family.id, m),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(await balance(a)).toBe('985');
  });
  it('records both actual transfer legs without income or expense', async () => {
    const a = await account(owner, false, 'USD', '200'),
      b = await account(owner, false, 'GEL', '0');
    const r = await save(owner, 'transaction.save', {
      type: 'transfer',
      accountId: a,
      toAccountId: b,
      amount: '100',
      currency: 'USD',
      toAmount: '258.50',
      date: '2026-09-10',
    });
    expect(await balance(a)).toBe('100');
    expect(await balance(b)).toBe('258.5');
    const s = await readSnapshot(db, owner.id, family.id);
    expect(
      totals(
        s.transactions.filter((t) => t.id === r.id),
        '2026-09',
        'shared',
        owner.id,
      ),
    ).toEqual({ spent: '0', income: '0', net: '0' });
  });
  it('refunds in the receipt month, enforces cumulative bounds, and keeps original month', async () => {
    const a = await account(),
      c = await label(),
      t = await save(owner, 'transaction.save', expense(a, c, '100'));
    const refund = {
      type: 'refund',
      originalId: t.id,
      amount: '40',
      currency: 'GEL',
      date: '2026-10-05',
    };
    const r = await save(owner, 'transaction.save', refund);
    expect(await balance(a)).toBe('940');
    const snapshot = await readSnapshot(db, owner.id, family.id),
      rows = snapshot.transactions.filter((tx) => [r.id, t.id].includes(tx.id));
    expect(totals(rows, '2026-09', 'shared', owner.id).spent).toBe('100');
    expect(totals(rows, '2026-10', 'shared', owner.id).spent).toBe('-40');
    await expect(save(owner, 'transaction.save', { ...refund, amount: '61' })).rejects.toThrow(
      'exceeds',
    );
    await expect(save(owner, 'transaction.delete', { id: t.id })).rejects.toThrow('refunds');
    await save(owner, 'transaction.delete', { id: r.id });
    await save(owner, 'transaction.delete', { id: t.id });
    expect(await balance(a)).toBe('1000');
  });
  it('freezes historical rates on edit and requires an adjustment reason', async () => {
    const a = await account(owner, false, 'USD', '100'),
      c = await label(),
      t = await save(owner, 'transaction.save', expense(a, c, '10', { currency: 'USD' }));
    await db.query(
      "UPDATE exchange_rates SET data=jsonb_set(data,'{rates,USD}','\"2\"') WHERE id=1",
    );
    await save(owner, 'transaction.save', {
      ...expense(a, c, '20', { currency: 'USD' }),
      id: t.id,
    });
    const row = (await readSnapshot(db, owner.id, family.id)).transactions.find(
      (x) => x.id === t.id,
    )!;
    expect(row.baseAmount).toBe('54.00');
    await expect(
      save(owner, 'transaction.save', {
        type: 'adjustment',
        accountId: a,
        amount: '5',
        currency: 'USD',
        date: '2026-09-15',
      }),
    ).rejects.toThrow('reason');
    await save(owner, 'transaction.save', {
      type: 'adjustment',
      accountId: a,
      amount: '-5',
      currency: 'USD',
      date: '2026-09-15',
      comment: 'Cash recount',
    });
    expect(await balance(a)).toBe('75');
  });
  it('writes both versions to the audit for a stale offline edit', async () => {
    const a = await account(),
      c = await label(),
      t = await save(owner, 'transaction.save', expense(a, c));
    await save(owner, 'transaction.save', { ...expense(a, c, '80'), id: t.id }, t.version);
    await save(owner, 'transaction.save', { ...expense(a, c, '60'), id: t.id }, t.version);
    expect(await balance(a)).toBe('940');
    const audit = await getAudit(db, owner.id, family.id, t.id);
    expect(audit.some((a) => a.conflict)).toBe(true);
  });
});
describe('isolation and permissions', () => {
  it('rejects an outsider even with a known family ID', async () => {
    await expect(readSnapshot(db, outsider.id, family.id)).rejects.toThrow('access');
    await expect(save(outsider, 'entity.save', { kind: 'expense', name: 'Bad' })).rejects.toThrow(
      'access',
    );
  });
  it('lets members create and correct their own shared operations only', async () => {
    const a = await account(),
      c = await label(),
      other = await save(owner, 'transaction.save', expense(a, c));
    await expect(
      save(member, 'transaction.save', { ...expense(a, c, '20'), id: other.id }),
    ).rejects.toThrow('cannot edit');
    const own = await save(member, 'transaction.save', expense(a, c));
    await save(member, 'transaction.save', { ...expense(a, c, '50'), id: own.id });
    await expect(save(member, 'entity.save', { kind: 'expense', name: 'Shared' })).rejects.toThrow(
      'cannot create',
    );
    await save(owner, 'transaction.delete', { id: own.id });
  });
  it('redacts private income, tags and audit even for family Owner', async () => {
    const a = await account(member, true),
      source = await label(owner, false, 'source');
    const t = await save(member, 'transaction.save', {
      type: 'income',
      accountId: a,
      categoryId: source,
      amount: '777.13',
      currency: 'GEL',
      date: '2026-09-12',
      comment: 'SECRET',
      tags: ['secret-tag'],
    });
    const publicSnapshot = await readSnapshot(db, owner.id, family.id),
      notice = publicSnapshot.transactions.find((x) => x.id === t.id)!;
    expect(notice.redacted).toBe(true);
    for (const field of [
      'amount',
      'accountAmount',
      'currency',
      'accountId',
      'categoryId',
      'comment',
      'tags',
      'rates',
      'baseAmount',
    ])
      expect(notice).not.toHaveProperty(field);
    expect(JSON.stringify(publicSnapshot)).not.toContain('SECRET');
    expect(publicSnapshot.entities.some((e) => e.id === a)).toBe(false);
    expect(await getAudit(db, owner.id, family.id, t.id)).toHaveLength(0);
    expect(
      (await readSnapshot(db, member.id, family.id)).transactions.find((x) => x.id === t.id)
        ?.amount,
    ).toBe('777.13');
  });
  it('allows mixed transfers only to the current user personal accounts', async () => {
    const shared = await account(),
      privateAccount = await account(member, true);
    const t = await save(member, 'transaction.save', {
      type: 'transfer',
      accountId: shared,
      toAccountId: privateAccount,
      amount: '45',
      currency: 'GEL',
      date: '2026-09-15',
    });
    expect(await balance(shared)).toBe('955');
    expect(await balance(privateAccount, member)).toBe('1045');
    expect(
      (await readSnapshot(db, owner.id, family.id)).transactions.find((x) => x.id === t.id)
        ?.redacted,
    ).toBe(true);
    await expect(
      save(owner, 'transaction.save', {
        type: 'transfer',
        accountId: shared,
        toAccountId: privateAccount,
        amount: '1',
        currency: 'GEL',
        date: '2026-09-15',
      }),
    ).rejects.toThrow('unavailable');
  });
  it('rejects mismatched expense scopes, immutable currency/visibility, invalid dates and archived new entries', async () => {
    const a = await account(member, true),
      c = await label();
    await expect(save(member, 'transaction.save', expense(a, c))).rejects.toThrow('visibility');
    const shared = await account(),
      e = (await readSnapshot(db, owner.id, family.id)).entities.find((e) => e.id === shared)!;
    await expect(save(owner, 'entity.save', { ...e, currency: 'USD' })).rejects.toThrow('currency');
    await expect(save(owner, 'entity.save', { ...e, ownerId: owner.id })).rejects.toThrow(
      'visibility',
    );
    await expect(
      save(owner, 'transaction.save', expense(shared, c, '10', { date: '2026-02-31' })),
    ).rejects.toThrow();
    await save(owner, 'entity.save', { ...e, archived: true });
    await expect(save(owner, 'transaction.save', expense(shared, c))).rejects.toThrow('archived');
  });
  it('prevents a malicious caller from overwriting a foreign object through a chosen mutation ID', async () => {
    const a = await account(),
      other = await createFamily(db, outsider, { name: 'Other', currency: 'GEL', timezone: 'UTC' });
    await expect(
      mutate(db, outsider, other.id, {
        id: a,
        command: 'entity.save',
        input: { kind: 'account', name: 'Overwritten', currency: 'USD' },
      }),
    ).rejects.toThrow();
    expect(
      (await readSnapshot(db, owner.id, family.id)).entities.find((e) => e.id === a)?.currency,
    ).toBe('GEL');
  });
  it('rejects foreign ID collisions at the write even if the preliminary lookup was stale', async () => {
    const a = await account(),
      c = await label(),
      t = await save(owner, 'transaction.save', expense(a, c, '42')),
      other = await createFamily(db, outsider, {
        name: 'Concurrent family',
        currency: 'GEL',
        timezone: 'UTC',
      });
    const otherAccount = await mutate(db, outsider, other.id, {
      id: randomUUID(),
      command: 'entity.save',
      input: { kind: 'account', name: 'Other account', currency: 'GEL', openingBalance: '500' },
    });
    const otherCategory = await mutate(db, outsider, other.id, {
      id: randomUUID(),
      command: 'entity.save',
      input: { kind: 'expense', name: 'Other category' },
    });
    // Emulate a preflight snapshot taken before another family committed the ID.
    // The actual INSERT/ON CONFLICT still runs against the real database state.
    const staleLookup: Database = {
      query: db.query,
      transaction: (fn) =>
        db.transaction((connection) =>
          fn({
            query: (sql, params) =>
              sql ===
              'SELECT id FROM entities WHERE id=$1 UNION ALL SELECT id FROM transactions WHERE id=$1'
                ? Promise.resolve({ rows: [] })
                : connection.query(sql, params),
          }),
        ),
    };
    await expect(
      mutate(staleLookup, outsider, other.id, {
        id: a,
        command: 'entity.save',
        input: { kind: 'account', name: 'Overwritten', currency: 'USD' },
      }),
    ).rejects.toThrow('already been used');
    await expect(
      mutate(staleLookup, outsider, other.id, {
        id: t.id,
        command: 'transaction.save',
        input: expense(otherAccount.id, otherCategory.id, '999'),
      }),
    ).rejects.toThrow('already been used');
    expect(await balance(a)).toBe('958');
    const original = await readSnapshot(db, owner.id, family.id);
    expect(original.entities.find((e) => e.id === a)?.currency).toBe('GEL');
    expect(original.transactions.find((tx) => tx.id === t.id)?.amount).toBe('42');
    expect(
      (await readSnapshot(db, outsider.id, other.id)).entities.find((e) => e.id === otherAccount.id)
        ?.balance,
    ).toBe('500.000000000');
  });
});
describe('family lifecycle and history', () => {
  it('preserves effective-dated budget limits and prevents deleting accounts with history', async () => {
    const c = await label(),
      a = await account();
    const t = await save(owner, 'transaction.save', expense(a, c));
    await save(owner, 'transaction.delete', { id: t.id });
    await expect(save(owner, 'entity.delete', { id: a })).rejects.toThrow('history');
    await save(owner, 'budget.save', { categoryId: c, limit: '100', currency: 'USD' });
    await save(owner, 'budget.save', { categoryId: c, limit: '120', currency: 'USD' });
    const budgets = (await readSnapshot(db, owner.id, family.id)).entities.filter(
      (e) => e.kind === 'budget' && e.categoryId === c,
    );
    expect(budgets).toHaveLength(1);
    expect(budgets[0].limit).toBe('120');
  });
  it('enforces invitation usage and existing membership consumes no activation', async () => {
    const code = (await invite(db, owner.id, family.id, { uses: 1, days: 3 })).code;
    expect((await join(db, member.id, code)).status).toBe('already');
    await join(db, outsider.id, code);
    const fourth = await user('Fourth');
    await expect(join(db, fourth.id, code)).rejects.toThrow('used up');
  });
  it('preserves shared ledger effects but erases departing private financial details', async () => {
    const departing = await user('Departing');
    await db.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'member')", [
      family.id,
      departing.id,
    ]);
    const shared = await account(),
      privateAccount = await account(departing, true);
    const transfer = await save(departing, 'transaction.save', {
      type: 'transfer',
      accountId: shared,
      toAccountId: privateAccount,
      amount: '123',
      currency: 'GEL',
      date: '2026-09-15',
      comment: 'erase me',
      tags: ['erase-me'],
    });
    await leave(db, departing.id, family.id);
    expect(await balance(shared)).toBe('877');
    expect(
      (await db.query('SELECT id FROM entities WHERE id=$1', [privateAccount])).rows,
    ).toHaveLength(0);
    const snapshot = await readSnapshot(db, owner.id, family.id);
    expect(snapshot.transactions.find((t) => t.id === transfer.id)?.redacted).toBe(true);
    expect(
      JSON.stringify(
        (await db.query('SELECT data FROM transactions WHERE id=$1', [transfer.id])).rows,
      ),
    ).not.toContain('123');
    await expect(readSnapshot(db, departing.id, family.id)).rejects.toThrow('access');
  });
  it('requires ownership transfer before leave or account deletion', async () => {
    await expect(leave(db, owner.id, family.id)).rejects.toThrow('ownership');
    await expect(deleteUser(db, owner.id)).rejects.toThrow('ownership');
  });
  it('delivers deletion tombstones and incremental changes', async () => {
    const a = await account(),
      c = await label(),
      t = await save(owner, 'transaction.save', expense(a, c));
    const cursor = (await readSnapshot(db, owner.id, family.id)).cursor;
    await save(owner, 'transaction.delete', { id: t.id });
    const changes = await readSnapshot(db, owner.id, family.id, cursor);
    expect(changes.transactions).toHaveLength(1);
    expect(changes.transactions[0].deleted).toBe(true);
  });
  it('includes tracked zero months and compares matching elapsed periods', () => {
    const f = { ...family, createdAt: '2026-06-15T00:00:00Z' };
    const report = comparison([], f, '2026-09', '2026-09-15', 'shared', owner.id);
    expect(report.count).toBe(2);
    expect(report.average).toBe('0.00');
    expect(report.ranges).toContain('2026-08-15');
    expect(comparison([], f, '2026-06', '2026-06-20', 'shared', owner.id).average).toBeNull();
  });
});

describe('persistence boundaries', () => {
  it('paginates history without duplicating records and sends changes after the watermark', async () => {
    const f = await createFamily(db, owner, {
      name: 'Pagination',
      currency: 'GEL',
      timezone: 'UTC',
    });
    const write = (command: string, input: Record<string, unknown>) =>
      mutate(db, owner, f.id, { id: randomUUID(), command, input });
    const a = (
      await write('entity.save', {
        kind: 'account',
        name: 'Card',
        currency: 'GEL',
        openingBalance: '1000',
      })
    ).id;
    const c = (await write('entity.save', { kind: 'expense', name: 'Food' })).id;
    for (let i = 0; i < 155; i++) await write('transaction.save', expense(a, c, '1'));
    const first = await readSnapshot(db, owner.id, f.id);
    expect(first.transactions).toHaveLength(150);
    expect(first.next).toBeTruthy();
    const second = await readSnapshot(db, owner.id, f.id, 0, first.cursor, first.next!);
    expect(second.transactions).toHaveLength(5);
    expect(second.next).toBeNull();
    expect(new Set([...first.transactions, ...second.transactions].map((t) => t.id)).size).toBe(
      155,
    );
    const changed = first.transactions[0];
    await write('transaction.save', { ...expense(a, c, '2'), id: changed.id });
    const delta = await readSnapshot(db, owner.id, f.id, first.cursor);
    expect(delta.transactions).toHaveLength(1);
    expect(delta.transactions[0].amount).toBe('2');
  });
  it('uses the persisted creation snapshot for a delayed offline mutation', async () => {
    const a = await account(owner, false, 'USD', '100'),
      c = await label();
    const snapshot = {
      date: '2026-01-01',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      provider: 'Archived quote',
      rates: { USD: '1', GEL: '3' },
    };
    await db.query('INSERT INTO rate_snapshots(fetched_at,data) VALUES($1,$2)', [
      snapshot.fetchedAt,
      JSON.stringify(snapshot),
    ]);
    const t = await save(
      owner,
      'transaction.save',
      expense(a, c, '10', { currency: 'USD', rateTimestamp: snapshot.fetchedAt }),
    );
    expect(
      (await readSnapshot(db, owner.id, family.id)).transactions.find((tx) => tx.id === t.id)
        ?.baseAmount,
    ).toBe('30.00');
  });
  it('deletes a sole-owner family, its ledger and the user session atomically', async () => {
    const solo = await user('Sole owner'),
      f = await createFamily(db, solo, { name: 'Delete me', currency: 'GEL', timezone: 'UTC' });
    const write = (command: string, input: Record<string, unknown>) =>
      mutate(db, solo, f.id, { id: randomUUID(), command, input });
    const a = (
      await write('entity.save', {
        kind: 'account',
        name: 'Card',
        currency: 'GEL',
        openingBalance: '20',
      })
    ).id;
    const c = (await write('entity.save', { kind: 'expense', name: 'Food' })).id;
    await write('transaction.save', expense(a, c, '5'));
    await deleteUser(db, solo.id);
    expect((await db.query('SELECT id FROM families WHERE id=$1', [f.id])).rows).toHaveLength(0);
    expect((await db.query('SELECT id FROM ledger WHERE family_id=$1', [f.id])).rows).toHaveLength(
      0,
    );
    expect((await db.query('SELECT id FROM users WHERE id=$1', [solo.id])).rows).toHaveLength(0);
  });
});
