-- Add country field for investor visits
ALTER TABLE investor_visits ADD COLUMN IF NOT EXISTS country TEXT;

CREATE INDEX IF NOT EXISTS idx_investor_visits_country ON investor_visits (country);
