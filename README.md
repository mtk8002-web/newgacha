# newgacha — ガチャシステム

ライブ配信などで管理者が参加者へ pt を加算 → 一定値ごとにガチャ権利が貯まり、参加者が自分のスマホからガチャを引ける、という仕組みのウェブアプリ。

## 構成

- **フロント**：単一HTML 2枚（公開ホーム / 管理画面）
- **バック**：Vercel Serverless Functions（`/api/data`, `/api/auth`, `/api/pull`, `/api/user-auth`）
- **データ**：Upstash Redis（共有ストレージ）
- **ホスティング**：Vercel（GitHub連携で自動デプロイ）

## ファイル構成

```
newgacha-vercel/
├── api/
│   ├── data.js     # GET=データ取得 / POST=管理者上書き
│   ├── auth.js     # GET=トークン検証
│   └── pull.js     # POST=ガチャ抽選（サーバ側で実行）
├── public/
│   ├── index.html  # 公開ホーム
│   └── admin.html  # 管理画面
├── package.json
├── vercel.json
└── .gitignore
```

## セットアップ手順

### 1. Upstash で Redis を作成（5分）

1. https://upstash.com/ を開いて GitHub でログイン
2. **Create Database** をクリック
3. Name に適当な名前（例：`newgacha`）、Region は **Asia (Tokyo)** か **Global**
4. **Create** をクリック
5. データベース画面の右上「**REST API**」セクションで以下をコピー：
   - `UPSTASH_REDIS_REST_URL`（`https://...upstash.io` で始まる文字列）
   - `UPSTASH_REDIS_REST_TOKEN`（長い文字列）

### 2. このコードを GitHub にアップ

1. このフォルダ（`newgacha-vercel`）の中身をすべて GitHub の `newgacha` リポジトリにアップロード
   - `node_modules` は含めない（`.gitignore` に書いてあるので自動で除外）
2. GitHub リポジトリ画面で「Add file」→「Upload files」でフォルダごとドラッグ

### 3. Vercel で公開（5分）

1. https://vercel.com/ を開いて GitHub でログイン
2. **Add New** → **Project**
3. 自分の GitHub リポジトリ `newgacha` を「**Import**」
4. Framework Preset：**Other**（自動でそうなるはず）
5. **Environment Variables** セクションで3つ追加：

| Name | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash でコピーした URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash でコピーした Token |
| `ADMIN_TOKEN` | 自分で決めた管理者用パスワード（例：`admin-2026`） |

6. **Deploy** をクリック → 1〜2分でビルド完了
7. 完了画面に表示される URL（例：`https://newgacha.vercel.app`）が公開 URL

### 4. 動作確認

- 公開ホーム：`https://newgacha.vercel.app/`
- 管理画面：`https://newgacha.vercel.app/admin`
  - ログインで先ほど決めた `ADMIN_TOKEN` を入力

## 編集ワークフロー

1. 手元のファイル（`public/index.html` `public/admin.html` など）を編集
2. GitHub リポジトリにアップロード（同名ファイルで上書き）
3. Vercel が自動でビルド・デプロイ（1〜2分）
4. URL を強制リロード（Ctrl+Shift+R）で反映確認

## 管理者操作の流れ

1. `/admin` を開いて `ADMIN_TOKEN` でログイン
2. **新規登録**タブで参加者を追加（必要なら初期 pt を設定）
3. 配信中、**ユーザー**タブで参加者に pt を加算
4. **設定**タブでガチャ閾値・景品・ヘッダー画像などを調整

## 参加者の操作の流れ

1. `/` を開く
2. **GACHA** セクションへスクロール
3. 自分の名前のチップをクリック or 入力 → パスワード入力
   - **初回ログイン時**：4桁数字のパスワードを設定（2回入力で確認）
   - **2回目以降**：設定したパスワードでログイン
4. ガチャ権利があれば「🎰 1回引く」ボタンが押せる
5. 結果モーダルが出て、タイムラインにも流れる

## パスワードを忘れたら

管理画面（`/admin`）のユーザー一覧で対象ユーザーの 🔑 ボタンを押すとリセットできる。次回ログイン時に新しい4桁パスワードを設定し直せる。

## 環境変数の変更（管理者トークンを変えたい時）

1. Vercel ダッシュボード → このプロジェクト → **Settings** → **Environment Variables**
2. `ADMIN_TOKEN` を編集
3. **Deployments** タブ → 最新デプロイの「⋯」→ **Redeploy** で反映

## 注意事項

- `/api/data` POST は `ADMIN_TOKEN` 必須（管理者のみが書き込み可能）
- `/api/data` GET は認証なし（誰でも参加者リスト・景品確率を閲覧可能）。`passwordHash` / `passwordSalt` はサーバー側で除外して返す。
- `/api/user-auth` POST：`check`/`set`/`login` は認証なし、`reset`（管理者用）は `ADMIN_TOKEN` 必須
- `/api/pull` は参加者用で認証なし（user.id を渡せばガチャ抽選される）
- セキュリティ：URL が知られると景品確率や全データが見られる。パスワードは4桁数字なのでブルートフォースに対しては脆弱（10000通り）。1イベント限定ツールという前提。
- Upstash 無料枠：1日 10,000 コマンドまで。5秒ポーリングだと1ユーザー約 17,280 リクエスト/日 なので、参加者多数のときは要注意。**気になるならポーリング間隔を 10〜30 秒に延ばす**こと（`POLL_INTERVAL_MS` を変更）。
