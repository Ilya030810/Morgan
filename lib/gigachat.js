
// Общий клиент GigaChat для Morgan.
// Поддерживает текстовые запросы и распознавание изображений.
// Отдельно от webhook.js.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Blob } from "node:buffer";
import tls from "node:tls";
import { Agent, fetch as undiciFetch, FormData } from "undici";

const DEFAULT_MODEL = "GigaChat-3-Ultra";
const DEFAULT_BASE_URL = "https://api.giga.chat";
const DEFAULT_AUTH_URL =
  "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";

const TIMEOUT_MS = 20000;
const MAX_IMAGE_SIZE = 15 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- TLS ---------- */

let dispatcher;

function getDispatcher() {
  if (dispatcher !== undefined) return dispatcher;

  const caPath = join(
    process.cwd(),
    process.env.GIGACHAT_CA_PATH || "certs/russian_trusted_root_ca.pem"
  );

  if (existsSync(caPath)) {
    dispatcher = new Agent({
      connect: {
        ca: [
          ...tls.rootCertificates,
          readFileSync(caPath, "utf8"),
        ],
      },
    });
  } else {
    console.warn(
      `CA file not found at ${caPath}; using default trust store`
    );
    dispatcher = null;
  }

  return dispatcher;
}

function gfetch(url, options = {}) {
  const d = getDispatcher();

  return undiciFetch(url, {
    ...options,
    ...(d ? { dispatcher: d } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const baseUrl = () =>
  (process.env.GIGACHAT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

/* ---------- Авторизация ---------- */

let cachedToken = null;

async function getToken(force = false) {
  if (
    !force &&
    cachedToken &&
    cachedToken.expiresAt - Date.now() > 60000
  ) {
    return cachedToken.value;
  }

  const authKey = process.env.GIGACHAT_AUTH_KEY;

  if (!authKey) {
    throw new Error("GIGACHAT_AUTH_KEY is not configured");
  }

  const response = await gfetch(
    process.env.GIGACHAT_AUTH_URL || DEFAULT_AUTH_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        RqUID: randomUUID(),
        authorization: `Basic ${authKey}`,
      },
      body: new URLSearchParams({
        scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    const err = new Error(
      `GigaChat auth failed (${response.status}): ${JSON.stringify(data)}`
    );
    err.status = response.status;
    throw err;
  }

  const serverExpiry = Number(data.expires_at) || 0;

  const expiresAt = Math.min(
    serverExpiry || Infinity,
    Date.now() + 29 * 60 * 1000
  );

  cachedToken = {
    value: data.access_token,
    expiresAt,
  };

  return cachedToken.value;
}

/* ---------- Запросы с авторизацией ---------- */

async function authed(path, makeOptions) {
  for (let i = 0; i < 2; i++) {
    const token = await getToken(i > 0);

    const response = await gfetch(
      `${baseUrl()}${path}`,
      makeOptions(token)
    );

    if (response.status !== 401 || i === 1) {
      return response;
    }
  }

  throw new Error("GigaChat authorization failed");
}

/* ---------- Модели ---------- */

function getModels() {
  const primary = process.env.GIGACHAT_MODEL || DEFAULT_MODEL;

  const fallbacks = (process.env.GIGACHAT_FALLBACK_MODELS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return [...new Set([primary, ...fallbacks])];
}

function isRetryable(error) {
  return (
    error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    [429, 500, 502, 503, 504].includes(error.status)
  );
}

/* ---------- Текстовый чат ---------- */

async function chatOnce(model, system, user, maxTokens) {
  const response = await authed("/v1/chat/completions", (token) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
  }));

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      `GigaChat ${model} failed (${response.status}): ${JSON.stringify(data)}`
    );
    err.status = response.status;
    throw err;
  }

  const result = data.choices?.[0]?.message?.content;

  if (typeof result !== "string" || !result.trim()) {
    throw new Error(`GigaChat ${model} returned empty text`);
  }

  return result.trim();
}

export async function gigaChat(system, user, maxTokens = 1500) {
  let lastError;

  for (const model of getModels()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await chatOnce(model, system, user, maxTokens);
      } catch (error) {
        lastError = error;

        console.error(
          `GigaChat ${model} attempt ${attempt + 1}:`,
          error.message
        );

        if (!isRetryable(error)) break;

        await sleep(1000);
      }
    }
  }

  throw lastError || new Error("All GigaChat models failed");
}

/* ---------- Изображения ---------- */

// Загружает изображение в GigaChat и возвращает ID файла.

async function uploadImage(image) {
  if (!image || !Buffer.isBuffer(image.buffer)) {
    throw new Error("Invalid image buffer");
  }

  const allowedTypes = ["image/jpeg", "image/png"];

  if (!allowedTypes.includes(image.mime)) {
    throw new Error(`Unsupported image MIME type: ${image.mime}`);
  }

  if (image.buffer.length === 0) {
    throw new Error("Image is empty");
  }

  if (image.buffer.length > MAX_IMAGE_SIZE) {
    throw new Error("Image exceeds 15 MB limit");
  }

  const response = await authed("/v1/files", (token) => {
    const form = new FormData();

    const filename =
      image.mime === "image/png" ? "photo.png" : "photo.jpg";

    form.append(
      "file",
      new Blob([image.buffer], { type: image.mime }),
      filename
    );

    form.append("purpose", "general");

    return {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: form,
    };
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.id) {
    const err = new Error(
      `GigaChat image upload failed (${response.status}): ${JSON.stringify(data)}`
    );

    err.status = response.status;
    throw err;
  }

  return data.id;
}

/* ---------- Удаление изображения ---------- */

async function deleteFile(id) {
  try {
    const response = await authed(
      `/v1/files/${encodeURIComponent(id)}/delete`,
      (token) => ({
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
      })
    );

    if (!response.ok) {
      console.error(
        `GigaChat file deletion failed: ${response.status}`
      );
    }
  } catch (error) {
    console.error("GigaChat file delete failed:", error.message);
  }
}

/* ---------- Запрос с изображением ---------- */

async function chatImageOnce(
  model,
  system,
  user,
  fileId,
  maxTokens
) {
  const response = await authed("/v1/chat/completions", (token) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: system,
        },
        {
          role: "user",
          content: user,
          attachments: [fileId],
        },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
  }));

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      `GigaChat ${model} image failed (${response.status}): ${JSON.stringify(data)}`
    );

    err.status = response.status;
    throw err;
  }

  const result = data.choices?.[0]?.message?.content;

  if (typeof result !== "string" || !result.trim()) {
    throw new Error(
      `GigaChat ${model} returned empty image response`
    );
  }

  return result.trim();
}

