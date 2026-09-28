ALTER TABLE memberships ADD COLUMN push_preferences jsonb NOT NULL DEFAULT
 '{"expenseCreated":true,"expenseChanged":false,"transfer":false,"income":false}';

CREATE TABLE push_subscriptions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 endpoint text UNIQUE NOT NULL, keys jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE TABLE push_presence (
 subscription_id uuid NOT NULL REFERENCES push_subscriptions ON DELETE CASCADE,
 tab_id uuid NOT NULL, until_at timestamptz NOT NULL,
 PRIMARY KEY(subscription_id,tab_id)
);
CREATE TABLE push_outbox (
 id uuid PRIMARY KEY, family_id uuid NOT NULL, user_id uuid NOT NULL,
 subscription_id uuid NOT NULL REFERENCES push_subscriptions ON DELETE CASCADE,
 mutation_id uuid NOT NULL, events text[] NOT NULL, changed boolean NOT NULL,
 attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 lease_id uuid, lease_until timestamptz,
 FOREIGN KEY(family_id,user_id) REFERENCES memberships(family_id,user_id) ON DELETE CASCADE,
 UNIQUE(family_id,mutation_id,subscription_id)
);
CREATE INDEX push_outbox_due ON push_outbox(next_attempt_at);
