// 管理用の窓口（/api/admin/…）と Discord の知らせの試験。
// GitHub・Turnstile・KV・Discord・作者さんのサイトは、まねをするものに置き換える。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import worker from '../worker/src/index.js';
import { untar } from '../worker/src/tar.js';
import { newKey, normKey, sha256hex } from '../worker/src/util.js';
import { signBody } from '../worker/src/security.js';
import { ipHash } from '../worker/src/report.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const OWNER_KEY = newKey();
const HOOK = 'https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz_ABC-123';

/** KV のまね（get・put・list。メタデータつき） */
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k).v : null; }
  async put(k, v, o = {}) { this.m.set(k, { v, meta: o.metadata }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const part = keys.slice(start, start + limit);
    return { keys: part.map((name) => ({ name, metadata: this.m.get(name).meta })), list_complete: start + limit >= keys.length, cursor: String(start + limit) };
  }
}

/** GitHub の tarball のまね（全体の見出し＋「owner-repo-commit/」の下にファイル） */
function makeTarGz(files) {
  const blocks = [];
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const add = (name, body, type = '0') => {
    const b = Buffer.from(body);
    blocks.push(header(name, b.length, type), b, Buffer.alloc((512 - (b.length % 512)) % 512));
  };
  add('pax_global_header', '52 comment=0123456789abcdef0123456789abcdef01234567\n', 'g');
  add('o-r-0123456/', '', '5');
  for (const [k, v] of files) add(`o-r-0123456/${k}`, v);
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

let env, files, commits, sent;
const sha = (t) => createHash('sha1').update(t).digest('hex');
const res = (status, body, type = 'application/json') => new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

beforeEach(async () => {
  env = {
    REPO: 'o/r', ALLOW_ORIGIN: 'https://seihayukimi-oss.github.io', TURNSTILE_SECRET: 's',
    GH_APP_ID: '1', GH_APP_INSTALLATION_ID: '2', GH_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    PAGES_URL: 'https://seihayukimi-oss.github.io/cardwirth-catalog',
    KV: new FakeKV(), ADMIN_OWNER_HASH: await sha256hex(normKey(OWNER_KEY)),
  };
  files = new Map([
    ['blocklist.json', JSON.stringify({ note: 'メモ', urls: [], hosts: [], authors: [] })],
    ['catalog.json', JSON.stringify({ format: 1, name: 'テスト', content_labels: [] })],
  ]);
  commits = []; sent = [];
  const pages = new Map([['https://author.example/dl.html', '<html><body><h1>テスト冒険譚</h1><p>作：テスト作者</p></body></html>']]);
  const impl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://challenges.cloudflare.com/')) return res(200, { success: true });
    if (u.startsWith('https://discord.com/api/webhooks/')) { sent.push({ url: u, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); }
    if (u.endsWith('/access_tokens')) return res(201, { token: 't' });
    if (u === 'https://api.github.com/repos/o/r/tarball/main') return res(200, new Uint8Array(makeTarGz(files)), 'application/x-gzip');
    const m = /^https:\/\/api\.github\.com\/repos\/o\/r\/contents\/(.+)$/.exec(u);
    if (m) {
      const path = decodeURI(m[1]);
      if ((init.method || 'GET') === 'GET') {
        if (path === 'entries') return res(200, [...files.keys()].filter((k) => k.startsWith('entries/')).map((k) => ({ type: 'file', name: k.slice(8) })));
        if (!files.has(path)) return res(404, {});
        return res(200, { sha: sha(files.get(path)), content: Buffer.from(files.get(path)).toString('base64') });
      }
      const b = JSON.parse(init.body);
      if (files.has(path) && b.sha !== sha(files.get(path))) return res(409, {});
      files.set(path, Buffer.from(b.content, 'base64').toString('utf8'));
      commits.push(b.message);
      return res(200, {});
    }
    if (pages.has(u)) return res(200, pages.get(u), 'text/html; charset=utf-8');
    return res(404, 'not found', 'text/plain');
  };
  globalThis.fetch = function (url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return impl(url, init);
  };
});

const call = async (path, { method = 'POST', body, key = OWNER_KEY, ip = '' } = {}) => {
  const headers = { Origin: 'https://seihayukimi-oss.github.io', 'Content-Type': 'application/json' };
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await worker.fetch(new Request(`https://w.example${path}`, { method, headers, body: method === 'POST' ? JSON.stringify(body || {}) : undefined }), env);
  return { status: r.status, body: await r.json() };
};
const register = (over = {}) => call('/api/register', { key: '', body: { turnstile: 'ok', name: 'テスト冒険譚', author: 'テスト作者', url: 'https://other.example/x.html', rating: 'all', checked: 'site', proxy_ok: true, ...over } });

test('tar：GitHub の tarball から、欲しいファイルだけ取り出せる', () => {
  const gz = makeTarGz(new Map([['entries/e00001.json', '{"id":"e00001"}'], ['site/index.html', 'x']]));
  const out = untar(new Uint8Array(gunzipSync(gz)), (p) => p.startsWith('entries/'));
  assert.deepEqual([...out.keys()], ['entries/e00001.json']);
});

test('入る：キーが違う・無い・KV が無い・最初のキーがまだ', async () => {
  assert.equal((await call('/api/admin/me', { method: 'GET' })).body.me.role, 'owner');
  assert.equal((await call('/api/admin/me', { method: 'GET', key: newKey() })).status, 401);
  assert.equal((await call('/api/admin/me', { method: 'GET', key: '' })).status, 401);
  delete env.ADMIN_OWNER_HASH;
  const r = await call('/api/admin/me', { method: 'GET' });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'setup');
  delete env.KV;
  assert.equal((await call('/api/admin/me', { method: 'GET' })).status, 503);
});

