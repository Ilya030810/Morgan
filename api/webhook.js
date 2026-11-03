import { gigaChat } from "../lib/gigachat.js";
import { runMail } from "../lib/mail.js";

export const maxDuration = 60;

const MAX_TELEGRAM_TEXT = 3900;
const CHAT_SYSTEM = "Ты краткий и полезный помощник. Отвечай по-русски, если не попросили иначе.";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sendText(chatId, text) {
  const chunks = (text || "Пустой ответ.").match(new RegExp(`[\\s\\S]{1,${MAX_TELEGRAM_TEXT}}`, "g"));
  for (const chunk of chunks) {
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }
    );
    if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
  }
}

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
      await sendText(chatId, "Я понимаю только текстовые сообщения.");
      return json(200, { ok: true });
    }

    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().split("@")[0];

    if (cmd === "/start" || cmd === "/help") {
      await sendText(
        chatId,
        "Команды:\n/mail или /почта — разобрать почту и прислать итог\n/mail тест — то же, но ничего не менять\n/status — состояние\n\nЛюбой другой текст я перешлю в GigaChat как вопрос."
      );
    } else if (cmd === "/status") {
      const live = process.env.MAIL_LIVE === "1";
      await sendText(
        chatId,
        `Webhook работает. Почта: ${live ? "боевой режим" : "тест (MAIL_LIVE не включён)"}.`
      );
    } else if (cmd === "/mail" || cmd === "/почта") {
      await sendText(chatId, "Разбираю почту…");
      const dry = args.some((a) => /^(тест|test|dry)$/i.test(a));
      const { summary } = await runMail({ dry });
      await sendText(chatId, summary);
    } else if (cmd.startsWith("/")) {
      await sendText(chatId, "Не знаю такой команды. Список: /help");
    } else {
      await sendText(chatId, await gigaChat(CHAT_SYSTEM, text, 1000));
    }
  } catch (error) {
    console.error("Webhook handler error", error);
    const reply =
      process.env.DEBUG_ERRORS === "1"
        ? `Ошибка: ${String(error?.message || error).slice(0, 600)}`
        : "Не получилось выполнить. Попробуй ещё раз чуть позже.";
    try {
      await sendText(chatId, reply);
    } catch (sendError) {
      console.error("Telegram reply error", sendError);
    }
  }

  return json(200, { ok: true });
}
