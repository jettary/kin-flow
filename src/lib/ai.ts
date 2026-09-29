import type { Entity, Transaction } from './model';
import { D, validAmount } from './money';

export const AI_MONTHLY_LIMIT = 1000;
export const AI_MAX_ENTRIES = 20;
export const AI_MAX_TEXT = 8000;
export const AI_MAX_AUDIO_SECONDS = 60;
export const AI_AUDIO_RATE = 16000;
export const AI_MAX_AUDIO_BYTES = 44 + AI_AUDIO_RATE * 2 * AI_MAX_AUDIO_SECONDS;
export const AI_NOTICE_VERSION = 1;

export interface AiDraft {
  type: 'expense' | 'income' | 'transfer';
  accountId: string;
  toAccountId: string;
  categoryId: string;
  amount: string;
  currency: string;
  accountAmount: string;
  toAmount: string;
  baseAmount: string;
  date: string;
  comment: string;
}
export interface AiStatus {
  available: boolean;
  reason: 'unconfigured' | 'quota' | null;
  accepted: boolean;
  remaining: number;
  resetsAt: string;
}
export interface AiPreparation {
  drafts: AiDraft[];
  status: AiStatus;
}
export function aiCategories(
  entities: Entity[],
  account: Entity | undefined,
  type: AiDraft['type'],
) {
  return entities.filter(
    (e) =>
      !e.archived &&
      e.kind === (type === 'income' ? 'source' : 'expense') &&
      account &&
      (e.ownerId === account.ownerId || (type === 'income' && !e.ownerId && !!account.ownerId)),
  );
}

// Runs on the user's device, including its pending manual entries. History never goes to AI.
export function possibleDuplicate(draft: AiDraft, rows: Transaction[]) {
  if (!validAmount(draft.amount, draft.currency)) return false;
  return rows.some(
    (row) =>
      !row.deleted &&
      !row.redacted &&
      row.type === draft.type &&
      row.date === draft.date &&
      row.accountId === draft.accountId &&
      row.currency === draft.currency &&
      row.amount &&
      D(row.amount).eq(draft.amount) &&
      (draft.type !== 'transfer' || row.toAccountId === draft.toAccountId),
  );
}
