import { api } from './offline';

export const pushSupported = () =>
  typeof window !== 'undefined' &&
  window.isSecureContext &&
  'Notification' in window &&
  'PushManager' in window &&
  'serviceWorker' in navigator;

export async function currentSubscription() {
  if (!pushSupported()) return null;
  return (
    (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription() || null
  );
}

export function deviceChanged() {
  window.dispatchEvent(new Event('kinflow-push-device'));
}

export async function enablePush(publicKey: string) {
  // This is the first asynchronous operation, called directly from the user's click.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error(
      'Notifications are blocked. Allow them in your browser settings, then try again.',
    );
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  let subscription = await registration.pushManager.getSubscription();
  // VAPID rotation requires a new browser subscription.
  if (
    subscription &&
    subscription.options.applicationServerKey &&
    !equalKeys(new Uint8Array(subscription.options.applicationServerKey), key)
  ) {
    await api('push/subscription', 'DELETE', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  try {
    await api('push/subscription', 'POST', subscription.toJSON());
  } catch (error) {
    // Roll back the browser subscription if registration fails; enable remains retryable.
    await subscription.unsubscribe();
    throw error;
  }
  deviceChanged();
}
function equalKeys(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (subscription) {
    await api('push/subscription', 'DELETE', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  await closePushNotifications();
  deviceChanged();
}

export async function closePushNotifications() {
  const registration = await navigator.serviceWorker?.getRegistration('/');
  for (const notification of (await registration?.getNotifications()) || []) notification.close();
}

export async function clearPushOnLogout() {
  // Also runs offline. Server subscriptions are revoked by deleting this session on reconnect.
  try {
    await (await currentSubscription())?.unsubscribe();
  } catch {}
  try {
    await closePushNotifications();
  } catch {}
  deviceChanged();
}
