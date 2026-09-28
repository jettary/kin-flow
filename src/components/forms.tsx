'use client';
import { useEffect, useMemo, useState, useRef, type FormEvent } from 'react';
import type { Entity, Transaction, TransactionType } from '@/lib/model';
import { accountTypes, categoryTemplates, sourceTemplates } from '@/lib/model';
import { D, convert, localDate, money, validAmount } from '@/lib/money';
import { api } from '@/lib/offline';
import type { Kinflow } from './use-kinflow';
import { BusyButton, CurrencySelect, ErrorMessage, Field, Icon, Modal, Privacy } from './ui';
export function TransactionForm({
  app,
  onClose,
  onSaved,
  transaction,
  initialType = 'expense',
  account,
  refund,
}: {
  app: Kinflow;
  onClose: () => void;
  onSaved: (message: string) => void;
  transaction?: Transaction;
  initialType?: TransactionType;
  account?: Entity;
  refund?: Transaction;
}) {
  const s = app.snapshot!,
    family = s.family,
    old = transaction;
  const [type, setType] = useState<TransactionType>(refund ? 'refund' : old?.type || initialType);
  const accounts = s.entities.filter(
    (e) =>
      e.kind === 'account' &&
      (!e.archived ||
        e.id === old?.accountId ||
        e.id === old?.toAccountId ||
        e.id === refund?.accountId),
  );
  const recent = s.transactions
    .filter((t) => !t.deleted && !t.redacted)
    .sort((a, b) => b.date.localeCompare(a.date));
  const [accountId, setAccountId] = useState(
    refund?.accountId ||
      old?.accountId ||
      account?.id ||
      recent.find((t) => accounts.some((a) => a.id === t.accountId))?.accountId ||
      accounts[0]?.id ||
      '',
  );
  const selected = accounts.find((e) => e.id === accountId);
  const [toId, setToId] = useState(
    old?.toAccountId || accounts.find((e) => e.id !== accountId)?.id || '',
  );
  const destination = accounts.find((e) => e.id === toId);
  const alreadyRefunded = s.transactions
    .filter((t) => t.originalId === refund?.id && !t.deleted)
    .reduce((acc, t) => acc.plus(t.accountAmount || '0'), D());
  const [amount, setAmount] = useState(
      refund ? D(refund.accountAmount!).minus(alreadyRefunded).toFixed() : old?.amount || '',
    ),
    [currency, setCurrency] = useState(
      refund ? selected?.currency || 'GEL' : old?.currency || selected?.currency || family.currency,
    ),
    [actual, setActual] = useState(old?.accountAmount || ''),
    [received, setReceived] = useState(old?.toAmount || ''),
    [receivedEdited, setReceivedEdited] = useState(!!old);
  const [categoryId, setCategoryId] = useState(old?.categoryId || refund?.categoryId || ''),
    [date, setDate] = useState(old?.date || localDate(family.timezone)),
    [comment, setComment] = useState(old?.comment || ''),
    [tags, setTags] = useState((old?.tags || refund?.tags)?.map((t) => '#' + t).join(' ') || ''),
    [baseAmount, setBaseAmount] = useState(old?.baseAmount || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [announcement, setAnnouncement] = useState('');
  const [balanceTarget, setBalanceTarget] = useState(
    old?.type === 'adjustment' ? D(selected?.balance || '0').toFixed() : '',
  );
  const categories = useMemo(
    () =>
      s.entities.filter(
        (e) =>
          e.kind === (type === 'income' ? 'source' : 'expense') &&
          (!e.archived || e.id === old?.categoryId) &&
          (e.ownerId === selected?.ownerId ||
            (type === 'income' && !e.ownerId && !!selected?.ownerId)),
      ),
    [s.entities, type, selected?.ownerId, old?.categoryId],
  );
  const suggestions = (items: Entity[], field: 'accountId' | 'categoryId') => {
    const eligible = recent.filter((t) => items.some((item) => item.id === t[field]));
    const frequency = new Map<string, number>();
    for (const t of eligible) frequency.set(t[field]!, (frequency.get(t[field]!) || 0) + 1);
    const frequent = [...items].sort(
      (a, b) => (frequency.get(b.id) || 0) - (frequency.get(a.id) || 0),
    );
    return [
      ...new Set([
        eligible[0]?.[field],
        ...frequent.filter((item) => frequency.has(item.id)).map((item) => item.id),
      ]),
    ]
      .filter((id): id is string => !!id)
      .slice(0, 3);
  };
  const sourceAccounts = accounts.filter(
    (a) => !a.archived || a.id === old?.accountId || a.id === refund?.accountId,
  );
  const accountSuggestions = suggestions(sourceAccounts, 'accountId');
  const categorySuggestions = suggestions(categories, 'categoryId');
  useEffect(() => {
    if (type === 'refund') return;
    if (!categories.some((c) => c.id === categoryId)) {
      const suggested = recent.find(
        (t) => t.type === type && categories.some((c) => c.id === t.categoryId),
      );
      setCategoryId(suggested?.categoryId || categories[0]?.id || '');
      if (categoryId) setAnnouncement('Category updated to match the account visibility.');
    }
  }, [accountId, type, categories.map((c) => c.id).join('|')]);
  useEffect(() => {
    if (
      type === 'transfer' &&
      selected &&
      destination &&
      validAmount(amount, selected.currency!) &&
      !receivedEdited
    ) {
      const suggested = convert(amount, selected.currency!, destination.currency!, s.rates);
      setReceived(suggested || '');
    }
  }, [amount, accountId, toId, type, receivedEdited]);
  const personal = !!selected?.ownerId || (type === 'transfer' && !!destination?.ownerId);
  const mixed =
    (type === 'transfer' && selected?.ownerId !== destination?.ownerId) ||
    (type === 'income' && personal && !categories.find((c) => c.id === categoryId)?.ownerId);
  const hasRate = selected
    ? convert('1', selected.currency!, family.currency, old?.rates || s.rates) !== null
    : true;
  const changeAccount = (id: string) => {
    setAccountId(id);
    const a = accounts.find((e) => e.id === id);
    setCurrency(a?.currency || family.currency);
    setActual('');
    setReceivedEdited(false);
    if (id === toId) setToId(accounts.find((a) => a.id !== id)?.id || '');
  };
  const saving = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    setError('');
    if (!selected) {
      setError('Add an account first.');
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      let entryAmount = amount;
      if (type === 'adjustment') {
        if (!validAmount(balanceTarget, selected.currency!, true))
          throw new Error('Enter a valid new balance.');
        entryAmount = D(balanceTarget)
          .minus(selected.balance || '0')
          .plus(old?.type === 'adjustment' ? old.accountAmount || '0' : '0')
          .toFixed();
      }
      if (
        !validAmount(entryAmount, currency, type === 'adjustment') ||
        (type !== 'adjustment' && !D(entryAmount).gt(0))
      )
        throw new Error('Enter a valid amount greater than zero.');
      if (type === 'expense' || type === 'income') {
        if (!categoryId)
          throw new Error('Add a compatible category or income source in More first.');
      }
      if (
        currency !== selected.currency &&
        (!validAmount(actual, selected.currency!) || !D(actual).gt(0))
      )
        throw new Error('Enter the actual account amount.');
      if (type === 'transfer' && (!destination || selected.id === destination.id))
        throw new Error('Choose two different accounts.');
      if (
        type === 'transfer' &&
        destination?.currency !== selected.currency &&
        (!validAmount(received, destination!.currency!) || !D(received).gt(0))
      )
        throw new Error('Enter the actual amount received.');
      if (!hasRate && !validAmount(baseAmount, family.currency, type === 'adjustment'))
        throw new Error('Enter the reporting amount.');
      const message = await app.save(
        'transaction.save',
        {
          ...(old ? { id: old.id } : {}),
          type,
          amount: entryAmount,
          currency,
          accountId: selected.id,
          toAccountId: type === 'transfer' ? toId : undefined,
          categoryId: ['expense', 'income'].includes(type) ? categoryId : undefined,
          accountAmount: currency === selected.currency ? entryAmount : actual,
          toAmount: received || undefined,
          date,
          comment,
          tags: tags
            .split(/[\s,]+/)
            .map((t) => t.replace(/^#+/, ''))
            .filter(Boolean),
          originalId: refund?.id,
          rateTimestamp: (old?.rates || s.rates)?.fetchedAt,
          baseAmount: baseAmount || undefined,
        },
        old?.version,
      );
      onSaved(message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        refund
          ? 'Record a refund'
          : type === 'adjustment'
            ? 'Adjust balance'
            : old
              ? 'Edit transaction'
              : 'Add transaction'
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        {!old && !refund && type !== 'adjustment' && (
          <div className="segmented form-tabs">
            {(['expense', 'income', 'transfer'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={type === t ? 'active' : ''}
                onClick={() => {
                  setType(t);
                  if (t === 'transfer') setCurrency(selected?.currency || family.currency);
                }}
              >
                <Icon name={t} size={17} />
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        )}
        {type === 'adjustment' ? (
          <>
            <p className="notice">
              Current balance <strong>{money(selected?.balance, selected?.currency)}</strong>
            </p>
            <Field label="New balance">
              <input
                autoFocus
                inputMode="decimal"
                required
                value={balanceTarget}
                onChange={(e) => setBalanceTarget(e.target.value)}
                placeholder="0.00"
                className="amount-input"
              />
            </Field>
            {balanceTarget &&
              validAmount(balanceTarget, selected?.currency || family.currency, true) && (
                <small>
                  Adjustment:{' '}
                  {money(
                    D(balanceTarget)
                      .minus(selected?.balance || '0')
                      .toFixed(),
                    selected?.currency,
                  )}
                </small>
              )}
          </>
        ) : (
          <Field
            label={type === 'transfer' ? 'Amount sent' : refund ? 'Amount refunded' : 'Amount'}
          >
            <div className="amount-wrap">
              <input
                autoFocus
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="amount-input"
                aria-label="Amount"
              />
              <span>{currency}</span>
            </div>
          </Field>
        )}
        {refund && (
          <p className="notice">
            Credits the original account and reduces spending on the receipt date. Remaining
            refundable:{' '}
            <strong>
              {money(D(refund.accountAmount!).minus(alreadyRefunded).toFixed(), selected?.currency)}
            </strong>
            .
          </p>
        )}
        <Field label={type === 'transfer' ? 'From account' : 'Account'}>
          <select
            value={accountId}
            onChange={(e) => changeAccount(e.target.value)}
            disabled={!!refund}
            required
          >
            <option value="" disabled>
              Select an account
            </option>
            {accountSuggestions.length > 0 && (
              <optgroup label="Recent & frequently used">
                {accountSuggestions.map((id) => {
                  const a = sourceAccounts.find((a) => a.id === id)!;
                  return (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency} · {a.ownerId ? 'Only you' : 'Shared'}
                    </option>
                  );
                })}
              </optgroup>
            )}
            <optgroup label="Accounts">
              {sourceAccounts
                .filter((a) => !accountSuggestions.includes(a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.currency} · {a.ownerId ? 'Only you' : 'Shared'}
                  </option>
                ))}
            </optgroup>
          </select>
        </Field>
        {type === 'transfer' ? (
          <>
            <Field label="To account">
              <select
                value={toId}
                onChange={(e) => {
                  setToId(e.target.value);
                  setReceivedEdited(false);
                }}
                required
              >
                <option value="" disabled>
                  Select destination
                </option>
                {accounts
                  .filter((a) => a.id !== accountId && (!a.archived || a.id === old?.toAccountId))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency} · {a.ownerId ? 'Only you' : 'Shared'}
                    </option>
                  ))}
              </select>
            </Field>
            {destination?.currency !== selected?.currency && (
              <>
                <Field
                  label={`Amount received · ${destination?.currency || ''}`}
                  hint="Use the actual amount credited by your bank."
                >
                  <input
                    required
                    inputMode="decimal"
                    value={received}
                    onChange={(e) => {
                      setReceived(e.target.value);
                      setReceivedEdited(true);
                    }}
                    placeholder="Actual received amount"
                  />
                </Field>
                {validAmount(amount, selected?.currency || family.currency) &&
                  validAmount(received, destination?.currency || family.currency) &&
                  D(amount).gt(0) && (
                    <small>
                      1 {selected?.currency} = {D(received).div(amount).toFixed(6)}{' '}
                      {destination?.currency}
                    </small>
                  )}
              </>
            )}
          </>
        ) : (
          ['expense', 'income'].includes(type) && (
            <Field label={type === 'income' ? 'Income source' : 'Category'}>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
                <option value="" disabled>
                  Select {type === 'income' ? 'source' : 'category'}
                </option>
                {categorySuggestions.length > 0 && (
                  <optgroup label="Recent & frequently used">
                    {categorySuggestions.map((id) => {
                      const c = categories.find((c) => c.id === id)!;
                      return (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.ownerId ? 'Only you' : 'Shared'}
                        </option>
                      );
                    })}
                  </optgroup>
                )}
                <optgroup label={type === 'income' ? 'Income sources' : 'Categories'}>
                  {categories
                    .filter((c) => !categorySuggestions.includes(c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.ownerId ? 'Only you' : 'Shared'}
                      </option>
                    ))}
                </optgroup>
              </select>
            </Field>
          )
        )}
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        <div>
          <Privacy personal={personal} />
        </div>
        {mixed && (
          <p className="notice">
            <Icon name="lock" size={18} />
            Only you can see the details. Your family will see that{' '}
            {type === 'transfer' ? 'a transfer' : 'an income posting'} occurred.
          </p>
        )}
        {['expense', 'income'].includes(type) && (
          <details>
            <summary>Different purchase currency</summary>
            <div className="form-stack">
              <CurrencySelect
                value={currency}
                onChange={setCurrency}
                label="Transaction currency"
              />
              {currency !== selected?.currency && (
                <Field
                  label={`Actual ${type === 'income' ? 'credited' : 'debited'} amount · ${selected?.currency}`}
                >
                  <input
                    inputMode="decimal"
                    value={actual}
                    required
                    onChange={(e) => setActual(e.target.value)}
                    placeholder="0.00"
                  />
                </Field>
              )}
            </div>
          </details>
        )}
        {!hasRate && (
          <Field
            label={`Reporting amount · ${family.currency}`}
            hint="A conversion rate is unavailable. Enter the known equivalent."
          >
            <input
              inputMode="decimal"
              value={baseAmount}
              required
              onChange={(e) => setBaseAmount(e.target.value)}
            />
          </Field>
        )}
        <Field label={refund ? 'Receipt date' : 'Date'}>
          <input
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            min={refund?.date}
          />
        </Field>
        <Field label={type === 'adjustment' ? 'Reason' : 'Note (optional)'}>
          <textarea
            value={comment}
            maxLength={2000}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              type === 'adjustment' ? 'Why does the balance need correcting?' : 'What was it for?'
            }
            required={type === 'adjustment'}
            rows={2}
          />
        </Field>
        <Field label="Tags (optional)">
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="#groceries #family"
            list="tag-suggestions"
          />
          <datalist id="tag-suggestions">
            {[...new Set(s.transactions.flatMap((t) => t.tags || []))].map((t) => (
              <option value={'#' + t} key={t} />
            ))}
          </datalist>
        </Field>
        {s.rates && (
          <small className="muted">
            Rate updated {s.rates.date} · {s.rates.provider}
          </small>
        )}
        <ErrorMessage message={error} />
        <BusyButton className="primary full" busy={busy} type="submit">
          <Icon name="check" size={18} />
          {old
            ? 'Save changes'
            : refund
              ? 'Save refund'
              : type === 'adjustment'
                ? 'Save adjustment'
                : 'Save transaction'}
        </BusyButton>
      </form>
    </Modal>
  );
}
export function EntityForm({
  app,
  entity,
  kind = 'account',
  onClose,
  onSaved,
}: {
  app: Kinflow;
  entity?: Entity;
  kind?: 'account' | 'expense' | 'source';
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const family = app.snapshot!.family;
  const [name, setName] = useState(entity?.name || ''),
    [visibility, setVisibility] = useState(entity?.ownerId ? 'mine' : 'shared'),
    [currency, setCurrency] = useState(entity?.currency || family.currency),
    [bank, setBank] = useState(entity?.bank || ''),
    [type, setType] = useState(entity?.accountType || 'Card'),
    [balance, setBalance] = useState(entity?.openingBalance || '0'),
    [date, setDate] = useState(entity?.openingDate || localDate(family.timezone)),
    [included, setIncluded] = useState(entity?.included ?? true),
    [icon, setIcon] = useState(
      entity?.icon || (kind === 'account' ? 'card' : kind === 'source' ? 'briefcase' : 'basket'),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (family.role === 'member' && !entity) setVisibility('mine');
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const message = await app.save('entity.save', {
        id: entity?.id,
        kind,
        name,
        icon,
        ownerId: visibility === 'mine' ? app.user!.id : null,
        currency: kind === 'account' ? currency : undefined,
        accountType: kind === 'account' ? type : undefined,
        bank,
        openingBalance: balance,
        openingDate: date,
        included,
        archived: entity?.archived || false,
      });
      onSaved(message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${entity ? 'Edit' : 'Add'} ${kind === 'account' ? 'account' : kind === 'source' ? 'income source' : 'category'}`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="form-stack">
        <Field label="Name">
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === 'account' ? 'Everyday card' : 'Groceries'}
          />
        </Field>
        <Field label="Visibility">
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            disabled={!!entity}
          >
            <option value="shared" disabled={family.role === 'member'}>
              Shared with family
            </option>
            <option value="mine">Only you</option>
          </select>
        </Field>
        <Field label="Icon">
          <div className="icon-grid">
            {[
              'card',
              'wallet',
              'landmark',
              'basket',
              'utensils',
              'home',
              'car',
              'heart',
              'bag',
              'plane',
              'coffee',
              'briefcase',
              'gift',
              'book',
              'zap',
              'grid',
            ].map((n) => (
              <button
                key={n}
                type="button"
                className={'icon-button ' + (icon === n ? 'selected' : '')}
                onClick={() => setIcon(n)}
                aria-label={n}
                aria-pressed={icon === n}
              >
                <Icon name={n} />
              </button>
            ))}
          </div>
        </Field>
        {kind === 'account' && (
          <>
            <div className="form-columns">
              <Field label="Account type">
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  {accountTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <CurrencySelect value={currency} onChange={setCurrency} disabled={!!entity} />
            </div>
            <Field label="Bank (optional)">
              <input value={bank} onChange={(e) => setBank(e.target.value)} maxLength={100} />
            </Field>
            {!entity && (
              <>
                <Field label="Opening balance">
                  <input
                    inputMode="decimal"
                    value={balance}
                    onChange={(e) => setBalance(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Opening balance date">
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </Field>
                <p className="muted small">
                  Currency and visibility cannot change after creation. Opening balances do not
                  count as income.
                </p>
              </>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={included}
                onChange={(e) => setIncluded(e.target.checked)}
              />
              <span>Include in available balance</span>
            </label>
          </>
        )}
        <ErrorMessage message={error} />
        <BusyButton busy={busy} className="primary full">
          {entity ? 'Save changes' : 'Create ' + (kind === 'source' ? 'income source' : kind)}
        </BusyButton>
      </form>
    </Modal>
  );
}
export function BudgetForm({
  app,
  category,
  onClose,
  onSaved,
}: {
  app: Kinflow;
  category: Entity;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const previous = app
    .snapshot!.entities.filter((e) => e.kind === 'budget' && e.categoryId === category.id)
    .sort((a, b) => b.effectiveMonth!.localeCompare(a.effectiveMonth!))[0];
  const [limit, setLimit] = useState(previous?.limit || ''),
    [currency, setCurrency] = useState(previous?.currency || app.snapshot!.family.currency),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={`${category.name} budget`} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onSaved(await app.save('budget.save', { categoryId: category.id, limit, currency }));
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Monthly limit">
          <input
            autoFocus
            inputMode="decimal"
            value={limit}
            required
            onChange={(e) => setLimit(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <CurrencySelect value={currency} onChange={setCurrency} />
        <p className="notice">
          Applies to this month and future months. Earlier monthly limits stay unchanged.
        </p>
        <ErrorMessage message={error} />
        <BusyButton busy={busy} className="primary full">
          Save budget
        </BusyButton>
        {previous && !previous.archived && (
          <button
            className="text-button"
            type="button"
            onClick={async () => {
              try {
                onSaved(
                  await app.save('budget.save', {
                    categoryId: category.id,
                    limit: previous.limit,
                    currency: previous.currency,
                    archived: true,
                  }),
                );
                onClose();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Stop budget from this month
          </button>
        )}
      </form>
    </Modal>
  );
}
export function Onboarding({ app, onClose }: { app: Kinflow; onClose?: () => void }) {
  const [mode, setMode] = useState<'create' | 'join'>('create'),
    [name, setName] = useState(''),
    [currency, setCurrency] = useState('GEL'),
    [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [templates, setTemplates] = useState<string[]>([]),
    [code, setCode] = useState(''),
    [invitation, setInvitation] = useState<{ name: string; status: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const value = localStorage.getItem('kinflow-invite');
    if (value) {
      setMode('join');
      setCode(value);
    }
  }, []);
  const content = (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          if (mode === 'create') {
            const family = await api<{ id: string }>('families', 'POST', {
              name,
              currency,
              timezone: zone,
              templates,
            });
            await app.reload();
            app.setActiveId(family.id);
          } else if (!invitation) {
            setInvitation(await api('invites/' + encodeURIComponent(code.trim())));
            return;
          } else {
            const result = await api<{ familyId: string }>('join', 'POST', { code });
            localStorage.removeItem('kinflow-invite');
            await app.reload();
            app.setActiveId(result.familyId);
          }
          onClose?.();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">A little clarity for your family’s everyday money.</p>
      <div className="segmented">
        <button
          type="button"
          className={mode === 'create' ? 'active' : ''}
          onClick={() => setMode('create')}
        >
          Create a family
        </button>
        <button
          type="button"
          className={mode === 'join' ? 'active' : ''}
          onClick={() => setMode('join')}
        >
          Join a family
        </button>
      </div>
      {mode === 'create' ? (
        <>
          <Field label="Family name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="The Morgan family"
              required
              maxLength={100}
            />
          </Field>
          <CurrencySelect value={currency} onChange={setCurrency} label="Base currency" />
          <small className="muted">
            Your reporting currency is fixed once the family is created.
          </small>
          <Field label="Time zone">
            <input
              list="timezones"
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              required
            />
            <datalist id="timezones">
              {Intl.supportedValuesOf('timeZone').map((t) => (
                <option key={t}>{t}</option>
              ))}
            </datalist>
          </Field>
          <details>
            <summary>Optional starter categories & sources</summary>
            <div className="template-grid">
              {[...categoryTemplates, ...sourceTemplates]
                .filter((t, i, a) => a.findIndex((x) => x[0] === t[0]) === i)
                .map(([n]) => (
                  <label key={n} className="checkbox">
                    <input
                      type="checkbox"
                      checked={templates.includes(n)}
                      onChange={(e) =>
                        setTemplates(
                          e.target.checked ? [...templates, n] : templates.filter((t) => t !== n),
                        )
                      }
                    />
                    {n}
                  </label>
                ))}
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setTemplates([...categoryTemplates, ...sourceTemplates].map((t) => t[0]))
              }
            >
              Select all
            </button>
          </details>
          <p className="small muted">You can add your first account on the next screen.</p>
        </>
      ) : (
        <>
          <Field label="Invitation code">
            <input
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setInvitation(null);
              }}
              placeholder="Enter your invitation code"
              required
            />
          </Field>
          {invitation && (
            <p className="notice">
              <strong>{invitation.name}</strong> ·{' '}
              {invitation.status === 'already'
                ? "You're already a member"
                : invitation.status === 'expired'
                  ? 'Invitation expired'
                  : invitation.status === 'used'
                    ? 'Invitation used up'
                    : 'Your invitation is ready'}
            </p>
          )}
        </>
      )}
      <ErrorMessage message={error} />
      <BusyButton
        busy={busy}
        className="primary full"
        disabled={
          mode === 'join' && !!invitation && ['expired', 'used'].includes(invitation.status)
        }
      >
        {mode === 'create'
          ? 'Create family'
          : !invitation
            ? 'Check invitation'
            : invitation.status === 'already'
              ? 'Open family'
              : 'Join ' + invitation.name}
        <Icon name="right" size={18} />
      </BusyButton>
    </form>
  );
  return onClose ? (
    <Modal title="Your family workspace" onClose={onClose}>
      {content}
    </Modal>
  ) : (
    <div className="welcome-page">
      <div className="welcome-card">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="leaf" />
          </span>
          KinFlow
        </div>
        <h1>Better, together.</h1>
        {content}
      </div>
    </div>
  );
}
