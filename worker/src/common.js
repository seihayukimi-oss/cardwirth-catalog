// 受付（index.js）・管理（admin.js）・通報（report.js）で使う、作品の読み書きなどの共通の部分

import { newKey } from './util.js';

export const ID_RE = /^e\d{5,}$/;
export const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;
export const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^\s]{1,2000}$/.test(u.trim());
export const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const now = () => new Date().toISOString();

/** 使う人に、そのまま見せてよいエラー */
export class UserError extends Error {
  constructor(message, status = 400, code = '') { super(message); this.status = status; this.code = code; }
}

export const STATE_NAMES = { public: '公開中', pending: '承認待ち', held: '一時保留中', private: '非公開', removed: '登録解除' };

export async function readEntry(gh, id) {
  if (!ID_RE.test(id || '')) throw new UserError('作品IDが正しくありません（例：e00012）');
  const f = await gh.read(`entries/${id}.json`);
  if (!f) throw new UserError('その作品IDは見つかりませんでした', 404);
  return { sha: f.sha, entry: JSON.parse(f.text) };
}

/** 空の項目は書かない */
export function clean(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

export async function saveEntry(gh, entry, sha, message) {
  const text = `${JSON.stringify(clean(entry), null, 2)}\n`;
  const r = await gh.write(`entries/${entry.id}.json`, text, message, sha);
  if (!r.ok) throw new UserError('ほかの変更と重なりました。少し待ってから、もう一度お試しください', 409);
}

/** JSON のファイルを読む（無ければ fallback）。書き戻すための sha も返す */
export async function readJson(gh, path, fallback) {
  const f = await gh.read(path);
  if (!f) return { sha: null, data: fallback };
  try { return { sha: f.sha, data: JSON.parse(f.text) }; } catch { return { sha: f.sha, data: fallback }; }
}

/** 指紋どうしを、かかる時間が変わらないように比べる */
export function sameHex(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length || !a) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** 操作の記録（KV。だれが・いつ・何を。400日で消える）。me は { id, name }（自動のときは id: 'system'） */
export async function addLog(env, me, action, target = '', detail = '') {
  if (!env.KV) return;
  const meta = { at: now(), by: me.id, name: str(me.name, 30), action, target: str(target, 40), detail: str(detail, 150) };
  // KV のメタデータは 1024 バイトまで。日本語は1文字3バイトなので、はみ出したら詳しいところを短くする
  while (new TextEncoder().encode(JSON.stringify(meta)).length > 1000 && meta.detail) meta.detail = meta.detail.slice(0, -10);
  const key = `log:${String(9e15 - Date.now()).padStart(16, '0')}:${newKey(4).replace(/-/g, '')}`;
  await env.KV.put(key, '', { metadata: meta, expirationTtl: 400 * 86400 });
}
