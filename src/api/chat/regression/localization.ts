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

export type Language = 'en' | 'ru' | 'kk' | 'neutral';

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
  coverageAnalysis: {
    noProject: string;
    success: (
      scoreBadge: string,
      score: number,
      coveredUrls: number,
      totalUrls: number,
      totalTestCases: number,
      staleTestCases: number,
      gapList: string,
      summary: string,
    ) => string;
    error: string;
  };
  /**
   * General-chat fallback when the LLM call fails. One message PER error class
   * (not a single catch-all) so the user gets an actionable hint, localized.
   */
  chatError: {
    /** Generic / unclassified LLM failure (500/502/503, unknown). */
    generic: string;
    /** Network / connection drop (ECONNRESET, fetch failed). */
    network: string;
    /** Rate limit or quota (429 / insufficient_quota). */
    rateLimit: string;
    /** Auth / config (401 / invalid_api_key) — user can't fix; team notified. */
    config: string;
    /** Request timed out / took too long. */
    timeout: string;
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
        `📋 **Test Recommendations**\n\nHere's what I recommend testing next:\n\n${formattedList}`,
      error: 'Failed to generate test recommendations. Please try again.',
    },
    coverageAnalysis: {
      noProject: 'No project context found. Please run a test first so I can analyze coverage.',
      success: (scoreBadge, score, coveredUrls, totalUrls, totalTestCases, staleTestCases, gapList, summary) =>
        `${scoreBadge} **Coverage Score: ${score}/100**\n\n` +
        `**URLs:** ${coveredUrls}/${totalUrls} covered | **Test Cases:** ${totalTestCases} total, ${staleTestCases} stale\n\n` +
        `---\n\n${summary}\n\n` +
        `---\n\n**Gaps:**\n\n${gapList}`,
      error: 'Failed to analyze coverage. Please try again.',
    },
    chatError: {
      generic: 'Something went wrong on our side while generating a reply. Please try again in a moment.',
      network: 'I couldn\'t reach the AI service — looks like a connection issue. Please check your network and try again.',
      rateLimit: 'The AI service is busy right now (rate limit reached). Please wait a minute and try again.',
      config: 'The AI service is temporarily unavailable due to a configuration issue. Our team has been notified.',
      timeout: 'The request took too long to process. Please try again, ideally with a shorter message.',
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
    coverageAnalysis: {
      noProject: 'Не найден контекст проекта. Запустите тест, чтобы я мог проанализировать покрытие.',
      success: (scoreBadge, score, coveredUrls, totalUrls, totalTestCases, staleTestCases, gapList, summary) =>
        `${scoreBadge} **Покрытие: ${score}/100**\n\n` +
        `**URL:** ${coveredUrls}/${totalUrls} покрыто | **Тест-кейсы:** ${totalTestCases} всего, ${staleTestCases} устаревших\n\n` +
        `---\n\n${summary}\n\n` +
        `---\n\n**Пробелы в покрытии:**\n\n${gapList}`,
      error: 'Не удалось проанализировать покрытие. Пожалуйста, попробуйте снова.',
    },
    chatError: {
      generic: 'Что-то пошло не так на нашей стороне при генерации ответа. Пожалуйста, попробуйте ещё раз через минуту.',
      network: 'Не удалось связаться с AI-сервисом — похоже на проблему с соединением. Проверьте сеть и попробуйте снова.',
      rateLimit: 'AI-сервис сейчас перегружен (превышен лимит запросов). Подождите минуту и попробуйте снова.',
      config: 'AI-сервис временно недоступен из-за проблемы с конфигурацией. Наша команда уже уведомлена.',
      timeout: 'Запрос обрабатывался слишком долго. Пожалуйста, попробуйте снова, желательно более коротким сообщением.',
    },
  },
  kk: {
    saveTest: {
      noTestId: 'Тестті сақтау үшін соңғы орындалған тесттің ID-і қажет. Алдымен тестті іске қосыңыз.',
      success: (name, id, paramsCount) =>
        `✅ Тест сәтті сақталды!\n\n**Атауы:** ${name}\n**ID:** ${id}\n**Параметрлер:** ${paramsCount}\n\nБұл тестті былай іске қоса аласыз: "run saved test ${id}"`,
      error: 'Тестті сақтау мүмкін болмады. Қайталап көріңіз.',
    },
    runRegression: {
      noId: 'Регрессиялық тестті іске қосу үшін сақталған тесттің ID-і қажет.',
      testStarted: (runId, testId) =>
        `✅ Сақталған тест іске қосылды!\n\n**Run ID:** ${runId}\n**Test ID:** ${testId}\n\nТест фонда орындалып жатыр. Аяқталғанда нәтижені аласыз.`,
      error: 'Регрессиялық тестті іске қосу мүмкін болмады. Қайталап көріңіз.',
    },
    analyzeFailure: {
      noTestId: 'Жақында сәтсіз аяқталған тест табылмады. Алдымен тестті іске қосыңыз немесе тест ID-ін көрсетіңіз.',
      success: (rootCause, category, severity, suggestions) =>
        `🔍 **Қате талдауы**\n\n**Себебі:** ${rootCause}\n**Санаты:** ${category}\n**Маңыздылығы:** ${severity}\n\n**Ұсыныстар:**\n${suggestions}`,
      error: 'Тест қатесін талдау мүмкін болмады. Қайталап көріңіз.',
    },
    testRecommendations: {
      noProject: 'Жоба контексті табылмады. Жобаңызды түсіну үшін алдымен тестті іске қосыңыз.',
      success: (formattedList) =>
        `📋 **Тестілеу ұсыныстары**\n\nКелесіні тестілеуді ұсынамын:\n\n${formattedList}`,
      error: 'Ұсыныстарды құру мүмкін болмады. Қайталап көріңіз.',
    },
    coverageAnalysis: {
      noProject: 'Жоба контексті табылмады. Қамтуды талдау үшін алдымен тестті іске қосыңыз.',
      success: (scoreBadge, score, coveredUrls, totalUrls, totalTestCases, staleTestCases, gapList, summary) =>
        `${scoreBadge} **Қамту: ${score}/100**\n\n` +
        `**URL:** ${coveredUrls}/${totalUrls} қамтылды | **Тест-кейстер:** ${totalTestCases} барлығы, ${staleTestCases} ескірген\n\n` +
        `---\n\n${summary}\n\n` +
        `---\n\n**Қамтудағы олқылықтар:**\n\n${gapList}`,
      error: 'Қамтуды талдау мүмкін болмады. Қайталап көріңіз.',
    },
    chatError: {
      generic: 'Жауап жасау кезінде біздің жағымызда бірдеңе дұрыс болмады. Сәлден соң қайталап көріңіз.',
      network: 'AI-қызметіне қосыла алмадым — байланыс мәселесі сияқты. Желіні тексеріп, қайталап көріңіз.',
      rateLimit: 'AI-қызметі қазір бос емес (сұраныс лимиті асып кетті). Бір минут күтіп, қайталап көріңіз.',
      config: 'AI-қызметі конфигурация мәселесіне байланысты уақытша қолжетімсіз. Командамыз хабардар етілді.',
      timeout: 'Сұраныс өңдеуге тым ұзақ уақыт алды. Қысқарақ хабарламамен қайталап көріңіз.',
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
        `📋 **Test Recommendations**\n\nHere's what I recommend testing next:\n\n${formattedList}`,
      error: 'Failed to generate test recommendations. Please try again.',
    },
    coverageAnalysis: {
      noProject: 'No project context found. Please run a test first so I can analyze coverage.',
      success: (scoreBadge, score, coveredUrls, totalUrls, totalTestCases, staleTestCases, gapList, summary) =>
        `${scoreBadge} **Coverage Score: ${score}/100**\n\n` +
        `**URLs:** ${coveredUrls}/${totalUrls} covered | **Test Cases:** ${totalTestCases} total, ${staleTestCases} stale\n\n` +
        `---\n\n${summary}\n\n` +
        `---\n\n**Gaps:**\n\n${gapList}`,
      error: 'Failed to analyze coverage. Please try again.',
    },
    chatError: {
      generic: 'Something went wrong on our side while generating a reply. Please try again in a moment.',
      network: 'I couldn\'t reach the AI service — looks like a connection issue. Please check your network and try again.',
      rateLimit: 'The AI service is busy right now (rate limit reached). Please wait a minute and try again.',
      config: 'The AI service is temporarily unavailable due to a configuration issue. Our team has been notified.',
      timeout: 'The request took too long to process. Please try again, ideally with a shorter message.',
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
  const validLangs: Language[] = ['en', 'ru', 'kk', 'neutral'];
  const lang = validLangs.includes(language as Language) ? (language as Language) : 'neutral';
  return messages[lang];
}
