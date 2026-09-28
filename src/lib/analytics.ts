import { D, convert, daysInMonth, shiftMonth, sum, localDate } from './money';
import {
  inScope,
  type Entity,
  type Family,
  type RateBook,
  type Scope,
  type Transaction,
} from './model';
export function totals(
  transactions: Transaction[],
  month: string,
  scope: Scope,
  userId: string,
  endDay = 31,
) {
  const rows = transactions.filter(
    (t) =>
      !t.deleted &&
      !t.redacted &&
      inScope(t, scope, userId) &&
      t.date.startsWith(month) &&
      +t.date.slice(8) <= endDay,
  );
  const expense = sum(rows.filter((t) => t.type === 'expense').map((t) => t.baseAmount));
  const refunds = sum(rows.filter((t) => t.type === 'refund').map((t) => t.baseAmount));
  const income = sum(rows.filter((t) => t.type === 'income').map((t) => t.baseAmount));
  const spent = D(expense).minus(refunds).toFixed();
  return { spent, income, net: D(income).minus(spent).toFixed() };
}
export function holdings(
  entities: Entity[],
  scope: Scope,
  userId: string,
  currency: string,
  rates: RateBook | null,
  onlyIncluded = true,
) {
  let total = D();
  const missing = new Set<string>();
  for (const e of entities.filter(
    (e) => e.kind === 'account' && inScope(e, scope, userId) && (!onlyIncluded || e.included),
  )) {
    const amount = convert(e.balance || '0', e.currency!, currency, rates);
    if (amount === null) missing.add(e.currency!);
    else total = total.plus(amount);
  }
  return { value: total.toFixed(), missing: [...missing] };
}
export function budgetFor(entities: Entity[], categoryId: string, month: string) {
  return entities
    .filter((e) => e.kind === 'budget' && e.categoryId === categoryId && e.effectiveMonth! <= month)
    .sort((a, b) => b.effectiveMonth!.localeCompare(a.effectiveMonth!))[0];
}
export function budgetState(
  budget: Entity,
  transactions: Transaction[],
  month: string,
  today: string,
) {
  let spent = D();
  let missing = false;
  for (const t of transactions.filter(
    (t) =>
      !t.deleted &&
      !t.redacted &&
      t.categoryId === budget.categoryId &&
      t.date.startsWith(month) &&
      ['expense', 'refund'].includes(t.type),
  )) {
    const amount =
      budget.currency === t.baseCurrency
        ? (t.baseAmount ?? null)
        : convert(
            t.accountAmount || t.amount!,
            t.accountCurrency || t.currency!,
            budget.currency!,
            t.rates,
          );
    if (amount === null) missing = true;
    else spent = spent.plus(D(amount).mul(t.type === 'refund' ? -1 : 1));
  }
  const days = daysInMonth(month),
    elapsed = month < today.slice(0, 7) ? days : month > today.slice(0, 7) ? 0 : +today.slice(8);
  const limit = D(budget.limit!),
    expected = limit.mul(elapsed).div(days);
  const status = spent.gt(limit) ? 'Over budget' : spent.gt(expected) ? 'Ahead of pace' : 'On pace';
  return {
    spent: spent.toFixed(),
    remaining: limit.minus(spent).toFixed(),
    status,
    missing,
    progress: limit.isZero()
      ? spent.gt(0)
        ? 100
        : 0
      : Math.min(100, Math.max(0, spent.div(limit).mul(100).toNumber())),
    pace: (elapsed / days) * 100,
  };
}
export function comparison(
  transactions: Transaction[],
  family: Family,
  month: string,
  today: string,
  scope: Scope,
  userId: string,
) {
  const previous = shiftMonth(month, -1),
    current = month === today.slice(0, 7),
    day = current ? +today.slice(8) : daysInMonth(month);
  const previousDay = current ? Math.min(day, daysInMonth(previous)) : daysInMonth(previous);
  const now = totals(transactions, month, scope, userId, day),
    before = totals(transactions, previous, scope, userId, previousDay);
  const tracking = localDate(family.timezone, new Date(family.createdAt)),
    first = tracking.endsWith('-01') ? tracking.slice(0, 7) : shiftMonth(tracking.slice(0, 7), 1);
  const last = shiftMonth(today.slice(0, 7), -1);
  const months: string[] = [];
  for (let m = last; m >= first && months.length < 12; m = shiftMonth(m, -1)) months.push(m);
  return {
    now,
    before,
    ranges: `${month}-01 – ${month}-${String(day).padStart(2, '0')} vs ${previous}-01 – ${previous}-${String(previousDay).padStart(2, '0')}`,
    average: months.length
      ? D(sum(months.map((m) => totals(transactions, m, scope, userId).spent)))
          .div(months.length)
          .toFixed(2)
      : null,
    count: months.length,
  };
}
