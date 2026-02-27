-- Add pipeline_metrics column to ai_usage_log
-- Stores sub-agent pipeline performance data (path, success, latency, tools, router confidence)
-- as JSONB for flexible querying of agent health metrics.

ALTER TABLE ai_usage_log
ADD COLUMN IF NOT EXISTS pipeline_metrics JSONB DEFAULT NULL;

COMMENT ON COLUMN ai_usage_log.pipeline_metrics IS 'Sub-agent pipeline metrics: {path, success, routerMs, executorMs, responderMs, totalMs, routerClassification, routerConfidence, toolCategories, toolsExecuted}';
