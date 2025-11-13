# 📊 Feedback Analytics - Практическое руководство

Полное руководство по использованию системы аналитики фидбека для улучшения AI.

---

## 🎯 Обзор

Система аналитики помогает:
- ✅ Находить проблемные области в ответах AI
- ✅ Отслеживать тренды удовлетворенности
- ✅ Получать конкретные рекомендации по улучшению
- ✅ Сравнивать производительность по периодам
- ✅ Визуализировать данные для отчетов

---

## 📖 API Endpoints

### 1. GET `/api/v1/chat/feedback/insights`

Получить комплексную аналитику с рекомендациями.

**Parameters:**
- `days` (integer, default: 30) - период анализа
- `global` (boolean, default: false) - глобальная аналитика (все пользователи)

**Response:**

```json
{
  "success": true,
  "data": {
    "summary": {
      "overall_satisfaction": 82.5,
      "total_responses": 156,
      "feedback_rate": 12.3,
      "trend": "improving"
    },
    "problem_areas": [
      {
        "intent_type": "api_test",
        "issue": "Low satisfaction rate",
        "severity": "medium",
        "affected_messages": 15,
        "satisfaction_rate": 65.2
      }
    ],
    "top_performers": [
      {
        "intent_type": "general_chat",
        "satisfaction_rate": 91.5,
        "total_feedback": 45,
        "why_successful": "Excellent: Users consistently satisfied with general_chat responses"
      }
    ],
    "recommendations": [
      {
        "priority": "high",
        "area": "api_test responses",
        "action": "Improve response format. Add more context about test results.",
        "expected_improvement": "+20-30% satisfaction for this intent"
      }
    ],
    "time_series": [
      {
        "date": "2024-11-13",
        "likes": 25,
        "dislikes": 5,
        "satisfaction_rate": 83.3
      }
    ]
  }
}
```

---

### 2. GET `/api/v1/chat/feedback/compare`

Сравнить производительность между периодами.

**Parameters:**
- `current_days` (integer, default: 7) - текущий период
- `previous_days` (integer, default: 7) - предыдущий период
- `global` (boolean, default: false) - глобальное сравнение

**Response:**

```json
{
  "success": true,
  "data": {
    "current_period": {
      "total_feedback": 85,
      "likes": 70,
      "dislikes": 15,
      "satisfaction_rate": 82.35
    },
    "previous_period": {
      "total_feedback": 78,
      "likes": 58,
      "dislikes": 20,
      "satisfaction_rate": 74.36
    },
    "changes": {
      "satisfaction_rate_change": +7.99,
      "likes_change": +12,
      "dislikes_change": -5,
      "total_feedback_change": +7
    },
    "improved_intents": ["api_test", "general_chat"],
    "declined_intents": []
  }
}
```

---

## 💻 Примеры использования

### 1. Базовая аналитика (Dashboard)

```typescript
import { useState, useEffect } from 'react';

function FeedbackDashboard() {
  const [insights, setInsights] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchInsights();
  }, []);

  const fetchInsights = async () => {
    try {
      const response = await fetch('/api/v1/chat/feedback/insights?days=30', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      setInsights(data.data);
    } catch (error) {
      console.error('Failed to fetch insights:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading analytics...</div>;

  return (
    <div className="dashboard">
      <SummaryCards summary={insights.summary} />
      <ProblemAreas areas={insights.problem_areas} />
      <Recommendations recs={insights.recommendations} />
      <TimeSeriesChart data={insights.time_series} />
    </div>
  );
}
```

---

### 2. Summary Cards Component

