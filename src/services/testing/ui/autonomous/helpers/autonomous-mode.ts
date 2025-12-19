import { logger } from '@/utils/core/logger';

/**
 * Detect if autonomous mode is needed
 * SIMPLIFIED: Now based purely on intent type
 */
export function needsAutonomousMode(intent: string): boolean {
  logger.info('[AUTONOMOUS] Checking if autonomous mode needed', { intent });

  // SIMPLIFIED LOGIC:
  // - platform_test → ALWAYS autonomous (with test plan approval)
  // - api_test → ALWAYS autonomous (with test plan approval)
  // - general_chat → NEVER autonomous

  // NEW intents
  if (intent === 'platform_test') {
    logger.info('[AUTONOMOUS] Activating - platform_test intent');
    return true;
  }

  if (intent === 'api_test') {
    logger.info('[AUTONOMOUS] Activating - api_test intent (will generate test plan)');
    return true;
  }

  if (intent === 'general_chat') {
    logger.info('[AUTONOMOUS] Skipping - general_chat intent');
    return false;
  }

  // LEGACY intents (for backward compatibility)
  const legacyUiIntents = ['check_element', 'fill_form', 'login_flow', 'assert_ui', 'navigate'];
  if (legacyUiIntents.includes(intent)) {
    logger.info('[AUTONOMOUS] Activating - legacy UI intent (migrating to platform_test)');
    return true;
  }

  if (intent === 'api_test_comprehensive') {
    logger.info('[AUTONOMOUS] Activating - legacy api_test_comprehensive');
    return true;
  }

  // Default: activate autonomous for unknown intents (safe approach)
  logger.info('[AUTONOMOUS] Activating - unknown intent, defaulting to autonomous', { intent });
  return true;
}
