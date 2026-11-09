// lib/research.js — режим «Исследование» для Куруми (Vercel + GigaChat + Telegram)
// Любая тема. ESM. Node 18+ (глобальный fetch). Нужна env-переменная TAVILY_API_KEY.
// llm(messages) -> Promise<string>: твоя функция вызова GigaChat, messages = [{role, content}].
//
// Конвейер: 1 задание -> 2 поиск -> 3 чтение и проверка цитат/типов источников ->
//           4 сопоставление и противоречия -> 5 статусы достоверности (считает код) ->
//           6 отчёт от Куруми + список источников (добавляет код)

import { buildSystem } from './persona.js';
import { fetchPublicText } from './safe-fetch.js';

const L = {
  rounds: 2,          // итераций поиска
  queries: 3,         // запросов за итерацию
  perQuery: 4,        // ссылок на запрос
  maxPages: 8,        // страниц всего
  pageChars: 8000,    // сколько текста страницы отдаём модели
  maxNotes: 60,       // сколько заметок идёт в сопоставление
  deadlineMs: 50_000, // уложиться в лимит функции Vercel
};

// Типы источников
const TYPES = {
  primary: 'первоисточник',            // оригинальные спецификации, документация, стандарты, исследования, официальные сайты
  reference: 'справочник или каталог',
  article: 'статья или новость',
  opinion: 'мнения пользователей',
  commercial: 'реклама или магазин',
};
const OPINION_RE = /(drive2|forum|reddit|motor-talk|otzovik|irecommend|pikabu|vk\.com|quora|twitter|x\.com)/i;
const SHOP_RE = /(ozon|wildberries|market\.yandex|avito|amazon|aliexpress|ebay|dns-shop|citilink)/i;

const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
// Приводим текст к словам: без регистра, пунктуации, кавычек, тире, «ё»
const words = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Цитата подтверждена, если встречается в тексте целиком или хотя бы 60% её троек слов
function quoteInText(quote, hay) {
  const q = words(quote);
  if (!q) return false;
  if (hay.includes(` ${q} `)) return true;
  const w = q.split(' ');
  if (w.length < 4) return false;
  let total = 0, hit = 0;
  for (let i = 0; i + 3 <= w.length; i++) {
    total++;
    if (hay.includes(` ${w.slice(i, i + 3).join(' ')} `)) hit++;
  }
  return total > 0 && hit / total >= 0.6;
}

// Все числа из утверждения должны быть на странице
const numbersOk = (claim, hay) =>
  (claim.match(/\d+(?:[.,]\d+)?/g) || []).every((n) => hay.includes(` ${words(n)} `));

async function askJson(llm, system, user) {
  try {
    const raw = await llm([{ role: 'system', content: system }, { role: 'user', content: user }]);
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function search(query) {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: L.perQuery }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    return (j.results || []).map((x) => ({ url: x.url, title: x.title }));
  } catch { return []; }
}

