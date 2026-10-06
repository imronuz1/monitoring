// Telegram reports for the Firebase-backed family monitoring app.
// Bind TELEGRAM_GROUPS and REPORT_STATE to separate KV namespaces.
// Keep TELEGRAM_BOT_TOKEN as a Worker secret.

const FIREBASE_API_KEY = 'AIzaSyA7I5qjQISZpbMVsufqvpIeSzb3BTAoQBU';
const SITE_ORIGIN = 'https://imronuz1.github.io';
const REPORT_CHAT_ID = '-1004495000068';
const PROFILES = [
  ['fuzayl', 'Fuzayl'],
  ['imron', 'Imron'],
  ['komron', 'Комрон'],
];

function tashkentDate(input = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(input);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', SITE_ORIGIN);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Vary', 'Origin');
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function authorized(request) {
  const match = /^Bearer ([-_A-Za-z0-9.]+)$/.exec(request.headers.get('Authorization') || '');
  if (!match) return false;
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: match[1] }) },
  );
  if (!response.ok) return false;
  const account = (await response.json()).users?.[0];
  return !!account?.localId && !account.disabled;
}

function cleanSnapshot(raw, profile) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid report data');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')) throw new Error('Invalid report date');
  if (!Array.isArray(raw.subjects) || raw.subjects.length > 100) throw new Error('Invalid task list');
  const subjects = raw.subjects.map((subject) => {
    if (!subject || typeof subject !== 'object') throw new Error('Invalid task');
    const id = String(subject.id || '').slice(0, 80);
    const name = String(subject.name || '').slice(0, 120);
    const target = Math.max(1, Math.min(100000, Number(subject.target) || 1));
    if (!id || !name) throw new Error('Invalid task');
    return {
      id, name, target,
      icon: String(subject.icon || '•').slice(0, 8),
      unit: String(subject.unit || '').slice(0, 40),
      created_at: String(subject.created_at || '').slice(0, 10),
      deleted_at: String(subject.deleted_at || '').slice(0, 10),
      schedule: subject.schedule === 'saturday' ? 'saturday' : subject.schedule === 'daily' ? 'daily' : '',
    };
  });
  const progress = {};
  for (const subject of subjects) {
    const value = Number(raw.progress?.[subject.id] || 0);
    progress[subject.id] = Math.max(0, Math.min(100000, Number.isFinite(value) ? value : 0));
  }
  return {
    profile, date: raw.date, subjects, progress,
    child_name: String(raw.child_name || PROFILES.find(([key]) => key === profile)?.[1] || '').slice(0, 80),
    mood: ['great', 'good', 'okay', 'tough'].includes(raw.mood) ? raw.mood : '',
    note: String(raw.note || '').slice(0, 2000),
    synced_at: new Date().toISOString(),
  };
}

function activeSubjects(subjects, date) {
  return subjects.filter((subject) => {
    const stamp = /^s(\d{13})$/.exec(subject.id);
    const created = subject.created_at || (stamp ? tashkentDate(new Date(Number(stamp[1]))) : '');
    const lifecycle = (!created || date >= created) && (!subject.deleted_at || date < subject.deleted_at);
    const saturdayOnly = subject.schedule === 'saturday' ||
      (subject.schedule !== 'daily' && subject.name.trim().toLowerCase() === 'saturday exercises');
    return lifecycle && !saturdayOnly;
  });
}

function stars(percent) {
  if (percent >= 100) return '★★★';
  if (percent >= 66) return '★★☆';
  if (percent >= 33) return '★☆☆';
  return '—';
}

function block(snapshot, fallbackName, date) {
  const subjects = activeSubjects(snapshot.subjects, date);
  const progress = snapshot.date === date ? snapshot.progress : {};
  const mood = snapshot.date === date ? snapshot.mood : '';
  const note = snapshot.date === date ? snapshot.note : '';
  const moods = { great: '😄 Отлично', good: '🙂 Хорошо', okay: '😐 Нормально', tough: '😟 Тяжело' };
  let completed = 0;
  const lines = subjects.map((subject) => {
    const value = progress[subject.id] || 0;
    const target = subject.target || 1;
    completed += Math.min(1, value / target);
    const mark = value >= target ? '✅' : value > 0 ? '🟡' : '⬜';
    return `${mark} ${subject.icon} ${subject.name}: ${value}/${target} ${subject.unit}`.trim();
  });
  const percent = subjects.length ? Math.round(completed / subjects.length * 100) : 0;
  return [
    `👤 ${snapshot.child_name || fallbackName}`,
    `😊 Настроение: ${moods[mood] || '—'}`,
    `✅ Прогресс: ${percent}%`,
    `⭐ Звёзды: ${stars(percent)}`,
    ...lines,
    ...(note ? [`📝 Заметка: ${note}`] : []),
  ].join('\n');
}

async function sendTelegramMessage(env, chatId, text, topicId) {
  const body = { chat_id: chatId, text };
  if (topicId) body.message_thread_id = topicId;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Telegram send failed (${response.status})`);
}

async function sendReport(env, { force = false } = {}) {
  const date = tashkentDate();
  if (!force && await env.REPORT_STATE.get(`sent:${date}`)) return { sent: false, reason: 'already-sent', date };
  const snapshots = await Promise.all(PROFILES.map(async ([key]) => {
    const snapshot = await env.REPORT_STATE.get(`profile:${key}`, 'json');
    if (!snapshot) throw new Error(`Profile ${key} has not synced to Cloudflare yet`);
    return snapshot;
  }));
  const groupIds = JSON.parse(await env.TELEGRAM_GROUPS.get('chat_ids') || '[]')
    .filter(id => String(id) === REPORT_CHAT_ID);
  const topics = JSON.parse(await env.TELEGRAM_GROUPS.get('topic_ids') || '{}');
  if (!groupIds.length) throw new Error('No Telegram group is registered');
  const report = `📊 Ежедневный семейный прогресс\n📅 ${date}\n\n` +
    snapshots.map((snapshot, i) => block(snapshot, PROFILES[i][1], date)).join('\n\n────────────\n\n');
  for (const chatId of groupIds) await sendTelegramMessage(env, chatId, report, topics[chatId]);
  if (!force) await env.REPORT_STATE.put(`sent:${date}`, new Date().toISOString());
  return { sent: true, date, groups: groupIds.length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('OK');
    if (url.pathname === '/telegram-webhook') return new Response('Ignored');
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (request.headers.get('Origin') !== SITE_ORIGIN) return cors(json({ error: 'Forbidden origin' }, 403));
    if (request.method !== 'POST') return cors(json({ error: 'Method not allowed' }, 405));
    if (!await authorized(request)) return cors(json({ error: 'Unauthorized' }, 401));
    try {
      const syncMatch = /^\/sync\/(fuzayl|imron|komron)$/.exec(url.pathname);
      if (syncMatch) {
        const payload = cleanSnapshot(await request.json(), syncMatch[1]);
        await env.REPORT_STATE.put(`profile:${syncMatch[1]}`, JSON.stringify(payload));
        return cors(json({ ok: true, synced_at: payload.synced_at }));
      }
      if (url.pathname === '/send-now') return cors(json(await sendReport(env, { force: true })));
      return cors(json({ error: 'Not found' }, 404));
    } catch (error) {
      console.error(error);
      return cors(json({ error: String(error.message || error) }, 500));
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sendReport(env));
  },
};
