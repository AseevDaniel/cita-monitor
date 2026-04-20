// cita-monitor.js
// Мониторинг cita previa на torrevieja.sedelectronica.es
// Использует встроенный https модуль с cookie jar и ручными редиректами,
// потому что сайт использует сессионные куки через редиректы.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// ========= КОНФИГ =========
const URL_CITA = 'https://torrevieja.sedelectronica.es/citaprevia.2';
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

// Простейший cookie jar: Map<name, value>
const cookieJar = new Map();

function updateCookies(setCookieHeaders) {
  if (!setCookieHeaders) return;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const sc of arr) {
    // Берём только "name=value" до первой точки с запятой, атрибуты типа Path/HttpOnly игнорируем
    const pair = sc.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      cookieJar.set(name, value);
    }
  }
}

function cookieHeader() {
  if (cookieJar.size === 0) return '';
  return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Один GET запрос с возвратом статуса, хедеров и тела
function httpGet(targetUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity', // без gzip — легче обрабатывать
      },
      rejectUnauthorized: false, // кривой сертификат у сайта
    };
    const cookies = cookieHeader();
    if (cookies) options.headers['Cookie'] = cookies;

    const req = https.request(options, res => {
      updateCookies(res.headers['set-cookie']);
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          location: res.headers.location,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

// GET с ручной обработкой редиректов и накоплением куков
async function fetchWithCookies(targetUrl) {
  let current = targetUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await httpGet(current);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
      const next = new URL(res.location, current).toString();
      console.log(`  [${res.status}] redirect → ${next}`);
      current = next;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(text) {
  // Для телеги используем обычный fetch — у api.telegram.org нормальный SSL
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });
  if (!res.ok) {
    console.error('Telegram error:', await res.text());
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  console.log('Прогрев куков через главную...');
  // Сначала заходим на корень чтобы получить сессионные куки
  await fetchWithCookies('https://torrevieja.sedelectronica.es/info.0');
  console.log('  cookies:', Array.from(cookieJar.keys()).join(', ') || '(нет)');

  console.log('Загружаем страницу cita previa...');
  const res = await fetchWithCookies(URL_CITA);

  if (res.status !== 200) {
    console.error(`HTTP ${res.status}`);
    console.error('Первые 500 символов тела:', res.body.slice(0, 500));
    process.exit(1);
  }

  const html = res.body;
  console.log(`  Получено ${html.length} символов HTML`);

  const prevState = loadState();
  const currentState = {};
  const newSlots = [];

  for (const mesa of MESAS_TO_WATCH) {
    const pattern = new RegExp(
      `>${escapeRegex(mesa)}<\\/label>[\\s\\S]*?Primer día disponible:\\s*([^|<]+?)\\s*\\|`,
      'i'
    );
    const match = html.match(pattern);

    if (!match) {
      console.log(`[WARN] ${mesa} не найдена на странице`);
      continue;
    }

    const date = match[1].trim();
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
      `\n\n<a href="${URL_CITA}">Открыть сайт и записаться</a>\n\n` +
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
