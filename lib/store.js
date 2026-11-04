// Маленькое хранилище для режима, истории диалога и данных об авто.
// Основной вариант: Upstash Redis (бесплатный тариф, REST, без зависимостей).
// Если переменные UPSTASH_* не заданы, данные живут только в памяти функции
// (на Vercel это ненадёжно: режим и история будут иногда сбрасываться).

const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = new Map();

export const persistent = Boolean(URL_ && TOKEN);

async function cmd(args) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(`Upstash ${r.status} ${d.error || ""}`);
  return d.result;
}

export async function getVal(key) {
  if (persistent) {
    try {
      const v = await cmd(["GET", key]);
      if (v !== null && v !== undefined) return v;
    } catch (e) {
      console.error("store get failed", key, e.message);
    }
  }
  return mem.get(key) ?? null;
}

export async function setVal(key, value, ttlSeconds = 60 * 60 * 24 * 30) {
  mem.set(key, value);
  if (!persistent) return;
  try {
    await cmd(["SET", key, value, "EX", String(ttlSeconds)]);
  } catch (e) {
    console.error("store set failed", key, e.message);
  }
}

// Записать ключ, только если его ещё нет. true, если записали (то есть ключ новый).
// Нужен, чтобы не обрабатывать повторную доставку одного и того же сообщения Telegram.
export async function setNx(key, value, ttlSeconds = 600) {
  if (persistent) {
    try {
      const r = await cmd(["SET", key, value, "NX", "EX", String(ttlSeconds)]);
      return r === "OK";
    } catch (e) {
      console.error("store setNx failed", key, e.message);
    }
  }
  if (mem.has(key)) return false;
  mem.set(key, value);
  return true;
}
