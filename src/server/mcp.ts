import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { getDB, type Database } from './db';
import { AppError, requireThat } from './errors';
import { rates } from './rates';
import { resourceMetadataPath, resourceURL, verifyAccess, type Access } from './oauth';
import {
  createFamily,
  deleteUser,
  getAudit,
  getEntities,
  getTx,
  inspectInvite,
  invite,
  join,
  leave,
  listFamilies,
  mapTransaction,
  membership,
  mutate,
  saveAiBatch,
  type TxRow,
} from './service';
import { budgetFor, budgetState, comparison, totals } from '../lib/analytics';
import { D, localDate, shiftMonth, daysInMonth } from '../lib/money';
import {
  categoryTemplates,
  inScope,
  sourceTemplates,
  type Entity,
  type Member,
  type Scope,
  type Transaction,
  type User,
} from '../lib/model';

// MCP tools: the same service layer, roles and privacy rules as the HTTP API, acting as the user.
const id = z.string().uuid();
const family = id
  .optional()
  .describe('Family id from list_families. Optional if you belong to one family.');
const key = id
  .optional()
  .describe('Optional UUID. Retrying with the same key never applies the change twice.');
const amount = z
  .string()
  .regex(/^-?\d{1,18}(\.\d{1,9})?$/)
  .describe('Decimal string, e.g. "12.50"');
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');
const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe('YYYY-MM; defaults to the current month');
const scope = z
  .enum(['shared', 'mine', 'combined'])
  .default('combined')
  .describe('shared = family objects, mine = your personal objects, combined = both');
const confirmName = z.string().max(100).describe('The exact name the user typed to confirm');

interface Context {
  db: Database;
  user: User;
}
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }],
});
const failure = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: message }],
});
const defined = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as Partial<T>;

async function resolveFamily(c: Context, familyId?: string) {
  if (familyId) return familyId;
  const families = await listFamilies(c.db, c.user.id);
  requireThat(families.length, 'You are not in a family yet. Use create_family or join_family.');
  requireThat(
    families.length === 1,
    'You belong to several families; pass `family`: ' +
      families.map((f) => `${f.name} = ${f.id}`).join(', '),
  );
  return families[0].id;
}
const visibility = (o: { ownerId: string | null }) => (o.ownerId ? 'personal' : 'shared');
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function visibleTransactions(c: Context, familyId: string, from: string, to: string) {
  const rows = (
    await c.db.query<TxRow>(
      `SELECT t.*,u.name author_name FROM transactions t LEFT JOIN users u ON u.id=t.author_id
       WHERE t.family_id=$1 AND (t.owner_id IS NULL OR t.owner_id=$2 OR t.notice=true) AND t.deleted=false AND t.date>=$3 AND t.date<=$4`,
      [familyId, c.user.id, from, to],
    )
  ).rows;
  return rows.map((r) => mapTransaction(r, c.user.id));
}
function txView(t: Transaction, names: Map<string, string>) {
  if (t.redacted)
    return {
      id: t.id,
      date: t.date,
      type: t.type,
      private: "Involves another member's personal account; details hidden.",
    };
  const converted = t.accountCurrency !== t.currency;
  return {
    id: t.id,
    date: t.date,
    type: t.type,
    amount: t.amount,
    currency: t.currency,
    accountAmount: converted ? t.accountAmount : undefined,
    accountCurrency: converted ? t.accountCurrency : undefined,
    account: t.accountId && { id: t.accountId, name: names.get(t.accountId) },
    toAccount: t.toAccountId && {
      id: t.toAccountId,
      name: names.get(t.toAccountId),
      amount: t.toAmount,
    },
    category: t.categoryId && { id: t.categoryId, name: names.get(t.categoryId) },
    reportingAmount: t.baseAmount && `${t.baseAmount} ${t.baseCurrency}`,
    comment: t.comment || undefined,
    tags: t.tags?.length ? t.tags : undefined,
    refundOf: t.originalId,
    author: t.authorName,
    visibility: visibility(t),
  };
}
const nameMap = (entities: Entity[]) => new Map(entities.map((e) => [e.id, e.name]));
const entityView = (e: Entity) => ({
  id: e.id,
  name: e.name,
  visibility: visibility(e),
  icon: e.icon,
  archived: e.archived || undefined,
  ...(e.kind === 'account'
    ? {
        currency: e.currency,
        balance: e.balance,
        accountType: e.accountType,
        bank: e.bank || undefined,
        includedInTotals: e.included,
      }
    : {}),
});

