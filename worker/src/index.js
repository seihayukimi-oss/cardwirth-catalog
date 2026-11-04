// CardWirth 共用カタログの受付（Cloudflare Workers）
//  POST /api/register        作品を登録する（Turnstile・ブロックリスト・自動承認）→ 作品ID と 編集キー を返す
//  GET  /api/entry?id=…      作品の今のデータ（直す画面用。管理用の項目は出さない）
//  POST /api/edit            編集キーで直す（URL・名前を変えたら、もう一度自動承認を確かめる）
//  POST /api/unregister      編集キーで登録を解除する
//  POST /api/takedown        掲載をやめてほしい（だれでも。すぐ非公開になり、管理人が確かめる）
//  POST /api/verify/start    サイト認証を始める（確認用の文字を返す。ほかの作品IDも並べれば、まとめて）
//  POST /api/verify/check    サイト認証を確かめる（見つかった作品を作者さん本人の登録にし、新しい編集キーを返す。
//                            作者本人の編集キーを渡せば、新しいキーは作らず、そのキーで直せるようにする）
//  ※ 作者本人の編集キー：サイト認証が済んだ作品の編集キー。同じ作者名の作品なら、まとめて認証・あとからの登録でも使える
//  POST /api/report          通報（report.js。だれでも。人数が集まると一時保留）
//  POST /api/github/webhook  安全の報告の知らせ（security.js。GitHub の署名で確かめる）
//  /api/admin/…              管理ページ用（admin.js。管理人キーで確かめる）
// データは GitHub のリポジトリ（entries/）に、GitHub App で書く。秘密の値は Cloudflare の Secrets に置く。
// 管理人・操作の記録・Discord の送り先は、KV（非公開の置き場）に置く。登録などがあると、Discord に知らせる（notify.js）。

import { GitHub } from './github.js';
import { sha256hex, newKey, normKey, normText, autoApprove, fetchPageText } from './util.js';
import { toPublic, siteLabel } from '../../scripts/build.mjs';
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
/**
 * 作者本人の編集キー：サイト認証が済んだ作品（claim が author）のうち、このキーで直せる作品を探す（作品の一覧は tarball 1回）
 * @returns {Promise<{hash: string, entries: object[]}>}
 */
async function authorKeyEntries(gh, key) {
  if (!normKey(key)) return { hash: '', entries: [] };
  const hash = await sha256hex(normKey(key));
  const files = await gh.snapshot((p) => /^entries\/e\d{5,}\.json$/.test(p));
  const entries = [];
  for (const text of files.values()) {
    try { const e = JSON.parse(text); if (e.claim === 'author' && e.edit_key_hash === hash && e.state !== 'removed') entries.push(e); } catch { /* 読めないものは飛ばす */ }
  }
  return { hash, entries };
}
/** 作者本人の編集キーが、この作者名の作品に使えるか（認証済みの作品と作者名が同じとき） */
const keyFitsAuthor = (owned, author) => owned.some((e) => normText(e.author) === normText(author));
/**
 * 同じ作者名で、別のサイトで認証した「作者本人」の作品（同じ名前の別の作者さんか、なりすましかもしれない）。
 * 止めはしないで、管理人に知らせる。作品の一覧は tarball 1回
 */
