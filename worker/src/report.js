// 通報（だれでも。Turnstile つき）。
//  ・同じ人（同じ IP）が、同じ作品に同じ理由で何度送っても、1人として数える
//  ・IP はそのまま置かない。KV にだけある「塩」を混ぜた SHA-256 の指紋にする（元の IP には戻せない）
//  ・理由ごとに決めた人数が集まったら、公開中の作品を一時保留にする（CWカタログでは、いつもは表示しない）
//    「リンク切れ・配布先の不備」は保留にせず、管理人に知らせるだけ
//  ・通報の記録（指紋・コメント）は KV に置き、管理人が片付けると消える。放っておいても1年で消える

import { UserError, str, now, readEntry, saveEntry, addLog } from './common.js';
import { sha256hex, newKey } from './util.js';

export const REASONS = [
  { id: 'r18', name: '年齢区分の不備（R18作品が全年齢・R15表記になっている等）', threshold: 5, held_reason: '年齢区分を確認中です' },
  { id: 'unauthorized', name: '無断転載・無断改変・作者様の意向違反', threshold: 20, held_reason: '掲載について確認中です' },
  { id: 'abuse', name: '危険なファイル・不適切なコンテンツ', threshold: 20, held_reason: '内容を確認中です' },
  { id: 'link', name: 'リンク切れ・配布先の不備', threshold: 0 },
  { id: 'other', name: 'その他', threshold: 20, held_reason: '内容を確認中です' },
];
const TTL = 365 * 86400;      // 通報の記録を置いておく長さ（片付けなければ1年で消える）
const MAX_ITEMS = 50;         // 1つの作品・理由で置いておくコメントの数
const DAILY_LIMIT = 30;       // 1人（1つの IP）が1日に送れる通報の数

/** 指紋に混ぜる「塩」。はじめて使うときに作って、KV にだけ置く */
async function salt(env) {
  let s = await env.KV.get('report_salt');
  if (!s) { s = newKey(32).replace(/-/g, ''); await env.KV.put('report_salt', s); }
  return s;
}
export const ipHash = async (env, ip) => (await sha256hex(`${await salt(env)}:${ip || 'unknown'}`)).slice(0, 32);

const keyOf = (id, reason) => `rep:${id}:${reason}`;
async function readRec(env, id, reason) {
  try { return JSON.parse((await env.KV.get(keyOf(id, reason))) || 'null'); } catch { return null; }
}

/** POST /api/report */
export async function report(env, gh, f, notify, ip) {
  if (!env.KV) throw new UserError('通報の受付の準備ができていません', 503);
  const reason = REASONS.find((r) => r.id === f.reason);
  if (!reason) throw new UserError('通報の理由を選んでください');
  const comment = str(f.comment, 500);
  if (reason.id === 'other' && !comment) throw new UserError('「その他」を選んだときは、詳細内容をご記入ください');
  const { sha, entry } = await readEntry(gh, f.id);
  const state = entry.state || 'public';
  if (state !== 'public' && state !== 'held') throw new UserError('この作品は、今カタログに載っていません', 404);

  const h = await ipHash(env, ip);
  const rlKey = `rl:${h}:${now().slice(0, 10)}`;
  const sent = Number((await env.KV.get(rlKey)) || 0);
  if (sent >= DAILY_LIMIT) throw new UserError('今日はたくさんの通報を受け付けました。明日もう一度お試しください', 429);

  const rec = (await readRec(env, entry.id, reason.id)) || { id: entry.id, reason: reason.id, ips: [], items: [], first: now() };
  if (rec.ips.includes(h)) return { id: entry.id, received: false, already: true };
  rec.ips.push(h);
  rec.items = [...rec.items, { at: now(), who: h.slice(0, 8), ...(comment ? { comment } : {}) }].slice(-MAX_ITEMS);
  rec.last = now();
  await env.KV.put(rlKey, String(sent + 1), { expirationTtl: 2 * 86400 });

  // 決めた人数が集まったら、一時保留にする（公開中のときだけ）
  let held = false;
  if (reason.threshold && rec.ips.length >= reason.threshold && state === 'public') {
    try {
      await saveEntry(gh, { ...entry, state: 'held', held_reason: reason.held_reason, report_hold: { reason: reason.id, count: rec.ips.length, at: now() }, changed: now() }, sha, `通報：${entry.id} 一時保留（${reason.name}）`);
      held = true;
      rec.held = now();
      await addLog(env, { id: 'system', name: '通報（自動）' }, 'report-hold', entry.id, `${entry.name}：${reason.name}（${rec.ips.length}人）→ 一時保留`);
    } catch { /* ほかの変更と重なったら、次の通報でもう一度 */ }
  }
  await env.KV.put(keyOf(entry.id, reason.id), JSON.stringify(rec), {
    expirationTtl: TTL,
    metadata: { id: entry.id, reason: reason.id, count: rec.ips.length, last: rec.last, ...(rec.held ? { held: rec.held } : {}) },
  });

  const extra = `理由：${reason.name}（${rec.ips.length}人目）${comment ? `／${comment}` : ''}`;
  if (held) notify('report_hold', 'report_hold', entry, `理由：${reason.name}（${rec.ips.length}人）`);
  if (reason.id === 'link') notify('report_link', 'report_link', entry, extra);
  notify('report', 'report', entry, extra);
  return { id: entry.id, received: true, held };
}

// ------------------------------------------------------------ 管理ページ用
/** 作品ごとの通報の数 { e00001: { r18: 3, link: 1 } } */
export async function reportSummary(env) {
  const out = {};
  let cursor;
  for (let i = 0; i < 10; i++) {
    const r = await env.KV.list({ prefix: 'rep:', ...(cursor ? { cursor } : {}) });
    for (const k of r.keys) {
      const m = k.metadata || {};
      const [, id, reason] = k.name.split(':');
      (out[id] ||= {})[reason] = m.count || 0;
    }
    if (r.list_complete) break;
    cursor = r.cursor;
  }
  return out;
}

/** 1つの作品の通報（コメントつき） */
export async function reportDetails(env, id) {
  const list = [];
  for (const reason of REASONS) {
    const rec = await readRec(env, id, reason.id);
    if (rec) list.push({ reason: reason.id, name: reason.name, threshold: reason.threshold, count: rec.ips.length, first: rec.first, last: rec.last, held: rec.held || '', items: rec.items.slice().reverse() });
  }
  return { id, reports: list };
}

/** 通報を片付ける（reason を省くと、その作品の全部） */
export async function clearReports(env, id, reason) {
  const targets = reason ? REASONS.filter((r) => r.id === reason) : REASONS;
  const done = [];
  for (const r of targets) {
    if (await env.KV.get(keyOf(id, r.id))) { await env.KV.delete(keyOf(id, r.id)); done.push(r.name); }
  }
  return done;
}
