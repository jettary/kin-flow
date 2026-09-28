'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/offline';
import { currentSubscription, disablePush, enablePush, pushSupported } from '@/lib/push-client';
import type { PushEvent, PushPreferences, PushSettings } from '@/lib/push';
import { BusyButton, ErrorMessage } from './ui';

const options: [PushEvent, string][] = [
  ['expenseCreated', 'New shared purchases'],
  ['expenseChanged', 'Purchase edits, deletions & refunds'],
  ['transfer', 'Transfers & currency exchanges'],
  ['income', 'Income deposits'],
];

export function NotificationSettings({
  familyId,
  familyName,
}: {
  familyId: string;
  familyName: string;
}) {
  const [settings, setSettings] = useState<PushSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const refreshDevice = async () => {
    setSupported(pushSupported());
    setBlocked(pushSupported() && Notification.permission === 'denied');
    const subscription = await currentSubscription();
    setEnabled(
      !!subscription &&
        !!(
          await api<{ id: string | null }>('push/status', 'POST', {
            endpoint: subscription.endpoint,
          })
        ).id,
    );
  };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await api<PushSettings>(`families/${familyId}/notifications`);
        if (cancelled) return;
        setSettings(value);
        await refreshDevice();
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [familyId]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const update = (event: PushEvent, value: boolean) =>
    run(async () => {
      const previous = settings!;
      const preferences: PushPreferences = { ...previous.preferences, [event]: value };
      setSettings({ ...previous, preferences });
      try {
        setSettings(
          await api<PushSettings>(`families/${familyId}/notifications`, 'PATCH', preferences),
        );
      } catch (error) {
        setSettings(previous);
        throw error;
      }
    });
  return (
    <div className="notification-settings">
      <div className="section-heading">
        <h2>Notifications</h2>
      </div>
      <ErrorMessage message={error} />
      {!loaded ? (
        <p>Loading notification settings…</p>
      ) : (
        <>
          <h3>This device</h3>
          <p>Get a private heads-up when another family member records a shared transaction.</p>
          {!supported ? (
            <p>
              Push notifications are unavailable here. On iPhone or iPad, add KinFlow to your Home
              Screen and open it there.
            </p>
          ) : (
            <>
              <p role="status">
                {enabled
                  ? 'Notifications are enabled on this device.'
                  : blocked
                    ? 'Notifications are blocked in your browser settings.'
                    : 'Notifications are off on this device.'}
              </p>
              {!settings?.publicKey && <p>Notifications are not configured on this server yet.</p>}
              <BusyButton
                className={enabled ? 'secondary device-action' : 'primary device-action'}
                busy={busy}
                disabled={!enabled && (!settings?.publicKey || blocked)}
                onClick={() =>
                  void run(async () => {
                    if (enabled) await disablePush();
                    else await enablePush(settings!.publicKey!);
                    await refreshDevice();
                  })
                }
              >
                {enabled ? 'Disable on this device' : 'Enable notifications'}
              </BusyButton>
            </>
          )}
          <p>
            Other devices keep their own subscriptions. While KinFlow is open, its history updates
            without a system notification.
          </p>
          <h3>Events in {familyName}</h3>
          <p>These choices apply only to you in this family, across your subscribed devices.</p>
          {settings &&
            options.map(([event, label]) => (
              <label className="checkbox archive-toggle" key={event}>
                <input
                  type="checkbox"
                  checked={settings.preferences[event]}
                  disabled={busy}
                  onChange={(e) => void update(event, e.target.checked)}
                />
                {label}
              </label>
            ))}
          <p>
            Personal transactions and balance adjustments never send notifications. Lock-screen
            messages contain no amounts, names or account details.
          </p>
        </>
      )}
    </div>
  );
}
