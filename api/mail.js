// Запуск по расписанию (Vercel Cron). Vercel сам шлёт Authorization: Bearer <CRON_SECRET>.
import { runMail, notifyTelegram } from "../lib/mail.js";

export const maxDuration = 60;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json(401, { ok: false });
  }
  try {
    const { summary } = await runMail();
    await notifyTelegram(summary);
    return json(200, { ok: true });
  } catch (error) {
    console.error("Mail cron error", error);
    try {
      await notifyTelegram(`Ошибка разбора почты: ${String(error?.message || error).slice(0, 300)}`);
    } catch {}
    return json(500, { ok: false });
  }
}
