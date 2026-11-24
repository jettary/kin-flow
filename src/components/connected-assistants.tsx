'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/offline';
import { ErrorMessage, Icon, Modal } from './ui';
import { ChatGptLogo, ClaudeLogo } from './assistant-logos';

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
  const [connecting, setConnecting] = useState(false);
  const load = useCallback(
    () =>
      api<Grant[]>('me/assistants')
        .then(setGrants)
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
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
      <div className="section-heading">
        <div>
          <h2>Connected assistants</h2>
        </div>
        <button className="primary" onClick={() => setConnecting(true)}>
          <Icon name="plus" size={17} />
          Connect MCP
        </button>
      </div>
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
      {connecting && (
        <ConnectDialog
          onClose={() => {
            setConnecting(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const url = `${window.location.origin}/api/mcp`;
  const [copied, setCopied] = useState('');
  const copy = async (what: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(what);
    } catch {
      setCopied('');
    }
  };
  const claude =
    'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=KinFlow&connectorUrl=' +
    encodeURIComponent(url);
  return (
    <Modal title="Connect an assistant" onClose={onClose}>
      <p className="muted">
        Your assistant opens a KinFlow page where you choose what it may do. No passwords or keys
        are shared.
      </p>
      <div className="connect-options">
        <a
          className="connect-option"
          href={claude}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Connect to Claude"
        >
          Connect to <ClaudeLogo />
        </a>
        <a
          className="connect-option"
          href="https://chatgpt.com/plugins"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Connect to ChatGPT"
          onClick={() => copy('chatgpt')}
        >
          Connect to <ChatGptLogo />
        </a>
      </div>
      {copied === 'chatgpt' && (
        <div className="connect-steps" role="status">
          <strong>Server URL copied. In ChatGPT:</strong>
          <ol>
            <li>
              Open <b>Plugins</b>, select <b>+</b>, then <b>Add custom MCP server</b>.
            </li>
            <li>Name it KinFlow and paste the URL.</li>
            <li>
              Choose <b>OAuth</b> authentication and create the plugin.
            </li>
          </ol>
          <p className="small muted">
            Custom servers need ChatGPT Business, Enterprise or Edu. Pro can only read.
          </p>
        </div>
      )}
      <details className="connect-other">
        <summary>Using another assistant?</summary>
        <p>
          Add KinFlow as a remote MCP server (Streamable HTTP) with this URL. Leave authentication
          on OAuth: the assistant will send you to KinFlow to approve access.
        </p>
        <div className="connect-url">
          <input
            readOnly
            value={url}
            aria-label="MCP server URL"
            onFocus={(e) => e.target.select()}
          />
          <button className="secondary" type="button" onClick={() => copy('url')}>
            <Icon name={copied === 'url' ? 'check' : 'copy'} size={16} />
            {copied === 'url' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="small muted">
          Claude Code: <code>claude mcp add --transport http kinflow {url}</code>
        </p>
      </details>
    </Modal>
  );
}
