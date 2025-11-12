-- ============================================================================
-- INTELLIGENT TEST SCENARIOS STORAGE
-- ============================================================================
-- Специализированные таблицы для хранения динамических тест-сценариев
-- от intelligent testing с полной детализацией для визуализации
-- ============================================================================

-- 1. INTELLIGENT TEST SESSIONS
-- Основная таблица для intelligent test сессий
CREATE TABLE IF NOT EXISTS intelligent_test_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Связи
  test_id UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Конфигурация теста
  goal TEXT NOT NULL, -- "Test login flow", "Explore e-commerce"
  start_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'balanced' CHECK (mode IN ('fast', 'balanced', 'thorough')),

  -- Результаты
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  success BOOLEAN,

  -- Метрики
  pages_visited INTEGER DEFAULT 0,
  actions_taken INTEGER DEFAULT 0,
  duration_ms INTEGER,

  -- Стоимость
  cost_usd DECIMAL(10, 4),
  tokens_used INTEGER,

  -- AI Summary
  summary TEXT,

  -- Metadata
  browser TEXT,
  viewport JSONB,
  credentials_used BOOLEAN DEFAULT false,

  -- Timestamps
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,

  -- Индексы
  CONSTRAINT fk_test FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 2. PAGE VISITS
-- Каждая посещенная страница во время теста
CREATE TABLE IF NOT EXISTS intelligent_page_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Связи
  session_id UUID NOT NULL REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE,

  -- Информация о странице
  url TEXT NOT NULL,
  page_type TEXT NOT NULL, -- home, product, login, checkout, etc.
  visit_order INTEGER NOT NULL, -- Порядок посещения (1, 2, 3...)

  -- Анализ страницы
  vision_analysis JSONB, -- Результат GPT-4 Vision анализа
  dom_analysis JSONB, -- DOM структура (формы, кнопки, ссылки)

  -- Скриншот
  screenshot TEXT, -- Base64 или URL
  screenshot_url TEXT, -- S3/CDN URL если храним отдельно

  -- Метаданные
  title TEXT,
  meta_description TEXT,

  -- Результат
  success BOOLEAN DEFAULT true,
  errors JSONB,

  -- Временные метки
  visited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  duration_ms INTEGER, -- Время на странице

  CONSTRAINT fk_session FOREIGN KEY (session_id) REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE
);

-- 3. TEST ACTIONS
-- Каждое действие выполненное AI на странице
CREATE TABLE IF NOT EXISTS intelligent_test_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Связи
  page_visit_id UUID NOT NULL REFERENCES intelligent_page_visits(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE,

  -- Информация о действии
  action_order INTEGER NOT NULL, -- Порядок действия на странице (1, 2, 3...)
  action_type TEXT NOT NULL
    CHECK (action_type IN ('goto', 'click', 'fill', 'select', 'wait', 'scroll', 'press', 'hover')),

  -- Детали действия
  selector TEXT, -- CSS селектор элемента
  value TEXT, -- Значение (для fill, select)
  description TEXT NOT NULL, -- "Click 'Add to Cart' button"
  expected_result TEXT, -- "Product should be added to cart"

  -- Конфигурация
  timeout_ms INTEGER,
  optional BOOLEAN DEFAULT false,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,

  -- Результат выполнения
  success BOOLEAN NOT NULL,
  error_message TEXT,

  -- URL изменения
  url_changed BOOLEAN DEFAULT false,
  url_before TEXT,
  url_after TEXT,

  -- Скриншоты до/после
  screenshot_before TEXT,
  screenshot_after TEXT,

  -- AI reasoning
  ai_reasoning TEXT, -- Почему AI выбрал это действие
  confidence DECIMAL(3, 2), -- 0.00 - 1.00

  -- Временные метки
  executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  duration_ms INTEGER,

  CONSTRAINT fk_page_visit FOREIGN KEY (page_visit_id) REFERENCES intelligent_page_visits(id) ON DELETE CASCADE,
  CONSTRAINT fk_session FOREIGN KEY (session_id) REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE
);

