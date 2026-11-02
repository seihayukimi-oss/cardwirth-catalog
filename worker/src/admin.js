// 管理用の窓口（/api/admin/…）。管理ページ（site/admin/）から使う。
//
// ・管理人は2種類：
//     管理人（owner）  … キーの指紋（SHA-256）を Cloudflare の Secret「ADMIN_OWNER_HASH」に置く。1人だけ
//     副管理人（sub）  … 管理人が管理ページで追加する。キーの指紋は KV に置く
//   できることは同じ。副管理人の追加・削除・キーの作り直しだけは管理人だけ（自分のキーの作り直しは副管理人もできる）
// ・KV（非公開の置き場）に置くもの：
//     admins       … 管理人の名前・キーの指紋・Discord の送り先・知らせる出来事
//     log:…        … 操作の記録（だれが・いつ・何を）。400日で消える
// ・作品の状態・ラベル・ブロックリスト・ラベルの種類は、これまでどおりリポジトリに書く（コミットの文に管理人の名前は入れない）

import { UserError, LABEL_RE, STATE_NAMES, str, now, isHttp, readEntry, saveEntry, readJson, addLog, sameHex } from './common.js';
import { reportSummary, reportDetails, clearReports } from './report.js';
import { sha256hex, newKey, normKey } from './util.js';
import { EVENTS, DEFAULT_EVENTS, cleanEvents, eventsOf, ALL_EVENT_IDS, WEBHOOK_RE, maskWebhook, sendDiscord, pagesUrl } from './notify.js';

/** CWカタログに最初から入っている注意のラベル（catalog.json の content_labels で名前を変えたり、増やしたりできる） */
export const BUILTIN_LABELS = [
  { id: 'gore', name: 'グロ・残酷描写' },
  { id: 'horror', name: 'ホラー' },
  { id: 'sexual', name: '性的な表現（R15相当）' },
];

const MAX_ADMINS = 20;

// ------------------------------------------------------------ 管理人
async function loadAdmins(env) {
  try { return JSON.parse((await env.KV.get('admins')) || '{}') || {}; } catch { return {}; }
}
const saveAdmins = (env, admins) => env.KV.put('admins', JSON.stringify(admins));

/** 管理人キーを確かめる */
export async function authAdmin(env, req) {
  if (!env.KV) throw new UserError('管理用の置き場（KV）が、まだ用意できていません', 503, 'no-kv');
  const raw = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const key = normKey(raw);
  const ownerHash = String(env.ADMIN_OWNER_HASH || '').trim().toLowerCase();
  const admins = await loadAdmins(env);
  if (!ownerHash && !Object.values(admins).some((a) => a.role === 'sub')) {
    throw new UserError('最初の管理人キーが、まだ登録されていません（このページの「はじめての設定」をご覧ください）', 401, 'setup');
  }
  if (key.length < 16) throw new UserError('管理人キーを入れてください', 401);
  const h = await sha256hex(key);
  if (sameHex(h, ownerHash)) {
    return { me: { ...(admins.owner || {}), id: 'owner', role: 'owner', name: admins.owner?.name || '管理人' }, admins };
  }
  for (const a of Object.values(admins)) {
    if (a.role === 'sub' && sameHex(a.key_hash, h)) return { me: a, admins };
  }
  throw new UserError('管理人キーが違います', 401);
}

/** ページに見せてよい形（キーの指紋・送り先そのものは出さない） */
const adminView = (a) => ({
  id: a.id, name: a.name, role: a.role, events: eventsOf(a),
  webhook: maskWebhook(a.webhook), created: a.created || '', by: a.by || '',
});

// ------------------------------------------------------------ 作品
/** 管理ページに見せる形（編集キーの指紋だけ外す。ほかは公開リポジトリにあるものと同じ） */
const entryView = (e) => { const { edit_key_hash, ...rest } = e; return rest; };

async function listEntries(env, gh) {
  const files = await gh.snapshot((p) => /^entries\/e\d{5,}\.json$/.test(p) || p === 'catalog.json' || p === 'blocklist.json');
  const entries = [];
  for (const [path, text] of files) {
    if (!path.startsWith('entries/')) continue;
    try { entries.push(entryView(JSON.parse(text))); } catch { entries.push({ id: path.slice(8, -5), state: 'broken', name: '（読めないファイル）', author: '' }); }
  }
  entries.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const parse = (p, fb) => { try { return JSON.parse(files.get(p) || ''); } catch { return fb; } };
  const catalog = parse('catalog.json', {});
  return {
    entries,
    reports: await reportSummary(env),
    labels: mergedLabels(catalog.content_labels),
    blocklist: normBlock(parse('blocklist.json', {})),
  };
}

