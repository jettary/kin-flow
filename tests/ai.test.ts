import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { embedded, migrate, type Database } from '../src/server/db';
import { createFamily, mutate, readSnapshot, saveAiBatch } from '../src/server/service';
import {
  acceptAiNotice,
  aiStatus,
  prepareAi,
  reserveAiRequest,
  validateAiAudio,
} from '../src/server/ai';
import { aiCategories, possibleDuplicate, type AiDraft } from '../src/lib/ai';
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
const output = (extra = {}) => ({
  type: 'expense',
  account: null,
  destination: null,
  category: null,
  amount: '12.5',
  currency: null,
  accountAmount: null,
  toAmount: null,
  date: null,
  comment: 'Coffee',
  ...extra,
});
const provider = (operations = [output()]) =>
  vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ operations }) }] } },
        ],
      }),
      { status: 200 },
    ),
  );

beforeAll(async () => {
  pg = new PGlite();
  db = embedded(pg);
  await migrate(db);
});
beforeEach(async () => {
  await db.query('DELETE FROM families; DELETE FROM users; DELETE FROM ai_monthly_usage;');
  vi.stubEnv('GEMINI_API_KEY', 'synthetic-test-key');
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
  vi.unstubAllEnvs();
  await pg.close();
});

describe('AI preparation and privacy', () => {
  it('requires membership and a persistent first-use acknowledgement before spending quota', async () => {
    const send = provider();
    expect((await aiStatus(db, owner.id, family.id)).accepted).toBe(false);
    await expect(prepareAi(db, owner.id, family.id, { text: 'coffee' }, send)).rejects.toThrow(
      'notice',
    );
    expect(send).not.toHaveBeenCalled();
    expect((await aiStatus(db, owner.id, family.id)).remaining).toBe(1000);
    await acceptAiNotice(db, owner.id, family.id);
    expect((await aiStatus(db, owner.id, family.id)).accepted).toBe(true);
    await db.query('DELETE FROM memberships WHERE user_id=$1', [other.id]);
    await expect(prepareAi(db, other.id, family.id, { text: 'coffee' }, send)).rejects.toThrow(
      'access',
    );
  });
  it('sends only eligible names/currencies and local usage ordering; normalizes missing details', async () => {
    const privateAccount = await write(
      { kind: 'account', name: 'HIDDEN ACCOUNT', currency: 'USD', ownerId: other.id },
      other,
    );
    await write({ kind: 'expense', name: 'HIDDEN CATEGORY', ownerId: other.id }, other);
    await write({ kind: 'account', name: 'ARCHIVED', currency: 'GEL', archived: true });
    await mutate(db, owner, family.id, {
      id: randomUUID(),
      command: 'transaction.save',
      input: expense({ comment: 'HISTORY SECRET' }),
    });
    await acceptAiNotice(db, owner.id, family.id);
    const send = provider([
      output({ amount: null, account: privateAccount.id, category: 'invented', currency: null }),
    ]);
    const result = await prepareAi(
      db,
      owner.id,
      family.id,
      { text: 'Добавь только последнюю покупку, coffee' },
      send,
    );
    const body = String(send.mock.calls[0][1]!.body);
    expect(body).toContain('Добавь только последнюю');
    for (const secret of [
      'HIDDEN ACCOUNT',
      'HIDDEN CATEGORY',
      'ARCHIVED',
      'HISTORY SECRET',
      'Family identity',
      owner.id,
      accountId,
    ])
      expect(body).not.toContain(secret);
    const sentContext = JSON.parse(JSON.parse(body).contents[0].parts[0].text).context;
    expect(sentContext.entities.every((e: Record<string, unknown>) => !('balance' in e))).toBe(
      true,
    );
    expect(result.drafts[0]).toMatchObject({
      amount: '',
      currency: 'GEL',
      accountId,
      categoryId,
      date: localDate(family.timezone),
    });
    expect(result.status.remaining).toBe(999);
    expect((await readSnapshot(db, owner.id, family.id)).transactions).toHaveLength(1);
    expect((await db.query('SELECT * FROM ai_batch_receipts')).rows).toHaveLength(0);
  });
  it('rechecks family access after AI finishes', async () => {
    await acceptAiNotice(db, other.id, family.id);
    const send: typeof fetch = async () => {
      await db.query('DELETE FROM memberships WHERE user_id=$1', [other.id]);
      return provider()('', {});
    };
    await expect(prepareAi(db, other.id, family.id, { text: 'coffee' }, send)).rejects.toThrow(
      'access',
    );
  });
  it('accepts Russian/English text together with validated audio, never uploads a file', async () => {
    await acceptAiNotice(db, owner.id, family.id);
    const audio = wav(16000);
    const send = provider([
      output({ comment: 'Кофе', amount: '12,50' }),
      output({ type: 'income', amount: '50' }),
    ]);
    const result = await prepareAi(
      db,
      owner.id,
      family.id,
      { text: 'Кофе and salary', audio: { mimeType: 'audio/wav', data: audio } },
      send,
    );
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0].amount).toBe('12.50');
    const body = JSON.parse(String(send.mock.calls[0][1]!.body));
    expect(body.contents[0].parts[1].inlineData.data).toBe(audio);
    expect(send.mock.calls[0][0]).toMatch(/:generateContent$/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects images, oversized inputs, invalid audio and excess duration before quota use', async () => {
    await acceptAiNotice(db, owner.id, family.id);
    for (const input of [
      {},
      { text: 'a'.repeat(8001) },
      { image: 'anything' },
      { audio: { mimeType: 'image/png', data: 'AAAA' } },
      { audio: { mimeType: 'audio/wav', data: 'AAAA' } },
    ]) {
      await expect(prepareAi(db, owner.id, family.id, input, provider())).rejects.toThrow();
    }
    expect(() => validateAiAudio(wav(16000 * 60))).not.toThrow();
    expect(() => validateAiAudio(wav(16000 * 60 + 1))).toThrow('one minute');
    const spoof = Buffer.from(wav(16000), 'base64');
    spoof.writeUInt32LE(8000, 24);
    expect(() => validateAiAudio(spoof.toString('base64'))).toThrow('Invalid audio');
    expect((await aiStatus(db, owner.id, family.id)).remaining).toBe(1000);
  });
  it('counts a failed provider attempt once and rejects malformed or truncated model output', async () => {
    await acceptAiNotice(db, owner.id, family.id);
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret provider content'));
    await expect(prepareAi(db, owner.id, family.id, { text: 'coffee' }, send)).rejects.toThrow(
      'AI could not prepare',
    );
    expect(send).toHaveBeenCalledTimes(1);
    for (const envelope of [
      { candidates: [{ finishReason: 'MAX_TOKENS' }] },
      {
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: '{"operations":[{"type":"delete"}]}' }] },
          },
        ],
      },
    ]) {
      await expect(
        prepareAi(
          db,
          owner.id,
          family.id,
          { text: 'coffee' },
          async () => new Response(JSON.stringify(envelope)),
        ),
      ).rejects.toThrow();
    }
    expect((await aiStatus(db, owner.id, family.id)).remaining).toBe(997);
  });
});

