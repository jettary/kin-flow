CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, google_id text UNIQUE NOT NULL, name text NOT NULL, avatar text,
 preferences jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (state_hash text PRIMARY KEY, verifier text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS families (
 id uuid PRIMARY KEY, name text NOT NULL, currency text NOT NULL, timezone text NOT NULL,
 version bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
 family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('owner','admin','member')), joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(family_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON memberships(family_id) WHERE role='owner';
CREATE TABLE IF NOT EXISTS invitations (
 code text PRIMARY KEY, family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, max_uses int NOT NULL CHECK(max_uses BETWEEN 1 AND 100), uses int NOT NULL DEFAULT 0,
 created_by uuid REFERENCES users ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entities (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE,
 owner_id uuid REFERENCES users ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('account','expense','source','budget')),
 data jsonb NOT NULL, version bigint NOT NULL, UNIQUE(id,family_id)
);
CREATE INDEX IF NOT EXISTS entities_family ON entities(family_id,owner_id);
CREATE TABLE IF NOT EXISTS transactions (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE,
 owner_id uuid REFERENCES users ON DELETE CASCADE, author_id uuid REFERENCES users ON DELETE SET NULL,
 type text NOT NULL CHECK(type IN ('expense','income','transfer','adjustment','refund')),
 date text NOT NULL, data jsonb NOT NULL, notice boolean NOT NULL DEFAULT false,
 redacted boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false, version bigint NOT NULL, UNIQUE(id,family_id)
);
CREATE INDEX IF NOT EXISTS transactions_sync ON transactions(family_id,version,id);
CREATE TABLE IF NOT EXISTS ledger (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE,
 account_id uuid NOT NULL, transaction_id uuid,
 amount numeric(38,9) NOT NULL, opening boolean NOT NULL DEFAULT false,
 FOREIGN KEY(account_id,family_id) REFERENCES entities(id,family_id) ON DELETE CASCADE,
 FOREIGN KEY(transaction_id,family_id) REFERENCES transactions(id,family_id) ON DELETE SET NULL (transaction_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_opening ON ledger(account_id) WHERE opening;
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id);
CREATE INDEX IF NOT EXISTS ledger_transaction ON ledger(transaction_id);
CREATE TABLE IF NOT EXISTS audits (
 id uuid PRIMARY KEY, family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE, object_id uuid NOT NULL,
 owner_id uuid REFERENCES users ON DELETE CASCADE, actor_id uuid REFERENCES users ON DELETE SET NULL,
 action text NOT NULL, before_data jsonb, after_data jsonb, conflict boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_object ON audits(family_id,object_id,created_at);
CREATE TABLE IF NOT EXISTS mutation_receipts (
 family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 mutation_id uuid NOT NULL, result jsonb NOT NULL, PRIMARY KEY(family_id,user_id,mutation_id)
);
CREATE TABLE IF NOT EXISTS exchange_rates (id int PRIMARY KEY CHECK(id=1), data jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS rate_refresh_lock (id int PRIMARY KEY CHECK(id=1), until_at timestamptz NOT NULL);
INSERT INTO rate_refresh_lock(id,until_at) VALUES(1,'2000-01-01') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS deletion_log (id uuid PRIMARY KEY, user_hash text NOT NULL, family_id uuid, deleted_at timestamptz NOT NULL DEFAULT now());
