# Frontend Video Streaming Guide

## 📹 Real-time Video Streaming Implementation

Детальная инструкция для реализации real-time видео стриминга на фронтенде.

---

## 1. WebSocket Events

### События от сервера

```typescript
// Типы событий от сервера
interface ServerToClientEvents {
  // Стрим начался
  "test:video:started": (data: TestVideoStartedPayload) => void;

  // Кадр видео (основное событие)
  "test:video:frame": (data: TestVideoFramePayload) => void;

  // Статистика стрима
  "test:video:stats": (data: TestVideoStatsPayload) => void;

  // Стрим на паузе (backpressure)
  "test:video:paused": (data: TestVideoPausedPayload) => void;

  // Стрим возобновлен
  "test:video:resumed": (data: TestVideoResumedPayload) => void;

  // Стрим остановлен
  "test:video:stopped": (data: TestVideoStoppedPayload) => void;

  // Стрим недоступен
  "test:video:unavailable": (data: TestVideoUnavailablePayload) => void;
}
```

---

## 2. Payload Types

### TestVideoFramePayload (основной)

```typescript
interface TestVideoFramePayload {
  testId: string;
  browser: string;
  sessionId: string;
  seq: number; // Номер кадра (монотонно растет)
  format: "jpeg";
  data: string; // Base64 JPEG без префикса
  width: number;
  height: number;
  timestamp: string; // ISO timestamp
  elapsedTime: number; // Миллисекунды от начала теста (для слайдера!)
  isCatchup?: boolean; // true если это кадр из буфера (late join)
}
```

### TestVideoStartedPayload

```typescript
interface TestVideoStartedPayload {
  testId: string;
  sessionId: string;
  url: string;
  width: number;
  height: number;
  fps: number; // Ожидаемый FPS (12)
  timestamp: string;
}
```

### TestVideoStatsPayload

```typescript
interface TestVideoStatsPayload {
  testId: string;
  sessionId: string;
  currentFPS: number;
  framesEmitted: number;
  framesDropped: number;
  avgLatency: number;
  quality: "high" | "medium" | "low";
  timestamp: string;
}
```

### TestVideoPausedPayload

```typescript
interface TestVideoPausedPayload {
  testId: string;
  sessionId: string;
  reason: "backpressure" | "redis_timeout" | "circuit_breaker";
  timestamp: string;
}
```

### TestVideoResumedPayload

```typescript
interface TestVideoResumedPayload {
  testId: string;
  sessionId: string;
  timestamp: string;
}
```

### TestVideoStoppedPayload

```typescript
interface TestVideoStoppedPayload {
  testId: string;
  sessionId: string;
  reason: "completed" | "cancelled" | "error" | "timeout";
  timestamp: string;
}
```

### TestVideoUnavailablePayload

```typescript
interface TestVideoUnavailablePayload {
  testId: string;
  reason: string;
  timestamp: string;
}
```

---

## 3. React Hook: useVideoStream

### Полная реализация

