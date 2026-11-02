// 受付で使う小さな道具：キー・指紋・ページの読み取り・名前のくらべ方

export const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** 編集キー（推測できない長さ。見やすいよう4文字ずつ区切る） */
export function newKey(len = 24) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // まぎらわしい 0 O 1 I は使わない
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  const s = [...bytes].map((b) => abc[b % abc.length]).join('');
  return s.match(/.{1,4}/g).join('-');
}
export const normKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 名前を比べやすくする（全角半角・大文字小文字・空白・記号の違いを無視） */
export const normText = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　・･_\-ー〜~!！?？「」『』()（）［］\[\]【】]/g, '');

/** HTML から、目に見える文字（と説明・題名）だけを取り出す */
export function pageText(html) {
  const meta = [...html.matchAll(/<meta[^>]+content=["']([^"']*)["'][^>]*>/gi)].map((m) => m[1]).join(' ');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(`${title} ${meta} ${body}`);
}
function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** 文字コードを見分けて読む（UTF-8・Shift_JIS・EUC-JP の個人サイトがある） */
export function decodeHtml(bytes, contentType = '') {
  const pick = (/charset=["']?([\w-]+)/i.exec(contentType) || [])[1]
    || (/<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder().decode(bytes.subarray(0, 4096))) || [])[1] || 'utf-8';
  const label = /shift_jis|sjis|x-sjis|windows-31j|cp932/i.test(pick) ? 'shift_jis' : /euc-jp/i.test(pick) ? 'euc-jp' : 'utf-8';
  try { return new TextDecoder(label).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

/**
 * ページを読んで文字にする（作者さんのサイトに負担をかけないよう、小さく・早く切り上げる）
 * @returns {Promise<string|null>}
 */
export async function fetchPageText(url, fetchImpl = fetch, { max = 1024 * 1024, timeout = 8000 } = {}) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'CardWirthCatalog-check (+https://seihayukimi-oss.github.io/cardwirth-catalog/)', Accept: 'text/html,*/*' }, redirect: 'follow', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return null; // ファイルそのものは読まない
    const buf = new Uint8Array(await r.arrayBuffer());
    return pageText(decodeHtml(buf.subarray(0, max), type));
  } catch {
    return null;
  }
}

/**
 * 自動で公開してよいか：配布ページ・紹介ページ・作者さんのサイトのどれかに、作品名と作者名の両方が書いてあるか
 * @returns {Promise<{ok: boolean, where: string}>}
 */
export async function autoApprove(entry, fetchImpl = fetch) {
  const urls = [...new Set([
    ...(entry.downloads || []).filter((d) => d.kind !== 'direct' && d.status !== 'closed').map((d) => d.url),
    ...(entry.intro || []).map((i) => i.url),
    entry.site,
  ].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))].slice(0, 5);
  const name = normText(entry.name), author = normText(entry.author);
  if (!name || !author) return { ok: false, where: '' };
  for (const u of urls) {
    const t = await fetchPageText(u, fetchImpl);
    if (!t) continue;
    const n = normText(t);
    if (n.includes(name) && n.includes(author)) return { ok: true, where: u };
  }
  return { ok: false, where: '' };
}

/** サイト認証：ページのどこかに確認用の文字が書いてあるか */
export async function findToken(urls, token, fetchImpl = fetch) {
  for (const u of urls.slice(0, 6)) {
    const t = await fetchPageText(u, fetchImpl);
    if (t && t.includes(token)) return u;
  }
  return '';
}
