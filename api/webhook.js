import { gigaChat } from "../lib/gigachat.js";
import { runMail } from "../lib/mail.js";
import { buildSystem, pick, MAIL_INTRO, MAIL_TEST_INTRO, WELCOME, MODE_MSG, CAR_FOOTER, carReady } from "../lib/persona.js";
import { getVal, setVal, persistent } from "../lib/store.js";

export const maxDuration = 60;

const MAX_TELEGRAM_TEXT = 3900;

const BTN = {
  help: "💬 Помощь",
  car: "🔧 Ремонт авто",
  mail: "📧 Почта",
  mailTest: "📧 Почта (тест)",
};

const KEYBOARD = {
  keyboard: [
    [{ text: BTN.help }, { text: BTN.car }],
    [{ text: BTN.mail }, { text: BTN.mailTest }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Кнопки прикрепляются к последнему куску каждого ответа.
async function sendText(chatId, text) {
  const chunks = (text || "Пустой ответ.").match(new RegExp(`[\\s\\S]{1,${MAX_TELEGRAM_TEXT}}`, "g"));
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i] };
    if (i === chunks.length - 1) payload.reply_markup = KEYBOARD;
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
}

/* ---------- Режим, история, данные об авто ---------- */

const modeKey = (id) => `mode:${id}`;
const histKey = (id) => `hist:${id}`;
const carKey = (id) => `car:${id}`;

async function loadHistory(chatId) {
  try {
    const v = JSON.parse((await getVal(histKey(chatId))) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function saveHistory(chatId, history) {
  await setVal(histKey(chatId), JSON.stringify(history.slice(-8)), 60 * 60 * 24 * 3);
}

async function setMode(chatId, mode) {
  await setVal(modeKey(chatId), mode);
  await setVal(histKey(chatId), "[]", 60 * 60 * 24 * 3); // при смене режима диалог начинается заново
}

function composeUser(history, text) {
  if (!history.length) return text;
  const log = history
    .map((h) => `${h.r === "u" ? "Пользователь" : "Куруми"}: ${h.t}`)
    .join("\n");
  return `Предыдущий диалог:\n${log}\n\nНовое сообщение пользователя:\n${text}`;
}

/* ---------- Вебхук ---------- */

export function GET() {
  return json(405, { ok: false, error: "POST only" });
}

export async function POST(request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return json(403, { ok: false, error: "Forbidden" });
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return json(500, { ok: false, error: "Missing TELEGRAM_BOT_TOKEN" });
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

  // Список обязателен: без него бот не отвечает никому (агент работает с твоей почтой).
  if (!allowList.includes(userId)) return json(200, { ok: true, ignored: true });

  try {
    const text = (message.text || "").trim();
    if (!text) {
      await sendText(chatId, "Я понимаю только текст. Фото и голосовые пока не мой уровень.");
      return json(200, { ok: true });
    }

    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().split("@")[0];

    // Кнопки (приходят обычным текстом)
    if (text === BTN.help) {
      await setMode(chatId, "help");
      await sendText(chatId, MODE_MSG.help);
    } else if (text === BTN.car) {
      await setMode(chatId, "car");
      const savedCar = await getVal(carKey(chatId));
      await sendText(chatId, savedCar ? carReady(savedCar) : MODE_MSG.car);
    } else if (text === BTN.mail || text === BTN.mailTest || cmd === "/mail" || cmd === "/почта") {
      const dry = text === BTN.mailTest || args.some((a) => /^(тест|test|dry)$/i.test(a));
      await sendText(chatId, pick(dry ? MAIL_TEST_INTRO : MAIL_INTRO));
      const { summary } = await runMail({ dry });
      await sendText(chatId, summary);
    } else if (cmd === "/start" || cmd === "/help") {
      await sendText(chatId, WELCOME);
    } else if (cmd === "/status") {
      const live = process.env.MAIL_LIVE === "1";
      const mode = (await getVal(modeKey(chatId))) || "help";
      await sendText(
        chatId,
        `Webhook работает. Режим: ${mode}. Почта: ${live ? "боевой режим" : "тест (MAIL_LIVE не включён)"}. Память: ${
          persistent ? "Upstash" : "только в оперативке (может сбрасываться)"
        }.`
      );
    } else if (cmd === "/авто") {
      const car = args.join(" ").trim().slice(0, 300);
      if (!car) {
        const saved = await getVal(carKey(chatId));
        await sendText(
          chatId,
          saved
            ? `Сейчас у меня записано: ${saved}\nЧтобы поменять, напиши /авто и новые данные.`
            : "Ничего не записано. Напиши /авто и модель, год, двигатель, а лучше и VIN."
        );
      } else {
        await setVal(carKey(chatId), car, 60 * 60 * 24 * 365);
        await sendText(chatId, `Записала: ${car}. Теперь буду подбирать под эту машину.`);
      }
    } else if (cmd === "/сброс") {
      await setVal(histKey(chatId), "[]", 60 * 60 * 24 * 3);
      await sendText(chatId, "Диалог сбросила. Начинаем с чистого листа.");
    } else if (cmd.startsWith("/")) {
      await sendText(chatId, "Не знаю такой команды. Список: /help");
    } else {
      // Обычное сообщение: отвечаем в текущем режиме с характером Куруми.
      const mode = (await getVal(modeKey(chatId))) || "help";
      const car = mode === "car" ? await getVal(carKey(chatId)) : null;
      const history = await loadHistory(chatId);
      const reply = await gigaChat(buildSystem(mode, car), composeUser(history, text), 1200);
      await sendText(chatId, mode === "car" ? `${reply}\n\n${CAR_FOOTER}` : reply);
      history.push({ r: "u", t: text.slice(0, 800) });
      history.push({ r: "a", t: String(reply).slice(0, 700) });
      await saveHistory(chatId, history);
    }
  } catch (error) {
    console.error("Webhook handler error", error);
    const reply =
      process.env.DEBUG_ERRORS === "1"
        ? `Ошибка: ${String(error?.message || error).slice(0, 600)}`
        : "Что-то сломалось. И это не я виновата! Попробуй ещё раз чуть позже.";
    try {
      await sendText(chatId, reply);
    } catch (sendError) {
      console.error("Telegram reply error", sendError);
    }
  }

  return json(200, { ok: true });
                     }
