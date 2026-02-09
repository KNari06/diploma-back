-- Migration: Add quality_checks column to test_results
-- Description: Store non-UI quality metrics (performance, accessibility, broken resources, API latency)
-- Safe: Uses IF NOT EXISTS so it is idempotent across environments

ALTER TABLE public.test_results
ADD COLUMN IF NOT EXISTS quality_checks JSONB;

COMMENT ON COLUMN public.test_results.quality_checks IS 'Quality check report: Web Vitals, broken resources, accessibility warnings, slow API calls';

-- Example quality_checks structure:
-- {
--   "performance": {
--     "lcp": 1234.56,
--     "cls": 0.05,
--     "tbt": 125.8,
--     "fid": 0,
--     "ttfb": 234.1,
--     "domContentLoaded": 567.3,
--     "load": 1245.9
--   },
--   "brokenResources": [
--     {
--       "type": "broken_image",
--       "url": "https://example.com/image.png",
--       "element": "img#logo"
--     }
--   ],
--   "accessibility": {
--     "totalWarnings": 3,
--     "warnings": [
--       {
--         "message": "Image without alt text",
--         "selector": "img.banner",
--         "wcag": "1.1.1"
--       }
--     ]
--   },
--   "apiPerformance": {
--     "totalRequests": 15,
--     "averageResponseTime": 234.5,
--     "p95ResponseTime": 1234.8,
--     "slowCalls": [
--       {
--         "url": "https://api.example.com/data",
--         "method": "GET",
--         "status": 200,
--         "responseTime": 3456.7
--       }
--     ]
--   }
-- }
