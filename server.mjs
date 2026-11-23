import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fetchChannel } from './tg.mjs';

try { for (const l of fs.readFileSync('.env', 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const E = process.env, PASS = E.ADMIN_PASSWORD;
if (!PASS) { console.error('Задайте ADMIN_PASSWORD в файле .env'); process.exit(1); }
const SECRET = E.SESSION_SECRET || crypto.createHash('sha256').update('s:' + PASS).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync('data', { recursive: true });
const db = new DatabaseSync('data/leads.db');
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY,dkey TEXT UNIQUE,hash TEXT,title TEXT,text TEXT,url TEXT,links TEXT DEFAULT '[]',source TEXT,channel TEXT,country TEXT,city TEXT,category TEXT,site_type TEXT,budget TEXT,score INT,temp TEXT,reason TEXT,summary TEXT,site_status TEXT DEFAULT 'не проверялся',tg TEXT DEFAULT '',phone TEXT DEFAULT '',status TEXT DEFAULT 'new',fav INT DEFAULT 0,note TEXT DEFAULT '',found_at INT,pub_at INT,history TEXT DEFAULT '[]');
CREATE INDEX IF NOT EXISTS lh ON leads(hash);
CREATE TABLE IF NOT EXISTS seen(k TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY,lead_id INT,text TEXT,ts INT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,ts INT,lvl TEXT,msg TEXT);`);
const run = (s, ...a) => db.prepare(s).run(...a), all = (s, ...a) => db.prepare(s).all(...a), one = (s, ...a) => db.prepare(s).get(...a);
const getS = (k, d) => { const r = one('SELECT v FROM kv WHERE k=?', k); return r ? JSON.parse(r.v) : d; };
const setS = (k, v) => run('INSERT INTO kv VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v));
const log = (l, m) => { run('INSERT INTO logs(ts,lvl,msg) VALUES(?,?,?)', Date.now(), l, String(m).slice(0, 500)); console.log(l, m); };

/* ---------- Разбор объявлений правилами (без AI) ---------- */
const SITE = /(сайт|лендинг|landing|интернет[- ]?магазин|веб[- ]?(разработ|студи|дизайн)|web[- ]?разработ|вёрстк|верстк|wordpress|tilda|тильда|битрикс|визитк)/i;
const ASK = /(ищу|ищем|нужен|нужна|нужно|требуется|необходим[аоы]?|кто (сделает|может|разработает|возьм[её]тся)|хочу (заказать|сделать|создать)|закажу|помогите найти|посоветуйте|подскажите.{0,30}(кто|разработчик|студи|исполнител))/i;
const DIRECT = /(ищу|ищем|кто (сделает|может|разработает|возьм[её]тся)|нужен (разработчик|исполнитель|веб)|подскажите.{0,30}(кто|разработчик|студи|исполнител))/i;
const OFFER = /(делаю сайт|делаем сайт|сделаю сайт|создаю сайт|создам сайт|разрабатываю сайт|разрабатываем сайт|портфолио|наша студия|в нашей студии|оказываем услуги|наши услуги|предлагаю услуги|предлагаем услуги|скидк|акци[яи]|вакансия|в штат|резюме|курс по|обучаем|обучение)/i;
const TYPES = [[/интернет[- ]?магазин/i, 'интернет-магазин'], [/лендинг|landing|одностраничн/i, 'лендинг'], [/визитк/i, 'сайт-визитка'], [/корпоратив/i, 'корпоративный сайт'], [/редизайн|переделать|переделк|обновить сайт/i, 'редизайн'], [/доработ|правк|исправить/i, 'доработка сайта']];
const CATS = [[/барбер|парикмахер|салон красот|маникюр/i, 'красота'], [/стомат|клиник|врач|медицин/i, 'медицина'], [/ремонт|строител|отделк/i, 'ремонт и строительство'], [/автосервис|автомойк|шиномонт/i, 'авто'], [/кафе|ресторан|пекарн/i, 'общепит'], [/юрист|юридич|адвокат/i, 'юридические услуги'], [/недвижимост|риелтор|риэлтор/i, 'недвижимость'], [/турфирм|турист|гостиниц/i, 'туризм'], [/фитнес|спортзал|йог/i, 'спорт'], [/репетитор|курсы|школ[аы]/i, 'образование']];
// Подсказки для города из текста; это не полный справочник, город берётся только если назван в самом объявлении
const CITY = [['москв', 'Москва', 'Россия'], ['петербург|спб', 'Санкт-Петербург', 'Россия'], ['новосибирск', 'Новосибирск', 'Россия'], ['екатеринбург', 'Екатеринбург', 'Россия'], ['казан', 'Казань', 'Россия'], ['краснодар', 'Краснодар', 'Россия'], ['самар(?!канд)', 'Самара', 'Россия'], ['ростов', 'Ростов-на-Дону', 'Россия'], ['минск', 'Минск', 'Беларусь'], ['гомел', 'Гомель', 'Беларусь'], ['алмат', 'Алматы', 'Казахстан'], ['астан|нур-султан', 'Астана', 'Казахстан'], ['шымкент', 'Шымкент', 'Казахстан'], ['караганд', 'Караганда', 'Казахстан'], ['бишкек', 'Бишкек', 'Кыргызстан'], ['ташкент', 'Ташкент', 'Узбекистан'], ['самарканд', 'Самарканд', 'Узбекистан'], ['ереван', 'Ереван', 'Армения'], ['баку', 'Баку', 'Азербайджан'], ['кишин[её]в', 'Кишинёв', 'Молдова'], ['душанбе', 'Душанбе', 'Таджикистан'], ['тбилиси', 'Тбилиси', 'Грузия']].map(([r, c, k]) => [new RegExp(r, 'i'), c, k]);
function classify(t, o = {}) {
  if (!o.force && (!SITE.test(t) || !ASK.test(t) || OFFER.test(t))) return null;
  const direct = DIRECT.test(t);
  const budget = t.match(/бюджет[^.\n]{0,40}/i)?.[0] || t.match(/\d[\d\s]{2,}\s?(₽|руб|тыс|\$|usd|тенге|₸|сом)/i)?.[0] || '';
  const tg = [...t.matchAll(/(?:@|t\.me\/)([A-Za-z0-9_]{5,32})/g)].map(m => '@' + m[1]).find(u => u.slice(1).toLowerCase() !== (o.ch || '').toLowerCase()) || '';
  const ph = t.match(/\+?\d[\d\s().-]{8,16}\d/)?.[0] || '', phone = ph.replace(/\D/g, '').length >= 10 ? ph.trim() : '';
  const age = o.pub ? (Date.now() - o.pub) / 864e5 : null, R = ['запрос на сайт'];
  let score = 40; const add = (n, why) => { score += n; R.push(why); };
  if (direct) add(25, 'прямой поиск исполнителя');
  if (/(срочно|быстро|сегодня|завтра|на этой неделе|в ближайшие дни)/i.test(t)) add(10, 'срочность');
  if (budget) add(10, 'указан бюджет'); if (tg || phone) add(10, 'есть контакт'); if (t.length >= 120) add(5, 'подробное описание');
  if (age !== null) { if (age <= 1) add(10, 'свежий пост'); else if (age <= 3) add(5, 'пост за последние дни'); else if (age > 30) add(-30, 'пост старше месяца'); else if (age > 14) add(-15, 'пост старше двух недель'); }
  score = Math.max(0, Math.min(100, score));
  const type = TYPES.find(([r]) => r.test(t))?.[1] || 'сайт', c = CITY.find(([r]) => r.test(t));
  const head = type[0].toUpperCase() + type.slice(1) + (c ? ' в ' + c[1] : '');
  return { score, temp: tier(score), tg, phone, budget, site_type: type, category: CATS.find(([r]) => r.test(t))?.[1] || '', city: c?.[1] || '', country: c?.[2] || '', reason: R.join(', '), summary: head, title: head + ': ' + t.replace(/\s+/g, ' ').slice(0, 70) };
}
const clean = s => s.replace(/\s*[—–]\s*/g, ', ').replace(/[«»"“”]/g, '').trim();
function buildMessage(l, prev) { // только факты из самого объявления, ничего не придумывается
  const where = l.source === 'telegram' ? 'ваше сообщение' : 'ваше объявление';
  const what = { 'интернет-магазин': 'создание интернет-магазина', 'лендинг': 'создание лендинга', 'сайт-визитка': 'создание сайта-визитки', 'корпоративный сайт': 'создание корпоративного сайта', 'редизайн': 'обновление сайта', 'доработка сайта': 'доработку сайта' }[l.site_type] || 'создание сайта';
  const ask = { 'интернет-магазин': 'Примерно сколько товаров планируете выкладывать?', 'лендинг': 'Уже есть понимание, какие блоки и тексты нужны?', 'редизайн': 'Подскажите, что именно не устраивает в нынешнем сайте?', 'доработка сайта': 'Что именно нужно доработать?' }[l.site_type] || 'Расскажите, что хотите получить от сайта?';
  const opts = [];
  for (const a of ['Здравствуйте!', 'Добрый день!']) for (const b of [`Увидел ${where} про ${what}.`, `Заметил ${where} про ${what}, подумал, что могу быть полезен.`]) for (const c of ['Я занимаюсь разработкой сайтов.', 'Делаю сайты для бизнеса.']) opts.push(`${a} ${b} ${c} ${ask}`);
  const fresh = opts.filter(x => !prev.includes(x)), pool = fresh.length ? fresh : opts;
  return clean(pool[Math.floor(Math.random() * pool.length)]);
}

/* ---------- Лиды ---------- */
const BAN = /(kwork|fl\.ru|freelance\.ru|upwork|fiverr|freelancer\.)/i; // биржи фриланса исключены
const KW = /(сайт|лендинг|landing|интернет[- ]?магазин|веб[- ]?(разработ|дизайн)|web[- ]?разработ|разработчик|вёрстк|верстк|wordpress|tilda|тильда|битрикс|визитк)/i;
const hashOf = t => crypto.createHash('sha1').update(t.toLowerCase().replace(/[^a-zа-яё0-9]/g, '').slice(0, 300)).digest('hex');
const tier = s => s >= 80 ? 'HOT' : s >= 50 ? 'WARM' : 'COLD';
async function notify(t) {
  if (!E.TG_BOT_TOKEN || !E.TG_CHAT_ID || !getS('notify', true)) return;
  try { await fetch(`https://api.telegram.org/bot${E.TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: E.TG_CHAT_ID, text: t, disable_web_page_preview: true }) }); } catch (e) { log('error', 'notify: ' + e.message); }
}
function addLead(o) {
  const hist = JSON.stringify([{ ts: Date.now(), status: 'new' }]);
  const r = run(`INSERT INTO leads(dkey,hash,title,text,url,links,source,channel,country,city,category,site_type,budget,score,temp,reason,summary,tg,phone,found_at,pub_at,history) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    o.dkey, hashOf(o.text), o.title, o.text, o.url || '', JSON.stringify(o.url ? [o.url] : []), o.source, o.channel || '', o.country || '', o.city || '', o.category || '', o.site_type || '', o.budget || '', o.score, o.temp, o.reason || '', o.summary || '', o.tg || '', o.phone || '', Date.now(), o.pub || null, hist);
  if (o.temp === 'HOT') notify(`Горячий лид (${o.score}): ${o.title}\n${o.url || ''}`);
  return Number(r.lastInsertRowid);
}
async function ingest(src, it, ch) {
  if (BAN.test(it.url + ' ' + it.text) || !KW.test(it.text)) return 0;
  if (it.pub && Date.now() - it.pub > getS('maxAge', 14) * 864e5) return 0; // старые посты не выдаём за актуальные заказы
  const dkey = src + ':' + it.id, hash = hashOf(it.text);
  if (one('SELECT 1 FROM seen WHERE k=?', dkey)) return 0;
  const dup = one('SELECT id,links FROM leads WHERE hash=?', hash);
  if (dup) { const l = JSON.parse(dup.links); if (!l.includes(it.url)) l.push(it.url); run('UPDATE leads SET links=? WHERE id=?', JSON.stringify(l), dup.id); run('INSERT INTO seen VALUES(?)', dkey); return 0; }
  const a = classify(it.text, { pub: it.pub, ch });
  run('INSERT INTO seen VALUES(?)', dkey);
  if (!a) return 0;
  addLead({ ...a, dkey, text: it.text, url: it.url, source: src, channel: ch, pub: it.pub });
  return 1;
}

/* ---------- Планировщик ---------- */
const st = { busy: false, next: null, timer: null, errors: 0, started: Date.now(), found: 0, fresh: 0 };
async function cycle() {
  if (st.busy) return; st.busy = true; let found = 0, fresh = 0; const chans = getS('channels', []);
  try {
    for (const ch of chans) {
      for (let n = 1; n <= 3; n++) {
        try {
          const items = await fetchChannel(ch, E.TG_PREVIEW_BASE || 'https://t.me/s/'); found += items.length;
          for (const it of items.slice(-30)) fresh += await ingest('telegram', it, ch);
          break;
        } catch (e) { if (n === 3) { log('error', `@${ch}: ${e.message}`); st.errors++; } else await sleep(n * 3000); }
      }
      await sleep(2000);
    }
    st.found = found; st.fresh = fresh; setS('last', { ts: Date.now(), found, fresh });
    log('info', `Поиск завершён: просмотрено ${found}, новых лидов ${fresh}`);
  } finally { st.busy = false; }
}
function schedule() {
  clearTimeout(st.timer); st.next = null; if (!getS('running', false)) return;
  const ms = Math.max(5, getS('interval', 15)) * 60000; st.next = Date.now() + ms;
  st.timer = setTimeout(async () => { await cycle().catch(e => log('error', e.message)); schedule(); }, ms);
}

/* ---------- HTTP ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const authed = req => { const t = (req.headers.cookie || '').match(/(?:^|; )lh=([^;]+)/)?.[1]; const [e, s] = (t || '').split('.'); return !!(e && s && s.length === 64 && +e > Date.now() && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sign(e)))); };
const fails = new Map();
const send = (res, code, body, type = 'application/json', h = {}) => { res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cache-control': 'no-store', ...h }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 2e5) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('bad json')); } }); });
const SRC = [['2gis', '2ГИС', 'Нужен ключ 2GIS API'], ['yandex', 'Яндекс Поиск', 'Нужен ключ Яндекс Search API'], ['gmaps', 'Google Maps', 'Нужен ключ Google Places API'], ['vk', 'VK', 'Нужен токен VK API'], ['avito', 'Авито, OLX, Юла', 'Нет официального API для такого поиска, нужно отдельное решение']];
const STAT = ['new', 'interested', 'contacted', 'waiting', 'replied', 'talks', 'client', 'rejected', 'skip'];
const esc = v => { v = String(v ?? ''); return '"' + (/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""') + '"'; };

function list(u) {
  const w = ['1=1'], p = [], g = k => u.searchParams.get(k);
  for (const [c, k] of [['temp=?', 'temp'], ['country=?', 'country'], ['source=?', 'source'], ['status=?', 'status']]) if (g(k)) { w.push(c); p.push(g(k)); }
  if (+g('min')) { w.push('score>=?'); p.push(+g('min')); }
  if (g('contacts')) w.push("(tg!='' OR phone!='')"); if (g('fav')) w.push('fav=1'); if (g('fresh')) w.push("status='new'");
  const lc = x => String(x || '').toLocaleLowerCase('ru'); // SQLite не сравнивает кириллицу без учёта регистра
  let r = all(`SELECT * FROM leads WHERE ${w.join(' AND ')} ORDER BY score DESC,found_at DESC`, ...p);
  if (g('city')) r = r.filter(x => lc(x.city) === lc(g('city')));
  if (g('q')) { const q = lc(g('q')); r = r.filter(x => lc(x.title + ' ' + x.summary + ' ' + x.text).includes(q)); }
  return r.slice(0, 300);
}
function stats() {
  const d0 = new Date().setHours(0, 0, 0, 0), c = (w, ...a) => one('SELECT COUNT(*) n FROM leads WHERE ' + w, ...a).n, last = getS('last', null);
  return { today: c('found_at>=?', d0), total: c('1=1'), hot: c("temp='HOT'"), warm: c("temp='WARM'"), cold: c("temp='COLD'"), fresh: c("status='new'"), done: c("status!='new'"),
    sources: getS('channels', []).length, active: getS('running', false) ? 1 : 0,
    countries: all("SELECT DISTINCT country v FROM leads WHERE country!='' ORDER BY 1").map(r => r.v), cities: all("SELECT DISTINCT city v FROM leads WHERE city!='' ORDER BY 1").map(r => r.v),
    search: { running: getS('running', false), busy: st.busy, last, next: st.next, up: Date.now() - st.started, errors: st.errors } };
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname, M = req.method;
    if (p === '/' && M === 'GET') return send(res, 200, fs.readFileSync('public/index.html'), 'text/html; charset=utf-8');
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (p === '/api/login' && M === 'POST') {
      const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: Date.now() };
      if (f.n >= 5 && Date.now() - f.t < 6e5) return send(res, 429, { error: 'Слишком много попыток, подождите 10 минут' });
      const b = await readBody(req), h = x => crypto.createHash('sha256').update(String(x)).digest();
      if (!crypto.timingSafeEqual(h(b.password), h(PASS))) { fails.set(ip, { n: f.n + 1, t: Date.now() }); return send(res, 401, { error: 'Неверный пароль' }); }
      fails.delete(ip); const e = Date.now() + 7 * 864e5;
      return send(res, 200, { ok: 1 }, 'application/json', { 'set-cookie': `lh=${e}.${sign('' + e)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${E.COOKIE_SECURE === '1' ? '; Secure' : ''}` });
    }
    if (!authed(req)) return send(res, 401, { error: 'auth' });
    if (M !== 'GET' && req.headers['x-req'] !== '1') return send(res, 403, { error: 'csrf' });
    let m;
    if (p === '/api/stats') return send(res, 200, stats());
    if (p === '/api/leads' && M === 'GET') return send(res, 200, list(u));
    if (p === '/api/leads' && M === 'POST') {
      const b = await readBody(req), text = String(b.text || '').trim(); if (!text) return send(res, 400, { error: 'Нужен текст' });
      if (BAN.test((b.url || '') + text)) return send(res, 400, { error: 'Биржи фриланса исключены' });
      const o = classify(text, { force: true });
      const id = addLead({ ...o, dkey: 'manual:' + crypto.randomUUID(), text, url: /^https?:\/\//.test(b.url || '') ? b.url : '', source: 'manual', country: b.country || o.country, city: b.city || o.city, tg: /^@[A-Za-z0-9_]{5,32}$/.test(b.tg || '') ? b.tg : o.tg });
      return send(res, 200, { id });
    }
    if ((m = p.match(/^\/api\/leads\/(\d+)$/))) {
      const id = +m[1], l = one('SELECT * FROM leads WHERE id=?', id); if (!l) return send(res, 404, { error: 'not found' });
      if (M === 'GET') return send(res, 200, { ...l, links: JSON.parse(l.links), history: JSON.parse(l.history), msgs: all('SELECT * FROM msgs WHERE lead_id=? ORDER BY id DESC', id) });
      if (M === 'DELETE') { run('DELETE FROM leads WHERE id=?', id); run('DELETE FROM msgs WHERE lead_id=?', id); return send(res, 200, { ok: 1 }); }
      if (M === 'PATCH') {
        const b = await readBody(req);
        if (b.status !== undefined) { if (!STAT.includes(b.status)) return send(res, 400, { error: 'status' }); const h = JSON.parse(l.history); h.push({ ts: Date.now(), status: b.status }); run('UPDATE leads SET status=?,history=? WHERE id=?', b.status, JSON.stringify(h), id); }
        if (b.fav !== undefined) run('UPDATE leads SET fav=? WHERE id=?', b.fav ? 1 : 0, id);
        if (b.note !== undefined) run('UPDATE leads SET note=? WHERE id=?', String(b.note).slice(0, 5000), id);
        return send(res, 200, { ok: 1 });
      }
    }
    if ((m = p.match(/^\/api\/leads\/(\d+)\/message$/)) && M === 'POST') {
      const id = +m[1], l = one('SELECT * FROM leads WHERE id=?', id); if (!l) return send(res, 404, { error: 'not found' });
      const prev = all('SELECT text FROM msgs WHERE lead_id=? ORDER BY id DESC LIMIT 12', id).map(r => r.text);
      const text = buildMessage(l, prev);
      run('INSERT INTO msgs(lead_id,text,ts) VALUES(?,?,?)', id, text, Date.now());
      return send(res, 200, { text });
    }
    if (p === '/api/sources') {
      const last = getS('last', null), ch = getS('channels', []);
      return send(res, 200, [{ id: 'telegram', name: 'Telegram, публичные каналы', state: !ch.length ? 'Добавьте каналы в настройках' : 'Подключен', last, count: one("SELECT COUNT(*) n FROM leads WHERE source='telegram'").n, note: 'Читает веб-превью t.me/s/канал. Закрытые группы и чаты недоступны.' }, ...SRC.map(([id, name, note]) => ({ id, name, state: 'Источник не подключен', note }))]);
    }
    if (p === '/api/settings') {
      if (M === 'PUT') {
        const b = await readBody(req);
        if (Array.isArray(b.channels)) setS('channels', [...new Set(b.channels.map(c => String(c).replace(/^@|^https?:\/\/t\.me\/(s\/)?/, '').trim()).filter(c => /^[A-Za-z0-9_]{4,32}$/.test(c)))]);
        if (+b.interval >= 5) setS('interval', Math.min(+b.interval, 1440));
        if (+b.maxAge >= 1) setS('maxAge', Math.min(+b.maxAge, 365));
        if (b.notify !== undefined) setS('notify', !!b.notify);
        schedule();
      }
      return send(res, 200, { channels: getS('channels', []), interval: getS('interval', 15), maxAge: getS('maxAge', 14), notify: getS('notify', true), bot: !!(E.TG_BOT_TOKEN && E.TG_CHAT_ID) });
    }
    if (p === '/api/search' && M === 'POST') {
      const a = (await readBody(req)).action;
      if (a === 'start') { setS('running', true); schedule(); cycle().catch(e => log('error', e.message)); }
      else if (a === 'stop') { setS('running', false); schedule(); }
      else if (a === 'now') cycle().catch(e => log('error', e.message));
      return send(res, 200, stats().search);
    }
    if (p === '/api/logs') return send(res, 200, all('SELECT * FROM logs ORDER BY id DESC LIMIT 100'));
    if (p === '/api/export.csv') {
      const cols = ['id', 'title', 'temp', 'score', 'status', 'source', 'url', 'country', 'city', 'category', 'site_type', 'tg', 'phone', 'summary', 'reason', 'note'];
      return send(res, 200, '\ufeff' + cols.join(',') + '\n' + all('SELECT * FROM leads ORDER BY found_at DESC').map(r => cols.map(c => esc(r[c])).join(',')).join('\n'), 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename=leads.csv' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { log('error', req.method + ' ' + req.url + ': ' + e.message); send(res, 500, { error: e.message.slice(0, 200) }); }
}).listen(+E.PORT || 3000, E.HOST || '127.0.0.1', () => { console.log('AI Lead Hunter: http://' + (E.HOST || '127.0.0.1') + ':' + (E.PORT || 3000)); if (getS('running', false)) { setTimeout(() => cycle().catch(() => { }).then(schedule), 3000); } });
