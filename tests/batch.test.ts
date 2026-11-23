import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { embedded, migrate, type Database } from '../src/server/db';
import { createFamily, mutate, readSnapshot, saveAiBatch } from '../src/server/service';
import { localDate } from '../src/lib/money';
import type { Family, User } from '../src/lib/model';

let pg: PGlite, db: Database, owner: User, other: User, family: Family;
let accountId: string, categoryId: string;
const write = (input: Record<string, unknown>, user = owner) =>
  mutate(db, user, family.id, { id: randomUUID(), command: 'entity.save', input });
const expense = (extra = {}) => ({
  type: 'expense',
  accountId,
  categoryId,
  amount: '10',
  currency: 'GEL',
  date: '2026-09-29',
  ...extra,
});
const batch = (operations: Record<string, unknown>[]) => ({ id: randomUUID(), operations });
beforeAll(async () => {
  pg = new PGlite();
  db = embedded(pg);
  await migrate(db);
});
beforeEach(async () => {
  await db.query('DELETE FROM families; DELETE FROM users;');
  owner = { id: randomUUID(), name: 'Owner' };
  other = { id: randomUUID(), name: 'Other' };
  for (const u of [owner, other])
    await db.query('INSERT INTO users(id,google_id,name) VALUES($1,$2,$3)', [u.id, u.id, u.name]);
  family = await createFamily(db, owner, {
    name: 'Family identity',
    currency: 'GEL',
    timezone: 'Asia/Tbilisi',
  });
  await db.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'member')", [
    family.id,
    other.id,
  ]);
  accountId = (
    await write({ kind: 'account', name: 'Everyday', currency: 'GEL', openingBalance: '100' })
  ).id;
  categoryId = (await write({ kind: 'expense', name: 'Groceries' })).id;
});
afterAll(async () => {
  await pg.close();
});
describe('atomic batch save', () => {
  it('rolls back all balances, audits, receipts and push jobs when any card fails, then retries safely', async () => {
    const before = await readSnapshot(db, owner.id, family.id);
    const request = batch([expense(), expense({ categoryId: randomUUID() })]);
    await expect(saveAiBatch(db, owner, family.id, request)).rejects.toThrow('Entry 2');
    const after = await readSnapshot(db, owner.id, family.id);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.entities).toEqual(before.entities);
    expect(after.cursor).toBe(before.cursor);
    expect((await db.query('SELECT * FROM ai_batch_receipts')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM push_outbox')).rows).toHaveLength(0);
    request.operations[1] = expense({ amount: '20' });
    const results = await Promise.all([
      saveAiBatch(db, owner, family.id, request),
      saveAiBatch(db, owner, family.id, request),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].ids).toHaveLength(2);
    expect(
      (await readSnapshot(db, owner.id, family.id)).entities.find((e) => e.id === accountId)!
        .balance,
    ).toBe('70.000000000');
  });
  it('supports income and cross-currency shared/personal transfers with the existing visibility rules', async () => {
    const usd = (
      await write({
        kind: 'account',
        name: 'Personal USD',
        currency: 'USD',
        ownerId: owner.id,
        openingBalance: '100',
      })
    ).id;
    const source = (await write({ kind: 'source', name: 'Salary' })).id;
    const result = await saveAiBatch(
      db,
      owner,
      family.id,
      batch([
        expense(),
        {
          type: 'income',
          accountId,
          categoryId: source,
          amount: '50',
          currency: 'GEL',
          date: '2026-09-29',
        },
        {
          type: 'transfer',
          accountId: usd,
          toAccountId: accountId,
          amount: '10',
          currency: 'USD',
          toAmount: '27',
          baseAmount: '27',
          date: '2026-09-29',
        },
      ]),
    );
    const mine = await readSnapshot(db, owner.id, family.id);
    expect(mine.transactions).toHaveLength(3);
    const others = await readSnapshot(db, other.id, family.id);
    const redacted = others.transactions.find((t) => t.id === result.ids[2])!;
    expect(redacted.redacted).toBe(true);
    expect(redacted.amount).toBeUndefined();
    expect(others.entities.some((e) => e.id === usd)).toBe(false);
  });
  it('forbids edits/refunds, other users’ accounts and incompatible visibility, even with crafted input', async () => {
    const hidden = (
      await write({ kind: 'account', name: 'Hidden', currency: 'GEL', ownerId: other.id }, other)
    ).id;
    const personal = (
      await write({ kind: 'account', name: 'Mine', currency: 'GEL', ownerId: owner.id })
    ).id;
    for (const op of [
      expense({ id: randomUUID() }),
      expense({ type: 'refund' }),
      expense({ accountId: hidden }),
      expense({ accountId: personal }),
    ]) {
      await expect(saveAiBatch(db, owner, family.id, batch([expense(), op]))).rejects.toThrow();
    }
    expect((await readSnapshot(db, owner.id, family.id)).transactions).toHaveLength(0);
  });
});
