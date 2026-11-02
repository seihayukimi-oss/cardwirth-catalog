// 管理ページの動き。受付（Cloudflare Workers）の /api/admin/… を、管理人キーで呼ぶ。
// 作品名などの文字は、すべて「文字として」画面に入れる（HTML として読ませない）。
(function () {
  'use strict';
  const API = (window.CW_CONFIG || {}).api || '';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const STATE = { pending: '承認待ち', public: '公開中', held: '一時保留中', private: '非公開', removed: '登録解除', broken: '読めない' };
  const RATING = { all: '全年齢', r15: 'R15', r18: 'R18' };
  const CHECKED = { readme: 'Readme', site: '作者公式サイト・配布ページ', author: '作者本人へ直接確認', other: 'その他' };
  const DL_STATUS = { active: '現役', mirror: '予備', old: '旧（移転前）', closed: '終了' };
  const DL_KIND = { page: '配布ページ', direct: '直接のリンク', list: 'ファイル一覧' };
  const TYPE = { scenario: 'シナリオ', skin: 'スキン', material: '素材' };
  const ACTION = { approve: '承認', state: '状態の変更', labels: 'ラベルの直し', 'label-types': 'ラベルの種類', blocklist: 'ブロックリスト', settings: '自分の設定', 'admin-add': '副管理人の追加', 'admin-remove': '副管理人を外す', 'admin-rekey': 'キーの作り直し', 'report-hold': '通報で一時保留', 'report-clear': '通報を片付ける' };
  const REASON = { r18: '年齢区分の不備', unauthorized: '無断転載・改変・作者の意向', abuse: '危険なファイル・不適切', link: 'リンク切れ・配布先の不備', other: 'その他' };
  const FILTERS = ['pending', 'reported', 'held', 'public', 'private', 'removed', 'all'];

  const S = { key: '', me: null, events: [], entries: [], reports: {}, labels: [], block: null, filter: 'pending', logCursor: null };

  /** 要素を作る（子は文字か要素。文字は textContent で入れる） */
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const isHttp = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);
  /** 外のページへのリンク（http・https だけ。新しいタブで、こちらの情報を渡さない） */
  const link = (url, text) => (isHttp(url) ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text || url) : h('span', {}, text || String(url || '')));
  const when = (s) => { try { return s ? new Date(s).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }) : ''; } catch { return s; } };
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

  function msg(el, text, kind = '') { el.className = `msg ${kind}`; el.textContent = text; el.hidden = !text; }
  /** 作品の一覧の上に、ページを読み込み直すまで残る知らせを出す（新しいものを上に） */
  function doneNote(text, kind = 'ok') { $('#entries-done').prepend(h('p', { class: `msg ${kind}` }, text)); }
  function toast(text) {
    const el = $('#toast'); el.textContent = text; el.hidden = false;
    clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, 2500);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { toast('コピーできませんでした。選んでコピーしてください'); }
  }

  // ------------------------------------------------------------ 受付とのやりとり
  async function api(path, body) {
    if (!API) throw new Error('受付のURL（config.js）がありません');
    const init = { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${S.key}` }, cache: 'no-store' };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(`${API}${path}`, init); } catch { throw new Error('受付につながりませんでした。ネットの調子を確かめて、もう一度お試しください'); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && S.me) { logout(); throw new Error(j.error || 'もう一度入ってください'); }
    if (!r.ok) { const e = new Error(j.error || `エラーが起きました（${r.status}）`); e.code = j.code; throw e; }
    return j;
  }
  /** ボタンを押している間は押せないようにして、結果を下に出す */
  async function run(btn, box, fn) {
    if (btn) btn.disabled = true;
    if (box) msg(box, '送っています…');
    try { const t = await fn(); if (box) msg(box, t || '', 'ok'); } catch (e) { if (box) msg(box, e.message, 'bad'); else msg($('#app-msg'), e.message, 'bad'); } finally { if (btn) btn.disabled = false; }
  }

  // ------------------------------------------------------------ 入る・出る
  const store = { get: () => { try { return sessionStorage.getItem('cw-admin-key') || ''; } catch { return ''; } }, set: (k) => { try { sessionStorage.setItem('cw-admin-key', k); } catch { /* 覚えられなくても動く */ } }, clear: () => { try { sessionStorage.removeItem('cw-admin-key'); } catch { /* なし */ } } };

  async function login(key, remember) {
    S.key = key.trim();
    const r = await api('/api/admin/me');
    S.me = r.me; S.events = r.events || []; S.securityHook = r.security_hook;
    if (remember) store.set(S.key); else store.clear();
    $('#login').hidden = true; $('#app').hidden = false;
    $('#login-key').value = '';
    renderWho();
    $$('[data-owner]').forEach((x) => { x.hidden = S.me.role !== 'owner'; });
    $('#me-rekey-box').hidden = S.me.role === 'owner';
    renderMe();
    const id = (location.hash.match(/^#(e\d{5,})$/) || [])[1];
    if (id) { S.filter = 'all'; $('#q').value = id; }
    await loadEntries();
  }
  function logout() {
    S.key = ''; S.me = null; store.clear();
    $('#entries-done').replaceChildren();
    $('#app').hidden = true; $('#login').hidden = false;
  }
  const renderWho = () => { $('#who').textContent = `${S.me.name}さん（${S.me.role === 'owner' ? '管理人' : '副管理人'}）`; };

  $('#login-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const box = $('#login-msg');
    run(ev.submitter, box, async () => {
      try { await login($('#login-key').value, $('#login-remember').checked); } catch (e) {
        S.key = '';
        if (e.code === 'setup') $('#setup').hidden = false;
        throw e;
      }
      return '';
    });
  });
  $('#logout').addEventListener('click', logout);

  // はじめての設定：キーと指紋を、このブラウザの中で作る
  $('#setup-open').addEventListener('click', () => { $('#setup').hidden = !$('#setup').hidden; });
  $('#setup-make').addEventListener('click', async () => {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const key = [...bytes].map((b) => abc[b % abc.length]).join('').match(/.{4}/g).join('-');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key.replace(/-/g, '')));
    $('#setup-key').textContent = key;
    $('#setup-hash').textContent = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    $('#setup-out').hidden = false;
    $('#setup-make').textContent = 'キーを作り直す';
  });
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-copy]');
    if (b) copy($(b.dataset.copy).textContent.trim());
  });

  // ------------------------------------------------------------ タブ
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
  function openTab(name) {
    $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.pane').forEach((p) => { p.hidden = p.id !== `pane-${name}`; });
    msg($('#app-msg'), '');
    if (name === 'labels') renderLabels();
    if (name === 'block') renderBlock();
    if (name === 'admins') loadAdmins();
    if (name === 'log') loadLog(true);
  }

  // ------------------------------------------------------------ 作品
  async function loadEntries() {
    const box = $('#entries');
    box.replaceChildren(h('p', { class: 'muted' }, '読み込んでいます…'));
    try {
      const r = await api('/api/admin/entries');
      S.entries = r.entries; S.reports = r.reports || {}; S.labels = r.labels; S.block = r.blocklist;
      renderEntries();
    } catch (e) { box.replaceChildren(h('p', { class: 'msg bad' }, e.message)); }
  }
  $('#reload').addEventListener('click', loadEntries);
  $('#q').addEventListener('input', renderEntries);

  function renderFilters() {
    const count = (f) => S.entries.filter((e) => inFilter(e, f)).length;
    $('#filters').replaceChildren(...FILTERS.map((f) => h('button', {
      type: 'button', class: `chip${S.filter === f ? ' on' : ''}${(f === 'pending' || f === 'reported') && count(f) ? ' attention' : ''}`,
      onclick: () => { S.filter = f; renderEntries(); },
    }, `${f === 'all' ? 'すべて' : f === 'reported' ? '通報あり' : STATE[f]} ${count(f)}`)));
  }

  const reportCount = (id) => Object.values(S.reports[id] || {}).reduce((a, b) => a + b, 0);
  const inFilter = (e, f) => f === 'all' || (f === 'reported' ? reportCount(e.id) > 0 : (e.state || 'public') === f);

  function renderEntries() {
    renderFilters();
    const q = $('#q').value.trim().toLowerCase();
    const list = S.entries.filter((e) => inFilter(e, S.filter)
      && (!q || [e.id, e.name, e.author, ...(e.downloads || []).map((d) => d.url), ...(e.intro || []).map((i) => i.url), e.site].some((x) => String(x || '').toLowerCase().includes(q))));
    const box = $('#entries');
    if (!list.length) { box.replaceChildren(h('p', { class: 'muted' }, S.filter === 'pending' && !q ? '承認待ちの作品はありません。' : '当てはまる作品はありません。')); return; }
    box.replaceChildren(...list.map(entryCard));
    const id = (location.hash.match(/^#(e\d{5,})$/) || [])[1];
    const target = id && box.querySelector(`[data-id="${id}"]`);
    if (target) { target.classList.add('focus'); target.scrollIntoView({ block: 'start' }); history.replaceState(null, '', location.pathname); }
  }

  const labelName = (id) => S.labels.find((l) => l.id === id)?.name || id;

  function entryCard(e) {
    const state = e.state || 'public';
    const card = h('article', { class: 'entry card', 'data-id': e.id });
    const box = h('p', { class: 'msg', hidden: true });

    // 見出し
    card.append(h('div', { class: 'entry-head' },
      h('span', { class: 'eid' }, e.id),
      h('span', { class: `badge st-${state}` }, STATE[state] || state),
      e.rating && e.rating !== 'all' ? h('span', { class: `badge rt-${e.rating}` }, RATING[e.rating]) : null,
      ...(e.content || []).map((c) => h('span', { class: 'badge lb' }, labelName(c))),
      h('span', { class: 'badge plain' }, e.claim === 'author' ? '作者本人' : e.claim_wish === 'author' ? '作者本人（未認証）' : '代理登録'),
      reportCount(e.id) ? h('span', { class: 'badge st-pending' }, `通報 ${reportCount(e.id)}`) : null,
    ));
    card.append(h('h3', { class: 'entry-title' }, e.name || '（作品名なし）', h('span', { class: 'by' }, ` ／ ${e.author || '（作者名なし）'}`)));

    // くわしく
    const dl = h('dl', { class: 'keys' });
    const row = (k, ...v) => { if (v.flat().some((x) => x !== '' && x != null)) dl.append(h('dt', {}, k), h('dd', {}, ...v)); };
    row('種類・形式', `${TYPE[e.type] || e.type || ''}${e.version ? `・版 ${e.version}` : ''}${e.format ? `・${{ classic: 'クラシック（1.50）', next: 'Next仕様', wsn: 'Py仕様（WSN）' }[e.format] || e.format}` : ''}`);
    row('配布先', h('ul', { class: 'plain' }, ...(e.downloads || []).map((d) => h('li', {}, link(d.url, d.label ? `${d.label}：${d.url}` : d.url), h('span', { class: 'muted' }, `（${DL_KIND[d.kind] || d.kind}・${DL_STATUS[d.status] || d.status}${d.match ? `・「${d.match}」で探す` : ''}）`)))));
    if ((e.intro || []).length) row('紹介ページ', h('ul', { class: 'plain' }, ...e.intro.map((i) => h('li', {}, link(i.url, i.label ? `${i.label}：${i.url}` : i.url)))));
    if (e.site) row('作者さんのサイト', link(e.site));
    row('情報元', `${CHECKED[e.checked] || e.checked || '（なし）'}${e.checked_note ? `：${e.checked_note}` : ''}`);
    if (e.derivative) row('改変版', `もと：${e.derivative.of || ''}／根拠：${e.derivative.basis || ''}`);
    if (e.auto_check) row('自動の確認', e.auto_check.ok ? h('span', {}, '作品名と作者名が見つかった：', link(e.auto_check.where)) : '配布ページなどに、作品名と作者名が見つからなかった', h('span', { class: 'muted' }, `（${when(e.auto_check.at)}）`));
    if (e.takedown) row('掲載停止の申請', h('b', {}, e.takedown.reason || '（理由なし）'), h('span', { class: 'muted' }, `（${when(e.takedown.at)}・申請の前は${STATE[e.takedown.from] || e.takedown.from || '？'}）`));
    if (state === 'held' && e.held_reason) row('一時保留の理由', e.held_reason, e.report_hold ? h('span', { class: 'muted' }, `（通報で自動：${REASON[e.report_hold.reason] || e.report_hold.reason} ${e.report_hold.count}人・${when(e.report_hold.at)}）`) : '');
    if (reportCount(e.id)) row('通報', Object.entries(S.reports[e.id]).map(([k, n]) => `${REASON[k] || k} ${n}人`).join('・'));
    if (e.verified) row('サイト認証', link(e.verified.where), h('span', { class: 'muted' }, `（${when(e.verified.at)}）`));
    if (e.verify) row('サイト認証', `手続き中（${when(e.verify.until)} まで）`);
    if ((e.tags || []).length) row('タグ', e.tags.join('、'));
    if (e.description) row('紹介文', h('span', { class: 'pre' }, e.description));
    row('日時', `登録 ${when(e.registered)}${e.changed ? `・変更 ${when(e.changed)}` : ''}${e.approved ? `・承認 ${when(e.approved.at)}` : ''}`);
    card.append(dl);

    // 作品の操作：結果は作品の欄と、一覧の上（ページを読み込み直すまで残る）の両方に出す
    const act = (btn, fn) => run(btn, box, async () => {
      try {
        const t = await fn();
        if (t) doneNote(`「${e.name}」（${e.id}）　${t}`);
        return t;
      } catch (err) { doneNote(`「${e.name}」（${e.id}）　${err.message}`, 'bad'); throw err; }
    });

    // 状態を変える
    const reason = h('input', { class: 'reason', maxlength: '300', placeholder: '一時保留の理由（任意。CWカタログに表示されます）' });
    const setState = (to, label, confirmText) => h('button', {
      type: 'button', class: `btn small${to === 'removed' ? ' danger' : to === 'public' ? '' : ' ghost'}`,
      onclick: (ev) => {
        if (confirmText && !confirm(confirmText)) return;
        act(ev.currentTarget, async () => {
          await api('/api/admin/state', { id: e.id, state: to, reason: to === 'held' ? reason.value : '' });
          e.state = to; if (to === 'held') e.held_reason = reason.value; else delete e.held_reason;
          if (state === 'pending' && to === 'public') e.approved = { at: new Date().toISOString() };
          setTimeout(renderEntries, 1200);
          return `「${STATE[to]}」にしました（数分でカタログに反映されます）`;
        });
      },
    }, label);
    const acts = h('div', { class: 'actions' });
    if (state === 'pending') acts.append(setState('public', '承認して公開'));
    else if (state !== 'public') acts.append(setState('public', '公開に戻す', state === 'removed' ? '登録解除された作品を、もう一度公開します。作者さんの意向を確かめましたか？' : state === 'private' && e.takedown ? '掲載停止の申請があった作品です。公開に戻してよいですか？' : ''));
    if (state !== 'held') acts.append(setState('held', '一時保留'));
    if (state !== 'private') acts.append(setState('private', '非公開'));
    if (state !== 'removed') acts.append(setState('removed', '登録解除', `「${e.name}」の登録を解除します。よろしいですか？`));
    card.append(acts);
    if (state !== 'held') card.append(reason);

    // ラベルを直す
    const lab = h('details', { class: 'sub' }, h('summary', {}, 'シナリオラベルを直す'));
    const rating = h('div', { class: 'choices' }, ...Object.entries(RATING).map(([v, n]) => h('label', {}, h('input', { type: 'radio', name: `rating-${e.id}`, value: v, checked: (e.rating || 'all') === v }), ` ${n}`)));
    const boxes = h('div', { class: 'choices' }, ...S.labels.map((l) => h('label', { title: l.description || '' }, h('input', { type: 'checkbox', value: l.id, checked: (e.content || []).includes(l.id) }), ` ${l.name}`)));
    lab.append(h('div', { class: 'field' }, '対象年齢', rating), h('div', { class: 'field' }, '注意ラベル', boxes), h('p', {}, h('button', {
      type: 'button', class: 'btn small',
      onclick: (ev) => act(ev.currentTarget, async () => {
        const r = await api('/api/admin/labels', { id: e.id, rating: $(`input[name="rating-${e.id}"]:checked`, lab)?.value, content: $$('input[type=checkbox]:checked', boxes).map((x) => x.value) });
        e.rating = r.rating; e.content = r.content;
        setTimeout(renderEntries, 1200);
        return 'ラベルを直しました（数分でカタログに反映されます）';
      }),
    }, 'ラベルを保存')));
    card.append(lab);

    // ブロック
    const blk = h('details', { class: 'sub' }, h('summary', {}, 'ブロックする'));
    const addBlock = (kind, value, text) => h('button', {
      type: 'button', class: 'btn small ghost',
      onclick: (ev) => {
        if (!confirm(`${text} をブロックリストに入れます。当たる作品は、カタログに出なくなります。よろしいですか？`)) return;
        act(ev.currentTarget, async () => {
          const r = await api('/api/admin/blocklist', { add: { [kind]: [value] } });
          S.block = r.blocklist;
          return `${text} をブロックしました`;
        });
      },
    }, text);
    const hosts = [...new Set([...(e.downloads || []).map((d) => d.url), ...(e.intro || []).map((i) => i.url), e.site].map(hostOf).filter(Boolean))];
    blk.append(h('p', { class: 'muted' }, 'いたずらや、載せてはいけない作品の登録が続くときに使います。作品だけを外すときは「非公開」で足ります。'),
      h('div', { class: 'actions' }, e.author ? addBlock('authors', e.author, `作者名「${e.author}」`) : null, ...hosts.map((x) => addBlock('hosts', x, `サイト ${x}`))));
    // 通報
    if (reportCount(e.id)) {
      const rep = h('details', { class: 'sub' }, h('summary', {}, '通報を見る・片付ける'));
      const inner = h('div', {}, h('p', { class: 'muted' }, '開くと読み込みます…'));
      rep.append(inner);
      rep.addEventListener('toggle', async () => {
        if (!rep.open || rep.dataset.loaded) return;
        try {
          const r = await api(`/api/admin/reports?id=${e.id}`);
          rep.dataset.loaded = '1';
          inner.replaceChildren(...r.reports.map((x) => h('div', { class: 'report' },
            h('p', {}, h('b', {}, x.name), ` … ${x.count}人${x.threshold ? `（${x.threshold}人で一時保留）` : '（保留にはしない）'}`, h('span', { class: 'muted' }, `　最初 ${when(x.first)}・最後 ${when(x.last)}`)),
            h('ul', { class: 'plain report-items' }, ...x.items.map((it) => h('li', {}, h('span', { class: 'muted' }, `${when(it.at)}　#${it.who}　`), it.comment ? h('span', { class: 'pre' }, it.comment) : h('span', { class: 'muted' }, '（コメントなし）')))),
          )), h('p', { class: 'muted' }, '「#」のあとの文字は、通報した人ごとの目印です（同じ人の通報を見分けるため。IP アドレスではありません）。'),
          h('div', { class: 'actions' }, h('button', {
            type: 'button', class: 'btn small',
            onclick: (ev) => { if (confirm('この作品の通報を片付けます（数とコメントが消えます）。作品の状態は変わりません。よろしいですか？')) act(ev.currentTarget, async () => { await api('/api/admin/reports/clear', { id: e.id }); delete S.reports[e.id]; setTimeout(renderEntries, 1200); return '通報を片付けました。一時保留中なら、必要に応じて「公開に戻す」を押してください'; }); },
          }, '通報を片付ける')));
        } catch (err) { inner.replaceChildren(h('p', { class: 'msg bad' }, err.message)); }
      });
      card.append(rep);
    }
    card.append(blk, box);
    return card;
  }

  // ------------------------------------------------------------ ラベルの種類
  function renderLabels() {
    const tb = $('#labels-table tbody');
    tb.replaceChildren(...S.labels.map((l) => labelRow({ ...l, saved: true })));
  }
  function labelRow(l = { id: '', name: '' }) {
    const tr = h('tr', {},
      h('td', {}, l.builtin || l.saved ? h('code', {}, l.id) : h('input', { class: 'lid', maxlength: '30', placeholder: '例：utsu', value: l.id, spellcheck: 'false' }), l.builtin ? h('span', { class: 'muted' }, ' 最初から') : null),
      h('td', {}, h('input', { class: 'lname', maxlength: '30', value: l.name || '' })),
      h('td', {}, h('input', { class: 'ldesc', maxlength: '200', value: l.description || '' })),
      h('td', {}, l.builtin ? '' : h('button', { type: 'button', class: 'btn small ghost', onclick: () => {
        if (S.entries.some((e) => (e.content || []).includes(l.id)) && !confirm(`ラベル「${l.name}」は作品に付いています。消すと、その作品からも表示されなくなります。よろしいですか？`)) return;
        tr.remove();
      } }, '消す')),
    );
    tr.dataset.id = l.id;
    return tr;
  }
  $('#label-add').addEventListener('click', () => $('#labels-table tbody').append(labelRow()));
  $('#labels-save').addEventListener('click', (ev) => run(ev.currentTarget, $('#labels-msg'), async () => {
    const labels = $$('#labels-table tbody tr').map((tr) => ({
      id: (tr.querySelector('.lid')?.value ?? tr.dataset.id).trim().toLowerCase(),
      name: tr.querySelector('.lname').value.trim(),
      description: tr.querySelector('.ldesc').value.trim(),
    })).filter((l) => l.id || l.name);
    const r = await api('/api/admin/content-labels', { labels });
    S.labels = r.labels;
    renderLabels();
    return 'ラベルの種類を保存しました（数分で、登録フォームと CWカタログに反映されます）';
  }));

  // ------------------------------------------------------------ ブロックリスト
  function renderBlock() {
    const b = S.block || { urls: [], hosts: [], authors: [] };
    $('#block-urls').value = b.urls.join('\n'); $('#block-hosts').value = b.hosts.join('\n'); $('#block-authors').value = b.authors.join('\n');
  }
  const lines = (s) => $(s).value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  $('#block-save').addEventListener('click', (ev) => run(ev.currentTarget, $('#block-msg'), async () => {
    const r = await api('/api/admin/blocklist', { urls: lines('#block-urls'), hosts: lines('#block-hosts'), authors: lines('#block-authors') });
    S.block = r.blocklist; renderBlock();
    return 'ブロックリストを保存しました（形のおかしい行は外しました）';
  }));

  // ------------------------------------------------------------ 自分の設定
  function renderMe() {
    $('#me-name').value = S.me.name;
    $('#me-hook').textContent = S.me.webhook || '（まだありません）';
    $('#sec-box').hidden = S.me.role !== 'owner';
    $('#sec-state').textContent = S.securityHook ? '設定済み（GH_WEBHOOK_SECRET があります）' : 'まだ設定されていません';
    $('#me-events').replaceChildren(...S.events.map((ev) => h('label', {}, h('input', { type: 'checkbox', value: ev.id, checked: (S.me.events || []).includes(ev.id) }), ` ${ev.name}`)));
  }
  const saveMe = async (body, done) => { const r = await api('/api/admin/me', body); S.me = { ...S.me, ...r.me }; renderMe(); renderWho(); return done; };
  $('#me-name-save').addEventListener('click', (ev) => run(ev.currentTarget, $('#me-name-msg'), () => saveMe({ name: $('#me-name').value }, '名前を保存しました')));
  $('#me-hook-save').addEventListener('click', (ev) => run(ev.currentTarget, $('#me-hook-msg'), async () => {
    const body = { events: $$('#me-events input:checked').map((x) => x.value) };
    const w = $('#me-hook-new').value.trim();
    if (w) body.webhook = w;
    const t = await saveMe(body, w ? '送り先と、知らせる出来事を保存しました。「ためしに送る」で確かめられます' : '知らせる出来事を保存しました');
    $('#me-hook-new').value = '';
    return t;
  }));
  $('#me-hook-clear').addEventListener('click', (ev) => { if (confirm('Discord の送り先を外します。よろしいですか？')) run(ev.currentTarget, $('#me-hook-msg'), () => saveMe({ webhook: '' }, '送り先を外しました')); });
  $('#me-hook-test').addEventListener('click', (ev) => run(ev.currentTarget, $('#me-hook-msg'), async () => { await api('/api/admin/me/test', {}); return 'ためしの知らせを送りました。Discord を見てみてください'; }));
  // 安全の報告：合言葉をこのブラウザの中で作る（どこにも送らない）
  $('#sec-make').addEventListener('click', () => {
    const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $('#sec-secret').textContent = [...crypto.getRandomValues(new Uint8Array(40))].map((b) => abc[b % abc.length]).join('');
    $('#sec-out').hidden = false;
  });
  $('#me-rekey').addEventListener('click', (ev) => {
    if (!confirm('自分のキーを作り直します。今のキーはすぐに使えなくなります。よろしいですか？')) return;
    run(ev.currentTarget, $('#me-rekey-msg'), async () => {
      const r = await api('/api/admin/admins/rekey', {});
      S.key = r.key; if (store.get()) store.set(r.key);
      return `新しいキー：${r.key}　⚠ 二度と表示されません。必ず控えてください`;
    });
  });

  // ------------------------------------------------------------ 副管理人
  async function loadAdmins() {
    const box = $('#admins-list');
    try {
      const r = await api('/api/admin/admins');
      box.replaceChildren(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '名前'), h('th', {}, '役目'), h('th', {}, 'Discord'), h('th', {}, ''))),
        h('tbody', {}, ...r.admins.map((a) => h('tr', {},
          h('td', {}, a.name, a.created ? h('div', { class: 'muted' }, `${when(a.created)} 追加`) : null),
          h('td', {}, a.role === 'owner' ? '管理人' : '副管理人'),
          h('td', {}, a.webhook ? 'あり' : '—'),
          h('td', { class: 'nowrap' }, a.role === 'owner' ? '' : [
            h('button', { type: 'button', class: 'btn small ghost', onclick: (ev) => { if (confirm(`「${a.name}」さんのキーを作り直します。今のキーは使えなくなります。よろしいですか？`)) run(ev.currentTarget, $('#admins-msg'), async () => { const k = await api('/api/admin/admins/rekey', { id: a.id }); return `「${a.name}」さんの新しいキー：${k.key}　⚠ 二度と表示されません。本人に、ほかの人に見られない方法で渡してください`; }); } }, 'キーを作り直す'),
            ' ',
            h('button', { type: 'button', class: 'btn small danger', onclick: (ev) => { if (confirm(`「${a.name}」さんを副管理人から外します。よろしいですか？`)) run(ev.currentTarget, $('#admins-msg'), async () => { await api('/api/admin/admins/remove', { id: a.id }); await loadAdmins(); return `「${a.name}」さんを外しました`; }); } }, '外す'),
          ]),
        )))));
    } catch (e) { box.replaceChildren(h('p', { class: 'msg bad' }, e.message)); }
  }
  $('#admin-add').addEventListener('click', (ev) => run(ev.currentTarget, $('#admins-msg'), async () => {
    const r = await api('/api/admin/admins/add', { name: $('#admin-name').value });
    $('#admin-name').value = '';
    await loadAdmins();
    return `「${r.admin.name}」さんを追加しました。キー：${r.key}　⚠ 二度と表示されません。本人に、ほかの人に見られない方法で渡してください`;
  }));

  // ------------------------------------------------------------ 記録
  async function loadLog(first) {
    const box = $('#log');
    if (first) { S.logCursor = null; box.replaceChildren(h('p', { class: 'muted' }, '読み込んでいます…')); }
    try {
      const r = await api(`/api/admin/log${S.logCursor ? `?cursor=${encodeURIComponent(S.logCursor)}` : ''}`);
      const rows = r.items.map((x) => h('li', {}, h('span', { class: 'muted' }, when(x.at)), ' ', h('b', {}, x.name || x.by), ' ', h('span', { class: 'badge plain' }, ACTION[x.action] || x.action), x.target ? h('span', { class: 'eid' }, ` ${x.target}`) : null, x.detail ? h('span', {}, ` ${x.detail}`) : null));
      if (first) box.replaceChildren(rows.length ? h('ul', { class: 'log' }, ...rows) : h('p', { class: 'muted' }, 'まだ記録はありません。'));
      else box.querySelector('ul')?.append(...rows);
      S.logCursor = r.cursor;
      $('#log-more').hidden = !r.cursor;
    } catch (e) { box.replaceChildren(h('p', { class: 'msg bad' }, e.message)); }
  }
  $('#log-more').addEventListener('click', () => loadLog(false));

  // ------------------------------------------------------------ はじめ
  const saved = store.get();
  if (saved) login(saved, true).catch((e) => { store.clear(); S.key = ''; msg($('#login-msg'), e.message, 'bad'); });
})();
