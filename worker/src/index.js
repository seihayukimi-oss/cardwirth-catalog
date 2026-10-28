// CardWirth 共用カタログの受付（Cloudflare Workers）
//  POST /api/register        作品を登録する（Turnstile・ブロックリスト・自動承認）→ 作品ID と 編集キー を返す
//  GET  /api/entry?id=…      作品の今のデータ（直す画面用。管理用の項目は出さない）
//  POST /api/edit            編集キーで直す（URL・名前を変えたら、もう一度自動承認を確かめる）
//  POST /api/unregister      編集キーで登録を解除する
//  POST /api/takedown        掲載をやめてほしい（だれでも。すぐ非公開になり、管理人が確かめる）
//  POST /api/verify/start    サイト認証を始める（確認用の文字を返す）
//  POST /api/verify/check    サイト認証を確かめる（見つかれば作者さん本人の登録にし、新しい編集キーを返す）
//  POST /api/report          通報（report.js。だれでも。人数が集まると一時保留）
//  POST /api/github/webhook  安全の報告の知らせ（security.js。GitHub の署名で確かめる）
//  /api/admin/…              管理ページ用（admin.js。管理人キーで確かめる）
// データは GitHub のリポジトリ（entries/）に、GitHub App で書く。秘密の値は Cloudflare の Secrets に置く。
// 管理人・操作の記録・Discord の送り先は、KV（非公開の置き場）に置く。登録などがあると、Discord に知らせる（notify.js）。

import { GitHub } from './github.js';
import { sha256hex, newKey, normKey, autoApprove, findToken } from './util.js';
import { toPublic } from '../../scripts/build.mjs';
import { UserError, isHttp, str, now, readEntry, saveEntry, clean } from './common.js';
import { handleAdmin } from './admin.js';
import { report } from './report.js';
import { githubHook } from './security.js';
import { notifyAdmins, entryMessage } from './notify.js';

function cors(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

/** Turnstile（いたずら防止）を確かめる */
async function checkTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) throw new UserError('受付の準備ができていません（Turnstile の設定がありません）', 503);
  if (!token) throw new UserError('「ロボットではありません」の確認をしてください');
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new UserError('「ロボットではありません」の確認がうまくいきませんでした。ページを読み込み直して、もう一度お試しください');
}

