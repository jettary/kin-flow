-- No prompts, audio or unconfirmed drafts are stored in the database.
ALTER TABLE users ADD COLUMN ai_notice_version integer NOT NULL DEFAULT 0;
CREATE TABLE ai_monthly_usage (
 month date PRIMARY KEY,
 requests integer NOT NULL CHECK (requests BETWEEN 0 AND 1000)
);
CREATE TABLE ai_batch_receipts (
 family_id uuid NOT NULL REFERENCES families ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 batch_id uuid NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(family_id,user_id,batch_id)
);
