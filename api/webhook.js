const MAX_TELEGRAM_TEXT = 3900;
const SYSTEM_PROMPT = `
Ты — учебный помощник по школьным заданиям.
Внимательно распознай условие и варианты ответа. Реши задание самостоятельно.
Кратко укажи условие, ответ и объяснение. Не выдумывай нечитаемые части.
Если данных не хватает, попроси более чёткое изображение.
Если это тест, укажи текст выбранного варианта, а не только букву.
Формат:
Задание: ...
Ответ: ...
Объяснение: ...
Уверенность: высокая/средняя/низкая.
`;

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function sendText(chatId, text) {
  const chunks = (text || "Не удалось сформировать ответ.")
    .match(new RegExp(`[\\s\\S]{1,${MAX_TELEGRAM_TEXT}}`, "g")) || ["Пустой ответ."];
  for (const chunk of chunks) {
    await telegram("sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function gemini(contents) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: contents }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1800 },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Gemini request failed: ${JSON.stringify(data)}`);
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n").trim()
    || "Gemini не вернул текстовый ответ.";
}

async function photoPart(fileId) {
  const file = await telegram("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram file_path is missing");
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error("Failed to download Telegram photo");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Изображение слишком большое (лимит 10 МБ).");
  const mimeType = file.file_path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { inlineData: { mimeType, data: btoa(binary) } };
}

export default async function handler(request) {
  if (request.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return json(403, { ok: false, error: "Forbidden" });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.GEMINI_API_KEY) {
    return json(500, { ok: false, error: "Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY" });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" });
  }

  const message = update.message;
  if (!message?.chat?.id) return json(200, { ok: true, ignored: true });

  const chatId = message.chat.id;
  const userId = String(message.from?.id ?? "");
  const allowList = (process.env.ALLOWED_TELEGRAM_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (allowList.length && !allowList.includes(userId)) {
    await sendText(chatId, "Этот бот пока доступен только разрешённым пользователям.");
    return json(200, { ok: true });
  }

  try {
    const text = (message.text || message.caption || "").trim();
    if (text === "/start" || text.startsWith("/start ")) {
      await sendText(chatId,
        "Привет! Я учебный бот на Gemini. Пришли текст или скриншот задания — я предложу решение и объяснение.\n\n" +
        "Пока я не вхожу в аккаунт МЭШ и не отправляю ответы туда автоматически. Интеграция с МЭШ — отдельный следующий этап."
      );
      return json(200, { ok: true });
    }
    if (text === "/help") {
      await sendText(chatId, "Отправь текст вопроса или скриншот с читаемым условием. Я разберу его и объясню ответ.");
      return json(200, { ok: true });
    }
    if (text === "/status") {
      await sendText(chatId, `Webhook работает. Модель: ${process.env.GEMINI_MODEL || "gemini-2.5-flash"}. Автоматический доступ к МЭШ ещё не подключён.`);
      return json(200, { ok: true });
    }

    let parts;
    if (message.photo?.length) {
      await sendText(chatId, "Получил скриншот. Анализирую…");
      const largest = message.photo[message.photo.length - 1];
      parts = [
        { text: "Реши задание или задания на изображении. Если их несколько, пронумеруй ответы." },
        await photoPart(largest.file_id),
      ];
    } else if (text && !text.startsWith("/")) {
      await sendText(chatId, "Разбираю задание…");
      parts = [{ text: `Реши школьное задание. Сначала укажи ответ, затем объяснение.\n\n${text}` }];
    } else {
      await sendText(chatId, "Пока я понимаю текстовые сообщения и фотографии заданий.");
      return json(200, { ok: true });
    }

    const answer = await gemini(parts);
    await sendText(chatId, answer);
  } catch (error) {
    console.error("Webhook handler error", error);
    try {
      await sendText(chatId, "Не удалось обработать задание. Проверь настройки API и попробуй снова.");
    } catch (sendError) {
      console.error("Telegram reply error", sendError);
    }
  }

  return json(200, { ok: true });
}
