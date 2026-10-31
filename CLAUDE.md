# CLAUDE.md（Claude が作業を始める前に読むメモ）

このリポジトリは **CardWirth 共用カタログ** です。CardWirth（1.50・Next・Py）のシナリオ・素材・スキンの「配布場所」をまとめたカタログと、その登録・管理のしくみが入っています。
運営は **清葉雪見**（GitHub：seihayukimi-oss）。アプリ（CWカタログ）は別のリポジトリ **seihayukimi-oss/cw-catalog-tool** です。

## 話し方・進め方の約束

- **日本語で、やさしく、ていねいに**話す。英語ばかりの返事にしない。専門用語はかみくだく
- 設定をお願いするときは、**1つずつ順番に、画面ごとに**説明する。スクショが来たら、その画面に合わせて答える（GitHub も Cloudflare も新しいデザインの画面）
- 決めることがあるときは、**選択肢を出して聞く**。おすすめがあれば示す
- 文章の直し（言い回しの案）が来たら、そのとおりに直す。案が2つあったり事実と合わなかったりしたところは、どう決めたかを最後に伝える
- **秘密の値はチャットに貼ってもらわない・出さない・コミットしない**：Turnstile の Secret Key、Cloudflare の API トークン、GitHub App の秘密鍵（.pem）、管理人キー、Discord の Webhook URL、GH_WEBHOOK_SECRET、Tauri の署名鍵。公開してよいのは App ID・Installation ID・Turnstile の Site Key など
- 本名は出さない（運営名は「清葉雪見」）
- 作者さんの作品ファイル（テスト用を含む）はコミットしない
- **頼まれた範囲の外は、できるだけさわらない**。頼まれた作業以外には手を付けず、UI も希望がない限り今のまま受け継ぐ。新しい機能や直しも、指示の範囲の中だけにする
- **直したら、直した範囲だけを ZIP にまとめて**、作業フォルダとは別のファイルで渡す（本番のサイトに反映しやすいように）

## しくみ

```
登録ページ（GitHub Pages：site/）── Turnstile ──▶ 受付（Cloudflare Workers：worker/）
                                                    │ GitHub App（cardwirth-catalog-bot）で書く
                                                    ▼
                                         entries/e00001.json …（作品1件ずつ）
                                                    │ push で Actions（pages.yml）
                                                    ▼
                         public/index.json・index-r18.json ＋ meta.json → GitHub Pages・jsDelivr
受付の非公開の置き場：Cloudflare KV（管理人・操作の記録・Discord の送り先・通報）
```

| 場所 | 中身 |
|---|---|
| `docs/` | データの形.md・登録のしかた.md（作者さん向け）・通報の決まり.md・管理のしかた.md。ページや受付の動きを変えたら、ここも直す |
| `entries/` | 作品1件ずつ。形は `docs/データの形.md`。今は空で、**次の本物の作品が e00001**（運営者の希望） |
| `catalog.json` | カタログの名前・出典（CC0）・ページのリンク・注意ラベルの種類（content_labels） |
| `blocklist.json` | 受け付けない URL・サイト・作者 |
| `public/` | 自動で作るカタログ（手で直さない） |
| `scripts/build.mjs` | カタログを作る（toPublic / buildCatalog / buildMeta） |
| `worker/src/` | 受付：index.js（登録・変更・解除・掲載停止・サイト認証）、admin.js（管理ページ用）、report.js（通報）、security.js（安全の報告の Webhook）、notify.js（Discord）、github.js、tar.js、common.js、util.js |
| `site/` | ページ：トップ・register/（register/bulk/＝複数シナリオの一括登録。受付には1作品ずつ /api/register で送り、Turnstile は作品ごとにやり直す）・manage/・report/・admin/（管理ページ）。config.js に受付のURL |
| `test/` | build.test.mjs・worker.test.mjs・admin.test.mjs（`npm test`、全16件） |

- 受付のURL：`https://cardwirth-catalog.seiha-yukimi-ilst.workers.dev`（`/api/health` で設定がそろっているか分かる）
- 受付のURLは **site/config.js** と、**管理ページの CSP（site/admin/index.html の connect-src）**の2か所に書いてある。変えるときは両方
- 作品の状態：public（公開）／pending（承認待ち）／held（一時保留中）／private（非公開）／removed（登録解除）
- 通報：理由ごとの人数で一時保留（年齢区分の不備＝5人、ほか20人、リンク切れは保留にしない）。IP は KV の塩を混ぜた指紋だけ

## 作業のしかた

- 始める前に `npm ci`、直したら `npm test`（全部通ること）
- コミットの文は日本語で、何をなぜ変えたかを短く
- `main` が変わると Actions が動く：pages.yml（カタログを作って公開）、worker.yml（worker/ が変わると受付を Cloudflare に置く）
- bot（cardwirth-catalog-bot）も `entries/` などに書き込むので、送る前に必ず最新を取り込む
- 実在の作品名・作者名・サイト名は、ページ・文書・試験のどこにも書かない。例が要るときは「サンプル店」「テスト冒険譚」「デバッグ読みシナ」「テスト作者」など、ひと目でサンプルと分かる名前にする
- 履歴（git）は 2026-10-28 に1つにまとめた（作品の登録が始まる前）。**作品の登録が始まったあとは、履歴を書き換えない（上書きで送らない）**。登録した人の記録を、だれでも見られる形で残すとお約束しているため
- **アプリの 1.0.0 のときに、作品の登録が始まる前なら、このリポジトリもいったん削除して同じ名前で作り直し、昔の記録を消す**（2026-10-31 に運営者が決めた）。作り直したあとは、GitHub Pages・Secrets（CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID）・GitHub App（cardwirth-catalog-bot）の入れ直し（**Installation ID が変わるので、Worker の Secret GH_APP_INSTALLATION_ID も入れ替える**）・Webhook（安全の報告）・Private vulnerability reporting をやり直す。Cloudflare の KV・Turnstile・管理人キーは、リポジトリと別なのでそのまま。登録が始まったあとは作り直さない
- 作品のファイルを消すときは、**先に管理ページで「通報を片付ける」**（通報の記録は作品IDごとに KV にあり、同じIDが次の作品に使われるため）

## ハマりどころ

- **Workers の fetch**：fetch をオブジェクトに入れて `this.fetch()` で呼ぶと「Illegal invocation」で止まる。包んで呼ぶ（github.js 参照）。試験のまねの fetch も、this が違うと止まるようにしてある
- **Workers 無料プランは、1回の受付で外へ取りに行けるのが50回まで**。作品の一覧は tarball 1回でまとめて読む（tar.js）
- KV は無料プランだと書き込みが1日1000回まで。むやみに書かない
- 作業場から github.io・workers.dev にはつながらないことが多い。ページの見た目は Playwright で手元で確かめ、本番の動きは運営者にブラウザで確かめてもらう
- 管理ページはキーを扱うので、CSP を外さない・作品名などは必ず textContent で入れる（innerHTML にしない）
- Discord への送信は allowed_mentions を空にする（@everyone を効かせない）
