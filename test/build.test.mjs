import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toPublic, buildCatalog, buildMeta } from '../scripts/build.mjs';

const base = { id: 'e00001', name: 'サンプル店', author: 'テスト作者', downloads: [{ url: 'https://example.com/mori.zip', kind: 'direct' }] };
const meta = { name: 'テスト', attribution: { name: 'テスト' }, license: 'CC0-1.0', links: {}, content_labels: [{ id: 'utsu', name: '鬱' }, { id: 'BAD', name: 'x' }] };
const block = { urls: [], hosts: ['bad.example'], authors: ['ブロック作者'] };

test('配る形：管理用の項目は出さない・状態・R18は別のファイル', () => {
  const e = { ...base, edit_key_hash: 'x'.repeat(64), registered: '2026-10-26', rating: 'r15', content: ['gore', 'NG'] };
  const r = toPublic(e).entry;
  assert.equal(r.edit_key_hash, undefined);
  assert.equal(r.registered, undefined);
  assert.equal(r.rating, 'r15');
  assert.deepEqual(r.content, ['gore']);
  assert.equal(toPublic({ ...base, state: 'private' }).skip, 'private');
  assert.equal(toPublic({ ...base, state: 'removed' }).skip, 'removed');
  assert.equal(toPublic({ ...base, state: 'held', held_reason: '通報' }).entry.state, 'held');
  assert.ok(toPublic({ ...base, downloads: [] }).error);
  assert.ok(toPublic({ ...base, id: 'x1' }).error);
  // ブロックリスト（サイト・作者）
  assert.equal(toPublic({ ...base, downloads: [{ url: 'https://dl.bad.example/a.zip' }] }, block).skip, 'blocked');
  assert.equal(toPublic({ ...base, author: 'ブロック作者' }, block).skip, 'blocked');
  const { index, r18, warnings } = buildCatalog(meta, [
    { file: 'e00001.json', data: base },
    { file: 'e00002.json', data: { ...base, id: 'e00002', rating: 'r18' } },
    { file: 'e00003.json', data: { ...base, id: 'e00003', state: 'removed' } },
    { file: 'dup.json', data: base },
    { file: 'bad.json', data: { id: 'e00009' } },
  ], block);
  assert.deepEqual(index.entries.map((x) => x.id), ['e00001']);
  assert.deepEqual(r18.entries.map((x) => x.id), ['e00002']);
  assert.equal(warnings.length, 2);
  assert.deepEqual(index.content_labels.map((d) => d.id), ['utsu']);
});

test('meta.json：ツールと同じ指紋の取り方・コミットを固定した jsDelivr の写し', () => {
  const { index, r18 } = buildCatalog(meta, [{ file: 'a', data: base }], block);
  const t = JSON.stringify(index), t2 = JSON.stringify(r18);
  const m = buildMeta(t, t2, 'a'.repeat(40));
  // ツール側は JSON.stringify(読んだJSON) の SHA-256 で比べる
  assert.equal(m.sha256, createHash('sha256').update(JSON.stringify(JSON.parse(t))).digest('hex'));
  assert.equal(m.mirrors[0], `https://cdn.jsdelivr.net/gh/seihayukimi-oss/cardwirth-catalog@${'a'.repeat(40)}/public/index.json`);
  assert.equal(m.r18.mirrors[0].endsWith('/public/index-r18.json'), true);
  assert.equal(m.count, 1);
});
