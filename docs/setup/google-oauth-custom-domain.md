# Настройка Google OAuth с доменом qait.dev

## Проблема

При OAuth логине Google показывает:
```
Переход в приложение "hzfcvwqjvdmynpqyjhls.supabase.co"
```

Вместо:
```
Переход в приложение "qait.dev"
```

---

## Решение

### Вариант 1: Изменить название приложения в Google Cloud Console (Рекомендуется)

Это самый простой способ - изменить название приложения в OAuth consent screen.

#### Шаги:

1. **Открой Google Cloud Console:**
   - https://console.cloud.google.com
   - Выбери проект QAI

2. **Перейди в OAuth consent screen:**
   - APIs & Services → OAuth consent screen

3. **Настрой App information:**
   ```
   App name: QAIT
   User support email: your-email@qait.dev
   App logo: (загрузи логотип qait.dev)
   ```

4. **Настрой Authorized domains:**
   - Добавь `qait.dev` в список authorized domains
   - Это позволит Google показывать правильный домен

5. **Сохрани изменения**

#### Результат:

Google будет показывать:
```
Переход в приложение "QAIT" (qait.dev)
```

---

### Вариант 2: Настроить Custom Domain в Supabase (Продвинутый)

Если у тебя есть Supabase Pro план, можно настроить custom domain для Auth.

#### Шаги:

1. **Supabase Dashboard:**
   - Settings → Custom Domains
   - Добавь `auth.qait.dev` (или `qait.dev`)

2. **Настрой DNS:**
   - Добавь CNAME запись:
     ```
     auth.qait.dev → YOUR_PROJECT.supabase.co
     ```

3. **Обнови Google OAuth redirect URI:**
   - Google Cloud Console → Credentials
   - Измени Authorized redirect URIs:
     ```
     https://auth.qait.dev/auth/v1/callback
     ```

4. **Обнови Supabase URL Configuration:**
   - Authentication → URL Configuration
   - Site URL: `https://qait.dev`
   - Redirect URLs: `https://qait.dev/auth/callback`

#### Результат:

Google будет показывать:
```
Переход в приложение "qait.dev"
```

---

### Вариант 3: Использовать свой backend как OAuth proxy (Сложный)

Можно сделать свой backend endpoint который проксирует OAuth через свой домен.

**Не рекомендуется** - сложно поддерживать и не дает особых преимуществ.

---

## Рекомендация

**Используй Вариант 1** - это самый простой и быстрый способ.

Просто измени название приложения в Google Cloud Console на "QAIT" и добавь `qait.dev` в authorized domains.

---

## Проверка

После настройки:

1. Открой OAuth flow:
   ```
   https://qait.dev/api/v1/auth/oauth/google
   ```

2. Проверь что Google показывает:
   ```
   Переход в приложение "QAIT" (qait.dev)
   ```

   Вместо:
   ```
   Переход в приложение "hzfcvwqjvdmynpqyjhls.supabase.co"
   ```

---

## Дополнительно

### Google Cloud Console - OAuth Consent Screen Settings:

```
App name: QAIT
User support email: support@qait.dev
Developer contact: dev@qait.dev

Authorized domains:
- qait.dev
- *.qait.dev (если нужны поддомены)

App logo: (загрузи логотип)
```

### Google Cloud Console - OAuth 2.0 Client ID:

```
Authorized redirect URIs:
- https://YOUR_PROJECT.supabase.co/auth/v1/callback
- https://auth.qait.dev/auth/v1/callback (если используешь custom domain)
```

---

**Готово!** После настройки Google будет показывать правильный домен.