/** 登録フォームの値から、作品のデータを作る（直すときは、前のデータに重ねる） */
export function entryFromForm(f, prev = {}) {
  const downloads = [];
  const main = str(f.url, 2000), moved = str(f.moved_url, 2000);
  const kind = ['page', 'direct', 'list'].includes(f.url_kind) ? f.url_kind : 'page';
  if (moved && isHttp(moved)) {
    downloads.push({ label: str(f.moved_label, 100) || '移行先', url: moved, kind: ['page', 'direct', 'list'].includes(f.moved_kind) ? f.moved_kind : 'page', status: 'active' });
    if (isHttp(main)) downloads.push({ label: str(f.url_label, 100) || '移行前', url: main, kind, status: 'old' });
  } else if (isHttp(main)) {
    downloads.push({ label: str(f.url_label, 100), url: main, kind, status: 'active', ...(kind === 'list' && str(f.match, 100) ? { match: str(f.match, 100) } : {}) });
  }
  for (const line of String(f.more_urls || '').split(/\r?\n/).slice(0, 10)) {
    const m = /^(?:(.+?)\s*\|\s*)?(https?:\/\/\S+)$/.exec(line.trim());
    if (m && !downloads.some((d) => d.url === m[2])) downloads.push({ label: str(m[1], 100) || '予備', url: m[2], kind: 'page', status: 'mirror' });
  }
  const intro = String(f.intro || '').split(/\r?\n/).map((s) => s.trim()).filter(isHttp).slice(0, 10).map((url) => ({ url }));
  const tags = String(f.tags || '').split(/[、,，\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 30);
  const derivative = f.derivative === 'yes' ? { of: str(f.derivative_of, 200), basis: str(f.derivative_basis, 500) } : null;
  return {
    ...prev,
    type: ['scenario', 'skin', 'material'].includes(f.type) ? f.type : prev.type || 'scenario',
    name: str(f.name, 200),
    author: str(f.author, 200),
    version: str(f.version, 50),
    format: ['classic', 'next', 'wsn'].includes(f.format) ? f.format : prev.format || 'classic',
    downloads,
    ...(isHttp(f.site) ? { site: f.site.trim() } : { site: undefined }),
    intro,
    tags,
    description: str(f.description, 5000),
    rating: ['all', 'r15', 'r18'].includes(f.rating) ? f.rating : 'all',
    content: (Array.isArray(f.content) ? f.content : []).filter((c) => /^[a-z0-9][a-z0-9_-]{0,29}$/.test(c)).slice(0, 20),
    checked: ['readme', 'site', 'author', 'other'].includes(f.checked) ? f.checked : '',
    checked_note: str(f.checked_note, 300),
    derivative,
  };
}

/** 登録・直すときの確かめ（足りないものがあれば、分かる言葉で止める） */
function validate(f, entry) {
  if (!entry.name) throw new UserError('作品名を入れてください');
  if (!entry.author) throw new UserError('作者名を入れてください');
  if (!entry.downloads.length) throw new UserError('配布URL（https:// から始まるもの）を入れてください');
  if (!['all', 'r15', 'r18'].includes(f.rating)) throw new UserError('対象年齢（全年齢・R15・R18）を選んでください');
  if (!entry.checked) throw new UserError('「情報元・確認方法」を選んでください');
  if (f.derivative === 'yes' && (!entry.derivative.of || !entry.derivative.basis)) throw new UserError('改変版のときは、もとの作品と、改変してよいと分かるもの（規約のURLなど）を書いてください');
  const r = toPublic({ ...entry, id: 'e00000', state: 'public' });
  if (r.error) throw new UserError(r.error);
}

async function blocklist(gh) {
  const f = await gh.read('blocklist.json').catch(() => null);
  try { return f ? JSON.parse(f.text) : { urls: [], hosts: [], authors: [] }; } catch { return { urls: [], hosts: [], authors: [] }; }
}
function checkBlocked(entry, block) {
  const r = toPublic({ ...entry, id: 'e00000', state: 'public' }, block);
  if (r.skip === 'blocked') throw new UserError('この作品（配布先・作者）は、共用カタログでは受け付けていません', 403);
}

async function checkKey(entry, key) {
  if (!entry.edit_key_hash || !key) throw new UserError('編集キーを入れてください', 403);
  if ((await sha256hex(normKey(key))) !== entry.edit_key_hash) throw new UserError('編集キーが違います', 403);
}
/** 管理用の項目を除いた、見せてよい形 */
function publicView(e) {
  const { edit_key_hash, verify, takedown, auto_check, report_hold, ...rest } = e;
  return { ...rest, ...(verify ? { verifying: true } : {}) };
}
const pagesOf = (e) => [...new Set([...(e.downloads || []).filter((d) => d.kind !== 'direct').map((d) => d.url), ...(e.intro || []).map((i) => i.url), e.site].filter(isHttp))];

// ------------------------------------------------------------ 受付
async function register(env, gh, f, notify) {
  if (f.claim !== 'author' && !f.proxy_ok) throw new UserError('代理で登録するときは、「代理での登録が許可されている作品です」にチェックを入れてください');
  const entry = entryFromForm(f);
  validate(f, entry);
  checkBlocked(entry, await blocklist(gh));
  const auto = await autoApprove(entry);
  const key = newKey();
  const base = {
    ...entry,
    state: auto.ok ? 'public' : 'pending',
    // 作者さん本人かどうかは、サイト認証で確かめるまで「代理登録」として扱う
    claim: 'proxy',
    ...(f.claim === 'author' ? { claim_wish: 'author' } : {}),
    registered: now(), changed: now(),
    edit_key_hash: await sha256hex(normKey(key)),
    auto_check: { ok: auto.ok, where: auto.where, at: now() },
  };
  // 作品ID：今ある中でいちばん大きい番号の次。同時に登録されてぶつかったら、次の番号で
  const names = await gh.list('entries');
  let n = Math.max(0, ...names.map((x) => /^e(\d+)\.json$/.exec(x)?.[1]).filter(Boolean).map(Number)) + 1;
  for (let i = 0; i < 6; i++, n++) {
    const id = `e${String(n).padStart(5, '0')}`;
    const r = await gh.write(`entries/${id}.json`, `${JSON.stringify(clean({ id, ...base }), null, 2)}\n`, `登録：${id} ${entry.name}（${entry.author}）`);
    if (r.ok) {
      const saved = { id, ...base };
      if (base.state === 'pending') notify('pending', 'pending', saved, f.claim === 'author' ? '作者さん本人としての登録（サイト認証はまだ）' : '代理登録');
      else notify('public_new', 'public_new', saved, `確認できたページ：${auto.where}`);
      return { id, edit_key: key, state: base.state, where: auto.where };
    }
  }
  throw new UserError('混み合っています。少し待ってから、もう一度お試しください', 503);
}

async function edit(env, gh, f, notify) {
  const { sha, entry: prev } = await readEntry(gh, f.id);
  await checkKey(prev, f.key);
  if (prev.state === 'removed') throw new UserError('この作品は登録が解除されています');
  const next = entryFromForm(f, prev);
  validate(f, next);
  checkBlocked(next, await blocklist(gh));
  // 作品名・作者名・配布先を変えたら、もう一度自動承認を確かめる（だめなら承認待ちに戻す）
  const changed = JSON.stringify([prev.name, prev.author, prev.downloads, prev.intro, prev.site]) !== JSON.stringify([next.name, next.author, next.downloads, next.intro, next.site]);
  if (changed && ['public', 'pending'].includes(prev.state)) {
    const auto = await autoApprove(next);
    next.state = auto.ok ? 'public' : 'pending';
    next.auto_check = { ok: auto.ok, where: auto.where, at: now() };
  }
  next.changed = now();
  await saveEntry(gh, next, sha, `修正：${prev.id} ${next.name}`);
  if (next.state === 'pending' && prev.state !== 'pending') notify('pending', 'pending', next, '内容の変更で、配布ページなどに作品名・作者名が見つからなくなりました');
  else notify('change', 'change', next, prev.name !== next.name ? `作品名：${prev.name} → ${next.name}` : '');
  return { id: prev.id, state: next.state };
}

async function unregister(env, gh, f, notify) {
  const { sha, entry } = await readEntry(gh, f.id);
  await checkKey(entry, f.key);
  if (entry.state === 'removed') return { id: entry.id, state: 'removed' };
  await saveEntry(gh, { ...entry, state: 'removed', changed: now() }, sha, `登録解除：${entry.id} ${entry.name}`);
  notify('takedown', 'unregister', entry, '編集キーによる登録解除');
  return { id: entry.id, state: 'removed' };
}

async function takedown(env, gh, f, notify) {
  const { sha, entry } = await readEntry(gh, f.id);
  if (entry.state === 'private' || entry.state === 'removed') return { id: entry.id, state: entry.state };
  await saveEntry(gh, { ...entry, state: 'private', takedown: { at: now(), reason: str(f.reason, 500), from: entry.state }, changed: now() }, sha, `掲載をやめてほしいとの依頼：${entry.id} ${entry.name}`);
  notify('takedown', 'takedown', entry, `理由：${str(f.reason, 500) || '（書かれていません）'}`);
  return { id: entry.id, state: 'private' };
}

async function verifyStart(env, gh, f) {
  const { sha, entry } = await readEntry(gh, f.id);
  if (entry.state === 'removed') throw new UserError('この作品は登録が解除されています');
  const token = `cw-catalog-verify:${newKey(16).replace(/-/g, '').toLowerCase()}`;
  await saveEntry(gh, { ...entry, verify: { token, until: new Date(Date.now() + 7 * 86400000).toISOString() } }, sha, `サイト認証を始める：${entry.id}`);
  return { id: entry.id, token, pages: pagesOf(entry) };
}

async function verifyCheck(env, gh, f, notify) {
  const { sha, entry } = await readEntry(gh, f.id);
  const v = entry.verify;
  if (!v?.token || new Date(v.until) < new Date()) throw new UserError('サイト認証が始まっていないか、期限（7日）が過ぎています。もう一度「確認用コードを発行」を押してください');
  const where = await findToken(pagesOf(entry), v.token);
  if (!where) throw new UserError(`確認用コードが、配布ページ・紹介ページ・公式サイトのいずれにも見つかりませんでした。記載してから数分おいて、もう一度お試しください（確認用コード：${v.token}）`);
  const key = newKey();
  const { verify, claim_wish, ...rest } = entry;
  await saveEntry(gh, { ...rest, claim: 'author', verified: { at: now(), where }, edit_key_hash: await sha256hex(normKey(key)), changed: now() }, sha, `サイト認証：${entry.id} ${entry.name}（作者さん本人の登録にしました）`);
  notify('change', 'verify', entry, `確認できたページ：${where}`);
  return { id: entry.id, edit_key: key, where };
}

const ROUTES = {
  'POST /api/report': (env, gh, f, notify, req) => report(env, gh, f, notify, req.headers.get('CF-Connecting-IP')),
  'POST /api/register': register,
  'POST /api/edit': edit,
  'POST /api/unregister': unregister,
  'POST /api/takedown': takedown,
  'POST /api/verify/start': verifyStart,
  'POST /api/verify/check': verifyCheck,
};

export default {
  async fetch(req, env, ctx) {
    const h = cors(env, req);
    // Discord への知らせは、返事を返したあとで送る（作者さんを待たせない）
    const later = [];
    const notify = (event, kind, entry, extra) => later.push(notifyAdmins(env, event, entryMessage(env, kind, entry, extra)).catch(() => {}));
    const res = await route(req, env, h, notify);
    if (later.length) { const all = Promise.all(later); if (ctx?.waitUntil) ctx.waitUntil(all); else await all; }
    return res;
  },
};

async function route(req, env, h, notify) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);
  try {
    const gh = new GitHub(env);
    if (req.method === 'GET' && url.pathname === '/api/entry') {
      const { entry } = await readEntry(gh, url.searchParams.get('id'));
      if (entry.state === 'removed') throw new UserError('この作品は登録が解除されています', 404);
      return json({ entry: publicView(entry) }, 200, h);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, configured: !!(env.GH_APP_ID && env.GH_APP_PRIVATE_KEY && env.GH_APP_INSTALLATION_ID && env.TURNSTILE_SECRET), kv: !!env.KV, admin: !!env.ADMIN_OWNER_HASH, security_hook: !!env.GH_WEBHOOK_SECRET }, 200, h);
    }
    if (req.method === 'POST' && url.pathname === '/api/github/webhook') return json(await githubHook(req, env), 200, {});
    if (url.pathname.startsWith('/api/admin/')) return json(await handleAdmin(req, env, gh, url), 200, { ...h, 'Cache-Control': 'no-store' });
    const fn = ROUTES[`${req.method} ${url.pathname}`];
    if (!fn) throw new UserError('ありません', 404);
    if (Number(req.headers.get('Content-Length') || 0) > 64 * 1024) throw new UserError('送る内容が大きすぎます', 413);
    const f = await req.json().catch(() => { throw new UserError('送られた内容を読めませんでした'); });
    await checkTurnstile(env, f.turnstile, req.headers.get('CF-Connecting-IP'));
    return json(await fn(env, gh, f, notify, req), 200, h);
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status, h);
    console.error(e);
    return json({ error: `受付でエラーが起きました（${e.message || e}）。時間をおいて、もう一度お試しください` }, 500, h);
  }
}
