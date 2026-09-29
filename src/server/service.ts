import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import type { DB, Database } from './db';
import { AppError, requireThat } from './errors';
import { rates } from './rates';
import { enqueuePush } from './push';
import { pushEvent, type PushEvent } from '../lib/push';
import { AI_MAX_ENTRIES } from '../lib/ai';
import { D, convert, currencyCodes, validAmount, localDate } from '../lib/money';
import {
  canEdit,
  canManage,
  categoryTemplates,
  sourceTemplates,
  type Entity,
  type Family,
  type Member,
  type Mutation,
  type Role,
  type Transaction,
  type User,
} from '../lib/model';
const uuid = z.string().uuid();
const short = z.string().trim().min(1).max(100);
const currency = z.enum(currencyCodes as [string, ...string[]]);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s,
    'Invalid date',
  );
const decimal = z.string().regex(/^-?\d{1,18}(\.\d{1,9})?$/);
const timezone = z.string().refine((s) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: s });
    return true;
  } catch {
    return false;
  }
}, 'Invalid time zone');
const entitySchema = z.object({
  id: uuid.optional(),
  kind: z.enum(['account', 'expense', 'source']),
  name: short,
  icon: z.string().max(30).default('wallet'),
  ownerId: uuid.nullable().default(null),
  currency: currency.optional(),
  accountType: z
    .enum(['Card', 'Cash', 'Deposit', 'Bank account', 'Investment', 'Other'])
    .optional(),
  bank: z.string().max(100).optional(),
  openingBalance: decimal.optional(),
  openingDate: date.optional(),
  included: z.boolean().optional(),
  archived: z.boolean().optional(),
});
const transactionSchema = z.object({
  id: uuid.optional(),
  type: z.enum(['expense', 'income', 'transfer', 'adjustment', 'refund']),
  date,
  accountId: uuid.optional(),
  toAccountId: uuid.optional(),
  categoryId: uuid.optional(),
  amount: decimal,
  currency: currency,
  accountAmount: decimal.optional(),
  toAmount: decimal.optional(),
  baseAmount: decimal.optional(),
  comment: z.string().trim().max(2000).default(''),
  tags: z.array(z.string().trim().max(40)).max(12).default([]),
  originalId: uuid.optional(),
  rateTimestamp: z.string().datetime().optional(),
});
export interface EntityRow {
  id: string;
  family_id: string;
  owner_id: string | null;
  kind: Entity['kind'];
  data: Partial<Entity>;
  version: string;
}
export interface TxRow {
  id: string;
  family_id: string;
  owner_id: string | null;
  author_id: string | null;
  type: Transaction['type'];
  date: string;
  data: Partial<Transaction>;
  notice: boolean;
  redacted: boolean;
  deleted: boolean;
  version: string;
  author_name?: string;
}
export function mapEntity(r: EntityRow): Entity {
  return {
    ...r.data,
    id: r.id,
    familyId: r.family_id,
    ownerId: r.owner_id,
    kind: r.kind,
    version: Number(r.version),
  } as Entity;
}
export function mapTransaction(r: TxRow, userId: string): Transaction {
  const publicFields = {
    id: r.id,
    familyId: r.family_id,
    ownerId: r.owner_id,
    type: r.type,
    date: r.date,
    version: Number(r.version),
    deleted: r.deleted,
    authorId: r.author_id,
    authorName: r.author_name || 'Former member',
  };
  if (r.redacted || (r.owner_id && r.owner_id !== userId))
    return {
      ...publicFields,
      ownerId: null,
      authorId: null,
      authorName: undefined,
      redacted: true,
      notice: true,
    };
  return { ...r.data, ...publicFields, notice: r.notice };
}
export async function membership(
  db: DB,
  userId: string,
  familyId: string,
  lock = false,
): Promise<Family> {
  uuid.parse(familyId);
  // Read permissions in a fresh statement after acquiring the mutation lock:
  // a role change may have committed while this request was waiting.
  if (lock) await db.query('SELECT id FROM families WHERE id=$1 FOR UPDATE', [familyId]);
  const r = (
    await db.query<{
      id: string;
      name: string;
      currency: string;
      timezone: string;
      created_at: Date | string;
      role: Role;
      version: string;
    }>(
      'SELECT f.*,m.role FROM families f JOIN memberships m ON m.family_id=f.id WHERE f.id=$1 AND m.user_id=$2',
      [familyId, userId],
    )
  ).rows[0];
  requireThat(r, 'You no longer have access to this family.', 403);
  return {
    id: r.id,
    name: r.name,
    currency: r.currency,
    timezone: r.timezone,
    createdAt: new Date(r.created_at).toISOString(),
    role: r.role,
    version: Number(r.version),
  };
}
export async function listFamilies(db: DB, userId: string) {
  const rows = (
    await db.query<{ family_id: string }>(
      'SELECT family_id FROM memberships WHERE user_id=$1 ORDER BY joined_at',
      [userId],
    )
  ).rows;
  const families: Family[] = [];
  for (const row of rows) families.push(await membership(db, userId, row.family_id));
  return families;
}
export async function getEntities(db: DB, userId: string, familyId: string): Promise<Entity[]> {
  const result = (
    await db.query<EntityRow>(
      `SELECT * FROM entities WHERE family_id=$1 AND (owner_id IS NULL OR owner_id=$2)`,
      [familyId, userId],
    )
  ).rows.map(mapEntity);
  const balances = (
    await db.query<{ account_id: string; balance: string }>(
      `SELECT l.account_id,SUM(l.amount)::text balance FROM ledger l JOIN entities a ON a.id=l.account_id WHERE l.family_id=$1 AND (a.owner_id IS NULL OR a.owner_id=$2) GROUP BY l.account_id`,
      [familyId, userId],
    )
  ).rows;
  for (const e of result)
    if (e.kind === 'account')
      e.balance = balances.find((b) => b.account_id === e.id)?.balance || '0';
  return result.sort((a, b) => (a.order || 0) - (b.order || 0));
}
async function getEntity(
  db: DB,
  userId: string,
  familyId: string,
  id: unknown,
  kind?: Entity['kind'],
) {
  uuid.parse(id);
  const row = (
    await db.query<EntityRow>(
      'SELECT * FROM entities WHERE id=$1 AND family_id=$2 AND (owner_id IS NULL OR owner_id=$3)',
      [id, familyId, userId],
    )
  ).rows[0];
  requireThat(row && (!kind || row.kind === kind), 'This item is unavailable.', 404);
  return mapEntity(row);
}
async function getTx(db: DB, userId: string, familyId: string, id: unknown) {
  uuid.parse(id);
  const row = (
    await db.query<TxRow>(
      'SELECT * FROM transactions WHERE id=$1 AND family_id=$2 AND (owner_id IS NULL OR owner_id=$3) AND redacted=false',
      [id, familyId, userId],
    )
  ).rows[0];
  requireThat(row, 'Transaction not found.', 404);
  return mapTransaction(row, userId);
}
async function audit(
  db: DB,
  familyId: string,
  userId: string,
  objectId: string,
  ownerId: string | null,
  action: string,
  before: unknown,
  after: unknown,
  conflict = false,
) {
  await db.query(
    'INSERT INTO audits(id,family_id,object_id,owner_id,actor_id,action,before_data,after_data,conflict) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      randomUUID(),
      familyId,
      objectId,
      ownerId,
      userId,
      action,
      JSON.stringify(before),
      JSON.stringify(after),
      conflict,
    ],
  );
}
async function putEntity(db: DB, e: Entity) {
  const { id, familyId, ownerId, kind, version, ...data } = e;
  const result = await db.query(
    'INSERT INTO entities(id,family_id,owner_id,kind,data,version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET data=$5,version=$6 WHERE entities.family_id=EXCLUDED.family_id AND entities.owner_id IS NOT DISTINCT FROM EXCLUDED.owner_id AND entities.kind=EXCLUDED.kind RETURNING id',
    [id, familyId, ownerId, kind, JSON.stringify(data), version],
  );
  requireThat(result.rows.length === 1, 'This operation ID has already been used.', 409);
}
async function writeLedger(
  db: DB,
  familyId: string,
  accountId: string,
  txId: string | null,
  amount: string,
  opening = false,
) {
  await db.query(
    "INSERT INTO ledger(id,family_id,account_id,transaction_id,amount,opening,date) VALUES($1,$2,$3,$4,$5,$6,COALESCE((SELECT date FROM transactions WHERE id=$4),(SELECT data->>'openingDate' FROM entities WHERE id=$3)))",
    [randomUUID(), familyId, accountId, txId, amount, opening],
  );
}
export async function createFamily(
  database: Database,
  user: User,
  input: unknown,
): Promise<Family> {
  const v = z
    .object({ name: short, currency, timezone, templates: z.array(z.string()).max(16).default([]) })
    .parse(input);
  return database.transaction(async (db) => {
    const id = randomUUID();
    await db.query('INSERT INTO families(id,name,currency,timezone) VALUES($1,$2,$3,$4)', [
      id,
      v.name,
      v.currency,
      v.timezone,
    ]);
    await db.query('INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,$3)', [
      id,
      user.id,
      'owner',
    ]);
    for (const [name, icon, kind] of [
      ...categoryTemplates.map((t) => [...t, 'expense'] as const),
      ...sourceTemplates.map((t) => [...t, 'source'] as const),
    ])
      if (v.templates.includes(name))
        await putEntity(db, {
          id: randomUUID(),
          familyId: id,
          ownerId: null,
          kind: kind as 'expense' | 'source',
          name,
          icon,
          archived: false,
          order: v.templates.indexOf(name),
          version: 0,
        });
    return membership(db, user.id, id);
  });
}
export async function readSnapshot(
  database: Database,
  userId: string,
  familyId: string,
  after = 0,
  until?: number,
  pageAfter = '',
) {
  requireThat(
    Number.isSafeInteger(after) &&
      after >= 0 &&
      (until === undefined || (Number.isSafeInteger(until) && until >= after)),
    'Invalid sync cursor.',
  );
  return database.transaction(async (db) => {
    // The family lock gives metadata, balances and the first page one consistent watermark.
    const family = await membership(db, userId, familyId, true);
    const cursor = Math.min(until ?? family.version, family.version);
    const entities = await getEntities(db, userId, familyId);
    const members = await db.query<Member>(
      'SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE family_id=$1 ORDER BY joined_at',
      [familyId],
    );
    const book = await rates(db);
    const [pageVersion, pageId] = pageAfter
      ? pageAfter.split(':')
      : ['-1', '00000000-0000-0000-0000-000000000000'];
    requireThat(/^\d+$/.test(pageVersion) || pageVersion === '-1', 'Invalid page.');
    uuid.parse(pageId);
    const rows = (
      await db.query<TxRow>(
        `SELECT t.*,u.name author_name FROM transactions t LEFT JOIN users u ON u.id=t.author_id WHERE t.family_id=$1 AND (t.owner_id IS NULL OR t.owner_id=$2 OR t.notice=true) AND t.version >= $3 AND t.version <= $4 AND (t.version,t.id)>($5::bigint,$6::uuid) ORDER BY t.version,t.id LIMIT 151`,
        [familyId, userId, after ? after + 1 : 0, cursor, pageVersion, pageId],
      )
    ).rows;
    const last = rows[149];
    return {
      family,
      entities,
      members: members.rows,
      rates: book,
      transactions: rows.slice(0, 150).map((r) => mapTransaction(r, userId)),
      cursor,
      next: rows.length > 150 ? `${last.version}:${last.id}` : null,
      syncedAt: new Date().toISOString(),
    };
  });
}
type PushOperation = { event: PushEvent; changed: boolean };

