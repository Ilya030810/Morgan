export const maxDuration = 60;

const MAX_TELEGRAM_TEXT = 3900;
const DEFAULT_MODEL = "gemini-3.8-flash";

const SYSTEM_PROMPT = `
Ты — помощник для ответов на школьные тесты.
Самостоятельно реши задание и верни только итоговый ответ и уверенность.

Никаких решений, объяснений, вступлений и пересказа условия.
Для теста укажи букву и текст выбранного варианта, если доступны.

Если ответ однозначен и условие читается:
Ответ: [краткий ответ]
Уверенность: уверен

Если условие нечитаемо, данных недостаточно или ответ неоднозначен:
Ответ: не удалось определить
Уверенность: не уверен

Не угадывай и не выдавай сомнительный ответ за достоверный.
`;


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function telegram(method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendText(chatId, text) {
  const chunks =
    (text || "Не удалось сформировать ответ.").match(
      new RegExp(`[\\s\\S]{1,${MAX_TELEGRAM_TEXT}}`, "g")
    ) || ["Пустой ответ."];
  for (const chunk of chunks) {
    await telegram("sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function geminiOnce(model, parts) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(`Gemini ${model} failed: ${JSON.stringify(data)}`);
    err.status = response.status;
    throw err;
  }
  const text = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || "")
    .join("\n")
    .trim();
  return text || "Gemini не вернул текстовый ответ.";
}

// Основная модель + запасные. При 429/5xx/таймауте — одна повторная попытка,
// при 400/403/404 — сразу следующая модель.

async function gemini(parts) {
  const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbacks = (
    process.env.GEMINI_FALLBACK_MODELS ||
    "gemini-flash-latest,gemini-3.6-flash"
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const models = [...new Set([primary, ...fallbacks])];
  let lastError;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await geminiOnce(model, parts);
      } catch (error) {
        lastError = error;
        console.error(
          `Gemini ${model} attempt ${attempt + 1}:`,
          error.message
        );

        const retryable =
          error.name === "TimeoutError" ||
          [429, 500, 503, 504].includes(error.status);

        if (!retryable) break;
        await sleep(1000);
      }
    }
  }

  throw lastError || new Error("All Gemini models failed");
}

async function photoPart(fileId) {
  const file = await telegram("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram file_path is missing");

  const response = await fetch(
    `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`
  );
  if (!response.ok) throw new Error("Failed to download Telegram photo");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error("Изображение слишком большое (лимит 10 МБ).");
  }
  const mimeType = file.file_path.toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";
  return { inlineData: { mimeType, data: buffer.toString("base64") } };
}

export function GET() {
  return json(405, { ok: false, error: "POST only" });
}

export async function POST(request) {
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
  const allowList = (process.env.ALLOWED_TELEGRAM_USER_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (allowList.length && !allowList.includes(userId)) {
    try {
      await sendText(chatId, "Этот бот пока доступен только разрешённым пользователям.");
    } catch (e) {
      console.error("Telegram reply error", e);
    }
    return json(200, { ok: true });
  }

  try {
    const text = (message.text || message.caption || "").trim();

    if (text === "/start" || text.startsWith("/start ")) {
      await sendText(
        chatId,
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
      await sendText(
        chatId,
        `Webhook работает. Модель: ${process.env.GEMINI_MODEL || DEFAULT_MODEL}. Автоматический доступ к МЭШ ещё не подключён.`
      );
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
    const debug = process.env.DEBUG_ERRORS === "1";
    const reply = debug
      ? `Не удалось обработать задание.\n\nПричина: ${String(error?.message || error).slice(0, 600)}`
      : "Не удалось обработать задание. Попробуй ещё раз чуть позже.";
    try {
      await sendText(chatId, reply);
    } catch (sendError) {
      console.error("Telegram reply error", sendError);
    }
  }

  return json(200, { ok: true });
}
