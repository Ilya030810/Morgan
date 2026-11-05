
import { gigaChat, gigaChatImage } from "../lib/gigachat.js";
import { runMail } from "../lib/mail.js";
import { research } from "../lib/research.js";
import { buildSystem, pick, MAIL_INTRO, MAIL_TEST_INTRO, WELCOME, MODE_MSG } from "../lib/persona.js";
import { getVal, setVal, setNx, persistent } from "../lib/store.js";

export const maxDuration = 60;

const MAX_TELEGRAM_TEXT = 3900;
const MAX_IMAGE_SIZE = 15 * 1024 * 1024;

const BTN = {
  help: "💬 Помощь",
  research: "🔎 Исследование",
  mail: "📧 Почта",
  mailTest: "📧 Почта (тест)",
};

// Старые подписи кнопок: у пользователя на телефоне может висеть прежняя клавиатура.
const LEGACY_RESEARCH = "🔎 Проверить по источникам";
const LEGACY_CAR = "🔧 Ремонт авто";

const KEYBOARD = {
  keyboard: [
    [{ text: BTN.help }, { text: BTN.research }],
    [{ text: BTN.mail }, { text: BTN.mailTest }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const MODES = ["help", "research"];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Кнопки прикрепляются к последнему куску каждого ответа.
async function sendText(chatId, text) {
  const chunks = (text || "Пустой ответ.").match(
    new RegExp(`[\\s\\S]{1,${MAX_TELEGRAM_TEXT}}`, "g")
  );

  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i] };

    if (i === chunks.length - 1) {
      payload.reply_markup = KEYBOARD;
    }

    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status}`);
    }
  }
}

/* ---------- Загрузка фотографий из Telegram ---------- */

async function downloadTelegramImage(message) {
  const photo = Array.isArray(message.photo) && message.photo.length
    ? message.photo[message.photo.length - 1]
    : null;

  const document = message.document?.mime_type?.startsWith("image/")
    ? message.document
    : null;

  const file = photo || document;

  if (!file?.file_id) {
    throw new Error("Фотография не найдена");
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;

  // Получаем путь к файлу.
  const metaResponse = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(file.file_id)}`
  );

  const meta = await metaResponse.json().catch(() => ({}));

  if (!metaResponse.ok || !meta.ok || !meta.result?.file_path) {
    throw new Error(
      `Telegram getFile failed: ${meta.description || metaResponse.status}`
    );
  }

  if (Number(meta.result.file_size) > MAX_IMAGE_SIZE) {
    throw new Error("Фото слишком большое. Максимальный размер — 15 МБ.");
  }

  // Скачиваем изображение.
  const imageResponse = await fetch(
    `https://api.telegram.org/file/bot${token}/${meta.result.file_path}`
  );

  if (!imageResponse.ok) {
    throw new Error(`Telegram image download failed: ${imageResponse.status}`);
  }

  const buffer = Buffer.from(await imageResponse.arrayBuffer());

  if (!buffer.length || buffer.length > MAX_IMAGE_SIZE) {
    throw new Error("Фото пустое или превышает лимит 15 МБ.");
  }

  // Определяем настоящий формат по сигнатуре файла.
  let mime;

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    mime = "image/jpeg";
  } else if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    )
  ) {
    mime = "image/png";
  } else {
    throw new Error("Поддерживаются только изображения JPEG и PNG.");
  }

  return { buffer, mime };
}

/* ---------- Режим и история ---------- */

const modeKey = (id) => `mode:${id}`;
const histKey = (id) => `hist:${id}`;

// Если в хранилище остался удалённый режим (например, «car»), считаем это обычной помощью.
async function getMode(chatId) {
  const m = await getVal(modeKey(chatId));
  return MODES.includes(m) ? m : "help";
}

