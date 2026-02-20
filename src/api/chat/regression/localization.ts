/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION HANDLERS LOCALIZATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Provides localized messages for regression test handlers.
 * Messages are returned in user's detected language (en/ru/neutral).
 *
 * All regression handlers use this module to ensure responses match
 * the language the user is communicating in.
 */

export type Language = 'en' | 'ru' | 'neutral';

interface LocalizedMessages {
  saveTest: {
    noTestId: string;
    success: (name: string, id: string, paramsCount: number) => string;
    error: string;
  };
  runRegression: {
    noId: string;
    testStarted: (runId: string, testId: string) => string;
    error: string;
  };
  analyzeFailure: {
    noTestId: string;
    success: (rootCause: string, category: string, severity: string, suggestions: string) => string;
    error: string;
  };
  testRecommendations: {
    noProject: string;
    success: (formattedList: string) => string;
    error: string;
  };
}

const messages: Record<Language, LocalizedMessages> = {
  en: {
    saveTest: {
      noTestId: 'To save a test, you need the ID of the last executed test. Please run a test first.',
      success: (name, id, paramsCount) =>
        `✅ Test saved successfully!\n\n**Name:** ${name}\n**ID:** ${id}\n**Parameters:** ${paramsCount}\n\nYou can run this test with: "run saved test ${id}"`,
      error: 'Failed to save test. Please try again.',
    },
    runRegression: {
      noId: 'To run a regression test, you need a saved test case ID.',
      testStarted: (runId, testId) =>
        `✅ Saved test started!\n\n**Run ID:** ${runId}\n**Test ID:** ${testId}\n\nThe test is running in the background. You will receive results when it completes.`,
      error: 'Failed to run regression test. Please try again.',
    },
    analyzeFailure: {
      noTestId: 'No recent failed test found. Please run a test first or specify a test ID.',
      success: (rootCause, category, severity, suggestions) =>
        `🔍 **Failure Analysis**\n\n**Root Cause:** ${rootCause}\n**Category:** ${category}\n**Severity:** ${severity}\n\n**Suggestions:**\n${suggestions}`,
      error: 'Failed to analyze test failure. Please try again.',
    },
    testRecommendations: {
      noProject: 'No project context found. Please run a test first so I can understand your project.',
      success: (formattedList) =>
        `📋 **Test Recommendations**\n\nHere\'s what I recommend testing next:\n\n${formattedList}`,
      error: 'Failed to generate test recommendations. Please try again.',
    },
  },
  ru: {
    saveTest: {
      noTestId: 'Для сохранения теста нужен ID последнего выполненного теста. Пожалуйста, запустите тест сначала.',
      success: (name, id, paramsCount) =>
        `✅ Тест успешно сохранен!\n\n**Название:** ${name}\n**ID:** ${id}\n**Параметры:** ${paramsCount}\n\nВы можете запустить этот тест командой: "run saved test ${id}"`,
      error: 'Не удалось сохранить тест. Пожалуйста, попробуйте снова.',
    },
    runRegression: {
      noId: 'Для запуска regression теста нужен ID сохраненного теста.',
      testStarted: (runId, testId) =>
        `✅ Запущен сохраненный тест!\n\n**Run ID:** ${runId}\n**Test ID:** ${testId}\n\nТест выполняется в фоне. Вы получите результаты когда он завершится.`,
      error: 'Не удалось запустить regression тест. Пожалуйста, попробуйте снова.',
    },
    analyzeFailure: {
      noTestId: 'Не найден недавний проваленный тест. Пожалуйста, запустите тест или укажите ID теста.',
      success: (rootCause, category, severity, suggestions) =>
        `🔍 **Анализ ошибки**\n\n**Причина:** ${rootCause}\n**Категория:** ${category}\n**Серьезность:** ${severity}\n\n**Рекомендации:**\n${suggestions}`,
      error: 'Не удалось проанализировать ошибку теста. Пожалуйста, попробуйте снова.',
    },
    testRecommendations: {
      noProject: 'Не найден контекст проекта. Запустите тест, чтобы я мог понять ваш проект.',
      success: (formattedList) =>
        `📋 **Рекомендации по тестированию**\n\nВот что я рекомендую протестировать:\n\n${formattedList}`,
      error: 'Не удалось сгенерировать рекомендации. Пожалуйста, попробуйте снова.',
    },
  },
  neutral: {
    saveTest: {
      noTestId: 'To save a test, you need the ID of the last executed test. Please run a test first.',
      success: (name, id, paramsCount) =>
        `✅ Test saved successfully!\n\n**Name:** ${name}\n**ID:** ${id}\n**Parameters:** ${paramsCount}\n\nYou can run this test with: "run saved test ${id}"`,
      error: 'Failed to save test. Please try again.',
    },
    runRegression: {
      noId: 'To run a regression test, you need a saved test case ID.',
      testStarted: (runId, testId) =>
        `✅ Saved test started!\n\n**Run ID:** ${runId}\n**Test ID:** ${testId}\n\nThe test is running in the background. You will receive results when it completes.`,
      error: 'Failed to run regression test. Please try again.',
    },
    analyzeFailure: {
      noTestId: 'No recent failed test found. Please run a test first or specify a test ID.',
      success: (rootCause, category, severity, suggestions) =>
        `🔍 **Failure Analysis**\n\n**Root Cause:** ${rootCause}\n**Category:** ${category}\n**Severity:** ${severity}\n\n**Suggestions:**\n${suggestions}`,
      error: 'Failed to analyze test failure. Please try again.',
    },
    testRecommendations: {
      noProject: 'No project context found. Please run a test first so I can understand your project.',
      success: (formattedList) =>
        `📋 **Test Recommendations**\n\nHere\'s what I recommend testing next:\n\n${formattedList}`,
      error: 'Failed to generate test recommendations. Please try again.',
    },
  },
};

/**
 * Get localized messages for user's language
 * Returns message templates based on detected user language
 * Falls back to 'neutral' (English) if language is not provided or invalid
 *
 * @param language - User's detected language ('en', 'ru', 'neutral', or any string)
 * @returns LocalizedMessages object with all message templates
 */
export function getLocalizedMessages(language?: string): LocalizedMessages {
  // Validate language is a known type, otherwise use neutral
  const validLangs: Language[] = ['en', 'ru', 'neutral'];
  const lang = validLangs.includes(language as Language) ? (language as Language) : 'neutral';
  return messages[lang];
}
