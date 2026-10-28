# CardWirth 共用カタログ

CardWirth（1.50・Next・Py）のシナリオ・素材・スキンの**配布場所**をまとめた、だれでも使える共用カタログです。
作品のファイルそのものは置きません（作者さんの配布ページ・配布ファイルへの案内だけです）。

- カタログのURL（CWカタログに入れる）：`https://seihayukimi-oss.github.io/cardwirth-catalog/index.json`
- トップページ：https://seihayukimi-oss.github.io/cardwirth-catalog/
- 読むツール：[CWカタログ](https://github.com/seihayukimi-oss/cw-catalog-tool)
- 作品を登録したい方は：[登録のしかた](docs/登録のしかた.md)

## しくみ

```
登録ページ（GitHub Pages）
   │ 送信（Cloudflare Turnstile でいたずらを防ぐ）
   ▼
受付（Cloudflare Workers）── GitHub App で ──▶ entries/e00001.json …（作品1件ずつ）
   │ 管理人・記録・Discord の送り先は KV（非公開）
                                                   │ push されると GitHub Actions が動く
                                                   ▼
                              public/index.json・index-r18.json（リポジトリにも入れる）
                                                   │
                         GitHub Pages（meta.json・index.json）＋ jsDelivr（コミットを固定した写し）
                                                   ▼
                                              CWカタログ
```

| 場所 | 中身 |
|---|---|
| `catalog.json` | カタログの名前・出典・データの決まり（CC0）・登録ページなどのURL・注意ラベルの種類 |
| `entries/` | 作品1件ずつ（`e00001.json` など）。形は [docs/データの形.md](docs/データの形.md) |
| `blocklist.json` | 受け付けない URL・サイト・作者 |
| `public/` | 自動で作るカタログ（手で直さない） |
| `site/` | GitHub Pages のページ（トップ・登録・まとめて登録・変更と解除・通報・管理） |
| `scripts/build.mjs` | カタログを作るプログラム |

## 文書

| 文書 | 読む人 |
|---|---|
| [docs/登録のしかた.md](docs/登録のしかた.md) | 作品を登録する作者さん・代理で登録する方 |
| [docs/通報の決まり.md](docs/通報の決まり.md) | 通報する方・管理人 |
| [docs/管理のしかた.md](docs/管理のしかた.md) | 管理人・副管理人 |
| [docs/データの形.md](docs/データの形.md) | カタログのデータを使う方・開発する方 |
| [worker/README.md](worker/README.md) | 受付（Cloudflare Workers）の置き方 |
| [SECURITY.md](SECURITY.md) | 安全の問題を見つけた方 |

## 管理のしかた

くわしくは [docs/管理のしかた.md](docs/管理のしかた.md) にあります。

- **管理ページ**：https://seihayukimi-oss.github.io/cardwirth-catalog/admin/ （管理人キーで入る）
  - 承認待ちの承認、状態の切り替え（公開・一時保留中・非公開・登録解除）、シナリオラベルの直し
  - ラベルの種類を増やす（`catalog.json` の `content_labels`）、ブロックリスト（`blocklist.json`）
  - 副管理人の追加（管理人だけ）、操作の記録、Discord の知らせ（管理人ごとに送り先と出来事を選ぶ）、通報を見る・片付ける
  - 安全の報告（GitHub の Private vulnerability reporting）が届いたら、管理人の Discord にだけ知らせる
- これまでどおり、GitHub の画面で `entries/` のファイルの `state` を直しても変えられます：`public`（公開）／`pending`（承認待ち）／`held`（一時保留中）／`private`（非公開）／`removed`（登録解除）
- **通報**：https://seihayukimi-oss.github.io/cardwirth-catalog/report/ （CWカタログからは `report/?id=e00012` で開く）
  - 同じ理由の通報が集まると、管理人が確かめるまで一時保留：年齢区分の不備は5人、無断転載・改変／危険なファイル・不適切／その他は20人。リンク切れ・配布先の不備は保留にせず、管理人に知らせるだけ
  - 同じ人（同じ IP）は1人と数える。IP は元に戻せない指紋にして、受付の側（KV）にだけ置く

## データの決まり

- カタログのデータ（`entries/`・`catalog.json`・`public/`）は **CC0 1.0**（https://creativecommons.org/publicdomain/zero/1.0/deed.ja ）です。自由に使えます。写して使うときに、出典として「CardWirth 共用カタログ」を書いていただけると嬉しいです（任意）
- プログラム（`scripts/`・`site/`・`.github/`、これから作る受付）は **MIT** です
- 「Card Wirth」の著作権は group Ask に帰属します。各作品の権利は、それぞれの作者さんにあります