async function loadHistory(chatId) {
  try {
    const v = JSON.parse((await getVal(histKey(chatId))) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function saveHistory(chatId, history) {
  await setVal(
    histKey(chatId),
    JSON.stringify(history.slice(-8)),
    60 * 60 * 24 * 3
  );
}

async function setMode(chatId, mode) {
  await setVal(modeKey(chatId), mode);
  await setVal(histKey(chatId), "[]", 60 * 60 * 24 * 3);
}

function composeUser(history, text) {
  if (!history.length) return text;

  const log = history
    .map((h) => `${h.r === "u" ? "Пользователь" : "Куруми"}: ${h.t}`)
    .join("\n");

  return `Предыдущий диалог:\n${log}\n\nНовое сообщение пользователя:\n${text}`;
}

/* ---------- Адаптер GigaChat для research.js ---------- */

// Не больше 3 одновременных запросов к GigaChat, чтобы не ловить 429.
function limiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || !queue.length) return;

    active++;

    const { fn, resolve, reject } = queue.shift();

    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// research.js вызывает llm(messages), а gigaChat принимает (system, user, maxTokens).
function makeLlm() {
  const limit = limiter(3);

  return (messages) => {
    const system = messages.find((m) => m.role === "system")?.content || "";

    const user = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n\n");

    return limit(() => gigaChat(system, user, 1800));
  };
}

/* ---------- Вебхук ---------- */

export function GET() {
  return json(405, { ok: false, error: "POST only" });
}

export async function POST(request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (
    secret &&
    request.headers.get("x-telegram-bot-api-secret-token") !== secret
  ) {
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

  if (!message?.chat?.id) {
    return json(200, { ok: true, ignored: true });
  }

  const chatId = message.chat.id;
  const userId = String(message.from?.id ?? "");

  const allowList = (process.env.ALLOWED_TELEGRAM_USER_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  // Список обязателен: без него бот не отвечает никому.
  if (!allowList.includes(userId)) {
    return json(200, { ok: true, ignored: true });
  }

  // Защита от повторной обработки обновлений Telegram.
  if (update.update_id !== undefined) {
    const fresh = await setNx(`upd:${update.update_id}`, "1", 600);

    if (!fresh) {
      return json(200, { ok: true, duplicate: true });
    }
  }

  try {
    const text = (message.text || "").trim();

    /* ---------- Обработка фотографий ---------- */

    const hasPhoto =
      (Array.isArray(message.photo) && message.photo.length > 0) ||
      message.document?.mime_type?.startsWith("image/");

    if (hasPhoto) {
      await sendText(chatId, "Фото получила. Сейчас рассмотрю...");

      const image = await downloadTelegramImage(message);

      const history = await loadHistory(chatId);

      // Telegram передаёт подпись фотографии в caption, а не text.
      const prompt =
        (message.caption || "").trim() ||
        "Опиши, что изображено на фотографии, и обрати внимание на важные детали.";

      const userPrompt = composeUser(
        history,
        `Пользователь отправил фотографию. Его вопрос: ${prompt}`
      );

      const system =
        buildSystem("help") +
        "\n\nПользователь прислал изображение. Внимательно рассмотри его. " +
        "Описывай только то, что действительно видно. Не выдумывай детали. " +
        "Если это техническая проблема, перечисли наблюдения, возможные причины " +
        "и способы проверки. Отделяй то, что видно на фото, от предположений.";

      const reply = await gigaChatImage(
        system,
        userPrompt,
        image,
        1200
      );

      await sendText(chatId, reply);

      history.push({
        r: "u",
        t: `[Фото] ${prompt}`.slice(0, 800),
      });

      history.push({
        r: "a",
        t: String(reply).slice(0, 700),
      });

      await saveHistory(chatId, history);

      return json(200, { ok: true });
    }

    /* ---------- Обычные сообщения ---------- */

    if (!text) {
      await sendText(
        chatId,
        "Я понимаю текст и фотографии JPEG/PNG. Голосовые пока не умею разбирать."
      );

      return json(200, { ok: true });
    }

    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().split("@")[0];

    // Кнопки (приходят обычным текстом)
    if (text === BTN.help) {
      await setMode(chatId, "help");
      await sendText(chatId, MODE_MSG.help);

    } else if (text === BTN.research || text === LEGACY_RESEARCH) {
      await setMode(chatId, "research");
      await sendText(chatId, MODE_MSG.research);

    } else if (text === LEGACY_CAR) {
      // Режима ремонта больше нет.
      await sendText(chatId, WELCOME);

    } else if (
      text === BTN.mail ||
      text === BTN.mailTest ||
      cmd === "/mail" ||
      cmd === "/почта"
    ) {
      const dry =
        text === BTN.mailTest ||
        args.some((a) => /^(тест|test|dry)$/i.test(a));

      await sendText(chatId, pick(dry ? MAIL_TEST_INTRO : MAIL_INTRO));

      const { summary } = await runMail({ dry });

      await sendText(chatId, summary);

    } else if (cmd === "/start" || cmd === "/help") {
      await sendText(chatId, WELCOME);

    } else if (cmd === "/status") {
      const live = process.env.MAIL_LIVE === "1";
      const mode = await getMode(chatId);

      await sendText(
        chatId,
        `Webhook работает. Режим: ${mode}. Почта: ${
          live ? "боевой режим" : "тест (MAIL_LIVE не включён)"
        }. Память: ${
          persistent ? "Upstash" : "только в оперативке (может сбрасываться)"
        }.`
      );

    } else if (cmd === "/сброс") {
      await setVal(histKey(chatId), "[]", 60 * 60 * 24 * 3);

      await sendText(chatId, "Диалог сбросила. Начинаем с чистого листа.");

    } else if (cmd.startsWith("/")) {
      await sendText(chatId, "Не знаю такой команды. Список: /help");

    } else {
      // Обычное сообщение: отвечаем в текущем режиме с характером Куруми.
      const mode = await getMode(chatId);

      if (mode === "research") {
        await sendText(
          chatId,
          "Ищу и проверяю источники. Это займёт до минуты, не дёргай меня."
        );

        await sendText(chatId, await research(text, makeLlm()));

      } else {
        const history = await loadHistory(chatId);

        const reply = await gigaChat(
          buildSystem(mode),
          composeUser(history, text),
          1200
        );

        await sendText(chatId, reply);

        history.push({ r: "u", t: text.slice(0, 800) });
        history.push({ r: "a", t: String(reply).slice(0, 700) });

        await saveHistory(chatId, history);
      }
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
