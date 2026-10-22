# Telegram + GigaChat для ЦДЗ МЭШ — Vercel webhook

Serverless webhook для Vercel. Бот принимает текст и фотографии теста, отправляет их в GigaChat и возвращает краткий ответ и уверенность.

## Что пока не реализовано
Вход в МЭШ, чтение ЦДЗ, отправка ответов в МЭШ, база истории. Пароли и cookies МЭШ в код не помещай.

## Структура
```
api/webhook.js   обработчик (экспорт POST/GET, Request/Response)
certs/           корневой сертификат НУЦ Минцифры (нужен для api.giga.chat / ngw)
vercel.json      maxDuration = 60, includeFiles = certs/**
package.json     "type": "module", зависимость undici
```
`_env.example` → `.env.example`, `_gitignore` → `.gitignore`.

## 1. Ключи
- Бот у `@BotFather` → токен.
- GigaChat: на странице developers.sber.ru → «Настройка API» → «Получить ключ». Нужен **Ключ авторизации** (Authorization key), он сохраняется в `GIGACHAT_AUTH_KEY`. Access token бот получает сам и обновляет каждые ~30 минут.
- Секрет webhook: `[guid]::NewGuid().ToString("N")`.

## 2. Сертификат Минцифры
Серверы Сбера используют сертификат НУЦ Минцифры, которого нет в доверенных у Node на Vercel. Скачай корневой сертификат с https://www.gosuslugi.ru/crt (PEM), положи как `certs/russian_trusted_root_ca.pem` и закоммить. Без него запросы падают с ошибкой вида `unable to verify the first certificate` или `fetch failed`. Отключать проверку TLS не нужно.

## 3. Vercel (Framework preset: Other)
| Переменная | Значение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | тот же секрет, что в `setWebhook` |
| `ALLOWED_TELEGRAM_USER_IDS` | ID Telegram через запятую (обязательно, иначе бот открыт всем) |
| `GIGACHAT_AUTH_KEY` | ключ авторизации |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` (физлицо, freemium) |
| `GIGACHAT_MODEL` | `GigaChat-3-Ultra` |
| `GIGACHAT_FALLBACK_MODELS` | необязательно, запасные модели |
| `DEBUG_ERRORS` | `1` только для отладки |

После изменения переменных нужен **Redeploy**. Список доступных ключу моделей:
```powershell
# сначала получи access token (см. документацию), затем:
Invoke-RestMethod "https://api.giga.chat/v1/models" -Headers @{ Authorization = "Bearer $ACCESS_TOKEN" }
```

## 4. Webhook
```powershell
$TOKEN  = Read-Host "Токен бота"
$SECRET = Read-Host "secret_token"
$URL    = "https://ТВОЙ_ДОМЕН.vercel.app/api/webhook"
$body = @{ url = $URL; secret_token = $SECRET; allowed_updates = @("message") } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$TOKEN/setWebhook" -ContentType "application/json" -Body $body
(Invoke-RestMethod "https://api.telegram.org/bot$TOKEN/getWebhookInfo").result | Format-List
```

## 5. Проверка
`/status`, затем текст задания, затем фото. При проблемах: Vercel → Logs и `DEBUG_ERRORS=1`.

## Типичные ошибки
- `fetch failed` / `unable to verify the first certificate`: нет `certs/russian_trusted_root_ca.pem` или он не попал в деплой.
- `auth failed: 401/400`: неверный `GIGACHAT_AUTH_KEY` или `GIGACHAT_SCOPE`.
- `429`: исчерпан лимит бесплатных токенов.
- Ошибка на фото: выбранная модель может не принимать изображения. Укажи другую в `GIGACHAT_MODEL` или `GIGACHAT_FALLBACK_MODELS`.
- Таймауты: единственный запрос ограничен 25 с, функция 60 с.

## Безопасность
Если токен бота, секрет или ключ GigaChat попали в чат или репозиторий: перевыпусти токен (`/revoke` у @BotFather), сгенерируй новый secret_token и новый ключ GigaChat, обнови Vercel и заново вызови `setWebhook`.
