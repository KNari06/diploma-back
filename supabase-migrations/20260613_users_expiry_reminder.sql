-- Dedup marker for the "plan expiring in 3 days" reminder email.
-- Stores the current_period_end value we last reminded the user about, so:
--   * within one billing period we email at most once (sweep runs daily and
--     would otherwise fire 3 days in a row);
--   * a new period (new current_period_end) naturally re-arms the reminder.
-- NULL = never reminded.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS expiry_reminder_sent_for TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN users.expiry_reminder_sent_for IS
  'current_period_end value the expiry reminder email was last sent for (dedup marker). NULL = not sent.';

-- Partial index for the daily expiring-plans sweep: it only ever scans paid
-- users with a future period end. Partial keeps the index tiny (most users are
-- free / no period end) and avoids a seq scan on the full users table.
CREATE INDEX IF NOT EXISTS idx_users_expiring_paid
  ON users (current_period_end)
  WHERE plan_status = 'paid' AND current_period_end IS NOT NULL;