async function allEntries(gh) {
  const files = await gh.snapshot((p) => /^entries\/e\d{5,}\.json$/.test(p));
  const all = [];
  for (const text of files.values()) { try { all.push(JSON.parse(text)); } catch { /* 読めないものは飛ばす */ } }
  return all;
}
function sameNameOthers(all, author, site, exceptIds = []) {
  if (!site) return [];
  const byId = new Map(all.map((e) => [e.id, e]));
  const siteOf = (e, depth = 0) => (e?.verified?.where ? siteLabel(e.verified.where) : e?.verified?.from && depth < 5 ? siteOf(byId.get(e.verified.from), depth + 1) : '');
  const skip = new Set(exceptIds);
  return all.filter((e) => e.claim === 'author' && e.state !== 'removed' && !skip.has(e.id) && normText(e.author) === normText(author))
    .map((e) => ({ id: e.id, site: siteOf(e) })).filter((x) => x.site && x.site !== site);
}
const sameNameNote = (others) => (others.length ? `⚠ 同じ作者名で、別のサイトで認証した作者本人の作品があります（${others.map((x) => `${x.id}：${x.site}`).join('、')}）。同じ名前の別の作者さんか、なりすましでないか確かめてください` : '');
const AUTHOR_KEY_NG = '作者本人の編集キーが違うか、作者名がサイト認証済みの作品と違います（作者名は、認証済みの作品と同じにしてください）';
/** 作品IDの並び（空白・改行・「、」で区切る。最初の1つ＋ほか。15作品まで） */
function idList(first, more) {
  const ids = [...new Set([first, ...String(more || '').split(/[\s、,，]+/)].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
  for (const id of ids) if (!/^e\d{5,}$/.test(id)) throw new UserError(`作品ID「${id}」が正しくありません（例：e00012）`);
  if (!ids.length) throw new UserError('作品IDを入れてください');
  if (ids.length > 15) throw new UserError('まとめて認証できるのは、一度に15作品までです');
  return ids;
}

const pagesOf = (e) => [...new Set([...(e.downloads || []).filter((d) => d.kind !== 'direct').map((d) => d.url), ...(e.intro || []).map((i) => i.url), e.site].filter(isHttp))];

// ------------------------------------------------------------ 受付
async function register(env, gh, f, notify) {
  if (f.claim !== 'author' && !f.proxy_ok) throw new UserError('代理で登録するときは、「代理での登録が許可されている作品です」にチェックを入れてください');
  const entry = entryFromForm(f);
  validate(f, entry);
  checkBlocked(entry, await blocklist(gh));
  // 作者本人の編集キー（サイト認証が済んだ作品のキー）があれば、サイト認証なしで作者本人の登録にして、同じキーで直せるようにする
  let owned = null;
  if (f.claim === 'author' && normKey(f.author_key)) {
    const { hash, entries } = await authorKeyEntries(gh, f.author_key);
    if (!keyFitsAuthor(entries, entry.author)) throw new UserError(AUTHOR_KEY_NG, 403);
    const src = entries.find((e) => e.verified?.where) || entries[0];
    owned = { hash, from: src.id, where: src.verified?.where || '' };
  }
  // 同じ作者名で、別のサイトの作者本人がいないか（作者本人の編集キーで登録するとき）
  const others = owned ? sameNameOthers(await allEntries(gh), entry.author, siteLabel(owned.where)) : [];
  const auto = await autoApprove(entry);
  const key = owned ? '' : newKey();
  const base = {
    ...entry,
    state: auto.ok ? 'public' : 'pending',
    // 作者さん本人かどうかは、サイト認証（か作者本人の編集キー）で確かめるまで「代理登録」として扱う
    claim: owned ? 'author' : 'proxy',
    ...(f.claim === 'author' && !owned ? { claim_wish: 'author' } : {}),
    ...(owned ? { verified: { at: now(), via: 'author_key', from: owned.from, ...(owned.where ? { where: owned.where } : {}) } } : {}),
    ...(others.length ? { same_name: { others, at: now() } } : {}),
    registered: now(), changed: now(),
    edit_key_hash: owned ? owned.hash : await sha256hex(normKey(key)),
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
      const warn = sameNameNote(others);
      if (base.state === 'pending') notify('pending', 'pending', saved, [owned ? `作者さん本人の登録（作者本人の編集キー：${owned.from} と同じ）` : f.claim === 'author' ? '作者さん本人としての登録（サイト認証はまだ）' : '代理登録', warn].filter(Boolean).join('\n'));
      else notify('public_new', 'public_new', saved, [`確認できたページ：${auto.where}`, warn].filter(Boolean).join('\n'));
      return { id, edit_key: key || null, author_key_used: !!owned, state: base.state, where: auto.where };
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
  const ids = idList(f.id, f.more_ids);
  const token = `cw-catalog-verify:${newKey(16).replace(/-/g, '').toLowerCase()}`;
  const until = new Date(Date.now() + 7 * 86400000).toISOString();
  const got = [];
  for (const id of ids) got.push({ id, ...(await readEntry(gh, id)) });
  for (const g of got) if (g.entry.state === 'removed') throw new UserError(`${g.id} は登録が解除されています`);
  // まとめて認証するときも、確認用コードは1つ（どの作品にも同じコードを置く）
  for (const g of got) await saveEntry(gh, { ...g.entry, verify: { token, until } }, g.sha, `サイト認証を始める：${g.id}`);
  return { id: ids[0], ids, token, pages: [...new Set(got.flatMap((g) => pagesOf(g.entry)))] };
}

async function verifyCheck(env, gh, f, notify) {
  const ids = idList(f.id, f.more_ids);
  const got = [];
  for (const id of ids) got.push({ id, ...(await readEntry(gh, id)) });
  const first = got[0].entry.verify;
  if (!first?.token || new Date(first.until) < new Date()) throw new UserError('サイト認証が始まっていないか、期限（7日）が過ぎています。もう一度「確認用コードを発行」を押してください');
  const token = first.token;
  // 確認用コードを、どのページで見つけたか（作品のページを合わせて、1つずつ1回だけ見に行く）
  const pages = [...new Set(got.flatMap((g) => pagesOf(g.entry)))].slice(0, 10);
  const found = new Set();
  for (const u of pages) { const t = await fetchPageText(u); if (t && t.includes(token)) found.add(u); }
  if (!found.size) throw new UserError(`確認用コードが、配布ページ・紹介ページ・公式サイトのいずれにも見つかりませんでした。記載してから数分おいて、もう一度お試しください（確認用コード：${token}）`);
  // 作者本人の編集キー（任意）：あれば新しいキーは作らず、そのキーで直せるようにする
  let owned = null;
  if (normKey(f.author_key)) {
    const { hash, entries } = await authorKeyEntries(gh, f.author_key);
    if (!entries.length) throw new UserError('作者本人の編集キーが違います（サイト認証が済んだ作品の編集キーを入れてください）', 403);
    owned = { hash, entries };
  }
  const key = owned ? '' : newKey();
  const hash = owned ? owned.hash : await sha256hex(normKey(key));
  const done = [], failed = [];
  let all = null; // 同じ作者名・別のサイトの作者本人を調べるための、作品の一覧（1回だけ読む）
  for (const g of got) {
    const v = g.entry.verify;
    // その作品に登録してあるページのどれかに、コードがあること（ほかの人のページでは認証しない）
    const where = pagesOf(g.entry).find((u) => found.has(u));
    if (g.entry.state === 'removed') failed.push({ id: g.id, reason: '登録が解除されています' });
    else if (v?.token !== token) failed.push({ id: g.id, reason: '確認用コードの発行に入っていません' });
    else if (!where) failed.push({ id: g.id, reason: 'この作品のページ（配布ページ・紹介ページ・作者さんのサイト）に、確認用コードがありません' });
    else if (owned && !keyFitsAuthor(owned.entries, g.entry.author)) failed.push({ id: g.id, reason: '作者名が、作者本人の編集キーの作品と違います' });
    else {
      const { verify, claim_wish, same_name, ...rest } = g.entry;
      all ||= await allEntries(gh);
      const others = sameNameOthers(all, g.entry.author, siteLabel(where), ids);
      await saveEntry(gh, { ...rest, claim: 'author', verified: { at: now(), where }, ...(others.length ? { same_name: { others, at: now() } } : {}), edit_key_hash: hash, changed: now() }, g.sha, `サイト認証：${g.id} ${g.entry.name}（作者さん本人の登録にしました）`);
      notify('change', 'verify', g.entry, [`確認できたページ：${where}`, sameNameNote(others)].filter(Boolean).join('\n'));
      done.push(g.id);
    }
  }
  if (!done.length) throw new UserError(`作者本人の登録にできた作品はありませんでした。${failed.map((x) => `${x.id}：${x.reason}`).join('／')}`);
  return { id: done[0], ids: done, failed, edit_key: key || null, author_key_used: !!owned, where: [...found][0] };
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
