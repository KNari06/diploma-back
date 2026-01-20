-- ============================================================================
-- GIT WEBHOOK DELIVERIES (audit + idempotency)
-- ============================================================================
-- Stores webhook deliveries from Git providers (GitHub/GitLab) to:
-- - deduplicate retries (idempotency)
-- - audit received payloads
-- - track processing status
-- ============================================================================

CREATE TABLE IF NOT EXISTS git_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  provider VARCHAR(50) NOT NULL CHECK (provider IN ('github', 'gitlab')),
  delivery_id TEXT NOT NULL,

  event_type TEXT NOT NULL,
  repository_url TEXT NOT NULL,

  integration_id UUID NULL REFERENCES git_integrations(id) ON DELETE SET NULL,

  payload JSONB NOT NULL,
  signature TEXT NULL,

  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'processed', 'ignored', 'failed')),
  received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE NULL,
  error TEXT NULL,

  CONSTRAINT unique_provider_delivery UNIQUE (provider, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_git_webhook_deliveries_integration_id
  ON git_webhook_deliveries(integration_id);

CREATE INDEX IF NOT EXISTS idx_git_webhook_deliveries_repository_url
  ON git_webhook_deliveries(repository_url);

CREATE INDEX IF NOT EXISTS idx_git_webhook_deliveries_received_at
  ON git_webhook_deliveries(received_at DESC);

-- Note: UNIQUE(provider, delivery_id) constraint automatically creates an index for idempotency checks
