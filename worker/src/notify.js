// Discord への知らせ。送り先（Webhook の URL）は、管理人ごとに KV に置く（ページにもリポジトリにも出さない）。

/** 知らせる出来事の種類（管理ページで、管理人ごとに選べる） */
export const EVENTS = [
  { id: 'pending', name: '承認待ちの登録（自動で公開にならなかったもの）', default: true },
  { id: 'takedown', name: '掲載停止の申請・登録解除', default: true },
  { id: 'change', name: '内容の変更・サイト認証', default: true },
  { id: 'public_new', name: '自動で公開された登録', default: false },
  { id: 'report_hold', name: '通報が集まって、一時保留になった作品', default: true },
  { id: 'report_link', name: '通報：リンク切れ・配布先の不備', default: true },
  { id: 'report', name: '通報（1件ごと。いたずらが続くと多くなります）', default: false },
];
/** はじめのころ（通報が無かったころ）にあった出来事。これより後に足した出来事は、保存したときに無かったものとして最初の設定で扱う */
const FIRST_EVENTS = ['pending', 'takedown', 'change', 'public_new'];
export const DEFAULT_EVENTS = EVENTS.filter((e) => e.default).map((e) => e.id);
const EVENT_IDS = new Set(EVENTS.map((e) => e.id));
export const cleanEvents = (list) => [...new Set((Array.isArray(list) ? list : []).filter((e) => EVENT_IDS.has(e)))];
export const ALL_EVENT_IDS = EVENTS.map((e) => e.id);

/** その管理人が、今選んでいる出来事（保存したあとに足した出来事は、最初の設定で ON/OFF） */
export function eventsOf(a) {
  if (!Array.isArray(a?.events)) return DEFAULT_EVENTS;
  const known = new Set(Array.isArray(a.events_known) ? a.events_known : FIRST_EVENTS);
  return [...a.events.filter((e) => EVENT_IDS.has(e)), ...EVENTS.filter((e) => !known.has(e.id) && e.default).map((e) => e.id)];
}

/** Discord の Webhook の URL だけを受け付ける（ほかの場所へ送らせないため） */
export const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;

/** 見せるときは、最後の4文字だけ */
export const maskWebhook = (u) => (u ? `https://discord.com/api/webhooks/…${String(u).slice(-4)}` : '');

/** 1つの Webhook に送る。失敗しても、受付そのものは止めない */
export async function sendDiscord(url, content, fetchImpl = fetch) {
  if (!WEBHOOK_RE.test(url || '')) return { ok: false, status: 0 };
  try {
    const r = await fetchImpl(`${url}?wait=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions を空にして、作品名などに @everyone が書かれていても、だれも呼ばれないようにする
      body: JSON.stringify({ username: 'CardWirth 共用カタログ', content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** 作品の知らせの文 */
export function entryMessage(env, kind, e, extra = '') {
  const page = `${pagesUrl(env)}/admin/#${e.id}`;
  const title = {
    pending: '🕒 承認待ちの登録があります',
    public_new: '🆕 新しい作品が公開されました',
    takedown: '🚫 掲載停止の申請がありました',
    unregister: '🗑 登録が解除されました',
    change: '✏️ 登録内容が変更されました',
    verify: '✅ サイト認証で、作者さん本人の登録になりました',
    report_hold: '⚠️ 通報が集まったので、一時保留にしました',
    report_link: '🔗 リンク切れ・配布先の不備の通報がありました',
    report: '📣 通報がありました',
  }[kind] || kind;
  const rating = e.rating === 'r18' ? '（R18）' : e.rating === 'r15' ? '（R15）' : '';
  const lines = [`**${title}**`, `${e.id}「${oneLine(e.name)}」${rating}／作者：${oneLine(e.author)}`];
  if (extra) lines.push(oneLine(extra));
  lines.push(`管理ページ：<${page}>`);
  return lines.join('\n');
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 200);
export const pagesUrl = (env) => String(env.PAGES_URL || 'https://seihayukimi-oss.github.io/cardwirth-catalog').replace(/\/+$/, '');

/** 管理人（いちばん上の人）だけに送る（安全の報告など） */
export async function notifyOwner(env, content, fetchImpl = fetch) {
  if (!env.KV) return { ok: false, status: 0 };
  let admins = {};
  try { admins = JSON.parse((await env.KV.get('admins')) || '{}'); } catch { /* 読めなければ送らない */ }
  return admins.owner?.webhook ? sendDiscord(admins.owner.webhook, content, fetchImpl) : { ok: false, status: 0 };
}

/**
 * その出来事を選んでいる管理人全員に送る
 * @param {object} env
 * @param {string} event  EVENTS の id
 * @param {string} content
 */
export async function notifyAdmins(env, event, content, fetchImpl = fetch) {
  if (!env.KV) return [];
  let admins = {};
  try { admins = JSON.parse((await env.KV.get('admins')) || '{}'); } catch { /* 読めなければ送らない */ }
  const targets = Object.values(admins).filter((a) => a?.webhook && eventsOf(a).includes(event));
  return Promise.all(targets.map((a) => sendDiscord(a.webhook, content, fetchImpl)));
}
