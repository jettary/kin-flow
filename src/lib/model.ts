export type Role = 'owner' | 'admin' | 'member';
export type Scope = 'shared' | 'mine' | 'combined';
export type TransactionType = 'expense' | 'income' | 'transfer' | 'adjustment' | 'refund';
export interface User {
  id: string;
  name: string;
  avatar?: string;
  theme?: 'system' | 'light' | 'dark';
  dateFormat?: 'dmy' | 'mdy' | 'iso';
}
export interface Family {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  createdAt: string;
  role: Role;
  version: number;
}
export interface Entity {
  id: string;
  familyId: string;
  ownerId: string | null;
  kind: 'account' | 'expense' | 'source' | 'budget';
  name: string;
  icon: string;
  archived: boolean;
  order: number;
  version: number;
  currency?: string;
  accountType?: string;
  bank?: string;
  openingBalance?: string;
  openingDate?: string;
  included?: boolean;
  balance?: string;
  categoryId?: string;
  limit?: string;
  effectiveMonth?: string;
}
export interface RateBook {
  date: string;
  fetchedAt: string;
  provider: string;
  rates: Record<string, string>;
}
export interface Transaction {
  id: string;
  familyId: string;
  ownerId: string | null;
  type: TransactionType;
  date: string;
  authorId: string | null;
  authorName?: string;
  version: number;
  deleted: boolean;
  redacted?: boolean;
  notice?: boolean;
  accountId?: string;
  toAccountId?: string;
  categoryId?: string;
  amount?: string;
  currency?: string;
  accountAmount?: string;
  accountCurrency?: string;
  toAmount?: string;
  baseAmount?: string;
  baseCurrency?: string;
  comment?: string;
  tags?: string[];
  originalId?: string;
  rates?: RateBook;
  pending?: boolean;
}
export interface Audit {
  id: string;
  objectId: string;
  action: string;
  actor: string;
  at: string;
  before: unknown;
  after: unknown;
  conflict: boolean;
}
export interface Member {
  id: string;
  name: string;
  role: Role;
}
export interface Mutation {
  id: string;
  command: string;
  input: Record<string, unknown>;
  baseVersion?: number;
}
export interface Pending extends Mutation {
  familyId: string;
  userId: string;
  error?: string;
  queuedAt?: number;
}
export interface Snapshot {
  family: Family;
  entities: Entity[];
  transactions: Transaction[];
  members: Member[];
  rates: RateBook | null;
  cursor: number;
  syncedAt: string;
}
export const categoryTemplates = [
  ['Groceries', 'basket'],
  ['Restaurants', 'utensils'],
  ['Rent', 'home'],
  ['Utilities', 'zap'],
  ['Transport', 'car'],
  ['Health', 'heart'],
  ['Entertainment', 'film'],
  ['Shopping', 'bag'],
  ['Travel', 'plane'],
  ['Education', 'book'],
  ['Other', 'grid'],
];
export const sourceTemplates = [
  ['Salary', 'briefcase'],
  ['Freelance', 'laptop'],
  ['Investment income', 'chart'],
  ['Gift', 'gift'],
  ['Other', 'grid'],
];
export const accountTypes = ['Card', 'Cash', 'Deposit', 'Bank account', 'Investment', 'Other'];
export function inScope(item: { ownerId: string | null }, scope: Scope, userId: string) {
  return scope === 'shared'
    ? !item.ownerId
    : scope === 'mine'
      ? item.ownerId === userId
      : !item.ownerId || item.ownerId === userId;
}
export function canManage(item: { ownerId: string | null }, role: Role, userId: string) {
  return item.ownerId ? item.ownerId === userId : role !== 'member';
}
export function canEdit(tx: Transaction, role: Role, userId: string) {
  return (
    !tx.redacted &&
    !tx.deleted &&
    (tx.ownerId ? tx.ownerId === userId : role !== 'member' || tx.authorId === userId)
  );
}