```tsx
function SummaryCards({ summary }) {
  const getTrendIcon = (trend) => {
    if (trend === 'improving') return '📈';
    if (trend === 'declining') return '📉';
    return '➡️';
  };

  const getTrendColor = (trend) => {
    if (trend === 'improving') return 'text-green-600';
    if (trend === 'declining') return 'text-red-600';
    return 'text-gray-600';
  };

  return (
    <div className="grid grid-cols-4 gap-4">
      <Card>
        <h3>Satisfaction Rate</h3>
        <p className="text-3xl font-bold">
          {summary.overall_satisfaction.toFixed(1)}%
        </p>
        <span className={getTrendColor(summary.trend)}>
          {getTrendIcon(summary.trend)} {summary.trend}
        </span>
      </Card>

      <Card>
        <h3>Total Feedback</h3>
        <p className="text-3xl font-bold">{summary.total_responses}</p>
      </Card>

      <Card>
        <h3>Feedback Rate</h3>
        <p className="text-3xl font-bold">
          {summary.feedback_rate.toFixed(1)}%
        </p>
        <p className="text-sm text-gray-500">of messages rated</p>
      </Card>

      <Card>
        <h3>Status</h3>
        <p className="text-xl font-semibold">
          {summary.overall_satisfaction >= 80 ? '✅ Excellent' :
           summary.overall_satisfaction >= 70 ? '⚠️ Good' : '🔴 Needs Work'}
        </p>
      </Card>
    </div>
  );
}
```

---

### 3. Problem Areas с приоритетами

