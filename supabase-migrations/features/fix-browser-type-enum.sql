-- Fix browser_type enum to match application code
-- The application uses 'chrome' but database enum has 'chromium'

DO $$
BEGIN
    -- Check if browser_type enum exists
    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'browser_type') THEN
        RAISE NOTICE 'Updating browser_type enum to match application code...';

        -- Drop and recreate the enum with correct values
        -- First, we need to drop dependent objects temporarily

        -- Get current enum values for verification
        RAISE NOTICE 'Current browser_type values: %', (
            SELECT array_agg(enumlabel ORDER BY enumsortorder)
            FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'browser_type')
        );

        -- Add missing values to enum if they don't exist
        -- Add 'chrome' if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'browser_type')
            AND enumlabel = 'chrome'
        ) THEN
            ALTER TYPE browser_type ADD VALUE 'chrome';
            RAISE NOTICE 'Added chrome to browser_type enum';
        END IF;

        -- Add 'safari' if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'browser_type')
            AND enumlabel = 'safari'
        ) THEN
            ALTER TYPE browser_type ADD VALUE 'safari';
            RAISE NOTICE 'Added safari to browser_type enum';
        END IF;

        -- Add 'edge' if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'browser_type')
            AND enumlabel = 'edge'
        ) THEN
            ALTER TYPE browser_type ADD VALUE 'edge';
            RAISE NOTICE 'Added edge to browser_type enum';
        END IF;

        -- Add 'mobile-chrome' if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'browser_type')
            AND enumlabel = 'mobile-chrome'
        ) THEN
            ALTER TYPE browser_type ADD VALUE 'mobile-chrome';
            RAISE NOTICE 'Added mobile-chrome to browser_type enum';
        END IF;

        -- Add 'mobile-safari' if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'browser_type')
            AND enumlabel = 'mobile-safari'
        ) THEN
            ALTER TYPE browser_type ADD VALUE 'mobile-safari';
            RAISE NOTICE 'Added mobile-safari to browser_type enum';
        END IF;

        -- Update existing records that use 'chromium' to 'chrome'
        -- Note: Check if browsers column is browser_type[] or text[]
        DO $update_block$
        BEGIN
            -- Check if tests table exists
            IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tests') THEN
                RAISE NOTICE 'Table tests does not exist, skipping updates';
                RETURN;
            END IF;

            -- Check if test_results table exists
            IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'test_results') THEN
                RAISE NOTICE 'Table test_results does not exist, skipping updates';
                RETURN;
            END IF;

            -- Check column type for tests.browsers
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'tests'
                AND column_name = 'browsers'
                AND data_type = 'ARRAY'
                AND udt_name LIKE '%browser_type%' -- browser_type array
            ) THEN
                -- browsers is browser_type[] - use enum casting
                UPDATE tests
                SET browsers = array_replace(browsers, 'chromium'::browser_type, 'chrome'::browser_type)
                WHERE 'chromium'::browser_type = ANY(browsers);

                UPDATE tests
                SET browsers = array_replace(browsers, 'webkit'::browser_type, 'safari'::browser_type)
                WHERE 'webkit'::browser_type = ANY(browsers);

                RAISE NOTICE 'Updated tests.browsers (browser_type[] format)';
            ELSE
                -- browsers is text[] - use text replacement
                UPDATE tests
                SET browsers = array_replace(browsers, 'chromium', 'chrome')
                WHERE 'chromium' = ANY(browsers);

                UPDATE tests
                SET browsers = array_replace(browsers, 'webkit', 'safari')
                WHERE 'webkit' = ANY(browsers);

                RAISE NOTICE 'Updated tests.browsers (text[] format)';
            END IF;

            -- Update test_results.browser (always browser_type)
            UPDATE test_results
            SET browser = 'chrome'::browser_type
            WHERE browser = 'chromium'::browser_type;

            UPDATE test_results
            SET browser = 'safari'::browser_type
            WHERE browser = 'webkit'::browser_type;

            RAISE NOTICE 'Updated test_results.browser';

        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Error updating records: %. Continuing...', SQLERRM;
        END;
        $update_block$;

        RAISE NOTICE 'Updated existing records to use new browser names';

        -- Show final enum values
        RAISE NOTICE 'Final browser_type values: %', (
            SELECT array_agg(enumlabel ORDER BY enumsortorder)
            FROM pg_enum
            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'browser_type')
        );

    ELSE
        RAISE NOTICE 'browser_type enum does not exist, creating it...';

        -- Create the enum with correct values
        CREATE TYPE browser_type AS ENUM (
            'chrome',
            'firefox',
            'safari',
            'edge',
            'mobile-chrome',
            'mobile-safari',
            'chromium',  -- Keep for backward compatibility
            'webkit'     -- Keep for backward compatibility
        );

        RAISE NOTICE 'Created browser_type enum with all values';
    END IF;

END $$;

-- Add comment for future reference
COMMENT ON TYPE browser_type IS 'Browser types supported by the application. Primary values: chrome, firefox, safari, edge, mobile-chrome, mobile-safari. Legacy values: chromium, webkit (for backward compatibility).';
