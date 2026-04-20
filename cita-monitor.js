// cita-monitor.js — ДИАГНОСТИЧЕСКАЯ ВЕРСИЯ
// Задача: посмотреть форму на шаге 1 (/citaprevia.1), чтобы понять как её сабмитить

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const URL_START = 'https://torrevieja.sedelectronica.es/citaprevia';
const MAX_REDIRECTS = 10;

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
        'Accept-Encoding': 'identity',
      },
      rejectUnauthorized: false,
    };
    const cookies = cookieHeader();
    if (cookies) options.headers['Cookie'] = cookies;

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
    req.end();
  });
}

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
    return { ...res, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

async function main() {
  console.log('=== Шаг 1: главная /citaprevia ===');
  const res = await fetchWithCookies(URL_START);
  console.log(`Финальный URL: ${res.finalUrl}`);
  console.log(`HTTP ${res.status}, HTML длина: ${res.body.length}`);
  console.log(`Cookies: ${Array.from(cookieJar.keys()).join(', ') || '(нет)'}`);
  console.log('');

  // Ищем все формы на странице
  console.log('=== Все <form> на странице ===');
  const forms = res.body.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
  console.log(`Найдено форм: ${forms.length}`);
  forms.forEach((f, i) => {
    console.log(`\n--- Форма ${i} ---`);
    console.log(f.slice(0, 2000));
    if (f.length > 2000) console.log(`... (всего ${f.length} символов)`);
  });

  console.log('\n\n=== Все radio-кнопки с label ===');
  // Ищем блоки вида <input type="radio" ... value="..."> ... <label ...>...</label>
  const radioRegex = /<input[^>]*type="radio"[^>]*>[\s\S]{0,500}?<label[^>]*>([^<]*)<\/label>/gi;
  let m;
  while ((m = radioRegex.exec(res.body)) !== null) {
    const inputTag = m[0].match(/<input[^>]*>/)[0];
    console.log(`\nradio: ${m[1].trim().slice(0, 80)}`);
    console.log(`  tag: ${inputTag}`);
  }

  console.log('\n\n=== Упоминания "empadronamiento" в HTML ===');
  const idx = res.body.toLowerCase().indexOf('empadronamiento');
  if (idx >= 0) {
    console.log(`Найдено на позиции ${idx}. Контекст:`);
    console.log(res.body.slice(Math.max(0, idx - 200), idx + 500));
  } else {
    console.log('НЕ найдено. Возможно мы не на том шаге.');
    console.log('\nПервые 2000 символов body:');
    console.log(res.body.slice(0, 2000));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

