// リポジトリの中身を、GitHub の tarball（.tar.gz）1回でまとめて読む。
// 作品が増えても、外へ取りに行く回数（Workers の無料プランは1回の受付で50回まで）を超えないようにするため。

const dec = new TextDecoder();

/** tar の見出しの数字（8進数） */
const octal = (b) => parseInt(dec.decode(b).replace(/\0.*$/s, '').trim() || '0', 8);
const cstr = (b) => dec.decode(b).replace(/\0.*$/s, '');

/** pax の拡張見出し（"長さ key=value\n" の並び） */
function paxPath(bytes) {
  const s = dec.decode(bytes);
  const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(s);
  return m ? m[1] : '';
}

/**
 * tar を読んで、ファイルの場所 → 中身（バイト列）の Map にする
 * @param {Uint8Array} buf
 * @param {(path: string) => boolean} want  欲しいファイルだけ取り出す
 */
export function untar(buf, want = () => true) {
  const out = new Map();
  let off = 0, nextPath = '';
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break; // 終わりの印
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const magic = cstr(h.subarray(257, 263));
    let name = cstr(h.subarray(0, 100));
    if (magic.startsWith('ustar')) { const prefix = cstr(h.subarray(345, 500)); if (prefix) name = `${prefix}/${name}`; }
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { nextPath = paxPath(body); continue; }
    if (type === 'g') continue; // GitHub が付ける全体の見出し（コミットの指紋）
    if (type === 'L') { nextPath = cstr(body); continue; } // GNU の長い名前
    const path = nextPath || name;
    nextPath = '';
    if (type !== '0' && type !== '\0') continue; // ふつうのファイルだけ
    // GitHub の tarball は「<owner>-<repo>-<commit>/」の下に入っているので、外す
    const rel = path.replace(/^[^/]+\//, '');
    if (want(rel)) out.set(rel, body.slice());
  }
  return out;
}

/** .tar.gz の応答を読む */
export async function readTarGz(res, want) {
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return untar(buf, want);
}
