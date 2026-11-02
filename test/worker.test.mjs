// 受付（Cloudflare Worker）の試験。GitHub・Turnstile・作者さんのサイトは、まねをするものに置き換える。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import worker from '../worker/src/index.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  REPO: 'o/r', ALLOW_ORIGIN: 'https://seihayukimi-oss.github.io', TURNSTILE_SECRET: 's',
  GH_APP_ID: '1', GH_APP_INSTALLATION_ID: '2', GH_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }),
};
let files, pages, commits;
const sha = (t) => createHash('sha1').update(t).digest('hex');
const res = (status, body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

beforeEach(() => {
  files = new Map([['blocklist.json', JSON.stringify({ urls: [], hosts: ['bad.example'], authors: [] })]]);
  commits = [];
  pages = new Map([
    ['https://author.example/dl.html', '<html><head><meta charset="utf-8"><title>森の配布ページ</title></head><body><h1>テスト冒険譚</h1><p>作：テスト作者</p></body></html>'],
    ['https://other.example/page.html', '<html><body>関係ないページ</body></html>'],
  ]);
  const impl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://challenges.cloudflare.com/')) return res(200, { success: init.body.get('response') === 'ok' });
    if (u.endsWith('/access_tokens')) { assert.match(init.headers.Authorization, /^Bearer ey/); return res(201, { token: 't' }); }
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
      if (!files.has(path) && b.sha) return res(409, {});
      if (files.has(path) && !b.sha) return res(422, {});
      files.set(path, Buffer.from(b.content, 'base64').toString('utf8'));
      commits.push(b.message);
      return res(200, {});
    }
    if (pages.has(u)) return res(200, pages.get(u), 'text/html; charset=utf-8');
    return res(404, 'not found', 'text/plain');
  };
  // Workers の fetch と同じく、ほかのものの中に入れて呼ぶ（this が違う）と止まるようにする
  globalThis.fetch = function (url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return impl(url, init);
  };
});

const call = async (path, body, method = 'POST') => {
  const r = await worker.fetch(new Request(`https://w.example${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: 'https://seihayukimi-oss.github.io' }, body: method === 'POST' ? JSON.stringify({ turnstile: 'ok', ...body }) : undefined }), env);
  return { status: r.status, body: await r.json(), cors: r.headers.get('Access-Control-Allow-Origin') };
};
const form = { name: 'テスト冒険譚', author: 'テスト作者', url: 'https://author.example/dl.html', url_kind: 'page', rating: 'all', checked: 'site', proxy_ok: true, tags: '短編、探索' };

test('登録：配布ページに作品名と作者名があれば公開、編集キーを返す', async () => {
  const r = await call('/api/register', form);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, 'e00001');
  assert.equal(r.body.state, 'public');
  assert.match(r.body.edit_key, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
  assert.equal(r.cors, 'https://seihayukimi-oss.github.io');
  const saved = JSON.parse(files.get('entries/e00001.json'));
  assert.equal(saved.claim, 'proxy');
  assert.equal(saved.edit_key_hash.length, 64);
  assert.ok(!JSON.stringify(saved).includes(r.body.edit_key), 'キーそのものは保存しない');
  assert.deepEqual(saved.tags, ['短編', '探索']);
  // 2つ目は次の番号
  assert.equal((await call('/api/register', { ...form, name: '別の森', url: 'https://other.example/page.html' })).body.id, 'e00002');
});

test('登録：ページに見当たらなければ承認待ち・足りないものや代理の確認・ブロックリストは止める', async () => {
  const r = await call('/api/register', { ...form, url: 'https://other.example/page.html' });
  assert.equal(r.body.state, 'pending');
  assert.equal((await call('/api/register', { ...form, proxy_ok: false })).status, 400);
  assert.equal((await call('/api/register', { ...form, rating: '' })).status, 400);
  assert.equal((await call('/api/register', { ...form, checked: '' })).status, 400);
  assert.equal((await call('/api/register', { ...form, derivative: 'yes' })).status, 400);
  assert.equal((await call('/api/register', { ...form, url: 'https://dl.bad.example/x.zip' })).status, 403);
  assert.equal((await call('/api/register', { ...form, turnstile: 'ng' })).status, 400);
  // 移行先URL：移行先が現役、元のURLは旧
  await call('/api/register', { ...form, moved_url: 'https://new.example/dl.html' });
  const e = JSON.parse(files.get('entries/e00002.json'));
  assert.deepEqual(e.downloads.map((d) => d.status), ['active', 'old']);
});

test('直す・登録解除・掲載をやめてほしい・見る', async () => {
  const { body: { id, edit_key } } = await call('/api/register', form);
  assert.equal((await call('/api/edit', { ...form, id, key: 'WRONG', version: '1.1' })).status, 403);
  const ok = await call('/api/edit', { ...form, id, key: edit_key.toLowerCase().replace(/-/g, ' '), version: '1.10' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(JSON.parse(files.get(`entries/${id}.json`)).version, '1.10');
  // URLを変えて、ページに名前が無ければ承認待ちに戻る
  assert.equal((await call('/api/edit', { ...form, id, key: edit_key, url: 'https://other.example/page.html' })).body.state, 'pending');
  const got = await call(`/api/entry?id=${id}`, null, 'GET');
  assert.equal(got.body.entry.name, 'テスト冒険譚');
  assert.equal(got.body.entry.edit_key_hash, undefined);
  assert.equal((await call('/api/takedown', { id, reason: '作者です。載せないでください' })).body.state, 'private');
  assert.equal((await call('/api/unregister', { id, key: edit_key })).body.state, 'removed');
  assert.equal((await call(`/api/entry?id=${id}`, null, 'GET')).status, 404);
  assert.ok(commits.some((m) => m.startsWith('登録解除：')));
});

test('サイト認証：確認用の文字がページにあれば作者さん本人の登録にして、新しい編集キー', async () => {
  const { body: { id, edit_key } } = await call('/api/register', form);
  const st = await call('/api/verify/start', { id });
  assert.match(st.body.token, /^cw-catalog-verify:[a-z2-9]{16}$/);
  assert.equal((await call('/api/verify/check', { id })).status, 400);
  pages.set('https://author.example/dl.html', `${pages.get('https://author.example/dl.html')}<!-- ${st.body.token} --><p>${st.body.token}</p>`);
  const ck = await call('/api/verify/check', { id });
  assert.equal(ck.status, 200, JSON.stringify(ck.body));
  assert.notEqual(ck.body.edit_key, edit_key);
  const e = JSON.parse(files.get(`entries/${id}.json`));
  assert.equal(e.claim, 'author');
  assert.equal(e.verify, undefined);
  assert.equal((await call('/api/edit', { ...form, id, key: edit_key })).status, 403, '古いキーは使えない');
  assert.equal((await call('/api/edit', { ...form, id, key: ck.body.edit_key })).status, 200);
});
