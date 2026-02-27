-- Update Pro and Ultra plan features to reflect actual product capabilities
-- Pro: accurate feature list based on implemented functionality
-- Ultra/Business: differentiated enterprise features

-- 1. Update Pro Plan features
UPDATE pricing_plans
SET
    features = ARRAY[
        'Create tests with AI agent',
        'Autonomous test execution',
        'Web UI + API testing',
        'Run up to 1 test in parallel',
        'Real-time test visualization',
        'Regression plans & test suites',
        'Chrome browser testing',
        'Scheduled test runs',
        'Advanced analytics',
        'Git-triggered test automation',
        'Slack & Telegram notifications',
        'Jira integration (Trello, Notion soon)',
        'Up to 3,000 AI credits per month',
        'Priority email support'
    ],
    updated_at = NOW()
WHERE slug = 'pro';

-- 2. Update Ultra/Business Plan features
UPDATE pricing_plans
SET
    features = ARRAY[
        'AI QA multi-agent infrastructure layer',
        'Everything from Pro',
        'Multi-browser testing (Chrome, Safari, Edge)',
        'Mobile viewport testing (Tablet, Mobile)',
        'Run up to 10 tests in parallel',
        'Team workspaces with role management',
        'Custom knowledge base training',
        'Continuous AI context learning',
        'Customizing by request',
        'Custom credit allocation',
        'Dedicated support & onboarding',
        'Enterprise-grade SLA (99% uptime)',
        'Enterprise integrations & API access',
        'WebSocket testing (soon)',
        'Overload testing (soon)',
        'Mobile device testing (soon)'
    ],
    updated_at = NOW()
WHERE slug = 'ultra';

-- 3. Verify updates
DO $$
DECLARE
    pro_features TEXT[];
    ultra_features TEXT[];
BEGIN
    SELECT features INTO pro_features FROM pricing_plans WHERE slug = 'pro';
    SELECT features INTO ultra_features FROM pricing_plans WHERE slug = 'ultra';

    RAISE NOTICE 'Pro Plan features count: %', array_length(pro_features, 1);
    RAISE NOTICE 'Ultra Plan features count: %', array_length(ultra_features, 1);

    IF array_length(pro_features, 1) IS NULL THEN
        RAISE WARNING 'Pro plan features are empty!';
    END IF;

    IF array_length(ultra_features, 1) IS NULL THEN
        RAISE WARNING 'Ultra plan features are empty!';
    END IF;
END $$;
