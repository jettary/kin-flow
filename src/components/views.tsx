'use client';
import { useEffect, useState } from 'react';
import { budgetFor, budgetState, comparison, holdings, totals } from '@/lib/analytics';
import { D, convert, formatDate, localDate, money, shiftMonth } from '@/lib/money';
import {
  canEdit,
  canManage,
  inScope,
  type Audit,
  type Entity,
  type Scope,
  type Transaction,
  type TransactionType,
} from '@/lib/model';
import { api, clearCache, clearFamily } from '@/lib/offline';
import type { Kinflow } from './use-kinflow';
import { Empty, ErrorMessage, Field, Icon, Modal, Privacy } from './ui';
export type Actions = {
  transaction: (type?: TransactionType, account?: Entity) => void;
  editTransaction: (t: Transaction) => void;
  refund: (t: Transaction) => void;
  detail: (t: Transaction) => void;
  entity: (kind: 'account' | 'expense' | 'source', entity?: Entity) => void;
  budget: (category: Entity) => void;
  account: (e: Entity) => void;
  toast: (m: string) => void;
};
export function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <div className="month-picker">
      <button
        className="icon-button"
        aria-label="Previous month"
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        <Icon name="left" size={18} />
      </button>
      <span>
        {new Date(month + '-01T12:00:00').toLocaleDateString('en', {
          month: 'long',
          year: 'numeric',
        })}
      </span>
      <button
        className="icon-button"
        aria-label="Next month"
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        <Icon name="right" size={18} />
      </button>
    </div>
  );
}
export function TransactionRows({
  app,
  transactions,
  onClick,
}: {
  app: Kinflow;
  transactions: Transaction[];
  onClick: (t: Transaction) => void;
}) {
  const s = app.snapshot!;
  return (
    <div className="transaction-list">
      {transactions.map((t) => {
        const category = s.entities.find((c) => c.id === t.categoryId),
          account = s.entities.find((a) => a.id === t.accountId),
          to = s.entities.find((a) => a.id === t.toAccountId);
        return (
          <button
            key={t.id}
            className={'transaction-row ' + (t.deleted ? 'deleted' : '')}
            onClick={() => onClick(t)}
          >
            <span
              className={
                'category-icon ' + (t.type === 'income' || t.type === 'refund' ? 'income' : '')
              }
            >
              <Icon name={t.redacted ? t.type : category?.icon || t.type} size={20} />
            </span>
            <span className="transaction-description">
              <strong>
                {t.redacted
                  ? `${t.type === 'income' ? 'Income' : 'Transfer'} recorded`
                  : t.type === 'transfer'
                    ? `${account?.name || 'Account'} → ${to?.name || 'Account'}`
                    : category?.name || 'Balance adjustment'}
              </strong>
              <span>
                {t.redacted ? 'Amount private' : t.comment || account?.name}
                {t.pending && (
                  <em>
                    {' '}
                    ·{' '}
                    {app.queue.some((q) => (q.input.id || q.id) === t.id && q.error)
                      ? 'Failed to sync'
                      : 'Pending sync'}
                  </em>
                )}
                {t.deleted && ' · Deleted'}
                {t.type === 'refund' && ' · Refund'}
              </span>
            </span>
            <span className="transaction-value">
              <strong className={['income', 'refund'].includes(t.type) ? 'positive' : ''}>
                {t.redacted ? (
                  <Icon name="lock" size={16} />
                ) : (
                  `${['income', 'refund'].includes(t.type) ? '+' : t.type === 'expense' ? '−' : ''}${money(t.amount, t.currency)}`
                )}
              </strong>
              <span>
                {formatDate(t.date, app.user?.dateFormat)}
                {!t.redacted && t.ownerId && <Icon name="lock" size={11} />}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
export function Budgets({
  app,
  scope,
  month,
  actions,
}: {
  app: Kinflow;
  scope: Scope;
  month: string;
  actions: Actions;
}) {
  const s = app.snapshot!,
    today = localDate(s.family.timezone),
    categories = s.entities.filter((e) => e.kind === 'expense' && inScope(e, scope, app.user!.id));
  const rows = categories
    .map((c) => ({ category: c, budget: budgetFor(s.entities, c.id, month) }))
    .filter((x) => x.budget && !x.budget.archived);
  return (
    <section className="card budget-card">
      <div className="section-heading">
        <div>
          <h2>
            Budget pace <span className="count">{rows.length}</span>
          </h2>
          <p>A little perspective on this month’s spending.</p>
        </div>
        <span className="subtle-tag">
          {month === today.slice(0, 7) ? `Day ${+today.slice(8)}` : 'Monthly view'}
        </span>
      </div>
      {!rows.length ? (
        <Empty title="Make room for what matters" icon="chart">
          Set a monthly category budget in More to see your spending pace.
        </Empty>
      ) : (
        <div className="budget-grid">
          {rows.map(({ category, budget }) => {
            const state = budgetState(budget!, s.transactions, month, today);
            const equivalent = convert(
              budget!.limit!,
              budget!.currency!,
              s.family.currency,
              s.rates,
            );
            return (
              <button
                key={category.id}
                className="budget-item"
                onClick={() => {
                  if (canManage(category, s.family.role, app.user!.id)) actions.budget(category);
                }}
                aria-label={`${category.name} budget: ${state.status}`}
              >
                <div className="budget-heading">
                  <span className="budget-name">
                    <Icon name={category.icon} size={18} />
                    {category.name}
                    {category.ownerId && <Icon name="lock" size={12} />}
                  </span>
                  <span
                    className={
                      'status ' +
                      (state.status === 'Over budget'
                        ? 'red'
                        : state.status === 'Ahead of pace'
                          ? 'amber'
                          : 'green')
                    }
                  >
                    {state.status}
                  </span>
                </div>
                <div className="budget-money">
                  <strong>{money(state.spent, budget!.currency)}</strong>
                  <span>of {money(budget!.limit, budget!.currency)}</span>
                </div>
                <div
                  className={
                    'progress-track ' +
                    (state.status === 'Over budget'
                      ? 'red'
                      : state.status === 'Ahead of pace'
                        ? 'amber'
                        : 'green')
                  }
                >
                  <div style={{ width: state.progress + '%' }} />
                  {month === today.slice(0, 7) && (
                    <i style={{ left: state.pace + '%' }} aria-label="Expected pace" />
                  )}
                </div>
                <div className="budget-footer">
                  <span>
                    {money(D(state.remaining).abs().toFixed(), budget!.currency)}{' '}
                    {D(state.remaining).lt(0) ? 'over' : 'left'}
                  </span>
                  {budget!.currency !== s.family.currency && (
                    <span>
                      {equivalent
                        ? '≈ ' + money(equivalent, s.family.currency)
                        : 'Rate unavailable'}
                    </span>
                  )}
                  {state.missing && <span>Some conversions unavailable</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="card-footnote">
        <span className="pace-key" /> The marker shows expected spending for today. Unused budget
        does not roll over.
      </div>
    </section>
  );
}
export function Dashboard({
  app,
  scope,
  actions,
  navigate,
}: {
  app: Kinflow;
  scope: Scope;
  actions: Actions;
  navigate: (page: string) => void;
}) {
  const s = app.snapshot!,
    today = localDate(s.family.timezone),
    month = today.slice(0, 7),
    summary = totals(s.transactions, month, scope, app.user!.id),
    available = holdings(s.entities, scope, app.user!.id, s.family.currency, s.rates);
  const accounts = s.entities.filter(
      (e) => e.kind === 'account' && !e.archived && inScope(e, scope, app.user!.id),
    ),
    recent = s.transactions
      .filter(
        (t) =>
          !t.deleted &&
          t.type !== 'refund' &&
          (t.redacted ? scope !== 'mine' : inScope(t, scope, app.user!.id)),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version)
      .slice(0, 5);
  return (
    <>
      <section className="hero-card">
        <div className="hero-top">
          <span>
            <span className="live-dot" /> YOUR MONEY, AT A GLANCE
          </span>
          <span>
            {new Date(today + 'T12:00:00').toLocaleDateString('en', {
              month: 'long',
              year: 'numeric',
            })}
          </span>
        </div>
        <div className="hero-metrics">
          <div>
            <span className="metric-label">
              Available now <span className="small-tag">Now</span>
            </span>
            <strong className="big-money">{money(available.value, s.family.currency)}</strong>
            <span className="hero-detail">
              Across {accounts.filter((a) => a.included).length} included accounts
              {available.missing.length
                ? ` · Excludes missing rates: ${available.missing.join(', ')}`
                : ''}
            </span>
          </div>
          <div>
            <span className="metric-label">Spent this month</span>
            <strong className="big-money">{money(summary.spent, s.family.currency)}</strong>
            <span className="hero-detail">The everyday, and everything else.</span>
          </div>
        </div>
        <div className="hero-bottom">
          <span>
            <span className="hero-income-icon">
              <Icon name="income" size={17} />
            </span>
            Income this month <strong>{money(summary.income, s.family.currency)}</strong>
          </span>
          <span className="hero-leaf">
            <Icon name="leaf" size={20} /> A clearer picture, together.
          </span>
        </div>
      </section>
      <Budgets app={app} scope={scope} month={month} actions={actions} />
      <div className="overview-columns">
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Recent activity</h2>
              <p>The latest in your family’s day to day.</p>
            </div>
            <button className="text-button" onClick={() => navigate('activity')}>
              See all <Icon name="right" size={16} />
            </button>
          </div>
          {recent.length ? (
            <TransactionRows app={app} transactions={recent} onClick={actions.detail} />
          ) : (
            <Empty title="A fresh start">Your first transaction will appear here.</Empty>
          )}
        </section>
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Your accounts</h2>
              <p>A home for every kind of money.</p>
            </div>
            <button
              className="icon-button"
              aria-label="View accounts"
              onClick={() => navigate('accounts')}
            >
              <Icon name="right" size={18} />
            </button>
          </div>
          {accounts.length ? (
            <div className="account-list">
              {accounts.slice(0, 4).map((a) => (
                <button key={a.id} className="account-mini" onClick={() => actions.account(a)}>
                  <span className="category-icon">
                    <Icon name={a.icon} />
                  </span>
                  <span>
                    <strong>{a.name}</strong>
                    <small>
                      {a.included
                        ? a.ownerId
                          ? 'Only you'
                          : a.bank || a.accountType
                        : 'Excluded from available'}
                    </small>
                  </span>
                  <strong>{money(a.balance, a.currency)}</strong>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="Add your first account"
              icon="wallet"
              action={
                <button className="secondary" onClick={() => actions.entity('account')}>
                  <Icon name="plus" size={17} /> Add account
                </button>
              }
            >
              Start with a card, wallet or bank account.
            </Empty>
          )}
          <div className="account-note">
            <Icon name="lock" size={14} /> Your personal money stays personal.
          </div>
        </section>
      </div>
    </>
  );
}
export function Activity({
  app,
  scope,
  actions,
  accountId: initialAccount,
}: {
  app: Kinflow;
  scope: Scope;
  actions: Actions;
  accountId?: string;
}) {
  const s = app.snapshot!,
    [month, setMonth] = useState(localDate(s.family.timezone).slice(0, 7)),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState(false),
    [account, setAccount] = useState(initialAccount || ''),
    [type, setType] = useState(''),
    [category, setCategory] = useState(''),
    [visibility, setVisibility] = useState(''),
    [tag, setTag] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [history, setHistory] = useState(false);
  const clear = () => {
    setSearch('');
    setAccount('');
    setType('');
    setCategory('');
    setVisibility('');
    setTag('');
    setFrom('');
    setTo('');
    setHistory(false);
  };
  const rows = s.transactions
    .filter((t) => {
      if (!t.date.startsWith(month) || (!history && (t.deleted || t.type === 'refund')))
        return false;
      if (t.redacted)
        return (
          scope !== 'mine' &&
          !account &&
          !category &&
          !tag &&
          !search &&
          (!type || type === t.type) &&
          (!visibility || visibility === 'shared') &&
          (!from || t.date >= from) &&
          (!to || t.date <= to)
        );
      if (!inScope(t, scope, app.user!.id)) return false;
      const label = s.entities.find((e) => e.id === t.categoryId)?.name || '';
      return (
        (!account || [t.accountId, t.toAccountId].includes(account)) &&
        (!type || type === t.type) &&
        (!category || t.categoryId === category) &&
        (!visibility || (visibility === 'mine' ? !!t.ownerId : !t.ownerId)) &&
        (!tag || t.tags?.includes(tag)) &&
        (!from || t.date >= from) &&
        (!to || t.date <= to) &&
        `${t.comment} ${label} ${(t.tags || []).map((x) => '#' + x).join(' ')}`
          .toLowerCase()
          .includes(search.toLowerCase())
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.version - a.version);
  const refunds = s.transactions.some(
    (t) =>
      t.type === 'refund' &&
      !t.deleted &&
      t.date.startsWith(month) &&
      inScope(t, scope, app.user!.id),
  );
  return (
    <section className="card activity-card">
      <div className="activity-toolbar">
        <MonthPicker month={month} onChange={setMonth} />
        <div className="search-box">
          <Icon name="search" size={18} />
          <input
            aria-label="Search transactions"
            placeholder="Search notes, categories, #tags"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className={'secondary ' + (filter ? 'selected' : '')}
          onClick={() => setFilter(!filter)}
        >
          <Icon name="filter" size={17} /> Filters
        </button>
      </div>
      {filter && (
        <div className="filters">
          <Field label="Account">
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Every account</option>
              {s.entities
                .filter((e) => e.kind === 'account')
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Every type</option>
              {['expense', 'income', 'transfer', 'adjustment', 'refund'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="Category / source">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Every category</option>
              {s.entities
                .filter((e) => ['expense', 'source'].includes(e.kind))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.ownerId ? 'Only you' : 'Shared'}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Visibility">
            <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="">Current scope</option>
              <option value="shared">Shared</option>
              <option value="mine">Only you</option>
            </select>
          </Field>
          <Field label="Tag">
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">Every tag</option>
              {[...new Set(s.transactions.flatMap((t) => t.tags || []))].map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input
              type="date"
              value={from}
              min={month + '-01'}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={history}
              onChange={(e) => setHistory(e.target.checked)}
            />
            Show deleted and refunded
          </label>
        </div>
      )}
      {(search || account || type || category || visibility || tag || from || to || history) && (
        <div className="filter-chips">
          {[
            [search, 'Search', () => setSearch('')],
            [account, 'Account', () => setAccount('')],
            [type, 'Type', () => setType('')],
            [category, 'Category', () => setCategory('')],
            [visibility, 'Visibility', () => setVisibility('')],
            [tag, 'Tag', () => setTag('')],
            [from, 'From', () => setFrom('')],
            [to, 'To', () => setTo('')],
            [history, 'History', () => setHistory(false)],
          ]
            .filter((x) => x[0])
            .map(([, label, remove]) => (
              <button key={String(label)} onClick={remove as () => void}>
                {String(label)}
                <Icon name="x" size={12} />
              </button>
            ))}
          <button onClick={clear}>Clear filters</button>
        </div>
      )}
      <div className="list-caption">
        <span>
          {rows.length} transaction{rows.length === 1 ? '' : 's'}
        </span>
        <span>
          {scope === 'mine'
            ? 'Your private activity'
            : scope === 'shared'
              ? 'Family activity'
              : 'Shared + your private activity'}
        </span>
      </div>
      {rows.length ? (
        <TransactionRows app={app} transactions={rows} onClick={actions.detail} />
      ) : (
        <Empty
          icon="search"
          title="No matching transactions"
          action={
            <button className="text-button" onClick={clear}>
              Clear filters
            </button>
          }
        >
          Try another month or adjust your filters.
        </Empty>
      )}
      {refunds && !history && (
        <p className="card-footnote">
          Totals include refunds. Enable “Show deleted and refunded” to see those entries.
        </p>
      )}
    </section>
  );
}
export function Accounts({
  app,
  scope,
  actions,
}: {
  app: Kinflow;
  scope: Scope;
  actions: Actions;
}) {
  const s = app.snapshot!,
    [archived, setArchived] = useState(false),
    [ordering, setOrdering] = useState(false),
    value = holdings(s.entities, scope, app.user!.id, s.family.currency, s.rates, false);
  const rows = s.entities.filter(
    (e) => e.kind === 'account' && inScope(e, scope, app.user!.id) && (archived || !e.archived),
  );
  return (
    <>
      <div className="section-toolbar">
        <div>
          <span className="muted small">TOTAL HOLDINGS · NOW</span>
          <h2 className="holdings">{money(value.value, s.family.currency)}</h2>
          {value.missing.length > 0 && (
            <small>Rates unavailable for {value.missing.join(', ')}</small>
          )}
        </div>
        <div className="button-group">
          <button className="secondary" onClick={() => setOrdering(!ordering)}>
            <Icon name="filter" size={17} />
            {ordering ? 'Done ordering' : 'Edit order'}
          </button>
          <button className="secondary" onClick={() => actions.entity('account')}>
            <Icon name="plus" size={17} />
            Add account
          </button>
        </div>
      </div>
      <label className="checkbox archive-toggle">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        Show archived accounts
      </label>
      {rows.length ? (
        (['shared', 'mine'] as const).map((group) => {
          const list = rows.filter((e) => (group === 'mine' ? !!e.ownerId : !e.ownerId));
          return (
            list.length > 0 && (
              <section className="account-section" key={group}>
                <h2>
                  {group === 'mine' ? (
                    <>
                      <Icon name="lock" size={17} />
                      Only you
                    </>
                  ) : (
                    <>
                      <Icon name="users" size={17} />
                      Shared accounts
                    </>
                  )}
                </h2>
                <div className="account-grid">
                  {list.map((a, i) => (
                    <article
                      key={a.id}
                      className={'card account-card ' + (!a.included ? 'excluded' : '')}
                    >
                      <button className="account-open" onClick={() => actions.account(a)}>
                        <div className="account-card-top">
                          <span className="category-icon">
                            <Icon name={a.icon} size={23} />
                          </span>
                          <Icon name="right" size={18} />
                        </div>
                        <h3>{a.name}</h3>
                        <span className="muted small">
                          {[a.bank, a.accountType].filter(Boolean).join(' · ')}
                          {a.archived ? ' · Archived' : ''}
                        </span>
                        <strong
                          className={
                            'account-balance ' + (D(a.balance || 0).lt(0) ? 'negative' : '')
                          }
                        >
                          {money(a.balance, a.currency)}
                        </strong>
                        {D(a.balance || 0).lt(0) && (
                          <small className="negative">Account overdraft</small>
                        )}
                      </button>
                      <div className="account-card-footer">
                        <span className={'inclusion ' + (a.included ? 'included' : '')}>
                          <span />
                          {a.included ? 'Included in available' : 'Excluded from available'}
                        </span>
                        {canManage(a, s.family.role, app.user!.id) && (
                          <input
                            type="checkbox"
                            aria-label={`Include ${a.name} in available balance`}
                            checked={!!a.included}
                            onChange={async (e) => {
                              try {
                                actions.toast(
                                  await app.save('entity.save', {
                                    ...a,
                                    included: e.target.checked,
                                  }),
                                );
                              } catch (e) {
                                actions.toast((e as Error).message);
                              }
                            }}
                          />
                        )}
                      </div>
                      {ordering && canManage(a, s.family.role, app.user!.id) && (
                        <div className="reorder">
                          <button
                            className="text-button"
                            disabled={i === 0}
                            onClick={() =>
                              app
                                .save('entity.move', { id: a.id, direction: 'up' })
                                .catch((e) => actions.toast(e.message))
                            }
                          >
                            <Icon name="up" size={16} /> Move up
                          </button>
                          <button
                            className="text-button"
                            disabled={i === list.length - 1}
                            onClick={() =>
                              app
                                .save('entity.move', { id: a.id, direction: 'down' })
                                .catch((e) => actions.toast(e.message))
                            }
                          >
                            <Icon name="moveDown" size={16} /> Move down
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )
          );
        })
      ) : (
        <section className="card">
          <Empty
            title="A place for your money"
            icon="wallet"
            action={
              <button className="primary" onClick={() => actions.entity('account')}>
                Add your first account
              </button>
            }
          >
            Cards, cash, savings — keep them all in view.
          </Empty>
        </section>
      )}
    </>
  );
}
export function Insights({ app, scope }: { app: Kinflow; scope: Scope }) {
  const s = app.snapshot!,
    today = localDate(s.family.timezone),
    [month, setMonth] = useState(today.slice(0, 7)),
    [group, setGroup] = useState<'category' | 'tag'>('category'),
    stats = comparison(s.transactions, s.family, month, today, scope, app.user!.id),
    data = new Map<string, string>();
  for (const t of s.transactions.filter(
    (t) =>
      !t.deleted &&
      !t.redacted &&
      ['expense', 'refund'].includes(t.type) &&
      t.date.startsWith(month) &&
      inScope(t, scope, app.user!.id),
  )) {
    for (const key of group === 'tag'
      ? t.tags?.length
        ? t.tags
        : ['Untagged']
      : [s.entities.find((e) => e.id === t.categoryId)?.name || 'Other'])
      data.set(
        key,
        D(data.get(key) || 0)
          .plus(D(t.baseAmount!).mul(t.type === 'refund' ? -1 : 1))
          .toFixed(),
      );
  }
  const rows = [...data].sort((a, b) => D(b[1]).cmp(a[1])),
    max = rows.reduce((max, [, v]) => (D(v).gt(max) ? D(v) : max), D(1));
  const delta = D(stats.now.spent).minus(stats.before.spent);
  return (
    <>
      <div className="section-toolbar">
        <MonthPicker month={month} onChange={setMonth} />
        <div className="segmented">
          <button
            className={group === 'category' ? 'active' : ''}
            onClick={() => setGroup('category')}
          >
            Categories
          </button>
          <button className={group === 'tag' ? 'active' : ''} onClick={() => setGroup('tag')}>
            Tags
          </button>
        </div>
      </div>
      <div className="insight-metrics">
        {[
          ['Income', stats.now.income, 'income'],
          ['Net spending', stats.now.spent, 'expense'],
          ['Net this month', stats.now.net, 'chart'],
        ].map(([label, value, icon]) => (
          <section className="card insight-metric" key={label}>
            <span>
              <Icon name={icon} size={18} />
              {label}
            </span>
            <strong>{money(value, s.family.currency)}</strong>
          </section>
        ))}
      </div>
      <div className="overview-columns">
        <section className="card breakdown">
          <div className="section-heading">
            <div>
              <h2>Where it went</h2>
              <p>
                {group === 'tag'
                  ? 'Transactions may have multiple tags.'
                  : 'Your spending, one category at a time.'}
              </p>
            </div>
            <Icon name="chart" size={20} />
          </div>
          {rows.length ? (
            <div className="chart-bars">
              {rows.map(([name, value]) => (
                <div key={name} className="chart-row">
                  <div>
                    <span>
                      {group === 'tag' && name !== 'Untagged' ? '#' : ''}
                      {name}
                    </span>
                    <strong>{money(value, s.family.currency)}</strong>
                  </div>
                  <div className="progress-track">
                    <div
                      style={{ width: Math.max(0, D(value).div(max).mul(100).toNumber()) + '%' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Your story starts here" icon="chart">
              Add expenses to see a monthly breakdown.
            </Empty>
          )}
        </section>
        <div className="insight-aside">
          <section className="card insight-comparison">
            <span className="eyebrow">A LITTLE PERSPECTIVE</span>
            <h2>Compared to last month</h2>
            <strong>{money(delta.abs().toFixed(), s.family.currency)}</strong>
            <p>
              {delta.isZero()
                ? 'The same spending'
                : delta.lt(0)
                  ? 'Less spending'
                  : 'More spending'}{' '}
              over the compared period.
            </p>
            <div className="comparison-pair">
              <span>
                This period<strong>{money(stats.now.spent, s.family.currency)}</strong>
              </span>
              <span>
                Previous period<strong>{money(stats.before.spent, s.family.currency)}</strong>
              </span>
            </div>
            <small>{stats.ranges}</small>
          </section>
          <section className="card insight-average">
            <Icon name="leaf" size={22} />
            <div>
              <h3>Monthly average</h3>
              <strong>
                {stats.average === null
                  ? 'Not enough history'
                  : money(stats.average, s.family.currency)}
              </strong>
              <p>
                {stats.count
                  ? `${stats.count} completed full month${stats.count === 1 ? '' : 's'}, including zero-spend months.`
                  : 'Your first full completed month will appear here.'}
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
export function TransactionDetail({
  app,
  transaction,
  onClose,
  actions,
}: {
  app: Kinflow;
  transaction: Transaction;
  onClose: () => void;
  actions: Actions;
}) {
  const s = app.snapshot!,
    t = s.transactions.find((t) => t.id === transaction.id) || transaction,
    [audits, setAudits] = useState<Audit[] | null>(null),
    [error, setError] = useState('');
  const account = s.entities.find((e) => e.id === t.accountId),
    category = s.entities.find((e) => e.id === t.categoryId),
    allowed = canEdit(t, s.family.role, app.user!.id);
  return (
    <Modal
      title={
        t.redacted
          ? 'Private activity'
          : category?.name || t.type[0].toUpperCase() + t.type.slice(1)
      }
      onClose={onClose}
    >
      <div className="form-stack">
        {t.redacted ? (
          <Empty icon="lock" title="Amount private">
            {t.type === 'income' ? 'Income' : 'A transfer'} was recorded. Financial details are
            visible only to the personal account owner.
          </Empty>
        ) : (
          <>
            <div className="detail-amount">{money(t.amount, t.currency)}</div>
            <div>
              <Privacy personal={!!t.ownerId} />
              {t.deleted && <span className="subtle-tag">Deleted</span>}
              {t.pending && <span className="subtle-tag">Waiting to sync</span>}
            </div>
            <dl className="detail-list">
              <div>
                <dt>Date</dt>
                <dd>{formatDate(t.date, app.user?.dateFormat)}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{account?.name}</dd>
              </div>
              {t.currency !== account?.currency && (
                <div>
                  <dt>Account amount</dt>
                  <dd>{money(t.accountAmount, account?.currency)}</dd>
                </div>
              )}
              {t.toAccountId && (
                <div>
                  <dt>Received</dt>
                  <dd>
                    {money(t.toAmount, s.entities.find((e) => e.id === t.toAccountId)?.currency)}
                    <br />
                    {s.entities.find((e) => e.id === t.toAccountId)?.name}
                  </dd>
                </div>
              )}
              <div>
                <dt>Recorded by</dt>
                <dd>{t.authorName || 'You'}</dd>
              </div>
              <div>
                <dt>Reporting amount</dt>
                <dd>{money(t.baseAmount, s.family.currency)}</dd>
              </div>
            </dl>
            {t.comment && <p className="notice">{t.comment}</p>}
            {t.tags?.length !== 0 && (
              <div className="tag-list">
                {t.tags?.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </div>
            )}
            {t.originalId && (
              <p className="notice">
                Linked to purchase{' '}
                <button
                  className="text-button"
                  onClick={() => {
                    const original = s.transactions.find((x) => x.id === t.originalId);
                    if (original) {
                      onClose();
                      actions.detail(original);
                    }
                  }}
                >
                  View original
                </button>
              </p>
            )}
            {t.rates && (
              <small className="muted">
                Recorded rate snapshot: {t.rates.date} · {t.rates.provider}
              </small>
            )}
            {allowed && (
              <div className="detail-actions">
                {t.type !== 'refund' && (
                  <button
                    className="secondary"
                    onClick={() => {
                      onClose();
                      actions.editTransaction(t);
                    }}
                  >
                    <Icon name="edit" size={17} />
                    Edit
                  </button>
                )}
                {t.type === 'expense' && (
                  <button
                    className="secondary"
                    onClick={() => {
                      onClose();
                      actions.refund(t);
                    }}
                  >
                    <Icon name="refund" size={17} />
                    Refund
                  </button>
                )}
                <button
                  className="danger-button"
                  onClick={async () => {
                    if (
                      !confirm(
                        'Delete this transaction? Its balance effects will be removed. The record remains in audit history.',
                      )
                    )
                      return;
                    try {
                      actions.toast(await app.save('transaction.delete', { id: t.id }, t.version));
                      onClose();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Icon name="trash" size={17} />
                  Delete
                </button>
              </div>
            )}
            <button
              className="text-button"
              onClick={async () => {
                try {
                  setAudits(await api(`families/${s.family.id}/audit/${t.id}`));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Show audit history
            </button>
            {audits && (
              <div className="audit-list">
                {audits.length ? (
                  audits.map((a) => (
                    <div key={a.id}>
                      <strong>
                        {a.conflict ? 'Updated on another device · ' + a.action : a.action}
                      </strong>
                      <small>
                        {a.actor} · {new Date(a.at).toLocaleString('en')}
                      </small>
                      {a.conflict && (
                        <details>
                          <summary>Compare versions</summary>
                          <pre>{JSON.stringify({ before: a.before, after: a.after }, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  ))
                ) : (
                  <p>No audit records.</p>
                )}
              </div>
            )}
          </>
        )}
        <ErrorMessage message={error} />
      </div>
    </Modal>
  );
}
export function AccountDetail({
  app,
  entity,
  onClose,
  actions,
}: {
  app: Kinflow;
  entity: Entity;
  onClose: () => void;
  actions: Actions;
}) {
  const a = app.snapshot!.entities.find((e) => e.id === entity.id) || entity,
    allowed = canManage(a, app.snapshot!.family.role, app.user!.id),
    [error, setError] = useState('');
  return (
    <Modal title={a.name} onClose={onClose}>
      <div className="form-stack">
        <span className="muted">Current balance · Now</span>
        <strong className="detail-amount">{money(a.balance, a.currency)}</strong>
        <Privacy personal={!!a.ownerId} />
        <p className="muted">
          {a.bank} · {a.accountType} · {a.included ? 'Included' : 'Excluded from available'}
        </p>
        {!a.archived && (
          <div className="detail-actions">
            {(['expense', 'income', 'transfer', 'adjustment'] as const).map((type) => (
              <button
                key={type}
                className="secondary"
                onClick={() => {
                  onClose();
                  actions.transaction(type, a);
                }}
              >
                <Icon name={type} size={16} />
                {type === 'adjustment' ? 'Adjust balance' : type[0].toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        )}
        {allowed && (
          <div className="detail-actions">
            <button
              className="text-button"
              onClick={() => {
                onClose();
                actions.entity('account', a);
              }}
            >
              Edit details
            </button>
            <button
              className="text-button"
              onClick={async () => {
                try {
                  actions.toast(await app.save('entity.save', { ...a, archived: !a.archived }));
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {a.archived ? 'Restore account' : 'Archive account'}
            </button>
            <button
              className="danger-button"
              onClick={async () => {
                if (
                  !confirm(
                    'Permanently delete this empty account? Accounts with history must be archived instead.',
                  )
                )
                  return;
                try {
                  actions.toast(await app.save('entity.delete', { id: a.id }));
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Delete empty account
            </button>
          </div>
        )}
        <h3>Recent account activity</h3>
        <TransactionRows
          app={app}
          transactions={app
            .snapshot!.transactions.filter(
              (t) => !t.deleted && !t.redacted && (t.accountId === a.id || t.toAccountId === a.id),
            )
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 10)}
          onClick={(t) => {
            onClose();
            actions.detail(t);
          }}
        />
        <ErrorMessage message={error} />
      </div>
    </Modal>
  );
}