```typescript
// hooks/useVideoStream.ts
import { useEffect, useRef, useState, useCallback } from "react";
import { useSocket } from "./useSocket"; // ваш socket hook

interface VideoFrame {
  seq: number;
  data: string; // base64
  elapsedTime: number; // ms from test start
  timestamp: string;
}

interface VideoStreamState {
  status:
    | "idle"
    | "connecting"
    | "streaming"
    | "paused"
    | "stopped"
    | "unavailable";
  currentFrame: VideoFrame | null;
  bufferedFrames: VideoFrame[];
  stats: {
    fps: number;
    quality: "high" | "medium" | "low";
    framesReceived: number;
    framesDropped: number;
  };
  duration: number; // Current elapsed time in ms
  maxDuration: number; // Max elapsed time seen
  error: string | null;
  isLive: boolean; // true = показываем live, false = смотрим буфер
}

const MAX_BUFFER_SIZE = 300; // ~25 секунд при 12 fps
const FRAME_CLEANUP_INTERVAL = 60000; // Очистка старых кадров каждую минуту

export function useVideoStream(testId: string | null) {
  const socket = useSocket();
  const [state, setState] = useState<VideoStreamState>({
    status: "idle",
    currentFrame: null,
    bufferedFrames: [],
    stats: { fps: 0, quality: "high", framesReceived: 0, framesDropped: 0 },
    duration: 0,
    maxDuration: 0,
    error: null,
    isLive: true,
  });

  const bufferRef = useRef<VideoFrame[]>([]);
  const sliderPositionRef = useRef<number | null>(null); // null = live mode

  // Подписка на тест
  useEffect(() => {
    if (!testId || !socket) return;

    // Подписываемся на комнату теста
    socket.emit("subscribe:test", { testId });

    // Обработчики событий
    const handleStarted = (data: TestVideoStartedPayload) => {
      if (data.testId !== testId) return;
      setState((prev) => ({
        ...prev,
        status: "streaming",
        error: null,
        isLive: true,
      }));
    };

    const handleFrame = (data: TestVideoFramePayload) => {
      if (data.testId !== testId) return;

      const frame: VideoFrame = {
        seq: data.seq,
        data: data.data,
        elapsedTime: data.elapsedTime,
        timestamp: data.timestamp,
      };

      // Добавляем в буфер
      bufferRef.current.push(frame);

      // Ограничиваем размер буфера
      if (bufferRef.current.length > MAX_BUFFER_SIZE) {
        bufferRef.current = bufferRef.current.slice(-MAX_BUFFER_SIZE);
      }

      setState((prev) => {
        const newState = {
          ...prev,
          status: "streaming" as const,
          bufferedFrames: bufferRef.current,
          maxDuration: Math.max(prev.maxDuration, data.elapsedTime),
          stats: {
            ...prev.stats,
            framesReceived: prev.stats.framesReceived + 1,
          },
        };

        // Если в live режиме - показываем последний кадр
        if (prev.isLive || sliderPositionRef.current === null) {
          newState.currentFrame = frame;
          newState.duration = data.elapsedTime;
        }

        return newState;
      });
    };

    const handleStats = (data: TestVideoStatsPayload) => {
      if (data.testId !== testId) return;
      setState((prev) => ({
        ...prev,
        stats: {
          fps: data.currentFPS,
          quality: data.quality,
          framesReceived: data.framesEmitted,
          framesDropped: data.framesDropped,
        },
      }));
    };

    const handlePaused = (data: TestVideoPausedPayload) => {
      if (data.testId !== testId) return;
      setState((prev) => ({
        ...prev,
        status: "paused",
      }));
    };

    const handleResumed = (data: TestVideoResumedPayload) => {
      if (data.testId !== testId) return;
      setState((prev) => ({
        ...prev,
        status: "streaming",
      }));
    };

    const handleStopped = (data: TestVideoStoppedPayload) => {
      if (data.testId !== testId) return;
      setState((prev) => ({
        ...prev,
        status: "stopped",
        isLive: false, // Переключаемся в режим просмотра буфера
      }));
    };

    const handleUnavailable = (data: TestVideoUnavailablePayload) => {
      if (data.testId !== testId) return;
      setState((prev) => ({
        ...prev,
        status: "unavailable",
        error: data.reason,
      }));
    };

    // Подписываемся на события
    socket.on("test:video:started", handleStarted);
    socket.on("test:video:frame", handleFrame);
    socket.on("test:video:stats", handleStats);
    socket.on("test:video:paused", handlePaused);
    socket.on("test:video:resumed", handleResumed);
    socket.on("test:video:stopped", handleStopped);
    socket.on("test:video:unavailable", handleUnavailable);

    return () => {
      socket.emit("unsubscribe:test", { testId });
      socket.off("test:video:started", handleStarted);
      socket.off("test:video:frame", handleFrame);
      socket.off("test:video:stats", handleStats);
      socket.off("test:video:paused", handlePaused);
      socket.off("test:video:resumed", handleResumed);
      socket.off("test:video:stopped", handleStopped);
      socket.off("test:video:unavailable", handleUnavailable);

      // Очищаем буфер
      bufferRef.current = [];
    };
  }, [testId, socket]);

  // Seek к определенному времени (для слайдера)
  const seekTo = useCallback((elapsedTimeMs: number) => {
    const frames = bufferRef.current;
    if (frames.length === 0) return;

    // Ищем ближайший кадр
    let closestFrame = frames[0];
    let minDiff = Math.abs(frames[0].elapsedTime - elapsedTimeMs);

    for (const frame of frames) {
      const diff = Math.abs(frame.elapsedTime - elapsedTimeMs);
      if (diff < minDiff) {
        minDiff = diff;
        closestFrame = frame;
      }
    }

    sliderPositionRef.current = elapsedTimeMs;

    setState((prev) => ({
      ...prev,
      currentFrame: closestFrame,
      duration: closestFrame.elapsedTime,
      isLive: false,
    }));
  }, []);

  // Переключение в live режим
  const goLive = useCallback(() => {
    sliderPositionRef.current = null;
    const frames = bufferRef.current;
    const lastFrame = frames[frames.length - 1];

    setState((prev) => ({
      ...prev,
      currentFrame: lastFrame || prev.currentFrame,
      duration: lastFrame?.elapsedTime || prev.duration,
      isLive: true,
    }));
  }, []);

  return {
    ...state,
    seekTo,
    goLive,
    hasBuffer: bufferRef.current.length > 0,
    bufferStartTime: bufferRef.current[0]?.elapsedTime || 0,
    bufferEndTime:
      bufferRef.current[bufferRef.current.length - 1]?.elapsedTime || 0,
  };
}
```

