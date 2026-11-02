// CWカタログ（ツール）の README.md から、「アプリについての仕様説明」のページ（site/app/index.html）を作る。
// README を直したら、もう一度動かす：node scripts/app-page.mjs ../cw-catalog-tool/README.md
// （README の中の Markdown のうち、使っている書き方だけを HTML にする：見出し・段落・箇条書き・番号付き・表・区切り線・太字・斜体・`コード`・リンク）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const REPO = 'https://github.com/seihayukimi-oss/cw-catalog-tool';
const src = readFileSync(process.argv[2] || '../cw-catalog-tool/README.md', 'utf8').replace(/\r\n/g, '\n');

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkUrl = (u) => (/^https?:\/\//.test(u) ? u : `${REPO}/blob/main/${u.split('/').map(encodeURIComponent).join('/')}`);
function inline(t) {
  const keep = [];
  const hold = (html) => { keep.push(html); return `\u0000${keep.length - 1}\u0000`; };
  t = t.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, u) => hold(`<a href="${esc(linkUrl(u))}"${/^https?:/.test(u) && !u.startsWith('https://seihayukimi-oss.github.io/cardwirth-catalog') ? ' target="_blank" rel="noopener"' : ''}>${inline(label)}</a>`));
  t = t.replace(/<br\s*\/?>/gi, () => hold('<br>'));
  t = esc(t);
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(\(.+?\)|[^*\s][^*]*?)\*/g, '<i>$1</i>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

const lines = src.split('\n');
const out = [];
let i = 0;
let para = [];
const flush = () => { if (para.length) { out.push(`<p>${para.map((l) => inline(l.replace(/ {2}$/, ''))).join('<br>')}</p>`); para = []; } };
while (i < lines.length) {
  const l = lines[i];
  if (!l.trim()) { flush(); i++; continue; }
  let m;
  if ((m = l.match(/^(#{1,3})\s+(.*)$/))) { flush(); const n = m[1].length + 1; out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
  if (/^---+$/.test(l.trim())) { flush(); out.push('<hr>'); i++; continue; }
  if (l.startsWith('|')) {
    flush();
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const align = cells(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : ''));
    const td = (tag, c, k) => `<${tag}${align[k] ? ' class="c"' : ''}>${inline(c)}</${tag}>`;
    out.push(`<div class="table-wrap"><table><thead><tr>${cells(rows[0]).map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${cells(r).map((c, k) => td('td', c, k)).join('')}</tr>`).join('')}</tbody></table></div>`);
    continue;
  }
  if (/^(\s*)[-*] /.test(l) || /^\d+\. /.test(l)) {
    flush();
    const ordered = /^\d+\. /.test(l);
    const items = [];
    while (i < lines.length && (ordered ? /^\d+\. /.test(lines[i]) : /^[-*] /.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
      if (/^\s{2,}\S/.test(lines[i]) && !/^\s*[-*] /.test(lines[i])) items[items.length - 1] += `<br>${inline(lines[i].trim())}`;
      else items.push(inline(lines[i].replace(ordered ? /^\d+\. / : /^[-*] /, '')));
      i++;
    }
    out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${t}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    continue;
  }
  para.push(l);
  i++;
}
flush();

const page = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>アプリについての仕様説明｜CardWirth 共用カタログ</title>
<link rel="icon" type="image/png" href="../favicon.png">
<link rel="apple-touch-icon" href="../apple-touch-icon.png">
<meta name="description" content="CWカタログ（ツール）の入手方法・できること・安全のしくみなどの説明です。GitHub の説明ページと同じ内容です。">
<link rel="stylesheet" href="../style.css">
<!-- このページは scripts/app-page.mjs で、CWカタログ（ツール）の README.md から作っています（手で直さない） -->
<style>
  .readme-page h2 { margin-top: 32px; }
  .readme-page h3 { font-size: 1rem; margin: 18px 0 6px; }
  .readme-page hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
  .readme-page li + li { margin-top: 4px; }
  .table-wrap { overflow-x: auto; margin: 12px 0; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .table-wrap table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  .table-wrap th, .table-wrap td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
  .table-wrap th { background: color-mix(in srgb, var(--accent) 8%, var(--panel)); white-space: nowrap; }
  .table-wrap tr:last-child td { border-bottom: 0; }
  .table-wrap .c { text-align: center; white-space: nowrap; }
  .same-note { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
</style>
</head>
<body>
<header class="site-head">
  <div class="in">
    <a href="../"><img src="../apple-touch-icon.png" alt=""></a>
    <a href="../"><div class="t">CWカタログ</div><div class="s">ツール / 共用カタログ登録サイト</div></a>
  </div>
</header>
<script src="../menu.js" defer></script>
<main class="readme-page">
  <p><a href="../">← 共用カタログ トップへ</a></p>
  <h1>アプリについての仕様説明</h1>
  <div class="card same-note">
    <span>このページは、GitHub にある CWカタログ（ツール）の説明ページと同じ内容です。</span>
    <a class="btn small" href="${REPO}#readme" target="_blank" rel="noopener">GitHub の説明ページを開く ↗</a>
  </div>
${out.join('\n')}
  <footer>運営：清葉雪見　／　「Card Wirth」の著作権は group Ask に帰属します。</footer>
</main>
</body>
</html>
`;
mkdirSync('site/app', { recursive: true });
writeFileSync('site/app/index.html', page);
console.log('site/app/index.html を作りました');
