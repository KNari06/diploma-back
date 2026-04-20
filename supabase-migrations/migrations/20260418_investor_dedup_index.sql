-- Composite index to speed up dedup lookup by (IP, name, report_month, visited_at)
CREATE INDEX IF NOT EXISTS idx_investor_visits_dedup
  ON investor_visits (ip_address, report_month, visited_at DESC);