---

## 4. VideoPlayer Component

### Полная реализация

```tsx
// components/VideoPlayer.tsx
import React, { useRef, useEffect } from "react";
import { useVideoStream } from "../hooks/useVideoStream";

interface VideoPlayerProps {
  testId: string;
  className?: string;
}

export function VideoPlayer({ testId, className }: VideoPlayerProps) {
  const {
    status,
    currentFrame,
    stats,
    duration,
    maxDuration,
    error,
    isLive,
    seekTo,
    goLive,
    hasBuffer,
    bufferStartTime,
    bufferEndTime,
  } = useVideoStream(testId);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Рендерим кадр на canvas
  useEffect(() => {
    if (!currentFrame || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Создаем image если еще не создан
    if (!imgRef.current) {
      imgRef.current = new Image();
    }

    const img = imgRef.current;
    img.onload = () => {
      // Устанавливаем размеры canvas под размер кадра
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      ctx.drawImage(img, 0, 0);
    };

    // Загружаем base64 JPEG
    img.src = `data:image/jpeg;base64,${currentFrame.data}`;
  }, [currentFrame]);

  // Форматирование времени
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  // Обработка слайдера
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    seekTo(value);
  };

  return (
    <div className={`video-player ${className || ""}`}>
      {/* Статус бар */}
      <div className="video-status-bar">
        {status === "streaming" && (
          <span className="status-indicator live">
            <span className="pulse" /> LIVE
          </span>
        )}
        {status === "paused" && (
          <span className="status-indicator paused">⏸️ Buffering...</span>
        )}
        {status === "stopped" && (
          <span className="status-indicator stopped">⏹️ Completed</span>
        )}
        {status === "unavailable" && (
          <span className="status-indicator unavailable">❌ {error}</span>
        )}

        {/* Качество */}
        {stats.quality && (
          <span className={`quality-badge quality-${stats.quality}`}>
            {stats.quality.toUpperCase()} • {stats.fps} FPS
          </span>
        )}
      </div>

      {/* Canvas для видео */}
      <div className="video-container">
        {status === "idle" && (
          <div className="video-placeholder">
            <span>Waiting for video stream...</span>
          </div>
        )}

        {status === "unavailable" && (
          <div className="video-error">
            <span>⚠️ Video unavailable</span>
            <p>{error}</p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="video-canvas"
          style={{
            display: currentFrame ? "block" : "none",
            maxWidth: "100%",
            height: "auto",
          }}
        />
      </div>

      {/* Контролы */}
      <div className="video-controls">
        {/* Таймлайн */}
        <div className="timeline">
          <span className="time-current">{formatTime(duration)}</span>

          <input
            type="range"
            className="timeline-slider"
            min={bufferStartTime}
            max={maxDuration}
            value={duration}
            onChange={handleSliderChange}
            disabled={!hasBuffer}
          />

          <span className="time-total">{formatTime(maxDuration)}</span>
        </div>

        {/* Кнопки */}
        <div className="control-buttons">
          {/* Go Live кнопка */}
          {!isLive && status === "streaming" && (
            <button className="btn-go-live" onClick={goLive}>
              🔴 Go Live
            </button>
          )}

          {/* Индикатор буфера */}
          {hasBuffer && (
            <span className="buffer-info">
              Buffer: {formatTime(bufferEndTime - bufferStartTime)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

---

## 5. CSS Styles

### Полные стили

```css
/* styles/video-player.css */