-- 4. TEST VALIDATIONS
-- Результаты валидации для каждого действия
CREATE TABLE IF NOT EXISTS intelligent_test_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Связи
  action_id UUID NOT NULL REFERENCES intelligent_test_actions(id) ON DELETE CASCADE,

  -- Тип валидации
  validation_type TEXT NOT NULL
    CHECK (validation_type IN ('element_visible', 'element_exists', 'url_changed', 'text_present', 'custom')),

  -- Результат
  passed BOOLEAN NOT NULL,
  message TEXT,

  -- Детали
  expected_value TEXT,
  actual_value TEXT,

  -- Timestamp
  validated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT fk_action FOREIGN KEY (action_id) REFERENCES intelligent_test_actions(id) ON DELETE CASCADE
);

-- 5. AI DECISIONS
-- Записи решений AI во время теста (для анализа и дебага)
CREATE TABLE IF NOT EXISTS intelligent_ai_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Связи
  session_id UUID NOT NULL REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE,
  page_visit_id UUID REFERENCES intelligent_page_visits(id) ON DELETE CASCADE,

  -- Тип решения
  decision_type TEXT NOT NULL
    CHECK (decision_type IN ('next_page', 'action_generation', 'stop_testing', 'cycle_detected', 'error_recovery')),

  -- Контекст решения
  context JSONB, -- Текущее состояние, история, ошибки

  -- Решение
  decision JSONB, -- Что AI решил делать
  reasoning TEXT, -- Объяснение решения
  confidence DECIMAL(3, 2),

  -- Альтернативы
  alternatives JSONB, -- Другие варианты которые AI рассматривал

  -- Модель
  model_used TEXT, -- gpt-4o, gpt-4o-mini
  tokens_used INTEGER,

  -- Timestamp
  decided_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT fk_session FOREIGN KEY (session_id) REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE
);

-- 6. TEST FINDINGS
-- Баги, проблемы и находки обнаруженные во время теста
CREATE TABLE IF NOT EXISTS intelligent_test_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Связи
  session_id UUID NOT NULL REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE,
  page_visit_id UUID REFERENCES intelligent_page_visits(id) ON DELETE SET NULL,
  action_id UUID REFERENCES intelligent_test_actions(id) ON DELETE SET NULL,

  -- Тип находки
  finding_type TEXT NOT NULL
    CHECK (finding_type IN ('bug', 'warning', 'improvement', 'security', 'performance', 'ux_issue')),

  -- Серьезность
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),

  -- Детали
  title TEXT NOT NULL,
  description TEXT NOT NULL,

  -- Воспроизведение
  reproduction_steps JSONB, -- Массив шагов для воспроизведения

  -- Доказательства
  screenshot TEXT,
  video_url TEXT,

  -- AI анализ
  ai_confidence DECIMAL(3, 2),
  ai_suggestions TEXT,

  -- Статус
  status TEXT DEFAULT 'new'
    CHECK (status IN ('new', 'confirmed', 'false_positive', 'fixed', 'wont_fix')),

  -- Timestamps
  found_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT fk_session FOREIGN KEY (session_id) REFERENCES intelligent_test_sessions(id) ON DELETE CASCADE
);

-- ============================================================================
-- INDEXES для производительности
-- ============================================================================

-- Intelligent Test Sessions
CREATE INDEX IF NOT EXISTS idx_intelligent_sessions_test
  ON intelligent_test_sessions(test_id);
