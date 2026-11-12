'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/offline';
import { ErrorMessage } from './ui';

interface Grant {
  id: string;
  name: string;
  host: string;
  scope: string[];
  createdAt: string;
  lastUsedAt: string;
}

export function ConnectedAssistants() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api<Grant[]>('me/assistants')
      .then(setGrants)
      .catch((e: Error) => setError(e.message));
  }, []);
  const disconnect = async (grant: Grant) => {
    setBusy(grant.id);
    setError('');
    try {
      await api(`me/assistants/${grant.id}`, 'DELETE');
      setGrants((list) => list?.filter((g) => g.id !== grant.id) || null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="notification-settings connected-assistants">
      <h2>Connected assistants</h2>
      <p>
        AI assistants such as Claude or ChatGPT connected to KinFlow act as you, with your role in
        each family. Disconnecting stops their access immediately.
      </p>
      <ErrorMessage message={error} />
      {grants?.length === 0 && <p>No assistants are connected.</p>}
      {grants?.map((g) => (
        <div className="assistant-row" key={g.id}>
          <div>
            <strong>{g.name}</strong>
            <p className="small muted">
              {g.host} · {g.scope.includes('write') ? 'Can make changes' : 'Read only'} · Last used{' '}
              {new Date(g.lastUsedAt).toLocaleDateString()}
            </p>
          </div>
          <button className="secondary" disabled={busy === g.id} onClick={() => disconnect(g)}>
            Disconnect
          </button>
        </div>
      ))}
    </div>
  );
}