.video-player {
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

/* Статус бар */
.video-status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.3);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
}

.status-indicator.live {
  color: #ff4757;
}

.status-indicator .pulse {
  width: 8px;
  height: 8px;
  background: #ff4757;
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(1.2);
  }
}

.status-indicator.paused {
  color: #ffa502;
}

.status-indicator.stopped {
  color: #7bed9f;
}

.status-indicator.unavailable {
  color: #ff6b6b;
}

.quality-badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.quality-badge.quality-high {
  background: rgba(46, 213, 115, 0.2);
  color: #2ed573;
}

.quality-badge.quality-medium {
  background: rgba(255, 165, 2, 0.2);
  color: #ffa502;
}

.quality-badge.quality-low {
  background: rgba(255, 71, 87, 0.2);
  color: #ff4757;
}

/* Контейнер видео */
.video-container {
  position: relative;
  background: #0f0f1a;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.video-placeholder,
.video-error {
  text-align: center;
  color: #666;
  padding: 40px;
}

.video-error {
  color: #ff6b6b;
}

.video-canvas {
  display: block;
  max-width: 100%;
  height: auto;
}

/* Контролы */
.video-controls {
  padding: 12px 16px;
  background: rgba(0, 0, 0, 0.4);
}

.timeline {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.time-current,
.time-total {
  font-size: 12px;
  color: #aaa;
  font-variant-numeric: tabular-nums;
  min-width: 40px;
}

.timeline-slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  background: #333;
  border-radius: 2px;
  cursor: pointer;
}

.timeline-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  background: #5352ed;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.1s;
}

.timeline-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.timeline-slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.control-buttons {
  display: flex;
  align-items: center;
  gap: 12px;
}

.btn-go-live {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(255, 71, 87, 0.2);
  color: #ff4757;
  border: 1px solid #ff4757;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-go-live:hover {
  background: rgba(255, 71, 87, 0.3);
}

.buffer-info {
  font-size: 11px;
  color: #666;
}
```

---

## 6. Два режима отображения

### TestVideoSection Component

```tsx
// components/TestVideoSection.tsx
import React, { useState } from "react";
import { VideoPlayer } from "./VideoPlayer";

interface TestVideoSectionProps {
  testId: string;
  testStatus: "running" | "completed" | "failed" | "cancelled";
  recordedVideoUrl?: string; // URL записанного видео после завершения
}

export function TestVideoSection({
  testId,
  testStatus,
  recordedVideoUrl,
}: TestVideoSectionProps) {
  const [viewMode, setViewMode] = useState<"live" | "recorded">("live");

  // Если тест завершен и есть записанное видео - показываем выбор
  const showModeToggle = testStatus !== "running" && recordedVideoUrl;

  return (
    <div className="test-video-section">
      {/* Переключатель режимов */}
      {showModeToggle && (
        <div className="video-mode-toggle">
          <button
            className={`mode-btn ${viewMode === "live" ? "active" : ""}`}
            onClick={() => setViewMode("live")}
          >
            📺 Stream Replay
          </button>
          <button
            className={`mode-btn ${viewMode === "recorded" ? "active" : ""}`}
            onClick={() => setViewMode("recorded")}
          >
            🎬 Full Recording
          </button>
        </div>
      )}

      {/* Live/Buffered Stream */}
      {viewMode === "live" && <VideoPlayer testId={testId} />}

      {/* Recorded Video (после завершения теста) */}
      {viewMode === "recorded" && recordedVideoUrl && (
        <video src={recordedVideoUrl} controls className="recorded-video" />
      )}
    </div>
  );
}
```

---

## 7. Важные моменты

### Buffer Management

```typescript
// Буфер хранит последние ~25 секунд (300 кадров при 12 fps)
// Это позволяет скроллить назад во время live стрима
const MAX_BUFFER_SIZE = 300;

