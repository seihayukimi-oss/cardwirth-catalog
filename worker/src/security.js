// 安全の報告（GitHub の Private vulnerability reporting）の知らせ。
// GitHub のリポジトリの Webhook（出来事：Repository advisories）を受けて、管理人（いちばん上の人）の Discord にだけ知らせる。
// 中身は Discord に書かない（「届きました。GitHub で確かめてください」とリンクだけ）。
// Webhook の合言葉は、Cloudflare の Secret「GH_WEBHOOK_SECRET」と、GitHub の Webhook の「Secret」に同じものを入れる。

import { UserError, sameHex } from './common.js';
import { notifyOwner } from './notify.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function signBody(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)))}`;
}

/** POST /api/github/webhook */
export async function githubHook(req, env) {
  if (!env.GH_WEBHOOK_SECRET) throw new UserError('安全の報告の受付は、まだ設定されていません', 503);
  if (Number(req.headers.get('Content-Length') || 0) > 1024 * 1024) throw new UserError('大きすぎます', 413);
  const body = await req.text();
  if (!sameHex(await signBody(env.GH_WEBHOOK_SECRET, body), req.headers.get('X-Hub-Signature-256') || '')) throw new UserError('署名が合いません', 401);
  const event = req.headers.get('X-GitHub-Event') || '';
  if (event === 'ping') return { ok: true, pong: true };
  if (event !== 'repository_advisory') return { ok: true, ignored: event };
  let p;
  try { p = JSON.parse(body); } catch { throw new UserError('読めませんでした'); }
  if (p.action !== 'reported') return { ok: true, ignored: `${event}.${p.action}` };
  const repo = /^[\w.-]+\/[\w.-]+$/.test(p.repository?.full_name || '') ? p.repository.full_name : '';
  const link = repo ? `https://github.com/${repo}/security/advisories` : 'https://github.com/';
  const r = await notifyOwner(env, `**🛡 安全の報告が届きました。GitHubで確認してください**\n${repo}\n<${link}>`);
  return { ok: true, notified: !!r.ok };
}
