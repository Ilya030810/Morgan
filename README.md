# Telegram + Gemini для ЦДЗ МЭШ — Vercel webhook MVP

Эта версия заменяет постоянный Python polling на serverless webhook для Vercel.
Сейчас бот принимает текст и фотографии, передаёт задание Gemini и возвращает разбор.

## Что пока не реализовано
- автоматический вход в МЭШ;
- чтение списка ЦДЗ из личного кабинета;
- заполнение и отправка ответов в МЭШ;
- постоянная база истории.

Это намеренно отдельный этап: сначала подтверждаем, что webhook и Gemini работают. Для доступа к МЭШ нужно отдельно проверить разрешённый способ авторизации и доступный интерфейс. Не помещай пароль или session cookies МЭШ в исходный код.

## 1. Подготовь токены
- Создай бота у `@BotFather` и скопируй токен.
- Получи Gemini API key: https://aistudio.google.com/apikey
- Сгенерируй длинный случайный секрет webhook (например, в PowerShell: `[guid]::NewGuid().ToString("N")`).

## 2. Размести исходники в GitHub
Создай приватный репозиторий и загрузи все файлы этой папки. Не загружай `.env` и никогда не коммить реальные ключи.

## 3. Импортируй проект в Vercel
1. В Vercel выбери Add New → Project и импортируй репозиторий.
2. Framework preset: Other.
3. Добавь Environment Variables для Production (и Preview только если нужно):
   - `TELEGRAM_BOT_TOKEN` — токен BotFather
   - `GEMINI_API_KEY` — ключ Google AI Studio
   - `GEMINI_MODEL` — `gemini-2.5-flash`
   - `TELEGRAM_WEBHOOK_SECRET` — длинный случайный секрет
   - `ALLOWED_TELEGRAM_USER_IDS` — необязательно; ID Telegram через запятую, чтобы ограничить доступ
4. Deploy. Скопируй HTTPS-домен проекта, например `https://<твой-проект>.vercel.app`.

## 4. Зарегистрируй webhook
Открой PowerShell и выполни, подставив свои значения. Не публикуй команду, потому что в ней есть токен:

```powershell
$TOKEN = "ТОКЕН_ОТ_BOTFATHER"
$URL = "https://ТВОЙ_ДОМЕН.vercel.app/api/webhook"
$SECRET = "ТОТ_ЖЕ_TELEGRAM_WEBHOOK_SECRET"
$body = @{
  url = $URL
  secret_token = $SECRET
  allowed_updates = @("message")
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$TOKEN/setWebhook" -ContentType "application/json" -Body $body
```

Ожидается `ok: true`. Проверить статус:
```powershell
Invoke-RestMethod "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

Не отправляй токены или полный URL с токеном в чат/скриншоты.

## 5. Проверка
Напиши боту `/start`, отправь текст задания, затем фотографию.
Если ответы не приходят, открой Vercel → Project → Logs и проверь сообщения об ошибках. После изменения Environment Variables сделай Redeploy.

## Важное ограничение Vercel
Webhook должен завершить работу в пределах лимита Function. Текущая функция настроена на 30 секунд; для долгих задач понадобится очередь или отдельный worker. Браузерная автоматизация с постоянной сессией не должна жить внутри этого webhook.

## Следующий этап
После проверки webhook можно добавить очередь/базу данных и отдельно спроектировать модуль доступа к ЦДЗ. Не включай автоматическую отправку ответов без явного подтверждения и проверки разрешённого способа интеграции.