test('作品：承認待ちの一覧（編集キーの指紋は出さない）→ 承認 → 記録', async () => {
  const reg = await register();
  assert.equal(reg.body.state, 'pending');
  const list = await call('/api/admin/entries', { method: 'GET' });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.entries.length, 1);
  assert.equal(list.body.entries[0].state, 'pending');
  assert.equal(list.body.entries[0].edit_key_hash, undefined);
  assert.deepEqual(list.body.labels.map((l) => l.id), ['gore', 'horror', 'sexual']);
  // 名前を付けてから承認
  await call('/api/admin/me', { body: { name: 'テスト作者' } });
  const ok = await call('/api/admin/state', { body: { id: 'E00001', state: 'public' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const e = JSON.parse(files.get('entries/e00001.json'));
  assert.equal(e.state, 'public');
  assert.ok(e.approved?.at);
  assert.ok(commits.includes('管理：e00001 承認待ち→公開中'));
  assert.ok(!commits.some((c) => c.includes('テスト作者') && c.startsWith('管理')), 'コミットの文に管理人の名前は入れない');
  // 一時保留（理由つき）
  await call('/api/admin/state', { body: { id: 'e00001', state: 'held', reason: '確認中' } });
  assert.equal(JSON.parse(files.get('entries/e00001.json')).held_reason, '確認中');
  assert.equal((await call('/api/admin/state', { body: { id: 'e00001', state: 'pending' } })).status, 400);
  const log = await call('/api/admin/log', { method: 'GET' });
  assert.equal(log.body.items[0].action, 'state', '新しい順');
  assert.equal(log.body.items[1].action, 'approve');
  assert.equal(log.body.items[1].name, 'テスト作者');
});

test('ラベル：作品のラベルを直す・ラベルの種類を増やす', async () => {
  await register();
  assert.equal((await call('/api/admin/labels', { body: { id: 'e00001', rating: 'r18', content: ['gore', 'BAD!'] } })).status, 200);
  const e = JSON.parse(files.get('entries/e00001.json'));
  assert.equal(e.rating, 'r18');
  assert.deepEqual(e.content, ['gore']);
  assert.equal((await call('/api/admin/labels', { body: { id: 'e00001', rating: '' } })).status, 400);
  assert.match((await call('/api/admin/log', { method: 'GET' })).body.items[0].detail, /全年齢→R18・グロ・残酷描写$/, '記録はラベルの名前で');
  // 種類を増やす（最初からあるものは、名前を変えなければ書かない）
  const r = await call('/api/admin/content-labels', { body: { labels: [{ id: 'gore', name: 'グロ・残酷描写' }, { id: 'utsu', name: '鬱・救いのない展開' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(JSON.parse(files.get('catalog.json')).content_labels, [{ id: 'utsu', name: '鬱・救いのない展開' }]);
  assert.equal(JSON.parse(files.get('catalog.json')).name, 'テスト', 'ほかの項目はそのまま');
  assert.ok(r.body.labels.some((l) => l.id === 'utsu'));
  assert.equal((await call('/api/admin/content-labels', { body: { labels: [{ id: 'Bad Id', name: 'x' }] } })).status, 400);
  assert.equal((await call('/api/admin/content-labels', { body: { labels: [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }] } })).status, 400);
});

test('ブロックリスト：足す・まとめて直す（形のおかしいものは捨てる）', async () => {
  const r = await call('/api/admin/blocklist', { body: { add: { hosts: ['https://Bad.Example/path'], authors: ['いたずら'] } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let b = JSON.parse(files.get('blocklist.json'));
  assert.deepEqual(b.hosts, ['bad.example']);
  assert.deepEqual(b.authors, ['いたずら']);
  assert.equal(b.note, 'メモ');
  await call('/api/admin/blocklist', { body: { urls: ['javascript:alert(1)', 'https://x.example/a.zip'], hosts: [], authors: [] } });
  b = JSON.parse(files.get('blocklist.json'));
  assert.deepEqual(b, { note: 'メモ', urls: ['https://x.example/a.zip'], hosts: [], authors: [] });
  // ブロックした作者は、登録できない
  await call('/api/admin/blocklist', { body: { add: { authors: ['テスト作者'] } } });
  assert.equal((await register()).status, 403);
});

test('副管理人：管理人が追加 → 同じ操作ができる・副管理人の追加はできない → 外すと入れない', async () => {
  const add = await call('/api/admin/admins/add', { body: { name: '衣' } });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const subKey = add.body.key;
  assert.ok(!JSON.stringify([...env.KV.m.values()]).includes(subKey), 'キーそのものは置かない');
  const me = await call('/api/admin/me', { method: 'GET', key: subKey });
  assert.equal(me.body.me.role, 'sub');
  await register();
  assert.equal((await call('/api/admin/state', { key: subKey, body: { id: 'e00001', state: 'public' } })).status, 200);
  assert.equal((await call('/api/admin/content-labels', { key: subKey, body: { labels: [{ id: 'utsu', name: '鬱' }] } })).status, 200);
  assert.equal((await call('/api/admin/admins/add', { key: subKey, body: { name: 'x' } })).status, 403);
  assert.equal((await call('/api/admin/admins', { method: 'GET', key: subKey })).status, 403);
  // 自分のキーは作り直せる
  const re = await call('/api/admin/admins/rekey', { key: subKey, body: {} });
  assert.equal(re.status, 200);
  assert.equal((await call('/api/admin/me', { method: 'GET', key: subKey })).status, 401, '古いキーは使えない');
  const list = await call('/api/admin/admins', { method: 'GET' });
  assert.deepEqual(list.body.admins.map((a) => a.role), ['owner', 'sub']);
  assert.equal(JSON.stringify(list.body).includes('key_hash'), false);
  assert.equal((await call('/api/admin/admins/remove', { body: { id: add.body.admin.id } })).status, 200);
  assert.equal((await call('/api/admin/me', { method: 'GET', key: re.body.key })).status, 401);
});

test('Discord：選んだ出来事だけ、送り先に知らせる（@everyone は効かない・送り先は見せない）', async () => {
  assert.equal((await call('/api/admin/me', { body: { webhook: 'https://evil.example/api/webhooks/1/x' } })).status, 400);
  const set = await call('/api/admin/me', { body: { webhook: HOOK } });
  assert.equal(set.status, 200);
  assert.ok(!JSON.stringify(set.body).includes('abcdefghijklmnop'), '送り先そのものは返さない');
  assert.equal((await call('/api/admin/me/test', {})).status, 200);
  assert.equal(sent.length, 1);
  sent.length = 0;
  // 承認待ちの登録 → 知らせる
  await register({ name: '@everyone の森' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.content, /承認待ち/);
  assert.match(sent[0].body.content, /e00001/);
  assert.match(sent[0].body.content, /\/admin\/#e00001/);
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
  // 自動で公開された登録は、最初は知らせない
  await register({ url: 'https://author.example/dl.html' });
  assert.equal(sent.length, 1);
  // 掲載停止の申請 → 知らせる
  await call('/api/takedown', { key: '', body: { turnstile: 'ok', id: 'e00002', reason: '作者です' } });
  assert.equal(sent.length, 2);
  assert.match(sent[1].body.content, /掲載停止/);
  // 出来事を外すと、知らせない
  await call('/api/admin/me', { body: { events: ['change'] } });
  await register();
  assert.equal(sent.length, 2);
  // 送り先を外す
  await call('/api/admin/me', { body: { webhook: '' } });
  assert.equal((await call('/api/admin/me/test', {})).status, 400);
});

const sendReport = (id, reason, ip, comment = '') => call('/api/report', { key: '', ip, body: { turnstile: 'ok', id, reason, comment } });
const publicEntry = async () => { await register({ url: 'https://author.example/dl.html' }); return JSON.parse(files.get('entries/e00001.json')); };

test('通報：同じ人は1人と数える・R18の付け忘れは5人で一時保留・IPはそのまま置かない', async () => {
  assert.equal((await publicEntry()).state, 'public');
  await call('/api/admin/me', { body: { webhook: HOOK } });
  sent.length = 0;
  assert.equal((await sendReport('e00001', 'nope', '1.1.1.1')).status, 400);
  assert.equal((await sendReport('e00001', 'other', '1.1.1.1')).status, 400, 'その他は内容が要る');
  assert.equal((await sendReport('e09999', 'r18', '1.1.1.1')).status, 404);
  for (let i = 1; i <= 4; i++) assert.equal((await sendReport('e00001', 'r18', `10.0.0.${i}`, 'R18 です')).body.received, true);
  assert.equal((await sendReport('e00001', 'r18', '10.0.0.1')).body.already, true, '同じ人は数えない');
  assert.equal(JSON.parse(files.get('entries/e00001.json')).state, 'public', '4人ではまだ');
  assert.equal(sent.length, 0, '1件ごとの知らせは最初OFF');
  const r = await sendReport('e00001', 'r18', '10.0.0.5');
  assert.equal(r.body.held, true);
  const e = JSON.parse(files.get('entries/e00001.json'));
  assert.equal(e.state, 'held');
  assert.equal(e.held_reason, '年齢区分を確認中です');
  assert.ok(commits.at(-1).startsWith('通報：e00001 一時保留'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.content, /一時保留/);
  assert.ok(!JSON.stringify([...env.KV.m.entries()]).includes('10.0.0.'), 'IP そのものは置かない');
  // 保留中でも通報は受け付ける（もう一度保留にはしない）
  assert.equal((await sendReport('e00001', 'r18', '10.0.0.6')).body.held, false);
  // 管理ページ：数・中身・片付ける
  const list = await call('/api/admin/entries', { method: 'GET' });
  assert.deepEqual(list.body.reports, { e00001: { r18: 6 } });
  const d = await call('/api/admin/reports?id=e00001', { method: 'GET' });
  assert.equal(d.body.reports[0].count, 6);
  assert.equal(d.body.reports[0].items[0].comment, undefined, '新しい順（最後はコメントなし）');
  assert.equal(d.body.reports[0].items.at(-1).comment, 'R18 です');
  assert.equal((await call('/api/admin/reports/clear', { body: { id: 'e00001' } })).body.cleared, 1);
  assert.deepEqual((await call('/api/admin/entries', { method: 'GET' })).body.reports, {});
  // 公開に戻すと、保留の印も外れる
  await call('/api/admin/state', { body: { id: 'e00001', state: 'public' } });
  const back = JSON.parse(files.get('entries/e00001.json'));
  assert.equal(back.report_hold, undefined);
  assert.equal(back.held_reason, undefined);
  const log = (await call('/api/admin/log', { method: 'GET' })).body.items.map((x) => x.action);
  assert.ok(log.includes('report-hold') && log.includes('report-clear'));
});

test('通報：リンク切れは保留にせず知らせるだけ・保存したあとに足した知らせは最初の設定で届く・1日の上限', async () => {
  await publicEntry();
  // 通報が無かったころの形で保存した管理人（events_known なし）でも、「保留」「リンク切れ」は届く
  const admins = JSON.parse((await env.KV.get('admins')) || '{}');
  admins.owner = { id: 'owner', role: 'owner', name: 'テスト作者', webhook: HOOK, events: ['pending', 'takedown', 'change'] };
  await env.KV.put('admins', JSON.stringify(admins));
  sent.length = 0;
  for (let i = 1; i <= 25; i++) await sendReport('e00001', 'link', `10.1.0.${i}`, 'リンクが切れています');
  assert.equal(JSON.parse(files.get('entries/e00001.json')).state, 'public', 'リンク切れは保留にしない');
  assert.equal(sent.length, 25);
  assert.match(sent[0].body.content, /リンク切れ/);
  const me = await call('/api/admin/me', { method: 'GET' });
  assert.ok(me.body.me.events.includes('report_hold') && !me.body.me.events.includes('report'));
  // 1日の上限（同じ IP。30件まで）
  const h = await ipHash(env, '9.9.9.9');
  await env.KV.put(`rl:${h}:${new Date().toISOString().slice(0, 10)}`, '30');
  assert.equal((await sendReport('e00001', 'abuse', '9.9.9.9')).status, 429);
  assert.equal((await sendReport('e00001', 'abuse', '9.9.9.8')).status, 200);
});

test('安全の報告：署名が合えば管理人だけに知らせる（中身は書かない）', async () => {
  const sub = await call('/api/admin/admins/add', { body: { name: '衣' } });
  await call('/api/admin/me', { key: sub.body.key, body: { webhook: HOOK.replace('123456789012', '999999999999') } });
  await call('/api/admin/me', { body: { webhook: HOOK } });
  const hook = async (event, payload, secret = 'himitsu') => {
    const body = JSON.stringify(payload);
    const r = await worker.fetch(new Request('https://w.example/api/github/webhook', { method: 'POST', headers: { 'X-GitHub-Event': event, 'X-Hub-Signature-256': await signBody(secret, body), 'Content-Type': 'application/json' }, body }), env);
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await hook('ping', {})).status, 503, '合言葉の設定がまだ');
  env.GH_WEBHOOK_SECRET = 'himitsu';
  assert.equal((await hook('ping', { zen: 'x' })).body.pong, true);
  assert.equal((await hook('ping', {}, 'chigau')).status, 401);
  sent.length = 0;
  assert.equal((await hook('repository_advisory', { action: 'published', repository: { full_name: 'o/r' } })).body.ignored, 'repository_advisory.published');
  const r = await hook('repository_advisory', { action: 'reported', repository: { full_name: 'seihayukimi-oss/cw-catalog-tool' }, repository_advisory: { summary: 'ひみつの中身' } });
  assert.equal(r.body.notified, true);
  assert.equal(sent.length, 1, '管理人だけ');
  assert.ok(sent[0].url.includes('123456789012'));
  assert.match(sent[0].body.content, /安全の報告が届きました。GitHubで確認してください/);
  assert.ok(!sent[0].body.content.includes('ひみつの中身'), '中身は書かない');
});