```tsx
function ProblemAreas({ areas }) {
  if (areas.length === 0) {
    return (
      <div className="bg-green-50 p-4 rounded">
        <p className="text-green-800">
          ✅ No significant issues detected. Keep up the good work!
        </p>
      </div>
    );
  }

  const getSeverityBadge = (severity) => {
    const styles = {
      high: 'bg-red-100 text-red-800 border-red-200',
      medium: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      low: 'bg-blue-100 text-blue-800 border-blue-200',
    };
    return styles[severity];
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">🔍 Problem Areas</h2>

      {areas.map((area, idx) => (
        <div
          key={idx}
          className="border rounded-lg p-4 hover:shadow-md transition"
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">{area.intent_type}</h3>
            <span className={`px-3 py-1 rounded-full text-xs font-medium border ${getSeverityBadge(area.severity)}`}>
              {area.severity.toUpperCase()} PRIORITY
            </span>
          </div>

          <p className="text-gray-700 mb-2">{area.issue}</p>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Affected Messages:</span>
              <span className="ml-2 font-medium">{area.affected_messages}</span>
            </div>
            <div>
              <span className="text-gray-500">Satisfaction:</span>
              <span className="ml-2 font-medium">
                {area.satisfaction_rate.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

### 4. Actionable Recommendations

```tsx
function Recommendations({ recs }) {
  const [expandedIdx, setExpandedIdx] = useState(null);

  const getPriorityColor = (priority) => {
    return {
      high: 'border-red-500 bg-red-50',
      medium: 'border-yellow-500 bg-yellow-50',
      low: 'border-blue-500 bg-blue-50',
    }[priority];
  };

  const handleImplement = async (rec) => {
    // Logic to mark as implemented or create task
    console.log('Implementing:', rec);
  };

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-bold">💡 Recommendations</h2>

      {recs.map((rec, idx) => (
        <div
          key={idx}
          className={`border-l-4 rounded-lg p-4 ${getPriorityColor(rec.priority)}`}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold">{rec.area}</span>
                <span className="text-xs px-2 py-1 rounded bg-white">
                  {rec.priority}
                </span>
              </div>

              <p className="text-gray-700 mb-2">{rec.action}</p>

              {expandedIdx === idx && (
                <div className="mt-3 p-3 bg-white rounded">
                  <p className="text-sm">
                    <strong>Expected Impact:</strong> {rec.expected_improvement}
                  </p>
                </div>
              )}
            </div>

            <button
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              className="ml-4 text-gray-500 hover:text-gray-700"
            >
              {expandedIdx === idx ? '▼' : '▶'}
            </button>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={() => handleImplement(rec)}
              className="text-sm px-3 py-1 bg-white rounded border hover:bg-gray-50"
            >
              Mark as Implemented
            </button>
            <button
              className="text-sm px-3 py-1 bg-white rounded border hover:bg-gray-50"
            >
              Create Task
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

### 5. Time Series Chart (с Recharts)

```tsx
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

function TimeSeriesChart({ data }) {
  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h2 className="text-xl font-bold mb-4">📈 Satisfaction Trend</h2>

      <LineChart width={800} height={400} data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          tickFormatter={(date) => new Date(date).toLocaleDateString('ru-RU', {
            month: 'short',
            day: 'numeric'
          })}
        />
        <YAxis
          label={{ value: 'Satisfaction %', angle: -90, position: 'insideLeft' }}
          domain={[0, 100]}
        />
        <Tooltip
          formatter={(value, name) => {
            if (name === 'satisfaction_rate') return [`${value.toFixed(1)}%`, 'Satisfaction'];
            return [value, name];
          }}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="satisfaction_rate"
          stroke="#10b981"
          strokeWidth={3}
          name="Satisfaction Rate"
        />
        <Line
          type="monotone"
          dataKey="likes"
          stroke="#3b82f6"
          strokeWidth={2}
          name="Likes"
        />
        <Line
          type="monotone"
          dataKey="dislikes"
          stroke="#ef4444"
          strokeWidth={2}
          name="Dislikes"
        />
      </LineChart>
    </div>
  );
}
```

---

### 6. Period Comparison

```tsx
function ComparisonView() {
  const [comparison, setComparison] = useState(null);
  const [currentPeriod, setCurrentPeriod] = useState(7);
  const [previousPeriod, setPreviousPeriod] = useState(7);

  const fetchComparison = async () => {
    const response = await fetch(
      `/api/v1/chat/feedback/compare?current_days=${currentPeriod}&previous_days=${previousPeriod}`,
      { headers: { Authorization: `Bearer ${token}` }}
    );
    const data = await response.json();
    setComparison(data.data);
  };

  useEffect(() => {
    fetchComparison();
  }, [currentPeriod, previousPeriod]);

  if (!comparison) return <div>Loading...</div>;

  const { changes, improved_intents, declined_intents } = comparison;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">📊 Performance Comparison</h2>

      {/* Period Selector */}
      <div className="flex gap-4">
        <div>
          <label>Current Period (days):</label>
          <select value={currentPeriod} onChange={(e) => setCurrentPeriod(+e.target.value)}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </div>
        <div>
          <label>Compare with (days):</label>
          <select value={previousPeriod} onChange={(e) => setPreviousPeriod(+e.target.value)}>
            <option value={7}>Previous 7 days</option>
            <option value={14}>Previous 14 days</option>
            <option value={30}>Previous 30 days</option>
          </select>
        </div>
      </div>

      {/* Changes Summary */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard
          title="Satisfaction Rate"
          change={changes.satisfaction_rate_change}
          suffix="%"
        />
        <MetricCard
          title="Total Feedback"
          change={changes.total_feedback_change}
        />
        <MetricCard
          title="Likes"
          change={changes.likes_change}
          positive
        />
        <MetricCard
          title="Dislikes"
          change={changes.dislikes_change}
          inverted // lower is better
        />
      </div>

      {/* Improved/Declined Intents */}
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h3 className="font-semibold text-green-800 mb-2">
            ✅ Improved Areas ({improved_intents.length})
          </h3>
          {improved_intents.length > 0 ? (
            <ul className="space-y-1">
              {improved_intents.map(intent => (
                <li key={intent} className="text-green-700">
                  • {intent}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-gray-500">No significant improvements</p>
          )}
        </div>

        <div>
          <h3 className="font-semibold text-red-800 mb-2">
            ⚠️ Declined Areas ({declined_intents.length})
          </h3>
          {declined_intents.length > 0 ? (
            <ul className="space-y-1">
              {declined_intents.map(intent => (
                <li key={intent} className="text-red-700">
                  • {intent}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-gray-500">No declines detected</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ title, change, suffix = '', inverted = false }) {
  const isPositive = inverted ? change < 0 : change > 0;
  const color = isPositive ? 'text-green-600' : change < 0 ? 'text-red-600' : 'text-gray-600';
  const icon = isPositive ? '↗' : change < 0 ? '↘' : '→';

  return (
    <div className="bg-white p-4 rounded-lg border">
      <p className="text-sm text-gray-600 mb-1">{title}</p>
      <p className={`text-2xl font-bold ${color}`}>
        {change > 0 ? '+' : ''}{change}{suffix} {icon}
      </p>
    </div>
  );
}
```

---

## 🔄 Автоматический мониторинг

### Настройка ежедневных отчетов

```typescript
// server/cron/feedback-report.ts
import cron from 'node-cron';
import { FeedbackAnalyticsService } from '@/services/feedback-analytics.service';

// Каждый день в 9:00
cron.schedule('0 9 * * *', async () => {
  try {
    const insights = await FeedbackAnalyticsService.getInsights(undefined, 1); // последний день

    // Если есть проблемы высокого приоритета - уведомить
    const criticalIssues = insights.problem_areas.filter(p => p.severity === 'high');

    if (criticalIssues.length > 0) {
      await sendSlackNotification({
        text: `🚨 Critical AI quality issues detected!`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${criticalIssues.length} high-priority issues found*`
            }
          },
          ...criticalIssues.map(issue => ({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `• ${issue.intent_type}: ${issue.issue} (${issue.satisfaction_rate}% satisfaction)`
            }
          }))
        ]
      });
    }

    // Еженедельный полный отчет
    if (new Date().getDay() === 1) { // Понедельник
      const weeklyComparison = await FeedbackAnalyticsService.comparePerformance(
        undefined,
        7,
        7
      );

      await sendWeeklyReport(weeklyComparison);
    }
  } catch (error) {
    console.error('Failed to generate feedback report:', error);
  }
});
```

---

## 📈 Best Practices

### 1. Регулярный мониторинг
```typescript
// Проверять insights минимум раз в неделю
const insights = await fetch('/api/v1/chat/feedback/insights?days=7');

