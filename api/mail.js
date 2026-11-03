// Запуск по расписанию. Vercel Cron и GitHub Actions шлют Authorization: Bearer <CRON_SECRET>.
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
    const { summary, processed } = await runMail();
    // Пишем в Telegram только если что-то разобрали, чтобы не спамить пустыми отчётами.
    if (processed > 0) await notifyTelegram(summary);
    return json(200, { ok: true, processed });
  } catch (error) {
    console.error("Mail cron error", error);
    try {
      await notifyTelegram(`Ошибка разбора почты: ${String(error?.message || error).slice(0, 300)}`);
    } catch {}
    return json(500, { ok: false });
  }
}
