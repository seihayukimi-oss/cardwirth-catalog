# 受付（Cloudflare Workers）

登録ページ・直すページから送られた内容を確かめて、`entries/` に書き込みます。

## 置き方

- `main` の `worker/` が変わると、GitHub Actions（`.github/workflows/worker.yml`）が自動で Cloudflare に置きます
- GitHub の Secrets：`CLOUDFLARE_API_TOKEN`（Workers を編集できるトークン）・`CLOUDFLARE_ACCOUNT_ID`
- Cloudflare の画面（Workers → cardwirth-catalog → Settings → Variables and Secrets）に登録する秘密の値：

| 名前 | 中身 |
|---|---|
| `TURNSTILE_SECRET` | Turnstile の Secret Key |
| `GH_APP_ID` | GitHub App の App ID |
| `GH_APP_INSTALLATION_ID` | GitHub App を cardwirth-catalog に入れたときの Installation ID |
| `GH_APP_PRIVATE_KEY` | GitHub App の秘密鍵（.pem ファイルの中身をそのまま） |
| `ADMIN_OWNER_HASH` | 管理人キーの指紋（SHA-256）。管理ページ（`/admin/`）の「はじめての設定」で作る。キーそのものはここに入れない |
| `GH_WEBHOOK_SECRET` | 安全の報告（GitHub の Webhook）の合言葉。管理ページの「自分の設定」で作り、GitHub の Webhook の Secret にも同じものを入れる（任意） |

- 非公開の置き場（KV、名前は `KV`）は、最初に置くときに自動で作られます。管理人・副管理人・操作の記録（400日）・Discord の送り先・通報（IP の指紋とコメント。片付けるか1年で消える）を置きます

- 動いているかは `https://<受付のURL>/api/health` で確かめられます（`configured: true` なら秘密の値がそろっています。`kv: true` なら置き場あり、`admin: true` なら管理人キーの指紋あり、`security_hook: true` なら安全の報告の合言葉あり）

## ファイル

| ファイル | 中身 |
|---|---|
| `src/index.js` | 受付の入口（登録・変更・解除・掲載停止・サイト認証） |
| `src/admin.js` | 管理ページ用の窓口（`/api/admin/…`） |
| `src/notify.js` | Discord への知らせ |
| `src/report.js` | 通報（人数を数えて、一時保留にする） |
| `src/security.js` | 安全の報告（GitHub の Webhook）を受けて、管理人に知らせる |
| `src/common.js` | 作品の読み書きなど、共通の部分 |
| `src/github.js` | GitHub App としてリポジトリを読み書きする |
| `src/tar.js` | リポジトリをまとめて読む（tarball） |
| `src/util.js` | 編集キー・ページの読み取り・自動承認 |

## 試験

`npm test`（GitHub・Turnstile・作者さんのサイトは、まねをするものに置き換えて試します）
