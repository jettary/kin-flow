import type { Transaction } from './model';

export const defaultPushPreferences = {
  expenseCreated: true,
  expenseChanged: false,
  transfer: false,
  income: false,
};
export type PushPreferences = typeof defaultPushPreferences;
export type PushEvent = keyof PushPreferences;
export interface PushSettings {
  publicKey: string | null;
  preferences: PushPreferences;
}

// Accept only the server-derived visibility, never the mutation's input fields.
export function pushEvent(
  tx: Pick<Transaction, 'type' | 'ownerId' | 'notice'>,
  changed: boolean,
): PushEvent | null {
  if (tx.ownerId && !tx.notice) return null;
  switch (tx.type) {
    case 'expense':
      return changed ? 'expenseChanged' : 'expenseCreated';
    case 'refund':
      return 'expenseChanged';
    case 'transfer':
      return 'transfer';
    case 'income':
      return 'income';
    default:
      return null;
  }
}
