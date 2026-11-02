// GitHub App として、このリポジトリ（作品のデータ）を読み書きする。
// GitHub App の秘密鍵（PKCS#1 の PEM）から JWT を作り、インストール用のトークンに替えて使う。

import { readTarGz } from './tar.js';

const API = 'https://api.github.com';
const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlStr = (s) => b64url(enc.encode(s));

/** UTF-8 の文字列 ⇔ base64（GitHub の contents API の形） */
export function utf8ToB64(s) {
  const bytes = enc.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64ToUtf8(b) {
  const bin = atob(String(b).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** DER の長さ */
function derLen(n) {
  if (n < 0x80) return [n];
  const out = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

/** PEM を鍵のバイト列にする。PKCS#1（BEGIN RSA PRIVATE KEY）なら PKCS#8 に包み直す */
export function pemToPkcs8(pem) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!isPkcs1) return raw;
  // PrivateKeyInfo ::= SEQUENCE { version INTEGER 0, algorithm SEQUENCE { rsaEncryption, NULL }, privateKey OCTET STRING }
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(raw.length)];
  const inner = [0x02, 0x01, 0x00, ...alg, ...octet];
  const total = inner.length + raw.length;
  const out = new Uint8Array(1 + derLen(total).length + total);
  out.set([0x30, ...derLen(total), ...inner], 0);
  out.set(raw, out.length - raw.length);
  return out;
}

/** GitHub App の JWT（10分まで有効） */
export async function appJwt(appId, privatePem, now = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(privatePem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64urlStr(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export class GitHub {
  /** @param {{GH_APP_ID: string, GH_APP_PRIVATE_KEY: string, GH_APP_INSTALLATION_ID: string, REPO: string}} env */
  constructor(env, fetchImpl = fetch) {
    this.env = env;
    // そのまま this.fetch に入れて呼ぶと、Workers では「Illegal invocation」になるので、包んでおく
    this.fetch = (...a) => fetchImpl(...a);
    this.token = null;
  }

  async call(path, { method = 'GET', body, auth = 'token' } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cardwirth-catalog-worker', 'X-GitHub-Api-Version': '2022-11-28' };
    if (auth === 'jwt') headers.Authorization = `Bearer ${await appJwt(this.env.GH_APP_ID, this.env.GH_APP_PRIVATE_KEY)}`;
    else headers.Authorization = `token ${await this.installationToken()}`;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await this.fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* そのまま */ }
    return { status: r.status, ok: r.ok, json };
  }

  async installationToken() {
    if (this.token) return this.token;
    const r = await this.call(`/app/installations/${this.env.GH_APP_INSTALLATION_ID}/access_tokens`, { method: 'POST', auth: 'jwt' });
    if (!r.ok || !r.json?.token) throw new Error(`GitHub に接続できませんでした（${r.status}）`);
    this.token = r.json.token;
    return this.token;
  }

  /** ファイルを読む。無ければ null */
  async read(path) {
    const r = await this.call(`/repos/${this.env.REPO}/contents/${encodeURI(path)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`データを読めませんでした（${r.status}）`);
    return { sha: r.json.sha, text: b64ToUtf8(r.json.content || '') };
  }

  /** フォルダの中のファイル名 */
  async list(dir) {
    const r = await this.call(`/repos/${this.env.REPO}/contents/${encodeURI(dir)}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`一覧を読めませんでした（${r.status}）`);
    return (r.json || []).filter((x) => x.type === 'file').map((x) => x.name);
  }

  /**
   * リポジトリの今の中身を、tarball 1回でまとめて読む（作品の一覧など）
   * @param {(path: string) => boolean} want
   * @returns {Promise<Map<string, string>>}
   */
  async snapshot(want, ref = 'main') {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cardwirth-catalog-worker', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `token ${await this.installationToken()}` };
    const r = await this.fetch(`${API}/repos/${this.env.REPO}/tarball/${ref}`, { headers, redirect: 'follow' });
    if (!r.ok) throw new Error(`データをまとめて読めませんでした（${r.status}）`);
    const files = await readTarGz(r, want);
    const dec = new TextDecoder();
    return new Map([...files].map(([k, v]) => [k, dec.decode(v)]));
  }

  /**
   * ファイルを書く（コミットする）。sha を渡せば上書き、渡さなければ新しく作る（あれば失敗＝ conflict）
   * @returns {{ok: boolean, conflict?: boolean}}
   */
  async write(path, text, message, sha = null) {
    const r = await this.call(`/repos/${this.env.REPO}/contents/${encodeURI(path)}`, {
      method: 'PUT', body: { message, content: utf8ToB64(text), ...(sha ? { sha } : {}) },
    });
    if (r.ok) return { ok: true };
    if (r.status === 409 || r.status === 422) return { ok: false, conflict: true };
    throw new Error(`データを書き込めませんでした（${r.status}）`);
  }
}
