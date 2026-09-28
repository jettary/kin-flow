CREATE TABLE IF NOT EXISTS rate_snapshots (fetched_at text PRIMARY KEY, data jsonb NOT NULL);
INSERT INTO rate_snapshots(fetched_at,data) SELECT data->>'fetchedAt',data FROM exchange_rates ON CONFLICT DO NOTHING;
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS date text;
UPDATE ledger l SET date=COALESCE((SELECT t.date FROM transactions t WHERE t.id=l.transaction_id),(SELECT e.data->>'openingDate' FROM entities e WHERE e.id=l.account_id),'1970-01-01') WHERE date IS NULL;
ALTER TABLE ledger ALTER COLUMN date SET NOT NULL;