describe('global monthly quota', () => {
  it('allows only one concurrent request at the boundary and resets by UTC calendar month', async () => {
    await db.query(
      "INSERT INTO ai_monthly_usage VALUES(date_trunc('month',now() AT TIME ZONE 'UTC')::date,999)",
    );
    const attempts = await Promise.allSettled([
      reserveAiRequest(db),
      reserveAiRequest(db),
      reserveAiRequest(db),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await aiStatus(db, other.id, family.id)).toMatchObject({
      available: false,
      remaining: 0,
      reason: 'quota',
    });
    const send = provider();
    await acceptAiNotice(db, owner.id, family.id);
    await expect(prepareAi(db, owner.id, family.id, { text: 'coffee' }, send)).rejects.toThrow(
      'monthly AI limit',
    );
    expect(send).not.toHaveBeenCalled();
    await db.query("UPDATE ai_monthly_usage SET month=month-interval '1 month'");
    await reserveAiRequest(db);
    expect((await aiStatus(db, owner.id, family.id)).remaining).toBe(999);
  });
});

describe('atomic AI save', () => {
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
  it('warns about duplicates locally without excluding them or exposing redacted records', async () => {
    const r = await saveAiBatch(db, owner, family.id, batch([expense()]));
    const snapshot = await readSnapshot(db, owner.id, family.id);
    const draft = {
      ...expense(),
      amount: '10.00',
      accountAmount: '',
      toAmount: '',
      toAccountId: '',
      baseAmount: '',
      comment: '',
    } as AiDraft;
    expect(possibleDuplicate(draft, snapshot.transactions)).toBe(true);
    expect(
      possibleDuplicate(
        draft,
        snapshot.transactions.map((t) => ({ ...t, redacted: true })),
      ),
    ).toBe(false);
    expect(possibleDuplicate({ ...draft, amount: '' }, snapshot.transactions)).toBe(false);
    expect(
      aiCategories(
        snapshot.entities,
        snapshot.entities.find((e) => e.id === accountId),
        'expense',
      ).map((e) => e.id),
    ).toContain(categoryId);
    expect(r.ids).toHaveLength(1);
  });
});

function wav(samples: number) {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b.toString('base64');
}
