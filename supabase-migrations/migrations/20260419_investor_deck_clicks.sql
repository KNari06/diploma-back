-- Track pitch deck link clicks per visit
ALTER TABLE investor_visits ADD COLUMN IF NOT EXISTS deck_clicks INT DEFAULT 0;
ALTER TABLE investor_visits ADD COLUMN IF NOT EXISTS last_deck_click_at TIMESTAMPTZ;
