// cita-monitor.js
// Мониторинг cita previa на torrevieja.sedelectronica.es
// Запускается GitHub Actions по cron'у. Одна проверка — один запуск.

const fs = require('fs');
const path = require('path');
const https = require('https');

// ========= КОНФИГ =========
const URL_CITA = 'https://torrevieja.sedelectronica.es/citaprevia.2';
const MESAS_TO_WATCH = ['MESA 1', 'MESA 4', 'MESA 5', 'MESA 6'];
const STATE_FILE = path.join(__dirname, 'state.json');

// Из GitHub Secrets
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// ==========================

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Отсутствуют TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID в env');
  process.exit(1);
}

// У torrevieja.sedelectronica.es кривая цепочка сертификатов
// (не приложен промежуточный). Отключаем проверку только для этого запроса.
// Безопасно т.к. страница публичная и ничего секретного не передаём.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

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
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
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
  const res = await fetch(URL_CITA, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9',
    },
    // undici в Node 18+ принимает dispatcher, но для совместимости проще
    // через переменную NODE_TLS_REJECT_UNAUTHORIZED — ставим ниже
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    process.exit(1);
  }

  const html = await res.text();
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

// Простейший способ победить кривой SSL в Node: переменная окружения.
// Применяется только на время работы скрипта (не глобально).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
