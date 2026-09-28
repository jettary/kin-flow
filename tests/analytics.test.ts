import { describe, it, expect } from 'vitest';
import { budgetState, comparison, holdings } from '../src/lib/analytics';
import type { Entity, Family, Transaction } from '../src/lib/model';
const budget: Entity = {
  id: 'budget',
  familyId: 'family',
  ownerId: null,
  kind: 'budget',
  name: 'Food',
  icon: 'basket',
  archived: false,
  order: 0,
  version: 1,
  categoryId: 'category',
  currency: 'GEL',
  limit: '100',
  effectiveMonth: '2026-09',
};
const transaction: Transaction = {
  id: 'expense',
  familyId: 'family',
  ownerId: null,
  type: 'expense',
  date: '2026-09-10',
  authorId: 'user',
  version: 1,
  deleted: false,
  categoryId: 'category',
  amount: '10',
  currency: 'EUR',
  accountAmount: '11.03',
  accountCurrency: 'USD',
  baseAmount: '29.78',
  baseCurrency: 'GEL',
  rates: {
    date: '2026-09-10',
    fetchedAt: '2026-09-10T00:00:00Z',
    provider: 'Test',
    rates: { USD: '1', EUR: '0.9', GEL: '2.7' },
  },
};
describe('reporting semantics', () => {
  it('uses actual posted cost for budgets rather than the indicative purchase conversion', () => {
    expect(budgetState(budget, [transaction], '2026-09', '2026-09-15').spent).toBe('29.78');
    expect(
      budgetState({ ...budget, currency: 'USD' }, [transaction], '2026-09', '2026-09-15').spent,
    ).toBe('11.03');
  });
  it('handles a zero budget without division by zero and includes refund effects', () => {
    expect(
      budgetState({ ...budget, limit: '0' }, [transaction], '2026-09', '2026-09-15'),
    ).toMatchObject({ status: 'Over budget', progress: 100 });
    const refund = { ...transaction, id: 'refund', type: 'refund' as const };
    expect(budgetState(budget, [transaction, refund], '2026-09', '2026-09-15').spent).toBe('0');
  });
  it('keeps excluded funds in holdings and reports missing rates explicitly', () => {
    const accounts: Entity[] = [
      { ...budget, id: 'cash', kind: 'account', currency: 'GEL', balance: '100', included: true },
      {
        ...budget,
        id: 'deposit',
        kind: 'account',
        currency: 'GEL',
        balance: '200',
        included: false,
      },
      { ...budget, id: 'foreign', kind: 'account', currency: 'JPY', balance: '50', included: true },
    ];
    expect(holdings(accounts, 'shared', 'user', 'GEL', null)).toEqual({
      value: '100',
      missing: ['JPY'],
    });
    expect(holdings(accounts, 'shared', 'user', 'GEL', null, false).value).toBe('300');
  });
  it('caps averages at 12 completed months and excludes months before tracking', () => {
    const family: Family = {
      id: 'family',
      name: 'Family',
      currency: 'GEL',
      timezone: 'Asia/Tbilisi',
      createdAt: '2020-01-15T12:00:00Z',
      role: 'owner',
      version: 1,
    };
    expect(comparison([transaction], family, '2026-09', '2026-09-28', 'shared', 'user').count).toBe(
      12,
    );
    expect(comparison([], family, '2026-02', '2026-02-28', 'shared', 'user').ranges).toBe(
      '2026-02-01 – 2026-02-28 vs 2026-01-01 – 2026-01-28',
    );
  });
});
