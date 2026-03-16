-- Allow 'mobile' as a valid flow_type for mobile test flows.
-- Existing constraint: flow_type IN ('ui', 'api', 'mixed')
-- New constraint:      flow_type IN ('ui', 'api', 'mixed', 'mobile')

ALTER TABLE test_flows DROP CONSTRAINT IF EXISTS test_flows_flow_type_check;
ALTER TABLE test_flows ADD CONSTRAINT test_flows_flow_type_check
  CHECK (flow_type IN ('ui', 'api', 'mixed', 'mobile'));