CREATE INDEX IF NOT EXISTS idx_intelligent_sessions_user_project
  ON intelligent_test_sessions(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_intelligent_sessions_status
  ON intelligent_test_sessions(status, completed_at DESC);

-- Page Visits
CREATE INDEX IF NOT EXISTS idx_page_visits_session
  ON intelligent_page_visits(session_id, visit_order);
CREATE INDEX IF NOT EXISTS idx_page_visits_url
  ON intelligent_page_visits(session_id, url);
CREATE INDEX IF NOT EXISTS idx_page_visits_type
  ON intelligent_page_visits(session_id, page_type);

-- Test Actions
CREATE INDEX IF NOT EXISTS idx_actions_page_visit
  ON intelligent_test_actions(page_visit_id, action_order);
CREATE INDEX IF NOT EXISTS idx_actions_session
  ON intelligent_test_actions(session_id, executed_at);
CREATE INDEX IF NOT EXISTS idx_actions_type
  ON intelligent_test_actions(action_type, success);

-- Test Validations
CREATE INDEX IF NOT EXISTS idx_validations_action
  ON intelligent_test_validations(action_id, passed);

-- AI Decisions
CREATE INDEX IF NOT EXISTS idx_decisions_session
  ON intelligent_ai_decisions(session_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_decisions_type
  ON intelligent_ai_decisions(decision_type);

-- Test Findings
CREATE INDEX IF NOT EXISTS idx_findings_session
  ON intelligent_test_findings(session_id, severity);
CREATE INDEX IF NOT EXISTS idx_findings_type
  ON intelligent_test_findings(finding_type, status);
CREATE INDEX IF NOT EXISTS idx_findings_severity
  ON intelligent_test_findings(severity, found_at DESC);

-- ============================================================================
-- VIEWS для удобного доступа
-- ============================================================================

-- Полная информация о тест-сессии
CREATE OR REPLACE VIEW intelligent_test_session_full AS
SELECT
  s.*,
  t.url as test_url,
  t.status as test_status,
  p.name as project_name,
  COUNT(DISTINCT pv.id) as total_pages,
  COUNT(DISTINCT a.id) as total_actions,
  COUNT(DISTINCT f.id) as total_findings,
  COUNT(DISTINCT CASE WHEN f.severity IN ('critical', 'high') THEN f.id END) as critical_findings
FROM intelligent_test_sessions s
LEFT JOIN tests t ON s.test_id = t.id
LEFT JOIN projects p ON s.project_id = p.id
LEFT JOIN intelligent_page_visits pv ON s.id = pv.session_id
LEFT JOIN intelligent_test_actions a ON s.id = a.session_id
LEFT JOIN intelligent_test_findings f ON s.id = f.session_id
GROUP BY s.id, t.url, t.status, p.name;

-- Подробная информация о странице с действиями
CREATE OR REPLACE VIEW intelligent_page_with_actions AS
SELECT
  pv.*,
  COALESCE(json_agg(
    json_build_object(
      'id', a.id,
      'order', a.action_order,
      'type', a.action_type,
      'description', a.description,
      'success', a.success,
      'duration_ms', a.duration_ms,
      'error_message', a.error_message,
      'url_changed', a.url_changed,
      'url_before', a.url_before,
      'url_after', a.url_after
    ) ORDER BY a.action_order
  ) FILTER (WHERE a.id IS NOT NULL), '[]'::json) as actions
FROM intelligent_page_visits pv
LEFT JOIN intelligent_test_actions a ON pv.id = a.page_visit_id
GROUP BY pv.id;

-- Тест-кейсы для визуализации (flow diagram)
CREATE OR REPLACE VIEW intelligent_test_flow AS
SELECT
  s.id as session_id,
  s.goal,
  pv.visit_order,
  pv.url,
  pv.page_type,
  COUNT(a.id) as actions_count,
  COUNT(CASE WHEN a.success = true THEN 1 END) as successful_actions,
  pv.success as page_success
FROM intelligent_test_sessions s
JOIN intelligent_page_visits pv ON s.id = pv.session_id
LEFT JOIN intelligent_test_actions a ON pv.id = a.page_visit_id
GROUP BY s.id, s.goal, pv.id, pv.visit_order, pv.url, pv.page_type, pv.success
ORDER BY s.id, pv.visit_order;

-- ============================================================================
-- COMMENTS для документации
-- ============================================================================

COMMENT ON TABLE intelligent_test_sessions IS 'Основная таблица для intelligent test сессий с метриками и результатами';
COMMENT ON TABLE intelligent_page_visits IS 'Каждая посещенная страница с анализом и скриншотами';
COMMENT ON TABLE intelligent_test_actions IS 'Детальная история всех действий выполненных AI на каждой странице';
COMMENT ON TABLE intelligent_test_validations IS 'Результаты валидации для каждого действия';
COMMENT ON TABLE intelligent_ai_decisions IS 'Записи решений AI для анализа и улучшения алгоритмов';
COMMENT ON TABLE intelligent_test_findings IS 'Баги и проблемы обнаруженные во время тестирования';

-- ============================================================================
-- SUCCESS
-- ============================================================================
