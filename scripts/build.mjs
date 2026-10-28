// 共用カタログを作る：entries/*.json（作品1件ずつ）と catalog.json から、
//   public/index.json      … 全年齢・R15 の作品（公開中・一時保留中）
//   public/index-r18.json  … R18 の作品だけ（R18 をONにした人だけが取りに行く）
// を作る。site/meta.json（指紋とjsDelivrの写しのURL）は、公開するときに deploy の前に作る（--meta）。
// 承認待ち（pending）・非公開（private）・登録解除（removed）の作品と、ブロックリストに当たる作品は出さない。
// 使い方：node scripts/build.mjs           … public/ を作る（確かめるだけなら --check）
//         node scripts/build.mjs --meta <commit> … site/ に配る形をそろえる
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const REPO = 'seihayukimi-oss/cardwirth-catalog';
const STATES = new Set(['public', 'held', 'pending', 'private', 'removed']);
const RATINGS = new Set(['all', 'r15', 'r18']);
const ID_RE = /^e\d{5,}$/;
const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/.test(u);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 配る形に整える（管理用の項目は出さない）。おかしければ理由を返す */
export function toPublic(e, block = { urls: [], hosts: [], authors: [] }) {
  if (!e || typeof e !== 'object') return { error: '形が正しくありません' };
  if (!ID_RE.test(e.id || '')) return { error: 'id が正しくありません（e＋5桁以上の数字）' };
  const state = STATES.has(e.state) ? e.state : 'public';
  if (state === 'private' || state === 'removed' || state === 'pending') return { skip: state };
  const name = str(e.name, 200), author = str(e.author, 200);
  if (!name) return { error: '作品名がありません' };
  if (!author) return { error: '作者名がありません' };
  const downloads = (Array.isArray(e.downloads) ? e.downloads : []).filter((d) => d && isHttp(d.url)).slice(0, 20).map((d) => ({
    label: str(d.label, 100), url: d.url,
    kind: ['direct', 'list', 'page'].includes(d.kind) ? d.kind : 'page',
    ...(d.kind === 'list' && str(d.match, 100) ? { match: str(d.match, 100) } : {}),
    status: ['active', 'mirror', 'old', 'closed'].includes(d.status) ? d.status : 'active',
    ...(/^\d{4}-\d{2}-\d{2}$/.test(d.until || '') ? { until: d.until } : {}),
    ...(str(d.note, 300) ? { note: str(d.note, 300) } : {}),
  }));
  if (!downloads.length) return { error: '配布URLがありません' };
  // ブロックリスト
  const bUrls = new Set((block.urls || []).map((u) => u.toLowerCase()));
  const bHosts = new Set((block.hosts || []).map((h) => h.toLowerCase()));
  const bAuthors = new Set((block.authors || []).map(norm));
  const urls = [...downloads.map((d) => d.url), ...(e.intro || []).map((i) => i?.url || i), e.site].filter(isHttp);
  if (bAuthors.has(norm(author))) return { skip: 'blocked' };
  if (urls.some((u) => bUrls.has(u.toLowerCase()) || [...bHosts].some((h) => hostOf(u) === h || hostOf(u).endsWith(`.${h}`)))) return { skip: 'blocked' };
  const out = {
    id: e.id, type: ['scenario', 'skin', 'material'].includes(e.type) ? e.type : 'scenario',
    name, author, version: str(e.version, 50),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(e.updated || '') ? { updated: e.updated } : {}),
    format: ['classic', 'next', 'wsn', 'none'].includes(e.format) ? e.format : 'classic',
    ...(Number.isInteger(e.wsn_version) ? { wsn_version: e.wsn_version } : {}),
    compat: Object.fromEntries(['cw150', 'next', 'py'].map((k) => [k, ['verified', 'expected', 'no', 'unknown'].includes(e.compat?.[k]) ? e.compat[k] : 'unknown'])),
    convert: ['allowed', 'self', 'forbidden'].includes(e.convert) ? e.convert : 'self',
    downloads,
    rating: RATINGS.has(e.rating) ? e.rating : 'all',
  };
  const content = [...new Set((Array.isArray(e.content) ? e.content : []).filter((c) => LABEL_RE.test(c)))].slice(0, 20);
  if (content.length) out.content = content;
  if (state === 'held') { out.state = 'held'; if (str(e.held_reason, 300)) out.held_reason = str(e.held_reason, 300); }
  if (e.claim === 'author' || e.claim === 'proxy') out.claim = e.claim;
  for (const [k, max] of [['description', 5000], ['readme', 300], ['checked_note', 300]]) if (str(e[k], max)) out[k] = str(e[k], max);
  if (['readme', 'site', 'author', 'other'].includes(e.checked)) out.checked = e.checked;
  if (isHttp(e.site)) out.site = e.site;
  const tags = (Array.isArray(e.tags) ? e.tags : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 30);
  if (tags.length) out.tags = tags;
  const intro = (Array.isArray(e.intro) ? e.intro : []).map((i) => (typeof i === 'string' ? { url: i } : i)).filter((i) => isHttp(i?.url)).slice(0, 10).map((i) => ({ url: i.url, ...(str(i.label, 100) ? { label: str(i.label, 100) } : {}) }));
  if (intro.length) out.intro = intro;
  if (e.derivative && typeof e.derivative === 'object' && (str(e.derivative.of, 200) || str(e.derivative.basis, 500))) out.derivative = { of: str(e.derivative.of, 200), basis: str(e.derivative.basis, 500) };
  if (e.origin && str(e.origin.name, 100)) out.origin = { name: str(e.origin.name, 100), ...(isHttp(e.origin.url) ? { url: e.origin.url } : {}) };
  if (e.file && /^[0-9a-f]{64}$/.test(e.file.sha256 || '')) out.file = { name: str(e.file.name, 300), sha256: e.file.sha256 };
  if (e.level && Number.isInteger(e.level.min)) out.level = { min: e.level.min, max: Number.isInteger(e.level.max) ? e.level.max : e.level.min };
  return { entry: out };
}

