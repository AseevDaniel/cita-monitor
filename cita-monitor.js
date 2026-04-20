// cita-monitor.js
// Проходит визард /citaprevia шаг 1 (выбор услуги) → шаг 2 (список mesa)
// и парсит доступность слотов.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// ========= КОНФИГ =========
const BASE = 'https://torrevieja.sedelectronica.es';
const URL_START = `${BASE}/citaprevia`;
const TARGET_SERVICE = 'Altas de empadronamiento y cambios de domicilio';
const MESAS_TO_WATCH = ['MESA 1', 'MESA 4', 'MESA 5', 'MESA 6'];
const STATE_FILE = path.join(__dirname, 'state.json');
const MAX_REDIRECTS = 10;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// ==========================

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Отсутствуют TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID в env');
  process.exit(1);
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const cookieJar = new Map();

function updateCookies(setCookieHeaders) {
  if (!setCookieHeaders) return;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const sc of arr) {
    const pair = sc.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  if (cookieJar.size === 0) return '';
  return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function httpRequest(targetUrl, { method = 'GET', body = null, referer = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity',
    };
    if (referer) headers['Referer'] = referer;
    const cookies = cookieHeader();
    if (cookies) headers['Cookie'] = cookies;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
      headers['Origin'] = `${u.protocol}//${u.host}`;
    }

    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: false,
    };

    const req = https.request(options, res => {
      updateCookies(res.headers['set-cookie']);
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data, location: res.headers.location });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function fetchFollowRedirects(targetUrl, opts = {}) {
  let current = targetUrl;
  let method = opts.method || 'GET';
  let body = opts.body;
  let referer = opts.referer;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await httpRequest(current, { method, body, referer });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
      const next = new URL(res.location, current).toString();
      console.log(`  [${res.status}] ${method} → ${next}`);
      referer = current;
      current = next;
      // После редиректа переключаемся на GET (кроме 307/308)
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = null;
      }
      continue;
    }
    return { ...res, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) console.error('Telegram error:', await res.text());
}

/**
 * Из HTML шага 1 извлекаем:
 *   - formId      (id формы, напр. "idf9")
 *   - hiddenName  (имя Wicket hidden, напр. "idf9_hf_0")
 *   - submitUrl   (URL из onclick кнопки Continuar)
 *   - radioValue  (value радио-кнопки для нужной услуги)
 *   - radioName   (имя поля радио — ожидаем "appointmentAttention")
 */