// При seekTo() ищем ближайший кадр по elapsedTime
// elapsedTime - это миллисекунды от начала теста
```

### Memory Management

```typescript
// Очищаем буфер при отписке
useEffect(() => {
  return () => {
    bufferRef.current = [];
  };
}, [testId]);

// Ограничиваем размер буфера
if (bufferRef.current.length > MAX_BUFFER_SIZE) {
  bufferRef.current = bufferRef.current.slice(-MAX_BUFFER_SIZE);
}
```

### Error Handling

```typescript
// Показываем placeholder если стрим недоступен
if (status === "unavailable") {
  return <div>Video unavailable: {error}</div>;
}

// Показываем индикатор если стрим на паузе
if (status === "paused") {
  return <div>Buffering... Please wait</div>;
}
```

### Base64 Data Format

```typescript
// Важно: data приходит БЕЗ префикса data:image/jpeg;base64,
// Нужно добавить его при создании Image:
img.src = `data:image/jpeg;base64,${currentFrame.data}`;
```

---

## 8. Чеклист для фронта

- [ ] Подписка на `subscribe:test` при открытии страницы теста
- [ ] Обработка 7 типов событий `test:video:*`
- [ ] Буфер кадров (последние 300 кадров)
- [ ] Canvas для рендеринга JPEG
- [ ] Слайдер с `elapsedTime` для перемотки
- [ ] Кнопка "Go Live" для возврата к live
- [ ] Индикатор статуса (LIVE/Paused/Stopped)
- [ ] Индикатор качества (High/Medium/Low)
- [ ] Fallback на `test:video:unavailable`
- [ ] Переключение на recorded video после завершения
- [ ] Cleanup буфера при unmount
- [ ] Обработка late join (catchup frames)

---

## 9. Пример использования

### Базовый пример

```tsx
import { TestVideoSection } from "./components/TestVideoSection";

function TestPage({ testId, testStatus, videoUrl }) {
  return (
    <div>
      <h1>Test {testId}</h1>
      <TestVideoSection
        testId={testId}
        testStatus={testStatus}
        recordedVideoUrl={videoUrl}
      />
    </div>
  );
}
```

---

## 10. Troubleshooting

### Проблема: Кадры не отображаются

**Решение:**

- Проверьте что `currentFrame` не null
- Проверьте формат base64: `data:image/jpeg;base64,${data}`
- Проверьте размеры canvas соответствуют размерам кадра

### Проблема: Слайдер не работает

**Решение:**

- Проверьте что `hasBuffer === true`
- Проверьте что `bufferStartTime` и `maxDuration` установлены
- Проверьте что `seekTo()` правильно находит ближайший кадр

### Проблема: Memory leak

**Решение:**

- Убедитесь что буфер очищается в cleanup функции
- Ограничьте размер буфера (`MAX_BUFFER_SIZE`)
- Проверьте что все event listeners удаляются

### Проблема: Late join не работает

**Решение:**

- Проверьте что `subscribe:test` вызывается при подключении
- Проверьте что catchup frames приходят с `isCatchup: true`
- Проверьте что catchup frames добавляются в буфер

---

## 11. API Reference

### WebSocket Events

| Event                    | Direction       | Description       |
| ------------------------ | --------------- | ----------------- |
| `subscribe:test`         | Client → Server | Подписка на тест  |
| `unsubscribe:test`       | Client → Server | Отписка от теста  |
| `test:video:started`     | Server → Client | Стрим начался     |
| `test:video:frame`       | Server → Client | Кадр видео        |
| `test:video:stats`       | Server → Client | Статистика        |
| `test:video:paused`      | Server → Client | Стрим на паузе    |
| `test:video:resumed`     | Server → Client | Стрим возобновлен |
| `test:video:stopped`     | Server → Client | Стрим остановлен  |
| `test:video:unavailable` | Server → Client | Стрим недоступен  |

---

## 12. Performance Tips

1. **Ограничьте размер буфера** - 300 кадров достаточно для ~25 секунд
2. **Используйте requestAnimationFrame** для плавного рендеринга (опционально)
3. **Throttle слайдер** - обновляйте кадр не чаще 30fps при перемотке
4. **Lazy load** - не подписывайтесь на стрим пока компонент не виден

---

**Последнее обновление:** 2025-01-XX