/** カタログ全体を作る */
export function buildCatalog(meta, entries, block) {
  const warnings = [];
  const pub = [], r18 = [];
  const seen = new Set();
  for (const { file, data } of entries) {
    if (data?.id && seen.has(data.id)) { warnings.push(`${file}：id ${data.id} が重なっています（後のものを飛ばしました）`); continue; }
    if (data?.id) seen.add(data.id);
    const r = toPublic(data, block);
    if (r.error) { warnings.push(`${file}：${r.error}（飛ばしました）`); continue; }
    if (r.skip) continue;
    (r.entry.rating === 'r18' ? r18 : pub).push(r.entry);
  }
  const byId = (a, b) => a.id.localeCompare(b.id);
  pub.sort(byId); r18.sort(byId);
  const contentLabels = (Array.isArray(meta.content_labels) ? meta.content_labels : []).filter((d) => d && LABEL_RE.test(d.id || '') && str(d.name, 30)).map((d) => ({ id: d.id, name: str(d.name, 30), ...(str(d.description, 200) ? { description: str(d.description, 200) } : {}) }));
  const head = {
    format: 1, name: meta.name, attribution: meta.attribution, license: meta.license, links: meta.links,
    ...(contentLabels.length ? { content_labels: contentLabels } : {}),
    engines: [], authors: meta.authors || {},
  };
  return { index: { ...head, entries: pub }, r18: { ...head, entries: r18 }, warnings };
}

/** meta.json（ツールはまずこれを見て、変わっていたときだけ本体を取る） */
export function buildMeta(indexText, r18Text, commit) {
  const pinned = (f) => (commit ? [`https://cdn.jsdelivr.net/gh/${REPO}@${commit}/public/${f}`] : []);
  const idx = JSON.parse(indexText), r = JSON.parse(r18Text);
  return {
    format: 1, generated: new Date().toISOString(), count: idx.entries.length,
    sha256: sha256(JSON.stringify(idx)), ...(commit ? { commit } : {}), mirrors: pinned('index.json'),
    r18: { count: r.entries.length, sha256: sha256(JSON.stringify(r)), mirrors: pinned('index-r18.json') },
  };
}

export function readEntries(dir = 'entries') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { return { file: f, data: JSON.parse(readFileSync(join(dir, f), 'utf8')) }; } catch (e) { return { file: f, data: null, bad: e.message }; }
  });
}

// ---- コマンドとして動かしたとき
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const meta = JSON.parse(readFileSync('catalog.json', 'utf8'));
  const block = JSON.parse(readFileSync('blocklist.json', 'utf8'));
  if (args[0] === '--meta') {
    // 配る形：site/（ページ）＋ public/（カタログ）＋ meta.json
    const commit = args[1] || '';
    mkdirSync('_site', { recursive: true });
    cpSync('site', '_site', { recursive: true });
    const idx = readFileSync('public/index.json', 'utf8'), r18 = readFileSync('public/index-r18.json', 'utf8');
    writeFileSync('_site/index.json', idx);
    writeFileSync('_site/index-r18.json', r18);
    writeFileSync('_site/meta.json', JSON.stringify(buildMeta(idx, r18, commit)));
    console.log(`_site を用意しました（commit ${commit || 'なし'}）`);
  } else {
    const entries = readEntries();
    for (const e of entries) if (e.bad) console.error(`::warning::${e.file} を読めません：${e.bad}`);
    const { index, r18, warnings } = buildCatalog(meta, entries.filter((e) => !e.bad), block);
    for (const w of warnings) console.error(`::warning::${w}`);
    if (!args.includes('--check')) {
      mkdirSync('public', { recursive: true });
      // ツールは JSON.stringify(読んだもの) で指紋を取るので、区切りなしで書く
      writeFileSync('public/index.json', JSON.stringify(index));
      writeFileSync('public/index-r18.json', JSON.stringify(r18));
    }
    console.log(`作品 ${index.entries.length}件・R18 ${r18.entries.length}件${warnings.length ? `・注意 ${warnings.length}件` : ''}`);
  }
}
