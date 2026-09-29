'use client';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Mic, Square } from 'lucide-react';
import {
  AI_MAX_TEXT,
  aiCategories,
  possibleDuplicate,
  type AiDraft,
  type AiPreparation,
  type AiStatus,
} from '@/lib/ai';
import { APIError, api } from '@/lib/offline';
import { convert, D, validAmount } from '@/lib/money';
import type { Entity } from '@/lib/model';
import type { Kinflow } from './use-kinflow';
import { BusyButton, CurrencySelect, ErrorMessage, Field, Modal } from './ui';
import { useVoiceNote } from './use-voice-note';

export function GeminiIcon() {
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
          <stop stopColor="#4285f4" />
          <stop offset="1" stopColor="#9b72cb" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M12 1C13.6 7.6 16.4 10.4 23 12C16.4 13.6 13.6 16.4 12 23C10.4 16.4 7.6 13.6 1 12C7.6 10.4 10.4 7.6 12 1Z"
      />
    </svg>
  );
}
type Card = { key: string; included: boolean; draft: AiDraft };
type SaveRequest = { id: string; operations: Record<string, unknown>[] };

export function AiEntry({
  app,
  onClose,
  onManual,
  onSaved,
}: {
  app: Kinflow;
  onClose: () => void;
  onManual: () => void;
  onSaved: (message: string) => void;
}) {
  const snapshot = app.snapshot!;
  const base = `families/${snapshot.family.id}/ai`;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [text, setText] = useState('');
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const pending = useRef<SaveRequest | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const voice = useVoiceNote();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    if (app.online)
      void api<AiStatus>(`${base}/status`)
        .then((result) => {
          if (!cancelled) setStatus(result);
        })
        .catch(() => {
          if (!cancelled)
            setError(
              'AI entry is temporarily unavailable. You can still add transactions manually.',
            );
        })
        .finally(() => {
          if (!cancelled) setStatusLoading(false);
        });
    return () => {
      cancelled = true;
    };
  }, [base, app.online, statusAttempt]);
  const close = () => {
    if (busy || locked) return;
    onClose();
  };
  const manual = () => {
    voice.stop();
    onManual();
  };
  const refreshStatus = () =>
    void api<AiStatus>(`${base}/status`)
      .then((s) => {
        if (alive.current) setStatus(s);
      })
      .catch(() => {});
  async function accept() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setStatus(await api<AiStatus>(`${base}/accept`, 'POST', {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !app.online || voice.recording || voice.processing) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const input = {
      text,
      ...(voice.audio ? { audio: { mimeType: 'audio/wav', data: voice.audio.data } } : {}),
    };
    setText('');
    voice.clear();
    try {
      const result = await api<AiPreparation>(
        `${base}/prepare`,
        'POST',
        input,
        AbortSignal.timeout(45000),
      );
      if (!alive.current) return;
      setStatus(result.status);
      if (!result.drafts.length)
        setError(
          'No supported entries were found. Describe expenses, income or transfers, or use manual entry.',
        );
      else
        setCards(
          result.drafts.map((draft) => ({ key: crypto.randomUUID(), included: true, draft })),
        );
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        refreshStatus();
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !app.online || !cards) return;
    const retrying = !!pending.current;
    setError('');
    setNeedsSignIn(false);
    if (!pending.current) {
      const selected = cards.filter((c) => c.included);
      if (!selected.length) {
        setError('Include at least one entry.');
        return;
      }
      try {
        pending.current = {
          id: crypto.randomUUID(),
          operations: selected.map((c, i) => {
            const d = c.draft;
            const account = snapshot.entities.find((e) => e.id === d.accountId && !e.archived);
            const destination = snapshot.entities.find(
              (e) => e.id === d.toAccountId && !e.archived,
            );
            const valid = (value: string, currency: string) =>
              validAmount(value, currency) && D(value).gt(0);
            if (!account || !valid(d.amount, d.currency))
              throw new Error(
                `Entry ${i + 1}: choose an account and enter a valid amount greater than zero.`,
              );
            if (
              d.type !== 'transfer' &&
              !aiCategories(snapshot.entities, account, d.type).some((c) => c.id === d.categoryId)
            )
              throw new Error(`Entry ${i + 1}: choose a compatible category or income source.`);
            if (d.type === 'transfer' && (!destination || destination.id === account.id))
              throw new Error(`Entry ${i + 1}: choose two different accounts.`);
            if (d.currency !== account.currency && !valid(d.accountAmount, account.currency!))
              throw new Error(`Entry ${i + 1}: enter the actual account amount.`);
            if (
              d.type === 'transfer' &&
              destination!.currency !== account.currency &&
              !valid(d.toAmount, destination!.currency!)
            )
              throw new Error(`Entry ${i + 1}: enter the amount received.`);
            if (
              !convert('1', account.currency!, snapshot.family.currency, snapshot.rates) &&
              !valid(d.baseAmount, snapshot.family.currency)
            )
              throw new Error(`Entry ${i + 1}: enter the reporting amount.`);
            return {
              type: d.type,
              accountId: d.accountId,
              amount: d.amount,
              currency: d.currency,
              date: d.date,
              comment: d.comment,
              ...(d.type === 'transfer'
                ? { toAccountId: d.toAccountId, toAmount: d.toAmount || d.amount }
                : { categoryId: d.categoryId }),
              accountAmount: d.currency === account.currency ? d.amount : d.accountAmount,
              ...(d.baseAmount ? { baseAmount: d.baseAmount } : {}),
              ...(snapshot.rates ? { rateTimestamp: snapshot.rates.fetchedAt } : {}),
            };
          }),
        };
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    inFlight.current = true;
    setBusy(true);
    setLocked(true);
    try {
      const result = await api<{ ids: string[] }>(
        `${base}/save`,
        'POST',
        pending.current,
        AbortSignal.timeout(45000),
      );
      if (!alive.current) return;
      setSaved(true);
      setLocked(false);
      pending.current = null;
      void app.sync();
      onSaved(
        `${result.ids.length} ${result.ids.length === 1 ? 'transaction' : 'transactions'} saved`,
      );
      onClose();
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof APIError && e.status < 500 && !retrying) {
        pending.current = null;
        setLocked(false);
        setError(e.message);
      } else {
        setNeedsSignIn(e instanceof APIError && e.status === 401);
        setError(
          'The save could not be confirmed. Reconnect and retry this same batch safely; it will only be saved once.',
        );
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const unavailable = !app.online
    ? 'AI entry needs an internet connection. Manual entry works offline.'
    : status?.reason === 'quota'
      ? `The monthly AI limit has been reached. Available again ${new Date(status.resetsAt).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })} (UTC).`
      : status?.reason === 'unconfigured'
        ? 'AI entry is not available yet. You can add transactions manually.'
        : null;
  return (
    <Modal
      title={cards ? 'Review AI entries' : 'Add with AI'}
      onClose={close}
      closeDisabled={busy || locked}
      wide={!!cards}
    >
      <div className="form-stack ai-entry">
        <ErrorMessage message={error} />
        {needsSignIn && (
          <p className="notice">
            Your session expired.{' '}
            <a href="/api/auth/google" target="_blank" rel="noreferrer">
              Sign in in another tab
            </a>
            , then retry this batch here.
          </p>
        )}
        {cards ? (
          <form onSubmit={save} className="form-stack">
            <p className="muted">
              Review every entry. Fix a field or exclude an entry before saving the batch.
            </p>
            {!app.online && (
              <p className="notice" role="status">
                Your review stays here while you’re offline. Reconnect to save all entries together.
                Keep this window open.
              </p>
            )}
            {locked && (
              <p className="notice">
                These entries are held for a safe retry. Editing is available once the save result
                is known.
              </p>
            )}
            {cards.map((card, i) => (
              <DraftCard
                key={card.key}
                index={i}
                card={card}
                app={app}
                locked={busy || locked || saved}
                duplicate={
                  possibleDuplicate(card.draft, snapshot.transactions) ||
                  cards.some(
                    (other, j) => j < i && other.included && sameDraft(other.draft, card.draft),
                  )
                }
                onChange={(next) =>
                  setCards((prev) => prev!.map((c) => (c.key === card.key ? next : c)))
                }
              />
            ))}
            <div className="ai-actions">
              {!locked && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setCards(null);
                    setError('');
                  }}
                >
                  Start over
                </button>
              )}
              <BusyButton
                className="primary"
                busy={busy}
                disabled={!app.online || saved || !cards.some((c) => c.included)}
              >
                {locked ? 'Retry save all' : 'Save all'}
              </BusyButton>
            </div>
          </form>
        ) : (
          <>
            {unavailable ? (
              <p className="notice" role="status">
                {unavailable}
              </p>
            ) : !status ? (
              statusLoading ? (
                <p role="status">Checking AI availability…</p>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setError('');
                    setStatusAttempt((n) => n + 1);
                  }}
                >
                  Retry connection
                </button>
              )
            ) : !status.accepted ? (
              <div className="form-stack">
                <p>
                  Your text, audio and eligible account/category names will be sent to Google. Under
                  its free API terms, inputs and responses may help improve its services and may be
                  reviewed by people. Don’t include sensitive, confidential or identifying details.
                </p>
                <p className="muted">
                  KinFlow keeps only the transaction fields you confirm.{' '}
                  <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">
                    Google’s data terms
                  </a>
                </p>
                <BusyButton
                  className="primary"
                  busy={busy}
                  busyLabel="Continuing…"
                  type="button"
                  onClick={accept}
                >
                  I understand — continue
                </BusyButton>
              </div>
            ) : (
              <form onSubmit={prepare} className="form-stack">
                <Field
                  label="Describe your transactions"
                  hint="Type, paste edited SMS text or use your keyboard’s dictation. Russian and English are supported."
                >
                  <textarea
                    autoComplete="off"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    maxLength={AI_MAX_TEXT}
                    rows={5}
                    disabled={busy}
                    placeholder="Spent 35 GEL on groceries yesterday. Also moved 100 USD from my personal card to our everyday account and received 270 GEL."
                  />
                </Field>
                <div className="ai-voice">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || voice.processing}
                    onClick={() => (voice.recording ? voice.stop() : void voice.start())}
                  >
                    {voice.recording ? (
                      <Square size={17} aria-hidden="true" />
                    ) : (
                      <Mic size={17} aria-hidden="true" />
                    )}
                    {voice.recording
                      ? 'Stop recording'
                      : voice.audio
                        ? 'Record again'
                        : 'Record voice note'}
                  </button>
                  <span role="status">
                    {voice.recording
                      ? `${voice.seconds}s / 60s`
                      : voice.processing
                        ? 'Preparing audio…'
                        : 'Up to 1 minute'}
                  </span>
                </div>
                <ErrorMessage message={voice.error} />
                {voice.audio && (
                  <div className="ai-audio-preview">
                    <audio controls src={voice.audio.url} aria-label="Recorded voice note" />
                    <button type="button" className="text-button" onClick={voice.clear}>
                      Remove recording
                    </button>
                  </div>
                )}
                <p className="muted">
                  Text and a voice note can be sent together. You’ll review the entries before
                  saving.
                </p>
                <p className="muted">
                  Up to 20 expenses, income entries or transfers. Use manual entry for refunds or
                  edits.
                </p>
                <BusyButton
                  className="primary"
                  busy={busy}
                  busyLabel="Preparing…"
                  disabled={
                    !app.online ||
                    voice.recording ||
                    voice.processing ||
                    (!text.trim() && !voice.audio)
                  }
                >
                  Prepare entries
                </BusyButton>
              </form>
            )}
            <button type="button" className="text-button" onClick={manual} disabled={busy}>
              Use manual entry
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function sameDraft(a: AiDraft, b: AiDraft) {
  return (
    a.type === b.type &&
    a.date === b.date &&
    a.accountId === b.accountId &&
    a.toAccountId === b.toAccountId &&
    a.currency === b.currency &&
    validAmount(a.amount, a.currency) &&
    validAmount(b.amount, b.currency) &&
    D(a.amount).eq(b.amount)
  );
}

function DraftCard({
  card,
  index,
  app,
  locked,
  duplicate,
  onChange,
}: {
  card: Card;
  index: number;
  app: Kinflow;
  locked: boolean;
  duplicate: boolean;
  onChange: (card: Card) => void;
}) {
  const s = app.snapshot!,
    d = card.draft;
  const accounts = s.entities.filter((e) => e.kind === 'account' && !e.archived);
  const account = accounts.find((e) => e.id === d.accountId);
  const destination = accounts.find((e) => e.id === d.toAccountId);
  const categories = aiCategories(s.entities, account, d.type);
  const patch = (changes: Partial<AiDraft>) => {
    const next = { ...d, ...changes };
    const a = accounts.find((e) => e.id === next.accountId);
    if ('accountId' in changes) {
      next.currency = a?.currency || s.family.currency;
      next.accountAmount = '';
      next.baseAmount = '';
    }
    if (next.type === 'transfer') {
      next.currency = a?.currency || next.currency;
      next.categoryId = '';
      if (next.toAccountId === next.accountId)
        next.toAccountId = accounts.find((e) => e.id !== next.accountId)?.id || '';
      if ('accountId' in changes || 'toAccountId' in changes || 'type' in changes)
        next.toAmount = '';
    } else {
      const eligible = aiCategories(s.entities, a, next.type);
      if (!eligible.some((e) => e.id === next.categoryId)) next.categoryId = eligible[0]?.id || '';
      next.toAccountId = '';
      next.toAmount = '';
    }
    onChange({ ...card, draft: next });
  };
  const options = (items: Entity[]) =>
    items.map((e) => (
      <option key={e.id} value={e.id}>
        {e.name}
        {e.currency ? ` · ${e.currency}` : ''} · {e.ownerId ? 'Only you' : 'Shared'}
      </option>
    ));
  const needsBase = account && convert('1', account.currency!, s.family.currency, s.rates) === null;
  const personal = !!account?.ownerId || (d.type === 'transfer' && !!destination?.ownerId);
  const mixed =
    (d.type === 'transfer' && account?.ownerId !== destination?.ownerId) ||
    (d.type === 'income' && personal && !categories.find((c) => c.id === d.categoryId)?.ownerId);
  return (
    <section
      className={'ai-card ' + (!card.included ? 'ai-excluded' : '')}
      aria-label={`Entry ${index + 1}`}
    >
      <div className="ai-card-header">
        <h3>Entry {index + 1}</h3>
        <label className="ai-include">
          <input
            type="checkbox"
            checked={card.included}
            disabled={locked}
            onChange={(e) => onChange({ ...card, included: e.target.checked })}
          />
          Include entry
        </label>
      </div>
      {duplicate && card.included && (
        <p className="notice ai-duplicate" role="status">
          Possible duplicate: a similar entry already exists or appears in this batch. Keep it
          included only if it’s a separate transaction.
        </p>
      )}
      <fieldset disabled={locked || !card.included} className="ai-card-fields">
        <legend className="sr-only">Entry {index + 1} details</legend>
        <div className="ai-fields-grid">
          <Field label="Type">
            <select
              value={d.type}
              onChange={(e) => patch({ type: e.target.value as AiDraft['type'] })}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
              <option value="transfer">Transfer</option>
            </select>
          </Field>
          <Field label="Date">
            <input
              type="date"
              required
              value={d.date}
              onChange={(e) => patch({ date: e.target.value })}
            />
          </Field>
          <Field label={d.type === 'transfer' ? 'From account' : 'Account'}>
            <select
              required
              value={d.accountId}
              onChange={(e) => patch({ accountId: e.target.value })}
            >
              <option value="">Choose an account</option>
              {options(accounts)}
            </select>
          </Field>
          {d.type === 'transfer' ? (
            <Field label="To account">
              <select
                required
                value={d.toAccountId}
                onChange={(e) => patch({ toAccountId: e.target.value })}
              >
                <option value="">Choose an account</option>
                {options(accounts.filter((a) => a.id !== d.accountId))}
              </select>
            </Field>
          ) : (
            <Field label={d.type === 'income' ? 'Income source' : 'Category'}>
              <select
                required
                value={d.categoryId}
                onChange={(e) => patch({ categoryId: e.target.value })}
              >
                <option value="">Choose a category</option>
                {options(categories)}
              </select>
            </Field>
          )}
          <Field label="Amount">
            <input
              inputMode="decimal"
              required
              value={d.amount}
              placeholder="Enter amount"
              onChange={(e) => patch({ amount: e.target.value })}
            />
          </Field>
          <CurrencySelect
            value={d.currency}
            onChange={(currency) => patch({ currency, accountAmount: '' })}
            disabled={d.type === 'transfer' || locked || !card.included}
          />
          {account && d.currency !== account.currency && (
            <Field label={`Actual account amount (${account.currency})`}>
              <input
                inputMode="decimal"
                required
                value={d.accountAmount}
                onChange={(e) => patch({ accountAmount: e.target.value })}
              />
            </Field>
          )}
          {d.type === 'transfer' && destination && destination.currency !== account?.currency && (
            <Field label={`Amount received (${destination.currency})`}>
              <input
                inputMode="decimal"
                required
                value={d.toAmount}
                onChange={(e) => patch({ toAmount: e.target.value })}
              />
            </Field>
          )}
          {needsBase && (
            <Field
              label={`Reporting amount (${s.family.currency})`}
              hint="No exchange rate is available."
            >
              <input
                inputMode="decimal"
                required
                value={d.baseAmount}
                onChange={(e) => patch({ baseAmount: e.target.value })}
              />
            </Field>
          )}
        </div>
        <Field label="Note (optional)">
          <textarea
            rows={2}
            maxLength={2000}
            value={d.comment}
            onChange={(e) => patch({ comment: e.target.value })}
          />
        </Field>
        <p className="muted">
          {personal ? 'Only you can see the details.' : 'Visible to your family.'}
          {mixed ? ' Other family members can see that a transaction occurred.' : ''}
        </p>
      </fieldset>
    </section>
  );
}