const SETTABLE = ['public', 'held', 'private', 'removed'];
async function setState(env, gh, f, me) {
  if (!SETTABLE.includes(f.state)) throw new UserError('状態が正しくありません');
  const { sha, entry } = await readEntry(gh, f.id);
  const prev = entry.state || 'public';
  const reason = str(f.reason, 300);
  if (prev === f.state && (f.state !== 'held' || reason === (entry.held_reason || ''))) return { id: entry.id, state: prev };
  const next = { ...entry, state: f.state, changed: now() };
  if (f.state === 'held') next.held_reason = reason; else delete next.held_reason;
  if (f.state !== 'held') delete next.report_hold; // 通報で保留になっていた印も外す
  if (prev === 'pending' && f.state === 'public') next.approved = { at: now() };
  await saveEntry(gh, next, sha, `管理：${entry.id} ${STATE_NAMES[prev] || prev}→${STATE_NAMES[f.state]}`);
  await addLog(env, me, prev === 'pending' && f.state === 'public' ? 'approve' : 'state', entry.id, `${entry.name}：${STATE_NAMES[prev] || prev}→${STATE_NAMES[f.state]}${reason ? `（${reason}）` : ''}`);
  return { id: entry.id, state: f.state };
}

async function setLabels(env, gh, f, me) {
  if (!['all', 'r15', 'r18'].includes(f.rating)) throw new UserError('対象年齢（全年齢・R15・R18）を選んでください');
  const content = [...new Set((Array.isArray(f.content) ? f.content : []).filter((c) => LABEL_RE.test(c)))].slice(0, 20);
  const { sha, entry } = await readEntry(gh, f.id);
  const same = (entry.rating || 'all') === f.rating && JSON.stringify([...(entry.content || [])].sort()) === JSON.stringify([...content].sort());
  if (same) return { id: entry.id, rating: f.rating, content };
  await saveEntry(gh, { ...entry, rating: f.rating, content, changed: now() }, sha, `管理：${entry.id} シナリオラベルを直す`);
  const rn = { all: '全年齢', r15: 'R15', r18: 'R18' };
  // 記録には、ラベルの ID ではなく名前を書く（増やしたラベルの名前は catalog.json から）
  const names = new Map(mergedLabels((await readJson(gh, 'catalog.json', {}).catch(() => ({ data: {} }))).data.content_labels).map((l) => [l.id, l.name]));
  await addLog(env, me, 'labels', entry.id, `${entry.name}：${rn[entry.rating || 'all']}→${rn[f.rating]}${content.length ? `・${content.map((c) => names.get(c) || c).join('・')}` : ''}`);
  return { id: entry.id, rating: f.rating, content };
}

// ------------------------------------------------------------ ラベルの種類・ブロックリスト
/** 最初からのラベルに、catalog.json の content_labels を重ねる（同じ id は名前を上書き） */
export function mergedLabels(custom = []) {
  const map = new Map(BUILTIN_LABELS.map((l) => [l.id, { ...l, builtin: true }]));
  for (const l of Array.isArray(custom) ? custom : []) {
    if (!l || !LABEL_RE.test(l.id || '')) continue;
    map.set(l.id, { id: l.id, name: str(l.name, 30) || l.id, ...(str(l.description, 200) ? { description: str(l.description, 200) } : {}), ...(map.get(l.id)?.builtin ? { builtin: true } : {}) });
  }
  return [...map.values()];
}

async function setContentLabels(env, gh, f, me) {
  const list = Array.isArray(f.labels) ? f.labels : [];
  if (list.length > 30) throw new UserError('ラベルは30種類までです');
  const seen = new Set();
  const out = [];
  for (const l of list) {
    const id = str(l?.id, 30).toLowerCase(), name = str(l?.name, 30);
    if (!LABEL_RE.test(id)) throw new UserError(`ラベルのID「${id}」が正しくありません（英小文字・数字・_・- で30文字まで。最初は英小文字か数字）`);
    if (!name) throw new UserError(`ラベル「${id}」の名前を入れてください`);
    if (seen.has(id)) throw new UserError(`ラベルのID「${id}」が重なっています`);
    seen.add(id);
    const builtin = BUILTIN_LABELS.find((b) => b.id === id);
    const description = str(l?.description, 200);
    // 最初からあるラベルで、名前も説明も変えていないものは書かない
    if (builtin && builtin.name === name && !description) continue;
    out.push({ id, name, ...(description ? { description } : {}) });
  }
  const { sha, data } = await readJson(gh, 'catalog.json', {});
  const before = JSON.stringify(data.content_labels || []);
  if (before === JSON.stringify(out)) return { labels: mergedLabels(out) };
  const r = await gh.write('catalog.json', `${JSON.stringify({ ...data, content_labels: out }, null, 2)}\n`, '管理：シナリオラベルの種類を直す', sha);
  if (!r.ok) throw new UserError('ほかの変更と重なりました。読み込み直してから、もう一度お試しください', 409);
  await addLog(env, me, 'label-types', '', out.map((l) => `${l.id}=${l.name}`).join('、') || '（追加のラベルなし）');
  return { labels: mergedLabels(out) };
}

