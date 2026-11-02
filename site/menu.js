// いちばん上の帯の右上のメニュー（ハンバーガー）。
// メニューの中身はここだけで管理する（ページを足したら、下の MENU に1行足す）。
// 場所はこのファイルの場所からの相対パス。外のサイトは https:// から書く。
const MENU = [
  { label: 'トップ（共用カタログ）', href: '' },
  { label: '作品を登録する', href: 'register/' },
  { label: '複数シナリオの一括登録', href: 'register/bulk/' },
  { label: '登録内容の変更・解除', href: 'manage/' },
  { label: '作品の通報', href: 'report/' },
  { label: 'よくある質問（Q&A）', href: 'faq/' },
  { label: 'アプリについての仕様説明', href: 'app/' },
  { label: 'CWカタログ（アプリ）を入手する', href: 'https://github.com/seihayukimi-oss/cw-catalog-tool/releases/latest', external: true },
];

(() => {
  const head = document.querySelector('.site-head .in');
  if (!head) return;
  const base = new URL('.', document.currentScript?.src || location.href);
  const here = location.pathname.replace(/index\.html$/, '');
  const svg = (paths) => {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    for (const d of paths) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.append(p); }
    return s;
  };
  // アイコンは Lucide（ISC License）の menu・x を書き写したもの
  const iconMenu = () => svg(['M4 5h16', 'M4 12h16', 'M4 19h16']);
  const iconClose = () => svg(['M18 6 6 18', 'm6 6 12 12']);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'menu-btn';
  btn.setAttribute('aria-label', 'メニュー');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'site-menu');
  btn.append(iconMenu());

  const nav = document.createElement('nav');
  nav.id = 'site-menu';
  nav.className = 'site-menu';
  nav.hidden = true;
  nav.setAttribute('aria-label', 'サイトのメニュー');
  const ul = document.createElement('ul');
  for (const item of MENU) {
    const url = item.external ? new URL(item.href) : new URL(item.href, base);
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = url.href;
    a.textContent = item.label;
    if (item.external) { a.target = '_blank'; a.rel = 'noopener'; a.append(' ↗'); }
    if (!item.external && url.pathname === here) { a.setAttribute('aria-current', 'page'); }
    li.append(a);
    ul.append(li);
  }
  nav.append(ul);

  const open = (on) => {
    nav.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    btn.replaceChildren(on ? iconClose() : iconMenu());
  };
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); open(nav.hidden); });
  document.addEventListener('click', (ev) => { if (!nav.hidden && !nav.contains(ev.target)) open(false); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !nav.hidden) { open(false); btn.focus(); } });

  head.append(btn, nav);
})();