async function fetchPage(url) {
  try {
    const html = await fetchPublicText(url);
    if (!html) return null;
    const text = html
      .replace(/<(script|style|noscript|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    return text.length > 200 ? text.slice(0, L.pageChars) : null;
  } catch { return null; }
}

// Шаг 3: факты + тип источника. Цитата обязана дословно быть в тексте страницы (проверяет код).
async function extract(llm, topic, page, stats) {
  const j = await askJson(
    llm,
    'Извлекай только факты из переданного текста, относящиеся к теме. Верни ТОЛЬКО JSON: ' +
      '{"type":"primary|reference|article|opinion|commercial","facts":[{"claim":"...","quote":"дословная цитата из текста, до 200 символов"}]}. ' +
      'type: primary — оригинальный документ или сайт автора данных (спецификации, документация производителя, стандарт, научная статья, официальный сайт); ' +
      'reference — каталог, справочник, энциклопедия; article — статья, обзор, новость; ' +
      'opinion — отзывы и личный опыт пользователей; commercial — реклама, описание в магазине. ' +
      'quote копируй из текста дословно, ничего не меняя и не пересказывая. Числа, названия и единицы не меняй. Если по теме ничего нет — facts: []. Ничего не выдумывай.',
    `Тема: ${topic}\nURL: ${page.url}\n\nТекст:\n${page.text}`
  );
  if (!j || !Array.isArray(j.facts)) return [];
  const d = domain(page.url);
  let type = TYPES[j.type] ? j.type : 'article';
  if (OPINION_RE.test(d)) type = 'opinion';
  else if (SHOP_RE.test(d)) type = 'commercial';
  const hay = ` ${words(page.text)} `;
  stats.proposed += j.facts.length;
  const kept = j.facts
    .filter((f) => f.claim && f.quote && quoteInText(f.quote, hay) && numbersOk(f.claim, hay))
    .map((f) => ({ claim: f.claim, quote: f.quote, type, url: page.url }));
  stats.kept += kept.length;
  return kept;
}

export async function research(rawTopic, llm, onProgress = () => {}) {
  const topic = rawTopic.replace(/^\s*(исследуй|изучи|разберись|проверь)[:,\s]+/i, '').trim() || rawTopic;
  const t0 = Date.now();
  const left = () => L.deadlineMs - (Date.now() - t0);
  const seen = new Set();
  const pages = [];
  const notes = [];
  const stats = { proposed: 0, kept: 0 };

  // Шаг 2: план поиска
  const plan = await askJson(
    llm,
    `Составь поисковые запросы для исследования темы: один на языке задания, один на английском, ` +
      `один нацеленный на первоисточник (официальные характеристики, документация, стандарт, исследование). ` +
      `Если тема привязана к стране или рынку, учти язык этого рынка. Верни ТОЛЬКО JSON: {"queries":["..."]}, не более ${L.queries}.`,
    topic
  );
  let queries = (plan?.queries || [topic]).slice(0, L.queries);

  for (let round = 1; round <= L.rounds && queries.length && left() > 20_000; round++) {
    onProgress(`Раунд ${round}: ищу (${queries.length} запр.)…`);
    const results = (await Promise.all(queries.map(search))).flat();
    const fresh = [];
    for (const r of results) {
      if (!seen.has(r.url) && pages.length + fresh.length < L.maxPages) { seen.add(r.url); fresh.push(r); }
    }

    onProgress(`Читаю страницы: ${fresh.length}…`);
    const got = (await Promise.all(fresh.map(async (r) => {
      const text = await fetchPage(r.url);
      return text ? { url: r.url, title: r.title, text } : null;
    }))).filter(Boolean);
    pages.push(...got);
    notes.push(...(await Promise.all(got.map((p) => extract(llm, topic, p, stats)))).flat());

    if (round < L.rounds && left() > 25_000) {
      const gap = await askJson(
        llm,
        'Оцени, чего не хватает для обоснованного вывода: первоисточников, подтверждения ключевых чисел, ' +
          'проверки спорных мест. Верни ТОЛЬКО JSON: {"done":true|false,"queries":["новые запросы о недостающем"]}.',
        `Тема: ${topic}\nУже найдено:\n${notes.map((n) => `- (${TYPES[n.type]}) ${n.claim}`).join('\n') || '(пока ничего)'}`
      );
      queries = gap && !gap.done ? (gap.queries || []).slice(0, L.queries) : [];
    }
  }

  if (!notes.length) {
    return `Ничего, что можно проверить по цитатам, не нашла. Прочитано страниц: ${pages.length}, ` +
      `фактов предложено моделью: ${stats.proposed}, подтверждено цитатами: ${stats.kept}. ` +
      `Попробуй переформулировать задание или добавить конкретики (названия, модели, номера, годы).`;
  }

  // Шаг 4: сопоставление, поиск противоречий
  onProgress('Сопоставляю данные…');
  const pool = notes.slice(0, L.maxNotes);
  const listing = pool.map((n, i) => `[${i}] (${TYPES[n.type]}, ${domain(n.url)}) ${n.claim}`).join('\n');
  const syn = await askJson(
    llm,
    'Ты сопоставляешь заметки из разных источников ТОЛЬКО по переданному списку. Объедини одинаковые утверждения в один пункт, ' +
      'сравни числа и характеристики, расхождения выноси отдельными пунктами со статусом contradiction (в claim опиши обе версии). ' +
      'Верни ТОЛЬКО JSON: {"items":[{"claim":"...","status":"confirmed|partial|unknown|contradiction","notes":[номера заметок]}]}. ' +
      'Мнения пользователей и реклама не подтверждают факты. Ничего не добавляй от себя.',
    `Тема: ${topic}\n\nЗаметки:\n${listing}`
  );
  const items = syn && Array.isArray(syn.items) && syn.items.length
    ? syn.items
    : pool.map((n, i) => ({ claim: n.claim, status: 'partial', notes: [i] })); // запасной вариант

  // Шаг 5: достоверность считает код, а не модель
  const srcNum = new Map(); // url -> номер
  const num = (url) => { if (!srcNum.has(url)) srcNum.set(url, srcNum.size + 1); return srcNum.get(url); };
  const groups = { confirmed: [], partial: [], contradiction: [], unknown: [] };

  for (const it of items) {
    const used = (it.notes || []).map((i) => pool[i]).filter(Boolean);
    let status = groups[it.status] ? it.status : 'unknown';
    if (!used.length && status !== 'unknown') status = 'unknown';
    if (status === 'confirmed') {
      const solid = used.filter((n) => ['primary', 'reference', 'article'].includes(n.type));
      const hasPrimary = used.some((n) => n.type === 'primary');
      const independent = new Set(solid.map((n) => domain(n.url))).size;
      if (!hasPrimary && independent < 2) status = 'partial';
    }
    const refs = [...new Set(used.map((n) => num(n.url)))].map((n) => `[${n}]`).join('');
    groups[status].push(`- ${it.claim} ${refs}`.trim());
  }

  // тип каждого использованного источника (для легенды)
  const typeOf = new Map(pool.map((n) => [n.url, n.type]));
  const legend = [...srcNum].map(([u, n]) => `[${n}] ${TYPES[typeOf.get(u)] || 'источник'}, ${domain(u)}`).join('\n');
  const titles = { confirmed: 'Подтверждено', partial: 'Частично подтверждено или только мнения', contradiction: 'Противоречия', unknown: 'Не удалось установить' };
  const factsText = Object.keys(groups)
    .filter((k) => groups[k].length)
    .map((k) => `${titles[k]}:\n${groups[k].join('\n')}`)
    .join('\n\n');

  // Шаг 6: отчёт пишет Куруми по результатам проверки
  onProgress('Пишу отчёт…');
  const answer = await llm([
    { role: 'system', content: buildSystem('research') },
    { role: 'user', content: `Задание: ${topic}\n\nРезультаты проверки:\n${factsText}\n\nИсточники:\n${legend}` },
  ]);

  // Ссылки добавляет программа, только на реально прочитанные страницы
  const links = [...srcNum].map(([u, n]) => `[${n}] ${u}`).join('\n');
  return `${answer.trim()}\n\nИсточники (страниц прочитано: ${pages.length}):\n${links}`;
}

// Telegram режет сообщения по 4096 символов
export function splitForTelegram(text, max = 4000) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > max) { parts.push(cur); cur = line; }
    else cur += (cur ? '\n' : '') + line;
  }
  if (cur) parts.push(cur);
  return parts;
          }