const hostRe = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z0-9-]{2,63}$/;
function normBlock(b = {}) {
  const uniq = (a) => [...new Set(a)];
  return {
    urls: uniq((Array.isArray(b.urls) ? b.urls : []).map((u) => String(u).trim()).filter(isHttp)).slice(0, 1000),
    hosts: uniq((Array.isArray(b.hosts) ? b.hosts : []).map((h) => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((h) => hostRe.test(h))).slice(0, 1000),
    authors: uniq((Array.isArray(b.authors) ? b.authors : []).map((a) => str(String(a), 200)).filter(Boolean)).slice(0, 1000),
  };
}

async function setBlocklist(env, gh, f, me) {
  const { sha, data } = await readJson(gh, 'blocklist.json', {});
  const cur = normBlock(data);
  let next;
  if (f.add && typeof f.add === 'object') {
    next = normBlock({ urls: [...cur.urls, ...(f.add.urls || [])], hosts: [...cur.hosts, ...(f.add.hosts || [])], authors: [...cur.authors, ...(f.add.authors || [])] });
  } else {
    next = normBlock(f);
  }
  const diff = (k) => {
    const a = new Set(cur[k]), b = new Set(next[k]);
    return [...[...b].filter((x) => !a.has(x)).map((x) => `＋${x}`), ...[...a].filter((x) => !b.has(x)).map((x) => `－${x}`)];
  };
  const changes = [...diff('urls'), ...diff('hosts'), ...diff('authors')];
  if (!changes.length) return { blocklist: cur };
  const r = await gh.write('blocklist.json', `${JSON.stringify({ note: data.note || '登録を受け付けない URL・サイト（ホスト名）・作者名。管理人が追加する。ここに当たる作品はカタログに出さない', ...next }, null, 2)}\n`, '管理：ブロックリストを直す', sha);
  if (!r.ok) throw new UserError('ほかの変更と重なりました。読み込み直してから、もう一度お試しください', 409);
  await addLog(env, me, 'blocklist', '', changes.join('、'));
  return { blocklist: next };
}

// ------------------------------------------------------------ 自分の設定・Discord
async function saveMe(env, f, me, admins) {
  const a = { ...(admins[me.id] || {}), id: me.id, role: me.role, name: me.name, ...(me.role === 'sub' ? { key_hash: me.key_hash } : {}) };
  if (f.name !== undefined) {
    const name = str(f.name, 30);
    if (!name) throw new UserError('名前を入れてください');
    a.name = name;
  }
  if (typeof f.webhook === 'string') {
    const w = f.webhook.trim();
    if (!w) delete a.webhook;
    else if (!WEBHOOK_RE.test(w)) throw new UserError('Discord の Webhook の URL（https://discord.com/api/webhooks/… の形）を入れてください');
    else a.webhook = w;
  }
  if (f.events !== undefined) { a.events = cleanEvents(f.events); a.events_known = ALL_EVENT_IDS; }
  admins[me.id] = a;
  await saveAdmins(env, admins);
  await addLog(env, a, 'settings', '', `${typeof f.webhook === 'string' ? (f.webhook.trim() ? 'Discordの送り先を設定・' : 'Discordの送り先を外す・') : ''}知らせる出来事：${eventsOf(a).length}種類`);
  return { me: adminView(a) };
}

async function testDiscord(env, me) {
  if (!me.webhook) throw new UserError('Discord の送り先が、まだ設定されていません');
  const r = await sendDiscord(me.webhook, `**🔔 ためしの知らせです**\n${me.name}さんの送り先は、正しく設定されています。\n管理ページ：<${pagesUrl(env)}/admin/>`);
  if (!r.ok) throw new UserError(`送れませんでした（${r.status || 'つながりません'}）。Webhook の URL を作り直して、もう一度設定してください`);
  return { ok: true };
}

// ------------------------------------------------------------ 副管理人（管理人だけ）
const ownerOnly = (me) => { if (me.role !== 'owner') throw new UserError('これは管理人だけができる操作です', 403); };

async function addAdmin(env, f, me, admins) {
  ownerOnly(me);
  const name = str(f.name, 30);
  if (!name) throw new UserError('副管理人の名前を入れてください');
  if (Object.keys(admins).length >= MAX_ADMINS) throw new UserError(`管理人は${MAX_ADMINS}人までです`);
  const id = `a${newKey(8).replace(/-/g, '').toLowerCase()}`;
  const key = newKey();
  admins[id] = { id, role: 'sub', name, key_hash: await sha256hex(normKey(key)), events: DEFAULT_EVENTS, events_known: ALL_EVENT_IDS, created: now(), by: me.name };
  await saveAdmins(env, admins);
  await addLog(env, me, 'admin-add', id, `副管理人「${name}」を追加`);
  return { admin: adminView(admins[id]), key };
}

async function removeAdmin(env, f, me, admins) {
  ownerOnly(me);
  const a = admins[f.id];
  if (!a || a.role !== 'sub') throw new UserError('その副管理人は見つかりませんでした', 404);
  delete admins[f.id];
  await saveAdmins(env, admins);
  await addLog(env, me, 'admin-remove', f.id, `副管理人「${a.name}」を外す`);
  return { ok: true };
}

async function rekeyAdmin(env, f, me, admins) {
  const id = f.id || me.id;
  if (id === 'owner') throw new UserError('管理人のキーは、管理ページの「はじめての設定」で作り直して、Cloudflare の ADMIN_OWNER_HASH を入れ替えてください');
  if (me.role !== 'owner' && id !== me.id) throw new UserError('ほかの人のキーを作り直せるのは、管理人だけです', 403);
  const a = admins[id];
  if (!a || a.role !== 'sub') throw new UserError('その副管理人は見つかりませんでした', 404);
  const key = newKey();
  admins[id] = { ...a, key_hash: await sha256hex(normKey(key)) };
  await saveAdmins(env, admins);
  await addLog(env, me, 'admin-rekey', id, `「${a.name}」のキーを作り直す`);
  return { key };
}

// ------------------------------------------------------------ 窓口
const ROUTES = {
  'GET /api/admin/me': async ({ env, me }) => ({ me: adminView(me), events: EVENTS, ...(me.role === 'owner' ? { security_hook: !!env.GH_WEBHOOK_SECRET } : {}) }),
  'POST /api/admin/me': ({ env, f, me, admins }) => saveMe(env, f, me, admins),
  'POST /api/admin/me/test': ({ env, me }) => testDiscord(env, me),
  'GET /api/admin/entries': ({ env, gh }) => listEntries(env, gh),
  'POST /api/admin/state': ({ env, gh, f, me }) => setState(env, gh, f, me),
  'POST /api/admin/labels': ({ env, gh, f, me }) => setLabels(env, gh, f, me),
  'POST /api/admin/content-labels': ({ env, gh, f, me }) => setContentLabels(env, gh, f, me),
  'POST /api/admin/blocklist': ({ env, gh, f, me }) => setBlocklist(env, gh, f, me),
  'GET /api/admin/admins': async ({ me, admins }) => {
    ownerOnly(me);
    const list = Object.values(admins).filter((a) => a.role === 'sub').map(adminView);
    return { admins: [adminView({ ...(admins.owner || {}), id: 'owner', role: 'owner', name: me.name }), ...list] };
  },
  'POST /api/admin/admins/add': ({ env, f, me, admins }) => addAdmin(env, f, me, admins),
  'POST /api/admin/admins/remove': ({ env, f, me, admins }) => removeAdmin(env, f, me, admins),
  'POST /api/admin/admins/rekey': ({ env, f, me, admins }) => rekeyAdmin(env, f, me, admins),
  'GET /api/admin/reports': async ({ env, url }) => {
    const id = String(url.searchParams.get('id') || '').toLowerCase();
    if (!/^e\d{5,}$/.test(id)) throw new UserError('作品IDが正しくありません');
    return reportDetails(env, id);
  },
  'POST /api/admin/reports/clear': async ({ env, f, me }) => {
    if (!/^e\d{5,}$/.test(f.id || '')) throw new UserError('作品IDが正しくありません');
    const done = await clearReports(env, f.id, f.reason || '');
    if (done.length) await addLog(env, me, 'report-clear', f.id, `通報を片付ける：${done.join('・')}`);
    return { id: f.id, cleared: done.length };
  },
  'GET /api/admin/log': async ({ env, url }) => {
    const r = await env.KV.list({ prefix: 'log:', limit: 100, ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) });
    return { items: r.keys.map((k) => k.metadata).filter(Boolean), cursor: r.list_complete ? null : r.cursor };
  },
};

/** /api/admin/… を受け付ける（index.js から呼ぶ） */
export async function handleAdmin(req, env, gh, url) {
  const fn = ROUTES[`${req.method} ${url.pathname}`];
  if (!fn) throw new UserError('ありません', 404);
  const { me, admins } = await authAdmin(env, req);
  let f = {};
  if (req.method === 'POST') {
    if (Number(req.headers.get('Content-Length') || 0) > 256 * 1024) throw new UserError('送る内容が大きすぎます', 413);
    f = await req.json().catch(() => { throw new UserError('送られた内容を読めませんでした'); });
    if (f.id !== undefined && typeof f.id === 'string') f.id = f.id.trim().toLowerCase();
  }
  return fn({ env, gh, f, me, admins, url });
}

