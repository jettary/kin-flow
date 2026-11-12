-- OAuth 2.1 authorization server for the MCP connector. Only token hashes are stored.
CREATE TABLE oauth_clients (
 id text PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('cimd','dcr')),
 name text NOT NULL,
 redirect_uris jsonb NOT NULL,
 secret_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),
 fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_codes (
 code_hash text PRIMARY KEY,
 client_id text NOT NULL REFERENCES oauth_clients ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 scope text NOT NULL,
 code_challenge text NOT NULL,
 redirect_uri text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE oauth_grants (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 client_id text NOT NULL REFERENCES oauth_clients ON DELETE CASCADE,
 scope text NOT NULL,
 access_hash text NOT NULL UNIQUE,
 access_expires_at timestamptz NOT NULL,
 refresh_hash text NOT NULL UNIQUE,
 previous_refresh_hash text UNIQUE,
 refresh_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