function apply(
  c: Context,
  familyId: string,
  command: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
) {
  return mutate(c.db, c.user, familyId, { id: idempotencyKey || randomUUID(), command, input });
}

const txFields = {
  date: day.optional().describe("Defaults to today in the family's time zone"),
  accountId: id
    .optional()
    .describe('Account the money leaves (expense, transfer) or enters (income)'),
  toAccountId: id.optional().describe('Destination account of a transfer'),
  categoryId: id.optional().describe('Expense category, or income source for income'),
  amount: amount.optional(),
  currency: z.string().length(3).optional().describe('ISO code; defaults to the account currency'),
  accountAmount: amount
    .optional()
    .describe('Amount in the account currency when `currency` differs'),
  toAmount: amount.optional().describe('Amount received when the destination currency differs'),
  baseAmount: amount
    .optional()
    .describe('Amount in the family currency, only if no exchange rate exists'),
  comment: z.string().max(2000).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
};

export const instructions =
  'KinFlow is a family finance app. Amounts are decimal strings. Start with list_families or get_family to learn ids. Shared objects belong to the family; personal ones only to the user. Entries marked private involve another member and their details are hidden; never guess them. Ask before creating categories or accounts, and before any destructive action.';

export function registerKinflow(server: McpServer) {
  const tool = <S extends z.ZodObject>(
    name: string,
    config: {
      title: string;
      description: string;
      input: S;
      write?: boolean;
      destructive?: boolean;
    },
    run: (args: z.infer<S>, c: Context) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        annotations: {
          title: config.title,
          readOnlyHint: !config.write,
          destructiveHint: !!config.destructive,
          idempotentHint: !config.write,
          openWorldHint: false,
        },
      },
      (async (args: z.infer<S>, ctx: ServerContext) => {
        const access = ctx.http?.authInfo?.extra as unknown as Access | undefined;
        if (!access) return failure('Not signed in.');
        if (config.write && !access.scopes.includes('write'))
          return failure(
            'This connection is read-only. Reconnect KinFlow with "Allow changes" turned on.',
          );
        try {
          return text(await run(args, { db: await getDB(), user: access.user }));
        } catch (error) {
          if (error instanceof z.ZodError)
            return failure(
              error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            );
          if (error instanceof AppError) return failure(error.message);
          // Financial payloads and SQL details never go to ordinary logs.
          console.error(
            'KinFlow MCP tool failed',
            error instanceof Error ? error.name : 'UnknownError',
          );
          return failure('The request could not be completed. Please try again.');
        }
      }) as never,
    );

  // ---- Reading ----
  tool(
    'list_families',
    {
      title: 'List families',
      description: 'Families you belong to, with your role and reporting currency.',
      input: z.object({}),
    },
    async (_, c) =>
      (await listFamilies(c.db, c.user.id)).map(({ id, name, currency, timezone, role }) => ({
        id,
        name,
        currency,
        timezone,
        yourRole: role,
      })),
  );
  tool(
    'get_family',
    {
      title: 'Get family',
      description:
        'Accounts with balances, expense categories, income sources, current budgets, members and exchange rates. Call this first to learn ids.',
      input: z.object({ family }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const f = await membership(c.db, c.user.id, familyId);
      const entities = await getEntities(c.db, c.user.id, familyId);
      const members = (
        await c.db.query<Member>(
          'SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE family_id=$1 ORDER BY joined_at',
          [familyId],
        )
      ).rows;
      const book = await rates(c.db);
      const codes = new Set([f.currency, 'USD', ...entities.map((e) => e.currency || '')]);
      const today = localDate(f.timezone);
      return {
        family: {
          id: f.id,
          name: f.name,
          currency: f.currency,
          timezone: f.timezone,
          yourRole: f.role,
          today,
        },
        you: { id: c.user.id, name: c.user.name },
        members,
        accounts: entities.filter((e) => e.kind === 'account').map(entityView),
        categories: entities.filter((e) => e.kind === 'expense').map(entityView),
        incomeSources: entities.filter((e) => e.kind === 'source').map(entityView),
        budgets: entities
          .filter((e) => e.kind === 'expense')
          .map((e) => budgetFor(entities, e.id, today.slice(0, 7)))
          .filter((b): b is Entity => !!b && !b.archived)
          .map((b) => ({
            categoryId: b.categoryId,
            category: b.name,
            limit: b.limit,
            currency: b.currency,
            since: b.effectiveMonth,
          })),
        rates: book && {
          date: book.date,
          note: 'Units of each currency per 1 USD',
          rates: Object.fromEntries(Object.entries(book.rates).filter(([k]) => codes.has(k))),
        },
      };
    },
  );
  tool(
    'list_transactions',
    {
      title: 'List transactions',
      description:
        'Transactions, newest first, with filters. Pass `next` from a previous result to get the following page.',
      input: z.object({
        family,
        month: month.optional(),
        from: day.optional(),
        to: day.optional(),
        type: z.enum(['expense', 'income', 'transfer', 'adjustment', 'refund']).optional(),
        accountId: id.optional(),
        categoryId: id.optional(),
        tag: z.string().max(40).optional(),
        search: z.string().max(100).optional().describe('Text to find in comments'),
        limit: z.number().int().min(1).max(100).default(50),
        next: z.string().max(80).optional(),
      }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      await membership(c.db, c.user.id, familyId);
      const where = [
        't.family_id=$1',
        '(t.owner_id IS NULL OR t.owner_id=$2 OR t.notice=true)',
        't.deleted=false',
      ];
      const params: unknown[] = [familyId, c.user.id];
      const param = (value: unknown) => {
        params.push(value);
        return '$' + params.length;
      };
      if (a.month) where.push(`t.date>=${param(a.month + '-01')} AND t.date<=${param(a.month + '-31')}`);
      if (a.from) where.push(`t.date>=${param(a.from)}`);
      if (a.to) where.push(`t.date<=${param(a.to)}`);
      if (a.type) where.push(`t.type=${param(a.type)}`);
      // Content filters only see rows the user may read in full, so they cannot probe hidden data.
      if (a.accountId || a.categoryId || a.tag || a.search)
        where.push('(t.owner_id IS NULL OR t.owner_id=$2) AND t.redacted=false');
      if (a.accountId) {
        const p = param(a.accountId);
        where.push(`(t.data->>'accountId'=${p} OR t.data->>'toAccountId'=${p})`);
      }
      if (a.categoryId) where.push(`t.data->>'categoryId'=${param(a.categoryId)}`);
      if (a.tag)
        where.push(`t.data->'tags' @> ${param(JSON.stringify([a.tag.replace(/^#+/, '').toLowerCase()]))}::jsonb`);
      if (a.search)
        where.push(`t.data->>'comment' ILIKE ${param('%' + a.search.replace(/[\\%_]/g, '\\$&') + '%')}`);
      if (a.next) {
        const [d, i] = a.next.split('|');
        where.push(`(t.date,t.id)<(${param(day.parse(d))},${param(id.parse(i))}::uuid)`);
      }
      const rows = (
        await c.db.query<TxRow>(
          `SELECT t.*,u.name author_name FROM transactions t LEFT JOIN users u ON u.id=t.author_id WHERE ${where.join(' AND ')} ORDER BY t.date DESC,t.id DESC LIMIT ${param(a.limit + 1)}`,
          params,
        )
      ).rows;
      const names = nameMap(await getEntities(c.db, c.user.id, familyId));
      const page = rows.slice(0, a.limit);
      const last = page.at(-1);
      return {
        transactions: page.map((r) => txView(mapTransaction(r, c.user.id), names)),
        next: rows.length > a.limit && last ? `${last.date}|${last.id}` : null,
      };
    },
  );
  tool(
    'get_budgets',
    {
      title: 'Get budgets',
      description: 'Budget limits, spending so far and pace for a month.',
      input: z.object({ family, month: month.optional(), scope }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const f = await membership(c.db, c.user.id, familyId);
      const today = localDate(f.timezone),
        m = a.month || today.slice(0, 7);
      const entities = await getEntities(c.db, c.user.id, familyId);
      const txs = await visibleTransactions(c, familyId, m + '-01', m + '-31');
      const budgets = [];
      for (const category of entities.filter(
        (e) => e.kind === 'expense' && inScope(e, a.scope as Scope, c.user.id),
      )) {
        const budget = budgetFor(entities, category.id, m);
        if (!budget || budget.archived) continue;
        const s = budgetState(budget, txs, m, today);
        budgets.push({
          category: category.name,
          categoryId: category.id,
          limit: budget.limit,
          currency: budget.currency,
          spent: s.spent,
          remaining: s.remaining,
          status: s.status,
          percentOfMonthElapsed: Math.round(s.pace),
          missingRates: s.missing || undefined,
        });
      }
      return { month: m, budgets };
    },
  );
  tool(
    'get_insights',
    {
      title: 'Get insights',
      description:
        'Spending, income and net for a month in the family currency, by category and tag, compared with the same days of the previous month and the average of up to 12 completed months.',
      input: z.object({ family, month: month.optional(), scope }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const f = await membership(c.db, c.user.id, familyId);
      const today = localDate(f.timezone),
        current = today.slice(0, 7),
        m = a.month || current,
        s = a.scope as Scope;
      const first = [shiftMonth(current, -13), shiftMonth(m, -1)].sort()[0];
      const last = [current, m].sort()[1];
      const txs = await visibleTransactions(c, familyId, first + '-01', last + '-31');
      const names = nameMap(await getEntities(c.db, c.user.id, familyId));
      const spending = txs.filter(
        (t) =>
          !t.redacted &&
          inScope(t, s, c.user.id) &&
          t.date.startsWith(m) &&
          (t.type === 'expense' || t.type === 'refund'),
      );
      const group = (keys: (t: Transaction) => string[]) => {
        const out = new Map<string, ReturnType<typeof D>>();
        for (const t of spending)
          for (const k of keys(t))
            out.set(
              k,
              (out.get(k) || D()).plus(D(t.baseAmount || '0').mul(t.type === 'refund' ? -1 : 1)),
            );
        return [...out]
          .sort((x, y) => y[1].cmp(x[1]))
          .map(([name, spent]) => ({ name, spent: spent.toFixed() }));
      };
      const cmp = comparison(txs, f, m, today, s, c.user.id);
      return {
        month: m,
        currency: f.currency,
        period: m === current ? `days 1–${+today.slice(8)} of ${daysInMonth(m)}` : 'whole month',
        ...totals(txs, m, s, c.user.id),
        byCategory: group((t) => [names.get(t.categoryId || '') || 'Unknown']),
        byTag: group((t) => t.tags || []),
        comparedWithPreviousMonth: { range: cmp.ranges, now: cmp.now, before: cmp.before },
        averageMonthlySpending: cmp.average ?? 'Not enough history',
        completedMonthsInAverage: cmp.count,
      };
    },
  );
  tool(
    'get_audit',
    {
      title: 'Get history',
      description:
        'Change history of one account, category, budget, transaction, member or family.',
      input: z.object({ family, objectId: id }),
    },
    async (a, c) => getAudit(c.db, c.user.id, await resolveFamily(c, a.family), a.objectId),
  );
  tool(
    'inspect_invite',
    {
      title: 'Check invitation',
      description: 'Which family an invitation code is for and whether it is still valid.',
      input: z.object({ code: z.string().max(50) }),
    },
    async (a, c) => inspectInvite(c.db, c.user.id, a.code.trim().toUpperCase()),
  );

  // ---- Changes ----
  tool(
    'save_entity',
    {
      title: 'Save account or category',
      description:
        'Create or update an account, expense category or income source. To update, pass `id` and only the fields to change. Ask the user before creating anything.',
      write: true,
      input: z.object({
        family,
        idempotency_key: key,
        id: id.optional(),
        kind: z.enum(['account', 'expense', 'source']).optional().describe('Required when creating'),
        name: z.string().max(100).optional().describe('Required when creating'),
        icon: z.string().max(30).optional(),
        visibility: z
          .enum(['shared', 'personal'])
          .optional()
          .describe('When creating; cannot change later. Default shared.'),
        currency: z.string().length(3).optional().describe('Accounts only; cannot change later'),
        accountType: z
          .enum(['Card', 'Cash', 'Deposit', 'Bank account', 'Investment', 'Other'])
          .optional(),
        bank: z.string().max(100).optional(),
        openingBalance: amount.optional().describe('New accounts only'),
        openingDate: day.optional().describe('New accounts only'),
        includedInTotals: z.boolean().optional(),
        archived: z.boolean().optional(),
      }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const old = a.id
        ? (await getEntities(c.db, c.user.id, familyId)).find((e) => e.id === a.id)
        : undefined;
      requireThat(!a.id || (old && old.kind !== 'budget'), 'This item is unavailable.', 404);
      const { family: _, idempotency_key, visibility: v, includedInTotals, ...fields } = a;
      const input: Record<string, unknown> = {
        ...(old && {
          id: old.id,
          kind: old.kind,
          name: old.name,
          icon: old.icon,
          ownerId: old.ownerId,
          currency: old.currency,
          accountType: old.accountType,
          bank: old.bank,
          included: old.included,
          archived: old.archived,
        }),
        ...defined(fields),
        ...(includedInTotals !== undefined && { included: includedInTotals }),
        ...(v && { ownerId: v === 'personal' ? c.user.id : null }),
      };
      if (!old && !input.icon) input.icon = input.kind === 'account' ? 'wallet' : 'grid';
      return apply(c, familyId, 'entity.save', input, idempotency_key);
    },
  );
  tool(
    'delete_entity',
    {
      title: 'Delete account or category',
      description:
        'Delete an unused account or category. Items with history must be archived instead (save_entity with archived=true).',
      write: true,
      destructive: true,
      input: z.object({ family, id, idempotency_key: key }),
    },
    async (a, c) =>
      apply(c, await resolveFamily(c, a.family), 'entity.delete', { id: a.id }, a.idempotency_key),
  );
  tool(
    'move_entity',
    {
      title: 'Reorder item',
      description: 'Move an account or category one place up or down in its list.',
      write: true,
      input: z.object({ family, id, direction: z.enum(['up', 'down']), idempotency_key: key }),
    },
    async (a, c) =>
      apply(
        c,
        await resolveFamily(c, a.family),
        'entity.move',
        { id: a.id, direction: a.direction },
        a.idempotency_key,
      ),
  );
  tool(
    'save_budget',
    {
      title: 'Set budget',
      description:
        'Set or remove the monthly limit of an expense category, effective from the current month.',
      write: true,
      input: z.object({
        family,
        categoryId: id,
        limit: amount,
        currency: z.string().length(3).optional().describe('Defaults to the family currency'),
        remove: z.boolean().default(false),
        idempotency_key: key,
      }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const f = await membership(c.db, c.user.id, familyId);
      return apply(
        c,
        familyId,
        'budget.save',
        {
          categoryId: a.categoryId,
          limit: a.limit,
          currency: a.currency || f.currency,
          archived: a.remove,
        },
        a.idempotency_key,
      );
    },
  );
  tool(
    'save_transaction',
    {
      title: 'Save transaction',
      description:
        'Record or edit one expense, income, transfer, adjustment (comment = reason, required) or refund (originalId = the expense). To edit, pass `id` and only the fields to change. Use existing accounts and categories from get_family.',
      write: true,
      input: z.object({
        family,
        idempotency_key: key,
        id: id.optional(),
        type: z
          .enum(['expense', 'income', 'transfer', 'adjustment', 'refund'])
          .optional()
          .describe('Required when creating'),
        ...txFields,
        originalId: id.optional().describe('Refunds only: the expense being refunded'),
      }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const f = await membership(c.db, c.user.id, familyId);
      const { family: _, idempotency_key, ...fields } = a;
      let input: Record<string, unknown>;
      if (a.id) {
        const old = await getTx(c.db, c.user.id, familyId, a.id);
        // A new amount or currency invalidates the converted amounts of the old entry.
        const repriced = a.amount !== undefined || a.currency !== undefined;
        input = {
          id: old.id,
          type: old.type,
          date: old.date,
          accountId: old.accountId,
          toAccountId: old.toAccountId,
          categoryId: old.categoryId,
          amount: old.amount,
          currency: old.currency,
          ...(!repriced && {
            accountAmount: old.accountAmount,
            toAmount: old.toAmount,
            baseAmount: old.baseAmount,
          }),
          comment: old.comment,
          tags: old.tags,
          originalId: old.originalId,
          ...defined(fields),
        };
      } else {
        const entities = await getEntities(c.db, c.user.id, familyId);
        input = {
          date: localDate(f.timezone),
          currency: entities.find((e) => e.id === a.accountId)?.currency,
          ...defined(fields),
        };
      }
      return apply(c, familyId, 'transaction.save', input, idempotency_key);
    },
  );
  tool(
    'save_transactions',
    {
      title: 'Save several transactions',
      description:
        'Record up to 20 new expenses, incomes or transfers at once. Either all are saved or none.',
      write: true,
      input: z.object({
        family,
        idempotency_key: key,
        operations: z
          .array(z.object({ type: z.enum(['expense', 'income', 'transfer']), ...txFields }))
          .min(1)
          .max(20),
      }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const f = await membership(c.db, c.user.id, familyId);
      const entities = await getEntities(c.db, c.user.id, familyId);
      const operations = a.operations.map((o) => ({
        date: localDate(f.timezone),
        currency: entities.find((e) => e.id === o.accountId)?.currency,
        ...defined(o),
      }));
      return saveAiBatch(c.db, c.user, familyId, {
        id: a.idempotency_key || randomUUID(),
        operations,
      });
    },
  );
  tool(
    'delete_transaction',
    {
      title: 'Delete transaction',
      description: 'Delete a transaction. Its history stays in the audit log.',
      write: true,
      destructive: true,
      input: z.object({ family, id, idempotency_key: key }),
    },
    async (a, c) =>
      apply(
        c,
        await resolveFamily(c, a.family),
        'transaction.delete',
        { id: a.id },
        a.idempotency_key,
      ),
  );
  tool(
    'update_family',
    {
      title: 'Update family',
      description: 'Rename the family or change its time zone (owner or admin).',
      write: true,
      input: z.object({
        family,
        name: z.string().max(100).optional(),
        timezone: z.string().max(60).optional().describe('IANA time zone, e.g. Europe/Berlin'),
        idempotency_key: key,
      }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      const f = await membership(c.db, c.user.id, familyId);
      return apply(
        c,
        familyId,
        'family.update',
        { name: a.name ?? f.name, timezone: a.timezone ?? f.timezone },
        a.idempotency_key,
      );
    },
  );
  tool(
    'set_member_role',
    {
      title: 'Change member role',
      description: 'Make a member an admin or a regular member (owner or admin only).',
      write: true,
      input: z.object({
        family,
        userId: id,
        role: z.enum(['admin', 'member']),
        idempotency_key: key,
      }),
    },
    async (a, c) =>
      apply(
        c,
        await resolveFamily(c, a.family),
        'member.role',
        { userId: a.userId, role: a.role },
        a.idempotency_key,
      ),
  );
  const starters = [...new Set([...categoryTemplates, ...sourceTemplates].map(([n]) => n))];
  tool(
    'create_family',
    {
      title: 'Create family',
      description: `Create a new family with you as the owner. Starter expense categories and income sources: ${starters.join(', ')}.`,
      write: true,
      input: z.object({
        name: z.string().max(100),
        currency: z.string().length(3).describe('Reporting currency, ISO code'),
        timezone: z.string().max(60).describe('IANA time zone, e.g. Europe/Berlin'),
        starters: z
          .array(z.string().max(40))
          .max(16)
          .optional()
          .describe('Starter names to create; defaults to all of them'),
      }),
    },
    async (a, c) =>
      createFamily(c.db, c.user, {
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        templates: a.starters ?? starters,
      }),
  );
  tool(
    'create_invite',
    {
      title: 'Invite member',
      description: 'Create an invitation code and link (owner or admin only).',
      write: true,
      input: z.object({
        family,
        days: z.number().int().min(1).max(90).default(3),
        uses: z.number().int().min(1).max(100).default(1),
      }),
    },
    async (a, c) => {
      const result = await invite(c.db, c.user.id, await resolveFamily(c, a.family), {
        days: a.days,
        uses: a.uses,
      });
      const base = process.env.APP_URL?.replace(/\/$/, '');
      return { ...result, link: base ? `${base}/?invite=${result.code}` : undefined };
    },
  );
  tool(
    'join_family',
    {
      title: 'Join family',
      description: 'Join a family with an invitation code.',
      write: true,
      input: z.object({ code: z.string().max(50) }),
    },
    async (a, c) => join(c.db, c.user.id, a.code.trim().toUpperCase()),
  );

  // ---- Irreversible: the user has to type the name ----
  const confirmFamily = async (c: Context, familyId: string, typed: string) => {
    const f = await membership(c.db, c.user.id, familyId);
    requireThat(
      sameName(typed, f.name),
      `Ask the user to confirm by typing the family name "${f.name}".`,
    );
  };
  tool(
    'transfer_ownership',
    {
      title: 'Transfer ownership',
      description:
        'Make another member the owner; you become an admin. Only the new owner can undo it.',
      write: true,
      destructive: true,
      input: z.object({ family, userId: id, confirmName }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      await confirmFamily(c, familyId, a.confirmName);
      return apply(c, familyId, 'family.transfer', { userId: a.userId });
    },
  );
  tool(
    'leave_family',
    {
      title: 'Leave family',
      description: 'Leave a family. Your personal data in it is permanently erased.',
      write: true,
      destructive: true,
      input: z.object({ family, confirmName }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      await confirmFamily(c, familyId, a.confirmName);
      await leave(c.db, c.user.id, familyId);
      return { ok: true };
    },
  );
  tool(
    'delete_family',
    {
      title: 'Delete family',
      description:
        'Permanently delete a family you own. All other members must have left first.',
      write: true,
      destructive: true,
      input: z.object({ family, confirmName }),
    },
    async (a, c) => {
      const familyId = await resolveFamily(c, a.family);
      await confirmFamily(c, familyId, a.confirmName);
      await leave(c.db, c.user.id, familyId, true);
      return { ok: true };
    },
  );
  tool(
    'delete_account',
    {
      title: 'Delete KinFlow account',
      description:
        'Permanently delete your KinFlow account and personal data. This also disconnects the assistant.',
      write: true,
      destructive: true,
      input: z.object({ confirmName: confirmName.describe("The user's own name in KinFlow") }),
    },
    async (a, c) => {
      requireThat(
        sameName(a.confirmName, c.user.name),
        `Ask the user to confirm by typing their name "${c.user.name}".`,
      );
      await deleteUser(c.db, c.user.id);
      return { ok: true };
    },
  );

  // ---- Prompts ----
  const message = (text: string) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
  });
  server.registerPrompt(
    'monthly_review',
    {
      title: 'Monthly review',
      description: 'Review a month of family finances.',
      argsSchema: z.object({ family: z.string().optional(), month: z.string().optional() }),
    },
    ({ family: f, month: m }) =>
      message(
        `Review my KinFlow finances for ${m || 'this month'}${f ? ` in family ${f}` : ''}. Use get_insights and get_budgets. Summarise spending by category against last month and the monthly average, flag budgets that are over or ahead of pace, point out unusual items from list_transactions, and end with two or three practical suggestions. Do not change anything.`,
      ),
  );
  server.registerPrompt(
    'log_expenses',
    {
      title: 'Log expenses',
      description: 'Turn a free-form list into KinFlow transactions, with confirmation.',
      argsSchema: z.object({ family: z.string().optional() }),
    },
    ({ family: f }) =>
      message(
        `I will describe purchases and income. Record them in KinFlow${f ? ` family ${f}` : ''}. First call get_family. Use only existing accounts, categories and income sources; if nothing fits, ask me instead of creating one. Show the entries as a table (date, type, amount, account, category, comment) and wait for my confirmation, then save them with one save_transactions call and a fresh idempotency_key.`,
      ),
  );
}

const mcp = createMcpHandler(registerKinflow, {
  serverInfo: { name: 'KinFlow', version: '1.0.0' },
  instructions,
});

/** Bearer-protected MCP endpoint; `base` is the public app URL (issuer). */
export async function handleMcp(request: Request, base: string) {
  return withMcpAuth(
    mcp,
    async (_, token) => {
      if (!token) return undefined;
      const access = await verifyAccess(await getDB(), token);
      return access
        ? {
            token,
            clientId: access.clientId,
            scopes: access.scopes,
            expiresAt: access.expiresAt,
            resource: new URL(resourceURL(base)),
            extra: access as unknown as Record<string, unknown>,
          }
        : undefined;
    },
    { required: true, resourceUrl: base, resourceMetadataPath },
  )(request);
}