function parseStep1(html) {
  // Ищем форму
  const formMatch = html.match(/<form[^>]+id="([^"]+)"[^>]+method="post"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) throw new Error('Форма не найдена на шаге 1');
  const formId = formMatch[1];
  const formBody = formMatch[2];

  // Hidden поле Wicket (обычно {formId}_hf_0)
  const hiddenMatch = formBody.match(/<input[^>]+type="hidden"[^>]+name="([^"]+_hf_\d+)"/i);
  const hiddenName = hiddenMatch ? hiddenMatch[1] : `${formId}_hf_0`;

  // Находим ВСЕ <button> и ищем тот что с name="next".
  // Атрибуты могут идти в любом порядке, поэтому не полагаемся на жёсткий паттерн.
  const buttonTags = formBody.match(/<button\b[^>]*>/gi) || [];
  let submitUrl = null;
  for (const tag of buttonTags) {
    if (!/\bname="next"/i.test(tag)) continue;
    // В onclick есть wicketSubmitFormById('FORM_ID', 'URL', 'next', ...)
    // Берём второй аргумент — URL. Учитываем что в HTML &amp;
    const onclickMatch = tag.match(/wicketSubmitFormById\('[^']+',\s*'([^']+)'/);
    if (!onclickMatch) continue;
    submitUrl = new URL(onclickMatch[1].replace(/&amp;/g, '&'), URL_START).toString();
    break;
  }
  if (!submitUrl) {
    // Диагностика: покажем какие кнопки вообще нашли
    console.error('Кнопки найденные в форме:');
    buttonTags.forEach((t, i) => console.error(`  [${i}] ${t}`));
    throw new Error('Не найден URL кнопки Continuar на шаге 1');
  }

  // Радио для нужной услуги. Формат:
  // <input name="appointmentAttention" ... value="radio22">
  // <label ...>Altas de empadronamiento y cambios de domicilio</label>
  const re = new RegExp(
    `<input[^>]+name="(appointmentAttention)"[^>]+value="([^"]+)"[^>]*>[\\s\\S]{0,500}?<label[^>]*>${escapeRegex(TARGET_SERVICE)}`,
    'i'
  );
  const rm = formBody.match(re);
  if (!rm) throw new Error(`Не найдена услуга "${TARGET_SERVICE}"`);
  const radioName = rm[1];
  const radioValue = rm[2];

  return { formId, hiddenName, submitUrl, radioName, radioValue };
}

async function main() {
  // Шаг 1: загрузить форму
  console.log('→ GET /citaprevia');
  const step1 = await fetchFollowRedirects(URL_START);
  if (step1.status !== 200) {
    console.error(`Шаг 1: HTTP ${step1.status}`);
    process.exit(1);
  }
  console.log(`  OK, ${step1.body.length} байт, URL: ${step1.finalUrl}`);

  const parsed = parseStep1(step1.body);
  console.log(`  formId=${parsed.formId}, hidden=${parsed.hiddenName}, radio=${parsed.radioValue}`);

  // Шаг 2: сабмит формы
  const postBody = new URLSearchParams({
    [parsed.hiddenName]: '',
    [parsed.radioName]: parsed.radioValue,
    next: '1',
  }).toString();

  console.log('→ POST шаг 1 (выбор услуги)');
  const step2 = await fetchFollowRedirects(parsed.submitUrl, {
    method: 'POST',
    body: postBody,
    referer: step1.finalUrl,
  });
  if (step2.status !== 200) {
    console.error(`Шаг 2: HTTP ${step2.status}`);
    console.error('Первые 500 символов:', step2.body.slice(0, 500));
    process.exit(1);
  }
  console.log(`  OK, ${step2.body.length} байт, URL: ${step2.finalUrl}`);

  // Проверим что мы реально на шаге 2 (со списком mesa)
  if (!/Seleccionar agenda/i.test(step2.body) && !/MESA \d/.test(step2.body)) {
    console.error('Не похоже на шаг 2 со списком mesa. Первые 1000 символов:');
    console.error(step2.body.slice(0, 1000));
    process.exit(1);
  }

  // Парсим mesa
  const html = step2.body;
  const prevState = loadState();
  const currentState = {};
  const newSlots = [];

  for (const mesa of MESAS_TO_WATCH) {
    const pattern = new RegExp(
      `>${escapeRegex(mesa)}<\\/label>[\\s\\S]*?Primer día disponible:\\s*([^|<]+?)\\s*\\|`,
      'i'
    );
    const m = html.match(pattern);
    if (!m) {
      console.log(`[WARN] ${mesa} не найдена на странице`);
      continue;
    }
    const date = m[1].trim();
    currentState[mesa] = date;
    console.log(`${mesa}: ${date}`);
    if (date !== '-' && date !== prevState[mesa]) {
      newSlots.push({ mesa, date });
    }
  }

  if (newSlots.length > 0) {
    const msg =
      `🎉 <b>Появились слоты на empadronamiento!</b>\n\n` +
      newSlots.map(s => `• <b>${s.mesa}</b>: ${s.date}`).join('\n') +
      `\n\n<a href="${URL_START}">Открыть сайт и записаться</a>\n\n` +
      `⚡ Беги быстро, слоты разбирают за минуты`;
    await sendTelegram(msg);
    console.log('[OK] Уведомление отправлено:', newSlots);
  }

  saveState(currentState);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
