import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import { Agent, fetch as undiciFetch, FormData } from "undici";

export const maxDuration = 60;

const MAX_TELEGRAM_TEXT = 3900;
const DEFAULT_MODEL = "GigaChat-3-Ultra";
const DEFAULT_BASE_URL = "https://api.giga.chat";
const DEFAULT_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const REQUEST_TIMEOUT_MS = 25000;

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

/* ---------- Telegram ---------- */

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

async function photoBuffer(fileId) {
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
  const isPng = file.file_path.toLowerCase().endsWith(".png");
  return {
    buffer,
    mimeType: isPng ? "image/png" : "image/jpeg",
    filename: isPng ? "task.png" : "task.jpg",
  };
}

/* ---------- GigaChat ---------- */

// Серверы Сбера используют сертификат НУЦ Минцифры, которого нет в стандартном
// наборе Node. Если файл с корневым сертификатом лежит в certs/, подключаем его.
let dispatcher;
function getDispatcher() {
  if (dispatcher !== undefined) return dispatcher;
  const caPath = join(process.cwd(), process.env.GIGACHAT_CA_PATH || "certs/russian_trusted_root_ca.pem");
  if (existsSync(caPath)) {
    dispatcher = new Agent({
      connect: { ca: [...tls.rootCertificates, readFileSync(caPath, "utf8")] },
    });
  } else {
    console.warn(`CA file not found at ${caPath}; using default trust store`);
    dispatcher = null;
  }
  return dispatcher;
}

function gfetch(url, options = {}) {
  const d = getDispatcher();
  return undiciFetch(url, {
    ...options,
    ...(d ? { dispatcher: d } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const baseUrl = () => (process.env.GIGACHAT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

let cachedToken = null; // { value, expiresAt } — живёт, пока «тёплый» инстанс функции

async function getToken(force = false) {
  if (!force && cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.value;
  }
  const response = await gfetch(process.env.GIGACHAT_AUTH_URL || DEFAULT_AUTH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      RqUID: randomUUID(),
      authorization: `Basic ${process.env.GIGACHAT_AUTH_KEY}`,
    },
    body: new URLSearchParams({ scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS" }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const err = new Error(`GigaChat auth failed: ${response.status} ${JSON.stringify(data)}`);
    err.status = response.status;
    throw err;
  }
  // expires_at приходит в миллисекундах; на всякий случай ограничиваем 29 минутами
  const fromServer = Number(data.expires_at) || 0;
  const expiresAt = Math.min(fromServer || Infinity, Date.now() + 29 * 60_000);
  cachedToken = { value: data.access_token, expiresAt };
  return cachedToken.value;
}

// Запрос с автоматическим обновлением токена при 401
async function authed(path, makeOptions) {
  for (let i = 0; i < 2; i++) {
    const token = await getToken(i > 0);
    const response = await gfetch(`${baseUrl()}${path}`, makeOptions(token));
    if (response.status !== 401 || i === 1) return response;
  }
}

async function uploadImage({ buffer, mimeType, filename }) {
  const response = await authed("/v1/files", (token) => {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    form.append("purpose", "general");
    return { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form };
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    const err = new Error(`GigaChat upload failed: ${response.status} ${JSON.stringify(data)}`);
    err.status = response.status;
    throw err;
  }
  return data.id;
}

async function deleteFile(fileId) {
  try {
    await authed(`/v1/files/${fileId}/delete`, (token) => ({
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }));
  } catch (e) {
    console.error("GigaChat file delete failed", e.message);
  }
}

async function chatOnce(model, userContent, attachments) {
  const userMessage = { role: "user", content: userContent };
  if (attachments?.length) userMessage.attachments = attachments;

  const response = await authed("/v1/chat/completions", (token) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, userMessage],
      temperature: 0.2,
      max_tokens: 1500,
    }),
  }));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(`GigaChat ${model} failed: ${response.status} ${JSON.stringify(data)}`);
    err.status = response.status;
    throw err;
  }
  const text = data.choices?.[0]?.message?.content?.trim();
  return text || "Модель не вернула текстовый ответ.";
}

// Основная модель + запасные (GIGACHAT_FALLBACK_MODELS). При 429/5xx/таймауте —
// одна повторная попытка, при остальных ошибках сразу следующая модель.
async function gigachat(userContent, attachments) {
  const primary = process.env.GIGACHAT_MODEL || DEFAULT_MODEL;
  const fallbacks = (process.env.GIGACHAT_FALLBACK_MODELS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const models = [...new Set([primary, ...fallbacks])];

  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await chatOnce(model, userContent, attachments);
      } catch (error) {
        lastError = error;
        console.error(`GigaChat ${model} attempt ${attempt + 1}:`, error.message);
        const retryable =
          error.name === "TimeoutError" || [429, 500, 502, 503, 504].includes(error.status);
        if (!retryable) break;
        await sleep(1000);
      }
    }
  }
  throw lastError || new Error("All GigaChat models failed");
}

/* ---------- Webhook ---------- */

export function GET() {
  return json(405, { ok: false, error: "POST only" });
}

export async function POST(request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return json(403, { ok: false, error: "Forbidden" });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.GIGACHAT_AUTH_KEY) {
    return json(500, { ok: false, error: "Missing TELEGRAM_BOT_TOKEN or GIGACHAT_AUTH_KEY" });
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

  let uploadedId;
  try {
    const text = (message.text || message.caption || "").trim();

    if (text === "/start" || text.startsWith("/start ")) {
      await sendText(
        chatId,
        "Привет! Я учебный бот на GigaChat. Пришли текст или скриншот теста — я верну ответ и уверенность.\n\n" +
          "Пока я не вхожу в аккаунт МЭШ и не отправляю ответы туда автоматически."
      );
      return json(200, { ok: true });
    }
    if (text === "/help") {
      await sendText(chatId, "Отправь текст вопроса или скриншот с читаемым условием. Я верну краткий ответ и уверенность.");
      return json(200, { ok: true });
    }
    if (text === "/status") {
      await sendText(
        chatId,
        `Webhook работает. Модель: ${process.env.GIGACHAT_MODEL || DEFAULT_MODEL}. Автоматический доступ к МЭШ ещё не подключён.`
      );
      return json(200, { ok: true });
    }

    let answer;
    if (message.photo?.length) {
      await sendText(chatId, "Получил скриншот. Анализирую…");
      const largest = message.photo[message.photo.length - 1];
      uploadedId = await uploadImage(await photoBuffer(largest.file_id));
      answer = await gigachat(
        "Реши задание или задания на изображении. Верни только краткие ответы и уверенность для каждого. Без решения и объяснения. Если условие нечитаемо, данных недостаточно или ответ неоднозначен, не угадывай: напиши «Ответ: не удалось определить» и «Уверенность: не уверен». Если заданий несколько, пронумеруй ответы.",
        [uploadedId]
      );
    } else if (text && !text.startsWith("/")) {
      await sendText(chatId, "Разбираю задание…");
      answer = await gigachat(
        `Это тест. Реши задание и выведи только ответ и уверенность: «Уверенность: уверен» или «Уверенность: не уверен». Не показывай решение или объяснение. Если данных недостаточно, не угадывай.\n\n${text}`
      );
    } else {
      await sendText(chatId, "Пока я понимаю текстовые сообщения и фотографии заданий.");
      return json(200, { ok: true });
    }

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
  } finally {
    if (uploadedId) await deleteFile(uploadedId);
  }

  return json(200, { ok: true });
}

  return json(200, { ok: true });
}
