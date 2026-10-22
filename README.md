# Telegram + Gemini для ЦДЗ МЭШ — Vercel webhook MVP

Serverless webhook для Vercel. Бот принимает текст и фотографии, передаёт задание Gemini и возвращает разбор.

## Что пока не реализовано
- автоматический вход в МЭШ;
- чтение списка ЦДЗ из личного кабинета;
- заполнение и отправка ответов в МЭШ;
- постоянная база истории.

Это отдельный этап: сначала подтверждаем, что webhook и Gemini работают. Не помещай пароль или session cookies МЭШ в исходный код.

## Структура
```
api/webhook.js   обработчик (веб-стиль: экспорт POST/GET, Request/Response)
vercel.json      maxDuration = 60
package.json     "type": "module", Node >= 20
```
Файлы `_env.example` и `_gitignore` переименуй в `.env.example` и `.gitignore`.

## 1. Подготовь токены
- Бот у `@BotFather` → токен.
- Gemini API key: https://aistudio.google.com/apikey
- Секрет webhook: `[guid]::NewGuid().ToString("N")` в PowerShell (допустимы `A-Z a-z 0-9 _ -`).

## 2. GitHub
Приватный репозиторий, все файлы папки. Не коммить `.env` и реальные ключи.

## 3. Vercel
Add New → Project → импорт репозитория, Framework preset: Other. Environment Variables (Production):

| Переменная | Значение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен BotFather |
| `GEMINI_API_KEY` | ключ Google AI Studio |
| `GEMINI_MODEL` | `gemini-3.8-flash` (модели старого поколения Google отключает для новых ключей, смотри список ниже) |
| `GEMINI_FALLBACK_MODELS` | `gemini-flash-latest,gemini-3.5-flash` (запасные при 503/429) |
| `TELEGRAM_WEBHOOK_SECRET` | тот же секрет, что в `setWebhook` |
| `ALLOWED_TELEGRAM_USER_IDS` | ID Telegram через запятую. **Задай обязательно**, иначе бот доступен всем и тратит твою квоту |
| `DEBUG_ERRORS` | `1` только для отладки: бот присылает текст ошибки в чат |

После любого изменения переменных делай **Redeploy**.

Список моделей, доступных ключу:
```powershell
$KEY = Read-Host "Gemini API key"
(Invoke-RestMethod "https://generativelanguage.googleapis.com/v1beta/models" -Headers @{ "x-goog-api-key" = $KEY }).models |
  Where-Object { $_.supportedGenerationMethods -contains "generateContent" } | Select-Object name
```

## 4. Регистрация webhook
Токен и секрет вводятся в приглашение, в чаты и код их не вставляй:
```powershell
$TOKEN  = Read-Host "Токен бота"
$SECRET = Read-Host "secret_token"
$URL    = "https://ТВОЙ_ДОМЕН.vercel.app/api/webhook"

$body = @{
  url             = $URL
  secret_token    = $SECRET
  allowed_updates = @("message")
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$TOKEN/setWebhook" -ContentType "application/json" -Body $body
```
Проверка:
```powershell
(Invoke-RestMethod "https://api.telegram.org/bot$TOKEN/getWebhookInfo").result | Format-List
```
Смотри `pending_update_count` и `last_error_message`.

## 5. Проверка
`/start`, `/status` (покажет модель), текст задания, затем фото. При проблемах: Vercel → Logs, а также `DEBUG_ERRORS=1`.

## Как устроены ошибки Gemini
- `503`/`429`/`5xx`/таймаут: одна повторная попытка, затем следующая модель из списка;
- `400`/`403`/`404`: сразу следующая модель;
- таймаут одного запроса 20 с, общий лимит функции 60 с.

## Ограничения
Webhook должен уложиться в `maxDuration` (60 с). Для долгих задач нужна очередь/worker. Браузерная автоматизация с постоянной сессией не должна жить внутри этого webhook. Автоотправку ответов в МЭШ не включай без явного подтверждения и проверки разрешённого способа интеграции.

## Безопасность
Если токен бота или секрет попали в чат/репозиторий: `/revoke` у @BotFather, новый secret_token, обновить Vercel, заново вызвать `setWebhook`.
