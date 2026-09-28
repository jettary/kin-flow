'use client';
import { useState } from 'react';
import { NotificationSettings } from './notification-settings';
import { api, clearCache, clearFamily } from '@/lib/offline';
import { canManage, type Entity, type User } from '@/lib/model';
import { budgetFor } from '@/lib/analytics';
import { localDate, money } from '@/lib/money';
import type { Kinflow } from './use-kinflow';
import type { Actions } from './views';
import { BusyButton, Empty, ErrorMessage, Field, Icon, Privacy } from './ui';
export function SettingsView({ app, actions }: { app: Kinflow; actions: Actions }) {
  const s = app.snapshot!,
    user = app.user!,
    admin = s.family.role !== 'member';
  const [section, setSection] = useState('structure'),
    [kind, setKind] = useState<'expense' | 'source'>('expense'),
    [archived, setArchived] = useState(false),
    [ordering, setOrdering] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [familyName, setFamilyName] = useState(s.family.name),
    [timezone, setTimezone] = useState(s.family.timezone),
    [days, setDays] = useState(3),
    [uses, setUses] = useState(1),
    [invitation, setInvitation] = useState<{ code: string; expires: string } | null>(null),
    [name, setName] = useState(user.name);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const updatePreference = async (preferences: Partial<User>) =>
    run(async () => {
      const updated = await api<User>('me', 'PATCH', {
        name: user.name,
        theme: user.theme || 'system',
        dateFormat: user.dateFormat || 'dmy',
        ...preferences,
      });
      app.setUser(updated);
      await app.reload();
      actions.toast('Preferences saved');
    });
  const entitySave = async (e: Entity, archived: boolean) =>
    run(async () => {
      actions.toast(await app.save('entity.save', { ...e, archived }));
    });
  const tabs = [
    ['structure', 'grid', 'Categories & sources'],
    ['family', 'users', 'Family & members'],
    ['invitations', 'gift', 'Invitations'],
    ['preferences', 'settings', 'Your preferences'],
    ['notifications', 'settings', 'Notifications'],
  ];
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings">
        {tabs.map(([key, icon, label]) => (
          <button
            key={key}
            className={section === key ? 'active' : ''}
            onClick={() => {
              setSection(key);
              setError('');
            }}
          >
            <Icon name={icon} size={19} />
            {label}
            <Icon name="right" size={16} />
          </button>
        ))}
      </nav>
      <section className="card settings-panel">
        <ErrorMessage message={error} />
        {section === 'notifications' && (
          <NotificationSettings
            key={s.family.id}
            familyId={s.family.id}
            familyName={s.family.name}
          />
        )}
        {section === 'structure' && (
          <>
            <div className="section-heading">
              <div>
                <h2>Categories & income sources</h2>
                <p>Give every transaction a little context.</p>
              </div>
              <button className="secondary" onClick={() => actions.entity(kind)}>
                <Icon name="plus" size={17} />
                Add
              </button>
            </div>
            <div className="section-toolbar">
              <div className="segmented">
                <button
                  className={kind === 'expense' ? 'active' : ''}
                  onClick={() => setKind('expense')}
                >
                  Expenses
                </button>
                <button
                  className={kind === 'source' ? 'active' : ''}
                  onClick={() => setKind('source')}
                >
                  Income
                </button>
              </div>
              <button className="text-button" onClick={() => setOrdering(!ordering)}>
                {ordering ? 'Done ordering' : 'Edit order'}
              </button>
            </div>
            <label className="checkbox archive-toggle">
              <input
                type="checkbox"
                checked={archived}
                onChange={(e) => setArchived(e.target.checked)}
              />
              Show archived items
            </label>
            {(['shared', 'mine'] as const).map((scope) => {
              const list = s.entities.filter(
                (e) =>
                  e.kind === kind &&
                  (scope === 'mine' ? !!e.ownerId : !e.ownerId) &&
                  (archived || !e.archived),
              );
              return (
                <div key={scope} className="structure-group">
                  <h3>{scope === 'mine' ? 'Only you' : 'Shared with family'}</h3>
                  {list.length ? (
                    list.map((e, i) => {
                      const allowed = canManage(e, s.family.role, user.id),
                        budget = budgetFor(
                          s.entities,
                          e.id,
                          localDate(s.family.timezone).slice(0, 7),
                        );
                      return (
                        <div className="structure-row" key={e.id}>
                          <span className="category-icon">
                            <Icon name={e.icon} />
                          </span>
                          <div className="structure-info">
                            <strong>
                              {e.name}
                              {e.archived ? ' · Archived' : ''}
                            </strong>
                            <small>
                              {kind === 'expense'
                                ? budget && !budget.archived
                                  ? money(budget.limit, budget.currency) + ' / month'
                                  : 'No budget'
                                : 'Income source · no balance'}
                            </small>
                          </div>
                          {allowed && (
                            <div className="row-controls">
                              {ordering ? (
                                <>
                                  <button
                                    className="icon-button"
                                    aria-label={`Move ${e.name} up`}
                                    disabled={!i}
                                    onClick={() =>
                                      run(() =>
                                        app.save('entity.move', { id: e.id, direction: 'up' }),
                                      )
                                    }
                                  >
                                    <Icon name="up" size={17} />
                                  </button>
                                  <button
                                    className="icon-button"
                                    aria-label={`Move ${e.name} down`}
                                    disabled={i === list.length - 1}
                                    onClick={() =>
                                      run(() =>
                                        app.save('entity.move', { id: e.id, direction: 'down' }),
                                      )
                                    }
                                  >
                                    <Icon name="moveDown" size={17} />
                                  </button>
                                </>
                              ) : (
                                <>
                                  {kind === 'expense' && (
                                    <button
                                      className="text-button small"
                                      onClick={() => actions.budget(e)}
                                    >
                                      Budget
                                    </button>
                                  )}
                                  <button
                                    className="icon-button"
                                    aria-label={`Edit ${e.name}`}
                                    onClick={() => actions.entity(kind, e)}
                                  >
                                    <Icon name="edit" size={16} />
                                  </button>
                                  <button
                                    className="icon-button"
                                    aria-label={`${e.archived ? 'Restore' : 'Archive'} ${e.name}`}
                                    onClick={() => entitySave(e, !e.archived)}
                                  >
                                    <Icon name={e.archived ? 'sync' : 'archive'} size={16} />
                                  </button>
                                  <button
                                    className="icon-button"
                                    aria-label={`Delete ${e.name}`}
                                    onClick={() => {
                                      if (
                                        confirm(
                                          `Permanently delete ${e.name}? Items with history can only be archived.`,
                                        )
                                      )
                                        void run(() => app.save('entity.delete', { id: e.id }));
                                    }}
                                  >
                                    <Icon name="trash" size={16} />
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <p className="muted small">
                      No {scope === 'mine' ? 'personal' : 'shared'}{' '}
                      {kind === 'expense' ? 'categories' : 'sources'} yet.
                    </p>
                  )}
                </div>
              );
            })}
          </>
        )}
        {section === 'family' && (
          <>
            <div className="section-heading">
              <div>
                <h2>Family & members</h2>
                <p>A shared space, with room for privacy.</p>
              </div>
              <span className="subtle-tag">{s.family.role}</span>
            </div>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  actions.toast(await app.save('family.update', { name: familyName, timezone }));
                  await app.reload();
                });
              }}
            >
              <Field label="Family name">
                <input
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                  disabled={!admin}
                  required
                  maxLength={100}
                />
              </Field>
              <div className="form-columns">
                <Field label="Base currency · locked">
                  <input value={s.family.currency} disabled />
                </Field>
                <Field label="Time zone">
                  <input
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    list="family-timezones"
                    disabled={!admin}
                    required
                  />
                  <datalist id="family-timezones">
                    {Intl.supportedValuesOf('timeZone').map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </datalist>
                </Field>
              </div>
              {admin && (
                <BusyButton busy={busy} className="secondary">
                  Save family settings
                </BusyButton>
              )}
            </form>
            <h3 className="subsection-title">
              Family members <span className="count">{s.members.length}</span>
            </h3>
            <div>
              {s.members.map((m) => (
                <div key={m.id} className="member-row">
                  <span className="avatar">{m.name[0]}</span>
                  <div>
                    <strong>
                      {m.name}
                      {m.id === user.id ? ' (you)' : ''}
                    </strong>
                    <small>{m.role}</small>
                  </div>
                  {admin && m.role !== 'owner' && (
                    <select
                      aria-label={`Role for ${m.name}`}
                      value={m.role}
                      onChange={(e) =>
                        run(async () => {
                          await app.save('member.role', { userId: m.id, role: e.target.value });
                          await app.reload();
                        })
                      }
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  )}
                  {s.family.role === 'owner' && m.id !== user.id && (
                    <button
                      className="text-button small"
                      onClick={() => {
                        if (confirm(`Transfer ownership to ${m.name}? You will become an admin.`))
                          void run(async () => {
                            await app.save('family.transfer', { userId: m.id });
                            await app.reload();
                          });
                      }}
                    >
                      Make owner
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="danger-zone">
              <h3>Leave this family</h3>
              <p>
                Your personal accounts, transactions and budgets will be permanently deleted. Shared
                history stays, attributed to “Former member”.
              </p>
              {s.family.role === 'owner' && s.members.length > 1 ? (
                <p className="notice">Transfer ownership to another member before leaving.</p>
              ) : (
                <button
                  className="danger-button"
                  onClick={() => {
                    const deleting = s.members.length === 1;
                    if (
                      !confirm(
                        deleting
                          ? 'Delete this family and all of its financial data permanently?'
                          : 'Leave this family and permanently delete all your personal financial data in it? Shared history will remain.',
                      )
                    )
                      return;
                    void run(async () => {
                      await api(
                        `families/${s.family.id}${deleting ? '' : '/leave'}`,
                        deleting ? 'DELETE' : 'POST',
                        {},
                      );
                      await clearFamily(user.id, s.family.id);
                      await app.reload();
                    });
                  }}
                >
                  {s.members.length === 1 ? 'Delete family permanently' : 'Leave family'}
                </button>
              )}
            </div>
          </>
        )}
        {section === 'invitations' && (
          <>
            <div className="section-heading">
              <div>
                <h2>Make room at the table</h2>
                <p>Invite someone to your family workspace.</p>
              </div>
              <Icon name="users" size={24} />
            </div>
            {admin ? (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    setInvitation(
                      await api(`families/${s.family.id}/invitations`, 'POST', { days, uses }),
                    );
                  });
                }}
              >
                <div className="form-columns">
                  <Field label="Maximum uses">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      required
                      value={uses}
                      onChange={(e) => setUses(+e.target.value)}
                    />
                  </Field>
                  <Field label="Expires in (days)">
                    <input
                      type="number"
                      min={1}
                      max={90}
                      required
                      value={days}
                      onChange={(e) => setDays(+e.target.value)}
                    />
                  </Field>
                </div>
                <BusyButton busy={busy} className="primary">
                  Create invitation
                </BusyButton>
                {invitation && (
                  <div className="invitation-result">
                    <span className="eyebrow">INVITATION CODE</span>
                    <strong>{invitation.code}</strong>
                    <small>Expires {new Date(invitation.expires).toLocaleDateString('en')}</small>
                    <div className="button-group">
                      <button
                        className="secondary"
                        type="button"
                        onClick={() =>
                          run(async () => {
                            await navigator.clipboard.writeText(invitation.code);
                            actions.toast('Code copied');
                          })
                        }
                      >
                        <Icon name="copy" size={16} />
                        Copy code
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() =>
                          run(async () => {
                            await navigator.clipboard.writeText(
                              window.location.origin + '/?invite=' + invitation.code,
                            );
                            actions.toast('Invitation link copied');
                          })
                        }
                      >
                        <Icon name="copy" size={16} />
                        Copy link
                      </button>
                    </div>
                  </div>
                )}
                <p className="muted small">
                  New members can see shared accounts and history. Your personal financial details
                  stay visible only to you.
                </p>
              </form>
            ) : (
              <Empty title="Ask a family admin" icon="users">
                The owner and admins can create invitations.
              </Empty>
            )}
          </>
        )}
        {section === 'preferences' && (
          <>
            <div className="section-heading">
              <div>
                <h2>Your preferences</h2>
                <p>A space that feels like yours.</p>
              </div>
              <span className="avatar">{user.name[0]}</span>
            </div>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void updatePreference({ name });
              }}
            >
              <Field label="Display name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={100}
                />
              </Field>
              <BusyButton busy={busy} className="secondary">
                Update name
              </BusyButton>
            </form>
            <h3 className="subsection-title">Appearance</h3>
            <div className="theme-choices">
              {(['system', 'light', 'dark'] as const).map((theme) => (
                <button
                  key={theme}
                  className={'secondary ' + ((user.theme || 'system') === theme ? 'selected' : '')}
                  onClick={() => updatePreference({ theme })}
                >
                  <Icon
                    name={theme === 'system' ? 'monitor' : theme === 'light' ? 'sun' : 'moon'}
                    size={20}
                  />
                  {theme[0].toUpperCase() + theme.slice(1)}
                </button>
              ))}
            </div>
            <h3 className="subsection-title">Date format</h3>
            <select
              aria-label="Date format"
              value={user.dateFormat || 'dmy'}
              onChange={(e) =>
                updatePreference({ dateFormat: e.target.value as User['dateFormat'] })
              }
            >
              <option value="dmy">Day / Month / Year</option>
              <option value="mdy">Month / Day / Year</option>
              <option value="iso">Year-Month-Day</option>
            </select>
            <div className="account-settings">
              <button className="secondary" onClick={() => run(app.logout)}>
                <Icon name="logout" size={18} />
                Sign out
              </button>
              <p className="small muted">
                Signing out clears financial data cached on this device.
              </p>
            </div>
            <div className="danger-zone">
              <h3>Delete your KinFlow account</h3>
              <p>
                Permanently deletes your personal data in every family. Families where you are the
                only member will be deleted.
              </p>
              {app.families.filter((f) => f.role === 'owner').length > 0 && (
                <p className="notice">
                  Owned families:{' '}
                  {app.families
                    .filter((f) => f.role === 'owner')
                    .map((f) => f.name)
                    .join(', ')}
                  . Transfer ownership first in families with other members.
                </p>
              )}
              <button
                className="danger-button"
                onClick={() => {
                  if (
                    confirm(
                      'Permanently delete your KinFlow account and all personal financial data across every family? This cannot be undone.',
                    )
                  )
                    void run(async () => {
                      await api('me', 'DELETE', {});
                      app.invalidate();
                      await clearCache();
                      await app.reload();
                    });
                }}
              >
                Delete account permanently
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