// Сравнивать с предыдущей неделей
const comparison = await fetch('/api/v1/chat/feedback/compare?current_days=7&previous_days=7');
```

### 2. Действовать по рекомендациям
```typescript
// Фильтровать high-priority рекомендации
const criticalRecs = insights.recommendations.filter(r => r.priority === 'high');

// Создавать задачи для каждой
criticalRecs.forEach(rec => {
  createJiraTask({
    title: `Fix AI Quality: ${rec.area}`,
    description: rec.action,
    priority: 'High'
  });
});
```

### 3. Отслеживать эффект изменений
```typescript
// После внедрения улучшений
const before = getStatsForDate('2024-11-01', '2024-11-07');
const after = getStatsForDate('2024-11-08', '2024-11-14');

console.log(`Improvement: ${after.satisfaction_rate - before.satisfaction_rate}%`);
```

---

## 🎯 Метрики успеха

### Целевые значения:
- **Overall Satisfaction**: >80%
- **API Test Satisfaction**: >85%
- **General Chat Satisfaction**: >75%
- **Feedback Rate**: 10-15% (пользователи оставляют фидбек)
- **Trend**: "improving" или "stable"

### Красные флаги:
- ⚠️ Satisfaction <70% для любого intent
- 🚨 Trend = "declining" более 3 дней подряд
- 🔴 High-severity problem areas

---

## 📚 См. также

- [Feedback API Examples](./feedback-api-examples.md) - базовое использование like/dislike
- [Chat API](./README.md) - документация chat API
- [Websocket Events](../websocket-api.md) - real-time уведомления

---

**Last updated:** 2024-11-13
