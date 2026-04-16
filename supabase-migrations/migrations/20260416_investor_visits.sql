-- Investor report visit tracking
CREATE TABLE IF NOT EXISTS investor_visits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  visitor_name TEXT NOT NULL,
  report_month TEXT NOT NULL,
  visited_at TIMESTAMPTZ DEFAULT now(),
  user_agent TEXT,
  screen_width INT,
  screen_height INT,
  time_on_page_sec INT DEFAULT 0,
  max_scroll_pct INT DEFAULT 0,
  ip_address TEXT,
  session_id TEXT NOT NULL UNIQUE
);

-- Index for querying by report month
CREATE INDEX IF NOT EXISTS idx_investor_visits_report_month ON investor_visits (report_month);

-- Index for session lookups (used by PATCH endpoint)
CREATE INDEX IF NOT EXISTS idx_investor_visits_session_id ON investor_visits (session_id);
