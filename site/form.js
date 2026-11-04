// 登録ページ・直すページで使う、作品の入力欄と、受付への送信
(function () {
  const C = window.CW_CONFIG || {};
  const $ = (s, root = document) => root.querySelector(s);
  const LABELS = [['gore', 'グロ・残酷描写'], ['horror', 'ホラー'], ['sexual', '性的な表現（R15相当）']];

  /** 受付に送る。Turnstile のトークンを付ける（1回ずつ使い捨て） */
  async function send(path, body, widget) {
    if (!C.api) throw new Error('受付の準備中です。もうしばらくお待ちください');
    const token = widget ? window.turnstile?.getResponse(widget) : '';
    if (widget && !token) throw new Error('「ロボットではありません」の確認が終わるまで、少しお待ちください');
    try {
      const r = await fetch(`${C.api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, turnstile: token }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `受付でエラーが起きました（${r.status}）`);
      return j;
    } finally {
      if (widget) window.turnstile?.reset(widget);
    }
  }
  async function get(path) {
    if (!C.api) throw new Error('受付の準備中です。もうしばらくお待ちください');
    const r = await fetch(`${C.api}${path}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `読み込めませんでした（${r.status}）`);
    return j;
  }

  /** Turnstile の確認欄を置く */
  function turnstile(el) {
    return new Promise((resolve) => {
      const go = () => resolve(window.turnstile.render(el, { sitekey: C.turnstileSiteKey, language: 'ja' }));
      if (window.turnstile) go(); else window.addEventListener('cw-turnstile', go, { once: true });
    });
  }

  /** フォームの値をまとめる */
  function read(form) {
    const fd = new FormData(form);
    const o = {};
    for (const [k, v] of fd.entries()) {
      if (k === 'content') (o.content ||= []).push(v);
      else o[k] = typeof v === 'string' ? v : '';
    }
    o.proxy_ok = !!form.querySelector('[name=proxy_ok]')?.checked;
    return o;
  }

  /** 前のデータを、入力欄に入れる（直すとき） */
  function fill(form, e) {
    const set = (n, v) => { const el = form.querySelector(`[name="${n}"]`); if (el) el.value = v ?? ''; };
    const dl = e.downloads || [];
    const active = dl.find((d) => d.status === 'active') || dl[0] || {};
    const old = dl.find((d) => d.status === 'old');
    set('type', e.type || 'scenario'); set('name', e.name); set('author', e.author); set('version', e.version); set('format', e.format || 'classic');
    if (old) { set('url', old.url); set('url_label', old.label); set('url_kind', old.kind); set('moved_url', active.url); set('moved_label', active.label); set('moved_kind', active.kind); }
    else { set('url', active.url); set('url_label', active.label); set('url_kind', active.kind || 'page'); set('match', active.match); }
    set('more_urls', dl.filter((d) => d.status === 'mirror').map((d) => (d.label ? `${d.label} | ${d.url}` : d.url)).join('\n'));
    set('site', e.site); set('intro', (e.intro || []).map((i) => i.url).join('\n'));
    set('tags', (e.tags || []).join('、')); set('description', e.description);
    form.querySelector('[name=tags]')?.dispatchEvent(new Event('input'));
    form.querySelectorAll('[name=rating]').forEach((r) => { r.checked = r.value === (e.rating || 'all'); });
    form.dataset.content = JSON.stringify(e.content || []);
    form.querySelectorAll('[name=content]').forEach((c) => { c.checked = (e.content || []).includes(c.value); });
    set('checked', e.checked); set('checked_note', e.checked_note);
    form.querySelectorAll('[name=derivative]').forEach((r) => { r.checked = r.value === (e.derivative ? 'yes' : 'no'); });
    set('derivative_of', e.derivative?.of); set('derivative_basis', e.derivative?.basis);
    form.dispatchEvent(new Event('change'));
  }

  /** 選んだものに合わせて、欄を出したり隠したりする */
  function wire(form) {
    const upd = () => {
      const der = form.querySelector('[name=derivative]:checked')?.value === 'yes';
      form.querySelectorAll('.if-derivative').forEach((x) => { x.hidden = !der; });
      const claim = form.querySelector('[name=claim]:checked')?.value;
      form.querySelectorAll('.if-proxy').forEach((x) => { x.hidden = claim === 'author'; });
      // 作者本人の登録のときは、ほかの人も確かめられる場所を選んでもらう
      form.querySelectorAll('.if-author').forEach((x) => { x.hidden = claim !== 'author'; });
      form.querySelectorAll('.if-not-author').forEach((x) => { x.hidden = claim === 'author'; });
      form.querySelectorAll('.if-list').forEach((x) => { x.hidden = form.querySelector('[name=url_kind]')?.value !== 'list'; });
    };
    form.addEventListener('change', upd);
    upd();
    extendLabels(form);
    const tags = form.querySelector('[name=tags]');
    if (tags) tagChips(tags);
  }

  /** 管理人が増やした注意ラベル（カタログの content_labels）を、ラベルの欄に足す */
  async function extendLabels(form) {
    const box = form.querySelector('.label-choices');
    if (!box) return;
    let labels = [];
    try { labels = (await (await fetch('../index.json', { cache: 'no-cache' })).json()).content_labels || []; } catch { return; }
    for (const l of labels) {
      if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(l?.id || '') || !l.name) continue;
      let input = box.querySelector(`input[value="${l.id}"]`);
      if (input) { input.parentElement.lastChild.textContent = ` ${l.name}`; } else {
        const lab = document.createElement('label');
        input = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'content', value: l.id });
        lab.append(input, document.createTextNode(` ${l.name}`));
        box.append(lab);
      }
      if (l.description) input.parentElement.title = l.description;
    }
    // 先に読み込んだ作品のラベルを、足した欄にも反映する
    try { const c = JSON.parse(form.dataset.content || '[]'); box.querySelectorAll('[name=content]').forEach((x) => { if (c.includes(x.value)) x.checked = true; }); } catch { /* なし */ }
  }

  /** よく使うタグ：カタログ（index.json の tag_presets。管理ページで直せる）から読む。読めないときは最初の一覧 */
  const TAG_PRESETS = ['プライベート店', '読み物', '冒険', '戦闘あり', '店', 'その他', 'Lv無', 'Lv低', 'Lv中', 'Lv高', '一人用', '二人用', '少人数', '六人用', '短編', '中編', '長編', 'ギャグシナ', 'ホラーシナ', '悪役シナ', '両想い', '片想い', '相棒親友', 'ゴブ洞', '100kb'];
  const INDEX_URL = new URL('index.json', document.currentScript?.src || location.href).href;
  let presetsP = null;
  const tagPresets = () => (presetsP ||= fetch(INDEX_URL, { cache: 'no-cache' }).then((r) => r.json()).then((j) => (Array.isArray(j.tag_presets) && j.tag_presets.length ? j.tag_presets.map(String) : TAG_PRESETS)).catch(() => TAG_PRESETS));
  const splitTags = (v) => String(v || '').split(/[、,，\s]+/).map((t) => t.trim()).filter(Boolean);
  /** タグの欄の下に、押すと付け外しできるボタンを並べる */
  function tagChips(input) {
    const box = document.createElement('div');
    box.className = 'tag-chips';
    (input.closest('label') || input).after(box);
    let btns = [];
    const refresh = () => { const list = splitTags(input.value); btns.forEach((b) => { const on = list.includes(b.textContent); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); };
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);
    tagPresets().then((presets) => {
      btns = presets.map((t) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: t });
        b.addEventListener('click', () => {
          const list = splitTags(input.value);
          input.value = (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]).join('、');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return b;
      });
      const lvBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'chip level-btn', textContent: '＋対象レベル設定タグ' });
      lvBtn.addEventListener('click', () => levelDialog(input));
      box.replaceChildren(...btns, lvBtn);
      refresh();
    });
  }

  // ------------------------------------------------------------ 対象レベルのタグ（「Lv3以上」「Lv5以下」。アプリが Readme から付けるタグと同じ形）
  /** 書き方を読む：「3～5」「1-3」「２ー４」「3から5」「Lv3～Lv5」「3以上」「5以下」「4」など */
  function parseLevel(text) {
    const t = String(text || '').normalize('NFKC').replace(/(?:Lv\.?|LV\.?|lv\.?|レベル)/g, '');
    const two = t.match(/(\d{1,2})\s*(?:[~～〜\-ー―−]|から|to)\s*(\d{1,2})/);
    if (two) { const a = +two[1], b = +two[2]; return { min: Math.min(a, b), max: Math.max(a, b) }; }
    const up = t.match(/(\d{1,2})\s*(?:以上|～$|~$|〜$|-$|から$)/);
    if (up) return { min: +up[1], max: null };
    const down = t.match(/(\d{1,2})\s*以下|(?:[~～〜\-ー]|まで)\s*(\d{1,2})/);
    if (down) return { min: null, max: +(down[1] || down[2]) };
    const one = t.match(/^\s*(\d{1,2})\s*(?:$|[^\d])/);
    if (one) return { min: +one[1], max: +one[1] };
    return null;
  }
  const LV_TAG = /^Lv\d{1,2}(?:以上|以下)$/;
  /** 対象レベルを入れる窓。自由に書く（1～3 など）か、下限・上限の数字で入れる。前の Lv●以上・Lv●以下 は入れ替える */
  function levelDialog(input) {
    const d = document.createElement('dialog');
    d.className = 'level-dialog';
    const now = splitTags(input.value);
    const curMin = now.map((t) => /^Lv(\d+)以上$/.exec(t)?.[1]).find(Boolean) || '';
    const curMax = now.map((t) => /^Lv(\d+)以下$/.exec(t)?.[1]).find(Boolean) || '';
    d.innerHTML = `
      <h3>対象レベル設定タグ</h3>
      <p class="hint">自由に書くか、下限・上限の数字を入れてください。「Lv3以上」「Lv5以下」のようなタグになります。（片方だけでも大丈夫です）</p>
      <label class="field">自由に書く<span class="hint">例：1～3、1-3、２ー４、3以上、5以下</span><input class="lv-free" placeholder="1～3"></label>
      <div class="lv-nums"><label class="field">対象Lv下限<input class="lv-min" type="number" min="1" max="99" inputmode="numeric"></label>
      <label class="field">対象Lv上限<input class="lv-max" type="number" min="1" max="99" inputmode="numeric"></label></div>
      <p class="lv-preview hint"></p>
      <p class="lv-actions"><button type="button" class="btn lv-ok">タグに入れる</button> <button type="button" class="btn ghost lv-clear">レベルのタグを外す</button> <button type="button" class="btn ghost lv-cancel">やめる</button></p>`;
    document.body.append(d);
    const q = (c) => d.querySelector(c);
    q('.lv-min').value = curMin; q('.lv-max').value = curMax;
    const read = () => {
      const free = parseLevel(q('.lv-free').value);
      const min = free ? free.min : (q('.lv-min').value ? Math.max(1, Math.min(99, +q('.lv-min').value)) : null);
      const max = free ? free.max : (q('.lv-max').value ? Math.max(1, Math.min(99, +q('.lv-max').value)) : null);
      if (min != null && max != null && min > max) return { min: max, max: min };
      return { min, max };
    };
    const tagsOf = (lv) => [lv.min != null ? `Lv${lv.min}以上` : '', lv.max != null ? `Lv${lv.max}以下` : ''].filter(Boolean);
    const preview = () => {
      const free = q('.lv-free').value.trim();
      if (free && !parseLevel(free)) { q('.lv-preview').textContent = '読み取れませんでした（例：1～3、3以上）'; return; }
      const t = tagsOf(read());
      q('.lv-preview').textContent = t.length ? `入るタグ：${t.join('、')}` : '';
    };
    d.addEventListener('input', (ev) => {
      // 自由に書いた内容が読めたら、下限・上限の数字もそろえる（見た目が食い違わないように）
      if (ev.target.classList.contains('lv-free')) { const lv = parseLevel(ev.target.value); if (lv) { q('.lv-min').value = lv.min ?? ''; q('.lv-max').value = lv.max ?? ''; } }
      else q('.lv-free').value = '';
      preview();
    });
    const put = (add) => {
      input.value = [...splitTags(input.value).filter((t) => !LV_TAG.test(t)), ...add].join('、');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      d.close();
    };
    q('.lv-ok').addEventListener('click', () => { const t = tagsOf(read()); if (!t.length) { q('.lv-preview').textContent = 'レベルを入れてください'; return; } put(t); });
    q('.lv-clear').addEventListener('click', () => put([]));
    q('.lv-cancel').addEventListener('click', () => d.close());
    d.addEventListener('close', () => d.remove());
    preview();
    d.showModal();
  }

  const msg = (el, text, kind = '') => {
    el.className = `msg ${kind}`;
    // 行ごとに分けて出したいときは、要素の配列を渡す（中の文字は textContent で入れるので、HTML としては読まれない）
    if (Array.isArray(text)) el.replaceChildren(...text); else el.textContent = text;
    el.hidden = Array.isArray(text) ? !text.length : !text;
  };
  /** msg に渡す1行（cls：key＝キーや URL、danger＝赤い字） */
  const line = (text, cls = '') => { const d = document.createElement('div'); if (cls) d.className = `msg-line ${cls}`; d.textContent = text; return d; };

  window.CW = { $, LABELS, send, get, turnstile, read, fill, wire, msg, line, tagChips };
})();

