'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Entity, Scope, Transaction, TransactionType } from '@/lib/model';
import { localDate } from '@/lib/money';
import { api } from '@/lib/offline';
import { useKinflow } from './use-kinflow';
import { usePush } from './use-push';
import { Icon, ErrorMessage } from './ui';
import { BudgetForm, EntityForm, Onboarding, TransactionForm } from './forms';
import {
  AccountDetail,
  Accounts,
  Activity,
  Dashboard,
  Insights,
  TransactionDetail,
  type Actions,
} from './views';
import { SettingsView } from './settings';
import { AiEntry, GeminiIcon } from './ai-entry';
type Dialog =
  | {
      kind: 'transaction';
      type?: TransactionType;
      account?: Entity;
      transaction?: Transaction;
      refund?: Transaction;
    }
  | { kind: 'entity'; entityType: 'account' | 'expense' | 'source'; entity?: Entity }
  | { kind: 'budget'; category: Entity }
  | { kind: 'detail'; transaction: Transaction }
  | { kind: 'account'; entity: Entity }
  | { kind: 'onboarding' }
  | { kind: 'ai' }
  | null;
const navigation = [
  ['home', 'home', 'Home'],
  ['activity', 'transfer', 'Activity'],
  ['accounts', 'wallet', 'Accounts'],
  ['insights', 'chart', 'Insights'],
  ['more', 'more', 'More'],
];
export default function KinflowApp() {
  const app = useKinflow(),
    [page, setPage] = useState('home'),
    [pushFamily, setPushFamily] = useState<string | null>(null),
    [scope, setScope] = useState<Scope>('shared'),
    [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState(''),
    [config, setConfig] = useState<{ demo: boolean; google: boolean }>({
      demo: false,
      google: false,
    }),
    [loginBusy, setLoginBusy] = useState(false);
  usePush(app);
  useEffect(() => {
    void api<{ demo: boolean; google: boolean }>('config')
      .then(setConfig)
      .catch(() => {});
    const p = new URLSearchParams(window.location.search);
    if (p.get('view') === 'shared-history' && p.has('family')) setPushFamily(p.get('family'));
    if (p.has('invite')) localStorage.setItem('kinflow-invite', p.get('invite')!);
    if (p.has('authError')) app.setError(p.get('authError')!);
  }, []);
  useEffect(() => {
    setDialog(null);
    setPage('home');
    const saved = localStorage.getItem('kinflow-scope-' + app.activeId);
    setScope(saved === 'mine' || saved === 'combined' ? saved : 'shared');
  }, [app.activeId]);
  useEffect(() => {
    if (!pushFamily || app.loading || !app.user) return;
    if (!app.families.some((f) => f.id === pushFamily)) {
      setToast('You no longer have access to this family.');
    } else if (app.activeId !== pushFamily) {
      app.setActiveId(pushFamily);
      return;
    } else {
      setScope('shared');
      localStorage.setItem('kinflow-scope-' + pushFamily, 'shared');
      setDialog(null);
      setPage('activity');
      void app.sync();
    }
    setPushFamily(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('family');
    url.searchParams.delete('view');
    window.history.replaceState(null, '', url);
  }, [pushFamily, app.loading, app.user?.id, app.families, app.activeId]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (
      toast === 'Saved on this device · syncing' &&
      !app.syncing &&
      !app.queue.length &&
      app.online
    )
      setToast('Saved');
  }, [toast, app.syncing, app.queue.length, app.online]);
  useEffect(() => {
    document.documentElement.dataset.theme = app.user?.theme || 'system';
  }, [app.user?.theme]);
  useEffect(() => {
    if (app.user && app.families.length && localStorage.getItem('kinflow-invite'))
      setDialog({ kind: 'onboarding' });
  }, [app.user?.id]);
  const actions: Actions = {
    transaction: (type, account) => setDialog({ kind: 'transaction', type, account }),
    editTransaction: (transaction) => setDialog({ kind: 'transaction', transaction }),
    refund: (refund) => setDialog({ kind: 'transaction', refund }),
    detail: (transaction) => setDialog({ kind: 'detail', transaction }),
    entity: (entityType, entity) => setDialog({ kind: 'entity', entityType, entity }),
    budget: (category) => setDialog({ kind: 'budget', category }),
    account: (entity) => setDialog({ kind: 'account', entity }),
    toast: setToast,
  };
  if (app.loading)
    return (
      <div className="welcome-page">
        <div className="loading-state">
          <span className="brand-mark">
            <Icon name="leaf" size={28} />
          </span>
          <h2>Making room for clarity.</h2>
          <div className="loading-line" />
        </div>
      </div>
    );
  if (!app.user)
    return (
      <main className="signin">
        <div className="signin-story">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="leaf" />
            </span>
            KinFlow
          </div>
          <span className="eyebrow">LESS MENTAL MATH. MORE LIVING.</span>
          <h1>
            Money,
            <br />
            together.
          </h1>
          <p>
            A calm place for your family’s finances.
            <br />
            Shared plans. Personal space. A clearer everyday.
          </p>
          <div className="signin-illustration">
            <div className="illustration-orbit orbit-one" />
            <div className="illustration-orbit orbit-two" />
            <div className="illustration-card">
              <Icon name="leaf" size={32} />
              <span>A little more clarity.</span>
              <div className="illustration-bars">
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
            <span className="illustration-badge">
              <Icon name="check" size={16} /> In this together
            </span>
          </div>
          <small>Thoughtfully simple. Privately yours.</small>
        </div>
        <div className="signin-action">
          <div className="signin-content">
            <span className="signin-logo">
              <Icon name="leaf" size={26} />
            </span>
            <h2>
              A fresh perspective
              <br />
              on your money.
            </h2>
            <p>Keep track of the everyday and make space for what matters.</p>
            <ErrorMessage message={app.error} />
            <a
              className={'google-button ' + (!config.google ? 'unconfigured' : '')}
              href="/api/auth/google"
              onClick={(e) => {
                if (!config.google) {
                  e.preventDefault();
                  app.setError(
                    'Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.',
                  );
                }
              }}
            >
              <span className="google-g">G</span>Continue with Google
              <Icon name="right" size={18} />
            </a>
            <div className="signin-privacy">
              <Icon name="lock" size={14} />
              <span>Your personal finances stay visible only to you.</span>
            </div>
            <p className="signin-terms">
              KinFlow stores the records you confirm, not verified bank transactions.{' '}
              <Link href="/terms">Terms of Use</Link>
            </p>
            {config.demo && (
              <div className="demo-entry">
                <span>LOCAL DEVELOPMENT</span>
                <button
                  className="text-button"
                  disabled={loginBusy}
                  onClick={async () => {
                    setLoginBusy(true);
                    try {
                      await api('auth/demo', 'POST', {});
                      await app.reload();
                    } catch (e) {
                      app.setError((e as Error).message);
                    } finally {
                      setLoginBusy(false);
                    }
                  }}
                >
                  {loginBusy ? 'Preparing your workspace…' : 'Explore with sample data'}
                  <Icon name="right" size={17} />
                </button>
                <small>Creates an isolated sample family on this computer.</small>
              </div>
            )}
          </div>
        </div>
      </main>
    );
  if (!app.families.length)
    return (
      <>
        <Onboarding app={app} />
        <button className="onboarding-logout text-button" onClick={() => app.logout()}>
          Sign out
        </button>
      </>
    );
  const s = app.snapshot,
    heading =
      page === 'home'
        ? 'A little clarity, every day.'
        : page === 'activity'
          ? 'The everyday, in detail.'
          : page === 'accounts'
            ? 'Every account, in one place.'
            : page === 'insights'
              ? 'See the bigger picture.'
              : 'Make yourself at home.';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('home');
          }}
        >
          <span className="brand-mark">
            <Icon name="leaf" />
          </span>
          KinFlow<span className="brand-dot">.</span>
        </a>
        <span className="nav-caption">YOUR FAMILY SPACE</span>
        <nav aria-label="Main navigation">
          {navigation.map(([key, icon, label]) => (
            <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
              <Icon name={icon} size={20} />
              <span>{label}</span>
              {page === key && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="note-leaf">
            <Icon name="leaf" size={24} />
          </span>
          <h3>
            Life is more than
            <br />a balance.
          </h3>
          <p>
            A little awareness today.
            <br />
            More peace of mind tomorrow.
          </p>
        </div>
        <button className="sidebar-profile" onClick={() => setPage('more')}>
          <span className="avatar">{app.user.name[0]}</span>
          <span>
            <strong>{app.user.name}</strong>
            <small>Your personal space</small>
          </span>
          <Icon name="dots" size={19} />
        </button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="family-switcher">
            <span className="family-symbol">
              <Icon name="users" size={20} />
            </span>
            <select
              aria-label="Active family"
              value={app.activeId}
              onChange={(e) => {
                if (e.target.value === 'new') setDialog({ kind: 'onboarding' });
                else app.setActiveId(e.target.value);
              }}
            >
              {app.families.map((f) => (
                <option value={f.id} key={f.id}>
                  {f.name}
                </option>
              ))}
              <option value="new">+ Create or join a family</option>
            </select>
            <span className="family-badge">FAMILY SPACE</span>
          </div>
          <div className="topbar-right">
            <button
              className={'sync-status ' + (!app.online ? 'is-offline' : '')}
              onClick={() => app.sync()}
              aria-label="Synchronize"
            >
              <Icon
                name={!app.online ? 'offline' : app.syncing ? 'sync' : 'check'}
                size={14}
                className={app.syncing ? 'spin' : ''}
              />
              <span>
                {!app.online
                  ? 'Offline'
                  : app.syncing
                    ? 'Syncing'
                    : app.queue.length
                      ? `${app.queue.length} pending`
                      : 'Up to date'}
              </span>
            </button>
            <button
              className="avatar profile-button"
              aria-label="Open preferences"
              onClick={() => setPage('more')}
            >
              {app.user.name[0]}
            </button>
          </div>
        </header>
        <main className="main-content" id="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === 'home'
                  ? `WELCOME ${app.user.name.split(' ')[0].toUpperCase()}`
                  : navigation.find((n) => n[0] === page)?.[2].toUpperCase()}
              </span>
              <h1>{heading}</h1>
            </div>
            <div className="entry-actions">
              <button
                className="primary add-transaction"
                onClick={() => actions.transaction()}
                disabled={!s}
              >
                <Icon name="plus" size={19} />
                <span>Add transaction</span>
              </button>
              <button
                className="ai-entry-button"
                aria-label="Add with AI"
                title="Add with AI"
                disabled={!s}
                onClick={() => setDialog({ kind: 'ai' })}
              >
                <GeminiIcon />
              </button>
            </div>
          </div>
          {page !== 'more' && (
            <div className="scope-row">
              <div className="segmented scope-selector" aria-label="Financial scope">
                {(
                  [
                    ['shared', 'Shared'],
                    ['mine', 'Mine'],
                    ['combined', 'Shared + mine'],
                  ] as [Scope, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={scope === key ? 'active' : ''}
                    onClick={() => {
                      setScope(key);
                      localStorage.setItem('kinflow-scope-' + app.activeId, key);
                    }}
                  >
                    {key === 'mine' && <Icon name="lock" size={12} />} {label}
                  </button>
                ))}
              </div>
              <span className="scope-description">
                {scope === 'shared'
                  ? 'The things you share.'
                  : scope === 'mine'
                    ? 'Your money. Only you.'
                    : 'Your family’s shared money, plus your own.'}
              </span>
            </div>
          )}
          {app.error && (
            <div className="app-error">
              <ErrorMessage message={app.error} />
              {app.expired && (
                <a className="text-button" href="/api/auth/google">
                  Sign in again
                </a>
              )}
            </div>
          )}
          {!app.online && (
            <div className="offline-banner">
              <Icon name="offline" size={17} />
              <span>
                You’re offline. Changes are saved on this device.
                {s &&
                  ` Last synced ${new Date(s.syncedAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}.`}
              </span>
            </div>
          )}
          {app.queue.some((q) => q.error) && (
            <div className="sync-errors">
              {app.queue
                .filter((q) => q.error)
                .map((q) => (
                  <div key={q.id}>
                    <strong>Failed to sync</strong>
                    <span>{q.error}</span>
                    <button className="text-button" onClick={() => app.sync()}>
                      Retry
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (confirm('Discard this unsynced change from this device?'))
                          void app.discard(q.id);
                      }}
                    >
                      Discard
                    </button>
                  </div>
                ))}
            </div>
          )}
          {!s ? (
            <div className="loading-cards">
              <div />
              <div />
              <div />
            </div>
          ) : page === 'home' ? (
            <Dashboard app={app} scope={scope} actions={actions} navigate={setPage} />
          ) : page === 'activity' ? (
            <Activity app={app} scope={scope} actions={actions} />
          ) : page === 'accounts' ? (
            <Accounts app={app} scope={scope} actions={actions} />
          ) : page === 'insights' ? (
            <Insights app={app} scope={scope} />
          ) : (
            <SettingsView key={s.family.id} app={app} actions={actions} />
          )}
          <footer className="page-footer">
            <span>
              <Icon name="leaf" size={13} /> A little clarity goes a long way.
            </span>
            <Link href="/terms">Terms of Use</Link>
            {app.demo && <span>Local demo · Sample data</span>}
            {s?.rates && <span>Rates updated {s.rates.date}</span>}
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navigation.map(([key, icon, label]) => (
          <button key={key} className={page === key ? 'active' : ''} onClick={() => setPage(key)}>
            <Icon name={icon} size={21} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      {s && dialog?.kind === 'ai' && (
        <AiEntry
          app={app}
          onClose={() => setDialog(null)}
          onManual={() => setDialog({ kind: 'transaction' })}
          onSaved={setToast}
        />
      )}
      {s && dialog?.kind === 'transaction' && (
        <TransactionForm
          app={app}
          onClose={() => setDialog(null)}
          onSaved={setToast}
          initialType={dialog.type}
          account={dialog.account}
          transaction={dialog.transaction}
          refund={dialog.refund}
        />
      )}{' '}
      {s && dialog?.kind === 'entity' && (
        <EntityForm
          app={app}
          onClose={() => setDialog(null)}
          onSaved={setToast}
          entity={dialog.entity}
          kind={dialog.entityType}
        />
      )}{' '}
      {s && dialog?.kind === 'budget' && (
        <BudgetForm
          app={app}
          onClose={() => setDialog(null)}
          onSaved={setToast}
          category={dialog.category}
        />
      )}{' '}
      {s && dialog?.kind === 'detail' && (
        <TransactionDetail
          app={app}
          onClose={() => setDialog(null)}
          actions={actions}
          transaction={dialog.transaction}
        />
      )}{' '}
      {s && dialog?.kind === 'account' && (
        <AccountDetail
          app={app}
          onClose={() => setDialog(null)}
          actions={actions}
          entity={dialog.entity}
        />
      )}{' '}
      {dialog?.kind === 'onboarding' && (
        <Onboarding
          app={app}
          onClose={() => {
            localStorage.removeItem('kinflow-invite');
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