/* ---------- Публичная функция распознавания фото ---------- */

// Использование:
// gigaChatImage(system, user, {
//   buffer: imageBuffer,
//   mime: "image/jpeg"
// });



export async function gigaChatImage(
  system,
  user,
  image,
  maxTokens = 1200
) {
  const vision = (process.env.GIGACHAT_VISION_MODEL || "").trim();

  const models = [
    ...new Set([vision, ...getModels()].filter(Boolean)),
  ];

  if (!models.length) {
    throw new Error("No GigaChat models configured");
  }

  const imageSystem = options.extractOnly
  ? `${system}

РЕЖИМ РАСПОЗНАВАНИЯ БЕЗ РЕШЕНИЯ

Внимательно прочитай изображение.
Если на нём учебное задание, НЕ решай его.
Только перепиши условие, варианты ответов, таблицы и обозначения.

Начни ответ строго с:
ТИП: УЧЕБНОЕ ЗАДАНИЕ
УСЛОВИЕ:

Затем напиши полный распознанный текст.

Если учебного задания нет, начни с:
ТИП: ДРУГОЕ

Нечитаемые места помечай как [неразборчиво].
Не додумывай текст.
`
  : `${system}

АВТОМАТИЧЕСКАЯ РАБОТА С ФОТОГРАФИЯМИ

Самостоятельно определи, что изображено и что нужно сделать.
Учебные задания решай полностью, остальные фотографии анализируй.
Не выдумывай нечитаемый текст и не угадывай ответы.
Отвечай по-русски и по существу.
`;

  const fileId = await uploadImage(image);

  try {
    let lastError;

    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          console.log(`GigaChat image: trying model ${model}`);

          return await chatImageOnce(
            model,
            imageSystem,
            user,
            fileId,
            maxTokens
          );
        } catch (error) {
          lastError = error;

          console.error(
            `GigaChat ${model} image attempt ${attempt + 1}:`,
            error.message
          );

          if (!isRetryable(error)) break;

          await sleep(1000);
        }
      }
    }

    throw lastError || new Error("All GigaChat vision models failed");
  } finally {
    await deleteFile(fileId);
  }
}