// 作品の入力欄（登録ページと直すページで同じもの）
window.CW.fieldsHtml = `
<fieldset>
  <legend>作品</legend>
  <label class="field">種類
    <select name="type"><option value="scenario">シナリオ</option><option value="skin">スキン（CardWirthPy）</option><option value="material">素材（画像・音など）</option></select></label>
  <label class="field"><b class="req">必須</b> 作品名<input name="name" required maxlength="200"></label>
  <label class="field"><b class="req">必須</b> 作者名<span class="hint">作者名またはサークル名（※代理登録の場合、登録者ではなく原作者名を入力してください）</span><input name="author" required maxlength="200"></label>
  <div class="row2">
    <label class="field">バージョン<input name="version" maxlength="50" placeholder="例：1.10"></label>
    <label class="field">形式
      <select name="format"><option value="classic">クラシック（1.50）</option><option value="next">Next仕様</option><option value="wsn">Py仕様（WSN）</option></select></label>
  </div>
</fieldset>

<fieldset>
  <legend>配布先</legend>
  <label class="field"><b class="req">必須</b> 配布URL<span class="hint">作者さんの配布ページ・BOOTH・アップローダーなど</span><input name="url" type="url" required placeholder="https://"></label>
  <div class="row2">
    <label class="field">URLの種類
      <select name="url_kind"><option value="page">配布ページ</option><option value="direct">zipなどへの直接のリンク</option><option value="list">ファイル一覧（アップローダーの一覧ページ）</option></select></label>
    <label class="field">配布先の名前<input name="url_label" maxlength="100" placeholder="例：作者サイト、BOOTH"></label>
  </div>
  <label class="field if-list">一覧で探す名前<span class="hint">空なら作品名で探します</span><input name="match" maxlength="100"></label>
  <label class="field">移行先URL<span class="hint">配布先を移転・変更した際の新しいURL。入力すると上記の配布URLは自動的に「旧（移転前）」扱いとなります</span><input name="moved_url" type="url" placeholder="https://"></label>
  <input type="hidden" name="moved_kind" value="page"><input type="hidden" name="moved_label" value="">
  <label class="field">予備の配布URL<span class="hint">1行に1つ。「名前 | URL」とも書けます</span><textarea name="more_urls" rows="2"></textarea></label>
</fieldset>

<fieldset>
  <legend>作者さんのサイト・紹介ページ</legend>
  <label class="field">作者さんのサイト<input name="site" type="url" placeholder="https://"></label>
  <label class="field">紹介ページ<span class="hint">作品の紹介ページ・X・Misskey の告知など。1行に1つ</span><textarea name="intro" rows="2"></textarea></label>
</fieldset>

<fieldset>
  <legend>シナリオラベル</legend>
  <div class="field"><b class="req">必須</b> 対象年齢
    <div class="choices">
      <label><input type="radio" name="rating" value="all"> 全年齢</label>
      <label><input type="radio" name="rating" value="r15"> R15</label>
      <label><input type="radio" name="rating" value="r18"> R18（成人向け）</label>
    </div>
    <span class="hint">R18 の作品は、CWカタログで「R18を表示する」をONにした方にだけ表示されます。作品名・紹介文に、露骨な表現は書かないでください</span>
  </div>
  <div class="field">注意ラベル（あてはまるものすべて）
    <div class="choices label-choices">${window.CW.LABELS.map(([v, l]) => `<label><input type="checkbox" name="content" value="${v}"> ${l}</label>`).join('')}</div>
  </div>
</fieldset>

<fieldset>
  <legend>紹介</legend>
  <label class="field">タグ<span class="hint">「、」で区切る（例：短編、探索、1人用）。よく使うタグは、下のボタンで付け外しできます</span><input name="tags" maxlength="400"></label>
  <label class="field">紹介文<textarea name="description" rows="4" maxlength="5000"></textarea></label>
</fieldset>

<fieldset>
  <legend>確かめたこと</legend>
  <label class="field"><b class="req">必須</b> 情報元・確認方法<span class="hint if-not-author">配布先・作者名・代理許可等をどこで確認したか選択してください（後から変更可能です）</span><span class="hint if-author" hidden>作者本人が登録するときは、ほかの人も確かめられる場所（Readme・作者公式サイト・配布ページなど）を選んでください。（後から変更可能です）</span>
    <select name="checked" required><option value="">選んでください</option><option value="readme">Readme</option><option value="site">作者公式サイト・配布ページ</option><option value="author">作者本人へ直接確認</option><option value="other">その他</option></select></label>
  <label class="field">補足<input name="checked_note" maxlength="300" placeholder="例：Readmeの「再配布について」の項目"></label>
  <div class="field">改変版ですか？
    <div class="choices"><label><input type="radio" name="derivative" value="no" checked> いいえ</label><label><input type="radio" name="derivative" value="yes"> はい（ほかの作品を改変したもの）</label></div>
  </div>
  <label class="field if-derivative"><b class="req">必須</b> もとの作品<input name="derivative_of" maxlength="200"></label>
  <label class="field if-derivative"><b class="req">必須</b> 改変してよいと分かるもの<span class="hint">もとの作品の規約のURL・Readmeの項目など</span><input name="derivative_basis" maxlength="500"></label>
</fieldset>
`;