export async function mutate(database: Database, user: User, familyId: string, mutation: Mutation) {
  return database.transaction((db) => applyMutation(db, user, familyId, mutation));
}

async function applyMutation(
  db: DB,
  user: User,
  familyId: string,
  mutation: Mutation,
  batchEvents?: PushOperation[],
) {
  const m = z
    .object({
      id: uuid,
      command: z.string().max(50),
      input: z.record(z.string(), z.unknown()),
      baseVersion: z.number().int().nonnegative().optional(),
    })
    .parse(mutation);
  const family = await membership(db, user.id, familyId, true);
  const receipt = (
    await db.query<{ result: { id: string; version: number } }>(
      'SELECT result FROM mutation_receipts WHERE family_id=$1 AND user_id=$2 AND mutation_id=$3',
      [familyId, user.id, m.id],
    )
  ).rows[0];
  if (receipt) return receipt.result;
  const version = family.version + 1;
  let resultId = m.id;
  const admin = () =>
    requireThat(family.role !== 'member', 'Only an owner or admin can do this.', 403);
  if (m.command === 'entity.save') {
    const v = entitySchema.parse(m.input);
    const old = v.id ? await getEntity(db, user.id, familyId, v.id) : null;
    if (old) {
      requireThat(canManage(old, family.role, user.id), 'You cannot change this item.', 403);
      requireThat(
        old.kind === v.kind && old.ownerId === v.ownerId,
        'Kind and visibility cannot change.',
      );
    } else
      requireThat(
        v.ownerId === user.id || (!v.ownerId && family.role !== 'member'),
        'You cannot create this item.',
        403,
      );
    const id = old?.id || m.id;
    resultId = id;
    if (!old)
      requireThat(
        !(
          await db.query(
            'SELECT id FROM entities WHERE id=$1 UNION ALL SELECT id FROM transactions WHERE id=$1',
            [id],
          )
        ).rows.length,
        'This operation ID has already been used.',
        409,
      );
    if (v.kind === 'account') {
      requireThat(v.currency, 'Select an account currency.');
      requireThat(!old || old.currency === v.currency, 'Account currency cannot change.');
      requireThat(
        validAmount(v.openingBalance || '0', v.currency, true),
        'Invalid opening balance.',
      );
    }
    const e: Entity = {
      ...old,
      ...v,
      id,
      familyId,
      ownerId: v.ownerId,
      archived: v.archived ?? old?.archived ?? false,
      order: old?.order ?? Date.now(),
      version,
    };
    if (old) {
      e.openingBalance = old.openingBalance;
      e.openingDate = old.openingDate;
    } else if (v.kind === 'account') {
      e.openingDate = v.openingDate || localDate(family.timezone);
      e.included = v.included ?? true;
    }
    await putEntity(db, e);
    if (!old && v.kind === 'account')
      await writeLedger(db, familyId, id, null, v.openingBalance || '0', true);
    await audit(
      db,
      familyId,
      user.id,
      id,
      e.ownerId,
      old ? 'Item updated' : 'Item created',
      old,
      e,
    );
  } else if (m.command === 'entity.delete') {
    const e = await getEntity(db, user.id, familyId, m.input.id);
    requireThat(canManage(e, family.role, user.id), 'You cannot delete this item.', 403);
    const used = (
      await db.query(
        "SELECT id FROM transactions WHERE family_id=$1 AND (data->>'accountId'=$2 OR data->>'toAccountId'=$2 OR data->>'categoryId'=$2) LIMIT 1",
        [familyId, e.id],
      )
    ).rows.length;
    const retainedLedger =
      e.kind === 'account'
        ? (
            await db.query('SELECT id FROM ledger WHERE account_id=$1 AND opening=false LIMIT 1', [
              e.id,
            ])
          ).rows.length
        : 0;
    requireThat(!used && !retainedLedger, 'This item has history. Archive it instead.');
    await db.query('DELETE FROM entities WHERE family_id=$1 AND id=$2', [familyId, e.id]);
    await db.query(
      "DELETE FROM entities WHERE family_id=$1 AND kind='budget' AND data->>'categoryId'=$2",
      [familyId, e.id],
    );
    await audit(db, familyId, user.id, e.id, e.ownerId, 'Item deleted', e, null);
    resultId = e.id;
  } else if (m.command === 'entity.move') {
    const v = z.object({ id: uuid, direction: z.enum(['up', 'down']) }).parse(m.input);
    const e = await getEntity(db, user.id, familyId, v.id);
    requireThat(canManage(e, family.role, user.id), 'You cannot reorder this item.', 403);
    const list = (await getEntities(db, user.id, familyId)).filter(
      (x) => x.kind === e.kind && x.ownerId === e.ownerId,
    );
    const index = list.findIndex((x) => x.id === e.id),
      other = list[index + (v.direction === 'up' ? -1 : 1)];
    if (other) {
      [list[index], list[index + (v.direction === 'up' ? -1 : 1)]] = [other, e];
      for (let i = 0; i < list.length; i++) await putEntity(db, { ...list[i], order: i, version });
    }
    resultId = e.id;
    await audit(db, familyId, user.id, e.id, e.ownerId, 'Order changed', null, v);
  } else if (m.command === 'budget.save') {
    const v = z
      .object({
        categoryId: uuid,
        limit: decimal,
        currency,
        archived: z.boolean().default(false),
      })
      .parse(m.input);
    const category = await getEntity(db, user.id, familyId, v.categoryId, 'expense');
    requireThat(canManage(category, family.role, user.id), 'You cannot change this budget.', 403);
    requireThat(validAmount(v.limit, v.currency), 'Invalid budget limit.');
    const effectiveMonth = localDate(family.timezone).slice(0, 7);
    const old = (await getEntities(db, user.id, familyId)).find(
      (e) =>
        e.kind === 'budget' && e.categoryId === category.id && e.effectiveMonth === effectiveMonth,
    );
    if (!old)
      requireThat(
        !(
          await db.query(
            'SELECT id FROM entities WHERE id=$1 UNION ALL SELECT id FROM transactions WHERE id=$1',
            [m.id],
          )
        ).rows.length,
        'This operation ID has already been used.',
        409,
      );
    const e: Entity = {
      id: old?.id || m.id,
      familyId,
      ownerId: category.ownerId,
      kind: 'budget',
      name: category.name,
      icon: category.icon,
      order: category.order,
      version,
      effectiveMonth,
      ...v,
    };
    await putEntity(db, e);
    await audit(db, familyId, user.id, e.id, e.ownerId, 'Budget changed', old, e);
    resultId = e.id;
  } else if (m.command === 'transaction.save') {
    const v = transactionSchema.parse(m.input);
    const old = v.id ? await getTx(db, user.id, familyId, v.id) : null;
    if (old) {
      requireThat(canEdit(old, family.role, user.id), 'You cannot edit this transaction.', 403);
      requireThat(v.type === old.type, 'Transaction type cannot change.');
      requireThat(old.type !== 'refund', 'Delete the refund and record a replacement.');
    }
    const id = old?.id || m.id;
    resultId = id;
    if (!old)
      requireThat(
        !(
          await db.query(
            'SELECT id FROM entities WHERE id=$1 UNION ALL SELECT id FROM transactions WHERE id=$1',
            [id],
          )
        ).rows.length,
        'This operation ID has already been used.',
        409,
      );
    const linked = (
      await db.query(
        "SELECT id FROM transactions WHERE family_id=$1 AND data->>'originalId'=$2 AND deleted=false",
        [familyId, id],
      )
    ).rows;
    requireThat(
      !linked.length,
      'This purchase has refunds. Delete its refunds before editing the purchase.',
    );
    let original: Transaction | null = null;
    if (v.type === 'refund') {
      original = await getTx(db, user.id, familyId, v.originalId);
      requireThat(
        original.type === 'expense' && canEdit(original, family.role, user.id),
        'This purchase cannot be refunded.',
        403,
      );
      requireThat(v.date >= original.date, 'A refund cannot precede its purchase.');
      v.accountId = original.accountId;
      v.categoryId = original.categoryId;
      v.currency = (
        await getEntity(db, user.id, familyId, original.accountId, 'account')
      ).currency!;
      v.accountAmount = v.amount;
    }
    const account = await getEntity(db, user.id, familyId, v.accountId, 'account');
    requireThat(
      !account.archived || !!original || old?.accountId === account.id,
      'This account is archived.',
    );
    let destination: Entity | null = null,
      category: Entity | null = null;
    if (v.type === 'transfer') {
      destination = await getEntity(db, user.id, familyId, v.toAccountId, 'account');
      requireThat(account.id !== destination.id, 'Choose two different accounts.');
      requireThat(
        !destination.archived || old?.toAccountId === destination.id,
        'The destination is archived.',
      );
    }
    if (['expense', 'income', 'refund'].includes(v.type)) {
      category = await getEntity(
        db,
        user.id,
        familyId,
        v.categoryId,
        v.type === 'income' ? 'source' : 'expense',
      );
      requireThat(
        !category.archived || !!original || old?.categoryId === category.id,
        'This category is archived.',
      );
      requireThat(
        category.ownerId === account.ownerId ||
          (v.type === 'income' && !category.ownerId && account.ownerId === user.id),
        'Choose a category with matching visibility.',
      );
    }
    const ownerId = account.ownerId || destination?.ownerId || null;
    const notice =
      (v.type === 'income' && !!account.ownerId && !category?.ownerId) ||
      (v.type === 'transfer' && account.ownerId !== destination?.ownerId);
    const amount = v.amount;
    requireThat(
      validAmount(amount, v.currency, v.type === 'adjustment') &&
        (v.type === 'adjustment' || D(amount).gt(0)),
      'Enter a valid amount for this currency.',
    );
    const accountAmount = v.currency === account.currency ? amount : v.accountAmount;
    requireThat(
      accountAmount &&
        validAmount(accountAmount, account.currency!, v.type === 'adjustment') &&
        (v.type === 'adjustment' || D(accountAmount).gt(0)),
      'Enter the actual account amount.',
    );
    if (v.type === 'transfer' || v.type === 'adjustment')
      requireThat(v.currency === account.currency, 'Use the source account currency.');
    if (v.type === 'adjustment')
      requireThat(v.comment.trim(), 'A reason is required for an adjustment.');
    let toAmount: string | undefined;
    if (destination) {
      toAmount = destination.currency === account.currency ? accountAmount : v.toAmount;
      requireThat(
        toAmount && validAmount(toAmount, destination.currency!) && D(toAmount).gt(0),
        'Enter the actual amount received.',
      );
    }
    if (original) {
      const refunds = (
        await db.query<{ data: Transaction }>(
          "SELECT data FROM transactions WHERE family_id=$1 AND data->>'originalId'=$2 AND deleted=false",
          [familyId, original.id],
        )
      ).rows;
      const refunded = refunds.reduce((acc, r) => acc.plus(r.data.accountAmount!), D());
      requireThat(
        refunded.plus(accountAmount).lte(original.accountAmount!),
        'Refund exceeds the unrefunded amount.',
      );
    }
    // Preserve historical reporting rates on edits; a new market quote must not rewrite old totals.
    let book = old?.rates || (await rates(db));
    if (!old && v.rateTimestamp && book?.fetchedAt !== v.rateTimestamp) {
      const stored = (
        await db.query<{ data: import('../lib/model').RateBook }>(
          'SELECT data FROM rate_snapshots WHERE fetched_at=$1',
          [v.rateTimestamp],
        )
      ).rows[0];
      requireThat(
        stored,
        'The saved exchange rate is unavailable. Re-enter the transaction with a reporting amount.',
      );
      book = stored.data;
    }
    const baseAmount =
      convert(accountAmount, account.currency!, family.currency, book) ?? v.baseAmount;
    requireThat(
      baseAmount !== undefined && validAmount(baseAmount, family.currency, v.type === 'adjustment'),
      'No reporting rate is available. Enter the amount in the family currency.',
    );
    const tx: Transaction = {
      id,
      familyId,
      ownerId,
      type: v.type,
      date: v.date,
      authorId: old ? old.authorId : user.id,
      version,
      deleted: false,
      notice,
      accountId: account.id,
      toAccountId: destination?.id,
      categoryId: category?.id,
      amount,
      currency: v.currency,
      accountAmount,
      accountCurrency: account.currency,
      toAmount,
      baseAmount,
      baseCurrency: family.currency,
      comment: v.comment,
      tags: [...new Set(v.tags.map((t) => t.replace(/^#+/, '').toLowerCase()).filter(Boolean))],
      originalId: original?.id,
      rates: book || undefined,
    };
    const stored = await db.query(
      'INSERT INTO transactions(id,family_id,owner_id,author_id,type,date,data,notice,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET owner_id=$3,date=$6,data=$7,notice=$8,version=$9 WHERE transactions.family_id=EXCLUDED.family_id RETURNING id',
      [id, familyId, ownerId, tx.authorId, v.type, v.date, JSON.stringify(tx), notice, version],
    );
    requireThat(stored.rows.length === 1, 'This operation ID has already been used.', 409);
    await db.query('DELETE FROM ledger WHERE transaction_id=$1', [id]);
    await writeLedger(
      db,
      familyId,
      account.id,
      id,
      D(accountAmount)
        .mul(['expense', 'transfer'].includes(v.type) ? -1 : 1)
        .toFixed(),
    );
    if (destination) await writeLedger(db, familyId, destination.id, id, toAmount!);
    // Moving a transaction into personal visibility also makes its prior audit versions private.
    if (old && old.ownerId !== ownerId) {
      requireThat(
        old.ownerId === ownerId,
        'Transaction visibility cannot change. Create a new operation instead.',
      );
    }
    const event = pushEvent(tx, !!old);
    if (event) {
      const operation = { event, changed: !!old || tx.type === 'refund' };
      if (batchEvents) batchEvents.push(operation);
      else await enqueuePush(db, familyId, user.id, m.id, [operation]);
    }
    await audit(
      db,
      familyId,
      user.id,
      id,
      ownerId,
      old ? 'Transaction edited' : 'Transaction recorded',
      old,
      tx,
      !!old && m.baseVersion !== undefined && old.version !== m.baseVersion,
    );
  } else if (m.command === 'transaction.delete') {
    const old = await getTx(db, user.id, familyId, m.input.id);
    requireThat(canEdit(old, family.role, user.id), 'You cannot delete this transaction.', 403);
    requireThat(
      !(
        await db.query(
          "SELECT id FROM transactions WHERE family_id=$1 AND data->>'originalId'=$2 AND deleted=false",
          [familyId, old.id],
        )
      ).rows.length,
      'Delete the linked refunds first.',
    );
    await db.query('UPDATE transactions SET deleted=true,version=$1 WHERE id=$2 AND family_id=$3', [
      version,
      old.id,
      familyId,
    ]);
    await db.query('DELETE FROM ledger WHERE transaction_id=$1', [old.id]);
    await audit(
      db,
      familyId,
      user.id,
      old.id,
      old.ownerId,
      'Transaction deleted',
      old,
      { ...old, deleted: true, version },
      m.baseVersion !== undefined && m.baseVersion !== old.version,
    );
    const event = pushEvent(old, true);
    if (event) await enqueuePush(db, familyId, user.id, m.id, [{ event, changed: true }]);
    resultId = old.id;
  } else if (m.command === 'family.update') {
    admin();
    const v = z.object({ name: short, timezone }).parse(m.input);
    await db.query('UPDATE families SET name=$1,timezone=$2 WHERE id=$3', [
      v.name,
      v.timezone,
      familyId,
    ]);
    await audit(db, familyId, user.id, familyId, null, 'Family settings changed', family, v);
  } else if (m.command === 'member.role') {
    admin();
    const v = z.object({ userId: uuid, role: z.enum(['admin', 'member']) }).parse(m.input);
    const member = (
      await db.query<{ role: Role }>(
        'SELECT role FROM memberships WHERE family_id=$1 AND user_id=$2',
        [familyId, v.userId],
      )
    ).rows[0];
    requireThat(member && member.role !== 'owner', 'Use Transfer ownership to change the owner.');
    await db.query('UPDATE memberships SET role=$1 WHERE family_id=$2 AND user_id=$3', [
      v.role,
      familyId,
      v.userId,
    ]);
    await audit(db, familyId, user.id, v.userId, null, 'Role changed', member, v);
  } else if (m.command === 'family.transfer') {
    requireThat(family.role === 'owner', 'Only the owner can transfer ownership.', 403);
    const to = uuid.parse(m.input.userId);
    requireThat(to !== user.id, 'Choose another member.');
    requireThat(
      (
        await db.query('SELECT user_id FROM memberships WHERE family_id=$1 AND user_id=$2', [
          familyId,
          to,
        ])
      ).rows.length,
      'Member not found.',
    );
    await db.query("UPDATE memberships SET role='admin' WHERE family_id=$1 AND user_id=$2", [
      familyId,
      user.id,
    ]);
    await db.query("UPDATE memberships SET role='owner' WHERE family_id=$1 AND user_id=$2", [
      familyId,
      to,
    ]);
    await audit(
      db,
      familyId,
      user.id,
      familyId,
      null,
      'Ownership transferred',
      { owner: user.id },
      { owner: to },
    );
  } else throw new AppError(400, 'Unknown action.');
  await db.query('UPDATE families SET version=$1 WHERE id=$2', [version, familyId]);
  const result = { id: resultId, version };
  await db.query(
    'INSERT INTO mutation_receipts(family_id,user_id,mutation_id,result) VALUES($1,$2,$3,$4)',
    [familyId, user.id, m.id, JSON.stringify(result)],
  );
  return result;
}
// Every operation uses the same connection and financial validation as manual entry.
// A failed card rolls back ledger, audit, notifications and all receipts together.
export async function saveAiBatch(
  database: Database,
  user: User,
  familyId: string,
  input: unknown,
) {
  const batch = z
    .object({
      id: uuid,
      operations: z
        .array(
          transactionSchema
            .omit({ id: true, originalId: true })
            .extend({
              type: z.enum(['expense', 'income', 'transfer']),
            })
            .strict(),
        )
        .min(1)
        .max(AI_MAX_ENTRIES),
    })
    .strict()
    .parse(input);
  return database.transaction(async (db) => {
    await membership(db, user.id, familyId, true);
    const previous = (
      await db.query<{ result: { ids: string[]; version: number } }>(
        'SELECT result FROM ai_batch_receipts WHERE family_id=$1 AND user_id=$2 AND batch_id=$3',
        [familyId, user.id, batch.id],
      )
    ).rows[0];
    if (previous) return previous.result;
    const events: PushOperation[] = [];
    const ids: string[] = [];
    let version = 0;
    for (const [index, operation] of batch.operations.entries()) {
      try {
        const result = await applyMutation(
          db,
          user,
          familyId,
          {
            id: randomUUID(),
            command: 'transaction.save',
            input: operation,
          },
          events,
        );
        ids.push(result.id);
        version = result.version;
      } catch (error) {
        if (error instanceof AppError)
          throw new AppError(error.status, `Entry ${index + 1}: ${error.message}`);
        throw error;
      }
    }
    await enqueuePush(db, familyId, user.id, batch.id, events);
    const result = { ids, version };
    await db.query(
      'INSERT INTO ai_batch_receipts(family_id,user_id,batch_id,result) VALUES($1,$2,$3,$4)',
      [familyId, user.id, batch.id, JSON.stringify(result)],
    );
    return result;
  });
}

export async function getAudit(db: DB, userId: string, familyId: string, objectId: string) {
  await membership(db, userId, familyId);
  uuid.parse(objectId);
  return (
    await db.query(
      `SELECT a.id,a.object_id AS "objectId",a.action,COALESCE(u.name,'Former member') actor,a.created_at AS at,a.before_data AS before,a.after_data AS after,a.conflict FROM audits a LEFT JOIN users u ON u.id=a.actor_id WHERE a.family_id=$1 AND a.object_id=$2 AND (a.owner_id IS NULL OR a.owner_id=$3) ORDER BY a.created_at DESC LIMIT 100`,
      [familyId, objectId, userId],
    )
  ).rows;
}
export async function invite(database: Database, userId: string, familyId: string, input: unknown) {
  const v = z
    .object({
      days: z.number().int().min(1).max(90).default(3),
      uses: z.number().int().min(1).max(100).default(1),
    })
    .parse(input);
  return database.transaction(async (db) => {
    const f = await membership(db, userId, familyId, true);
    requireThat(f.role !== 'member', 'Only an owner or admin can invite.', 403);
    const code = randomBytes(9).toString('base64url').toUpperCase();
    const expires = new Date(Date.now() + v.days * 86400000).toISOString();
    await db.query(
      'INSERT INTO invitations(code,family_id,expires_at,max_uses,created_by) VALUES($1,$2,$3,$4,$5)',
      [code, familyId, expires, v.uses, userId],
    );
    return { code, expires, maxUses: v.uses };
  });
}
export async function inspectInvite(db: DB, userId: string, code: string) {
  requireThat(/^[A-Z0-9_-]{12}$/.test(code), 'Invitation not found.', 404);
  const r = (
    await db.query<{
      code: string;
      family_id: string;
      name: string;
      expires_at: Date;
      uses: number;
      max_uses: number;
    }>('SELECT i.*,f.name FROM invitations i JOIN families f ON f.id=i.family_id WHERE i.code=$1', [
      code,
    ])
  ).rows[0];
  requireThat(r, 'Invitation not found.', 404);
  const joined =
    (
      await db.query('SELECT user_id FROM memberships WHERE family_id=$1 AND user_id=$2', [
        r.family_id,
        userId,
      ])
    ).rows.length > 0;
  return {
    familyId: r.family_id,
    name: r.name,
    status: joined
      ? 'already'
      : new Date(r.expires_at).getTime() < Date.now()
        ? 'expired'
        : r.uses >= r.max_uses
          ? 'used'
          : 'valid',
  };
}
export async function join(database: Database, userId: string, code: string) {
  return database.transaction(async (db) => {
    const state = await inspectInvite(db, userId, code);
    await db.query('SELECT id FROM families WHERE id=$1 FOR UPDATE', [state.familyId]);
    await db.query('SELECT code FROM invitations WHERE code=$1 FOR UPDATE', [code]);
    const latest = await inspectInvite(db, userId, code);
    if (latest.status === 'already') return latest;
    requireThat(
      latest.status === 'valid',
      latest.status === 'expired'
        ? 'This invitation has expired.'
        : 'This invitation has been used up.',
    );
    await db.query("INSERT INTO memberships(family_id,user_id,role) VALUES($1,$2,'member')", [
      latest.familyId,
      userId,
    ]);
    await db.query('UPDATE invitations SET uses=uses+1 WHERE code=$1', [code]);
    await db.query('UPDATE families SET version=version+1 WHERE id=$1', [latest.familyId]);
    return latest;
  });
}
async function eraseMembership(db: DB, userId: string, familyId: string) {
  const f = await membership(db, userId, familyId, true);
  const count = Number(
    (
      await db.query<{ count: string }>(
        'SELECT count(*) count FROM memberships WHERE family_id=$1',
        [familyId],
      )
    ).rows[0].count,
  );
  requireThat(f.role !== 'owner' || count === 1, 'Transfer ownership before leaving this family.');
  if (count === 1) {
    await db.query('DELETE FROM families WHERE id=$1', [familyId]);
    return;
  }
  // Preserve real shared balances but detach private references and permanently erase payloads.
  await db.query(
    `UPDATE ledger SET transaction_id=NULL WHERE transaction_id IN (SELECT id FROM transactions WHERE family_id=$1 AND owner_id=$2) AND account_id IN (SELECT id FROM entities WHERE family_id=$1 AND owner_id IS NULL)`,
    [familyId, userId],
  );
  await db.query(
    `UPDATE transactions SET data='{}',redacted=true,owner_id=NULL,author_id=NULL,version=$3 WHERE family_id=$1 AND owner_id=$2 AND notice=true`,
    [familyId, userId, f.version + 1],
  );
  await db.query('DELETE FROM transactions WHERE family_id=$1 AND owner_id=$2', [familyId, userId]);
  await db.query('DELETE FROM entities WHERE family_id=$1 AND owner_id=$2', [familyId, userId]);
  await db.query('DELETE FROM audits WHERE family_id=$1 AND owner_id=$2', [familyId, userId]);
  await db.query(
    "UPDATE transactions SET author_id=NULL,data=data-'authorId'-'authorName',version=$3 WHERE family_id=$1 AND author_id=$2",
    [familyId, userId, f.version + 1],
  );
  await db.query(
    "UPDATE audits SET actor_id=NULL,before_data=before_data-'authorId'-'authorName',after_data=after_data-'authorId'-'authorName' WHERE family_id=$1 AND actor_id=$2",
    [familyId, userId],
  );
  await db.query('DELETE FROM ai_batch_receipts WHERE family_id=$1 AND user_id=$2', [
    familyId,
    userId,
  ]);
  await db.query('DELETE FROM mutation_receipts WHERE family_id=$1 AND user_id=$2', [
    familyId,
    userId,
  ]);
  await db.query('DELETE FROM memberships WHERE family_id=$1 AND user_id=$2', [familyId, userId]);
  await db.query('UPDATE families SET version=version+1 WHERE id=$1', [familyId]);
}
export async function leave(
  database: Database,
  userId: string,
  familyId: string,
  deleteFamily = false,
) {
  return database.transaction(async (db) => {
    const f = await membership(db, userId, familyId, true);
    if (deleteFamily) {
      requireThat(f.role === 'owner', 'Only the owner can delete this family.', 403);
      requireThat(
        (await db.query('SELECT user_id FROM memberships WHERE family_id=$1', [familyId])).rows
          .length === 1,
        'Other members must leave before deletion.',
      );
    }
    await eraseMembership(db, userId, familyId);
    await db.query('INSERT INTO deletion_log(id,user_hash,family_id) VALUES($1,$2,$3)', [
      randomUUID(),
      createHash('sha256').update(userId).digest('hex'),
      familyId,
    ]);
  });
}
export async function deleteUser(database: Database, userId: string) {
  return database.transaction(async (db) => {
    const families = await listFamilies(db, userId);
    for (const f of families.sort((a, b) => a.id.localeCompare(b.id)))
      await eraseMembership(db, userId, f.id);
    await db.query('INSERT INTO deletion_log(id,user_hash) VALUES($1,$2)', [
      randomUUID(),
      createHash('sha256').update(userId).digest('hex'),
    ]);
    await db.query('DELETE FROM users WHERE id=$1', [userId]);
  });
}
