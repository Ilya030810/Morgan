// Общий клиент GigaChat для почтового агента (отдельно от webhook.js, чтобы его не трогать).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";

const DEFAULT_MODEL = "GigaChat-3-Ultra";
const DEFAULT_BASE_URL = "https://api.giga.chat";
const DEFAULT_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const baseUrl = () => (process.env.GIGACHAT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

let cachedToken = null;

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
    const err = new Error(`GigaChat auth failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const fromServer = Number(data.expires_at) || 0;
  const expiresAt = Math.min(fromServer || Infinity, Date.now() + 29 * 60_000);
  cachedToken = { value: data.access_token, expiresAt };
  return cachedToken.value;
}

async function authed(path, makeOptions) {
  for (let i = 0; i < 2; i++) {
    const token = await getToken(i > 0);
    const response = await gfetch(`${baseUrl()}${path}`, makeOptions(token));
    if (response.status !== 401 || i === 1) return response;
  }
}

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
    const err = new Error(`GigaChat ${model} failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("GigaChat returned empty text");
  return text;
}

// Основная модель + запасные (GIGACHAT_FALLBACK_MODELS), как в webhook.js.
export async function gigaChat(system, user, maxTokens = 1500) {
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
        return await chatOnce(model, system, user, maxTokens);
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
