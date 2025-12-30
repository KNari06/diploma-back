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
  createSuite: {
    noTestCases: string;
    success: (name: string, id: string, count: number) => string;
    error: string;
  };
  runRegression: {
    noId: string;
    testStarted: (runId: string, testId: string) => string;
    suiteStarted: (runId: string, count: number) => string;
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
    createSuite: {
      noTestCases: 'To create a suite, you need saved test case IDs. Please save some tests first or provide test case IDs.',
      success: (name, id, count) =>
        `✅ Regression suite created successfully!\n\n**Name:** ${name}\n**ID:** ${id}\n**Test cases:** ${count}\n\nYou can run this suite with: "run suite ${id}"`,
      error: 'Failed to create suite. Please try again.',
    },
    runRegression: {
      noId: 'To run a regression test, you need a saved test case ID or suite ID.',
      testStarted: (runId, testId) =>
        `✅ Saved test started!\n\n**Run ID:** ${runId}\n**Test ID:** ${testId}\n\nThe test is running in the background. You will receive results when it completes.`,
      suiteStarted: (runId, count) =>
        `✅ Regression suite started!\n\n**Run ID:** ${runId}\n**Tests:** ${count}\n\nTests are running in the background. You will receive results when they complete.`,
      error: 'Failed to run regression test. Please try again.',
    },
  },
  ru: {
    saveTest: {
      noTestId: 'Для сохранения теста нужен ID последнего выполненного теста. Пожалуйста, запустите тест сначала.',
      success: (name, id, paramsCount) =>
        `✅ Тест успешно сохранен!\n\n**Название:** ${name}\n**ID:** ${id}\n**Параметры:** ${paramsCount}\n\nВы можете запустить этот тест командой: "run saved test ${id}"`,
      error: 'Не удалось сохранить тест. Пожалуйста, попробуйте снова.',
    },
    createSuite: {
      noTestCases: 'Для создания набора тестов нужны ID сохраненных тест-кейсов. Сначала сохраните несколько тестов или укажите ID тест-кейсов.',
      success: (name, id, count) =>
        `✅ Regression suite успешно создан!\n\n**Название:** ${name}\n**ID:** ${id}\n**Тест-кейсов:** ${count}\n\nВы можете запустить этот набор командой: "run suite ${id}"`,
      error: 'Не удалось создать набор тестов. Пожалуйста, попробуйте снова.',
    },
    runRegression: {
      noId: 'Для запуска regression теста нужен ID сохраненного теста или набора тестов.',
      testStarted: (runId, testId) =>
        `✅ Запущен сохраненный тест!\n\n**Run ID:** ${runId}\n**Test ID:** ${testId}\n\nТест выполняется в фоне. Вы получите результаты когда он завершится.`,
      suiteStarted: (runId, count) =>
        `✅ Запущен regression suite!\n\n**Run ID:** ${runId}\n**Тестов:** ${count}\n\nТесты выполняются в фоне. Вы получите результаты когда они завершатся.`,
      error: 'Не удалось запустить regression тест. Пожалуйста, попробуйте снова.',
    },
  },
  neutral: {
    saveTest: {
      noTestId: 'To save a test, you need the ID of the last executed test. Please run a test first.',
      success: (name, id, paramsCount) =>
        `✅ Test saved successfully!\n\n**Name:** ${name}\n**ID:** ${id}\n**Parameters:** ${paramsCount}\n\nYou can run this test with: "run saved test ${id}"`,
      error: 'Failed to save test. Please try again.',
    },
    createSuite: {
      noTestCases: 'To create a suite, you need saved test case IDs. Please save some tests first or provide test case IDs.',
      success: (name, id, count) =>
        `✅ Regression suite created successfully!\n\n**Name:** ${name}\n**ID:** ${id}\n**Test cases:** ${count}\n\nYou can run this suite with: "run suite ${id}"`,
      error: 'Failed to create suite. Please try again.',
    },
    runRegression: {
      noId: 'To run a regression test, you need a saved test case ID or suite ID.',
      testStarted: (runId, testId) =>
        `✅ Saved test started!\n\n**Run ID:** ${runId}\n**Test ID:** ${testId}\n\nThe test is running in the background. You will receive results when it completes.`,
      suiteStarted: (runId, count) =>
        `✅ Regression suite started!\n\n**Run ID:** ${runId}\n**Tests:** ${count}\n\nTests are running in the background. You will receive results when they complete.`,
      error: 'Failed to run regression test. Please try again.',
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
