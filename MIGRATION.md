# 組織アカウントへの移行手順

個人の Cloudflare アカウントで動いているバーチャルオフィスを、
組織のアカウントへ移す作業の手順書。

- 想定所要時間: 実作業は 1〜2 時間（アカウント作成の待ちを除く）
- 作業する人: 開発担当（1名で完結できる）
- 前提: Windows + PowerShell

---

## 0. 全体の流れ

```
【会議で決める】 → 【作業PCの準備】 → 【Cloudflareの準備】 → 【デプロイ】 → 【移行後の作業】
                        ↑ この2つは並行して進められる ↑
```

---

## 1. 会議で決めること

作業を始める前に、これだけ決まっていれば止まらない。

| 決めること | 備考 |
|---|---|
| **サブドメイン名** | URL に入る名前。世界で一意なので候補を3つ用意する |
| **独自ドメインを使うか** | 使う場合はドメイン管理者の協力が必要 |
| **Cloudflare アカウントの管理者** | ログイン情報を持つ人。2名以上が望ましい |

サブドメインは「3. Cloudflare の準備」の途中で登録してしまうため、
**後から変えると全 URL が変わる**。ここで決めておく。

---

## 2. 作業PCの準備

### 2-1. Node.js を入れる

wrangler が **Node.js 20 以上**を要求する。LTS 版を入れる。

```powershell
winget install OpenJS.NodeJS.LTS
```

winget が使えない場合は https://nodejs.org/ から LTS のインストーラを実行。

入ったか確認（**PowerShell を開き直してから**）:

```powershell
node -v     # v20.x.x 以上なら OK
npm -v
```

### 2-2. Git は不要

NAS の zip で管理しているため、Git はインストールしなくてよい。

### 2-3. zip を展開して依存を入れる

```powershell
cd <展開したフォルダ>
npm install
```

`wrangler` と `sharp`（アバター画像の切り出し用）が入る。
sharp はその PC 用のバイナリが自動で選ばれるので、追加の作業は不要。

### 2-4. `.dev.vars` を作る

`.dev.vars.example` をコピーして `.dev.vars` にリネームする。
中身は「3-3」で取得した値を入れる（この時点では空でよい）。

```
REALTIME_APP_ID=""
REALTIME_APP_SECRET=""
```

---

## 3. Cloudflare の準備

### 3-1. 組織用アカウントを作成

無料プランで可。複数人がログインできる状態にしておく。

### 3-2. URL（サブドメイン）を決めて登録する ★順番に注意

ダッシュボードの **Workers & Pages** を開くと、初回にサブドメインを聞かれる。
ここで決めた名前が、この先すべての Worker の URL に入る。

```
Cloudflare ダッシュボード → Workers & Pages
  初回          : サブドメインの入力を求められる
  設定済みの場合 : Your subdomain の「Change」から変更できる
```

URL はこの3つの組み合わせになる:

```
https://<Worker名>.<サブドメイン>.workers.dev/<パス>
        ↑ 自由        ↑ ここで決める      ↑ コード側
```

**この手順を飛ばしてデプロイすると、意図しない名前で確定する。**
必ず「4. デプロイ」より前に済ませる。

### 3-3. Realtime（Calls）アプリを作成

```
ダッシュボード → Realtime → アプリを作成
```

**APP ID と APP SECRET を控える。**
SECRET は後から読み出せないので、控えを NAS に保存しておく。

控えた値を「2-4」の `.dev.vars` に書き込む。

### 3-4. wrangler にログイン

ログイン情報は **PC ごと**に保存される。

```powershell
npx wrangler whoami      # 今どのアカウントか確認
npx wrangler logout      # 別アカウントでログイン済みの場合だけ必要
npx wrangler login       # ブラウザが開くので組織アカウントで承認
npx wrangler whoami      # 組織アカウントになったか確認
```

新しい PC で作業する場合、`logout` は不要（そもそもログインしていない）。

> メールアドレスが個人アカウントと組織アカウントの両方に紐づいている場合、
> デプロイ時にどちらに出すか聞かれることがある。個人側に上げないよう注意する。
> 固定したい場合は `$env:CLOUDFLARE_ACCOUNT_ID = "組織アカウントのID"`

### 3-5. KV 名前空間を2つ作る

```powershell
npx wrangler kv namespace create LAYOUT_KV   # 本番用
npm run kv:create-beta                       # ベータ用
```

それぞれ表示された **id** を控える。

### 3-6. `wrangler.jsonc` の id を書き替える

2箇所ある。

| 場所 | 書き替える値 |
|---|---|
| トップレベルの `kv_namespaces` の `id` | 本番用の id |
| `env.beta` の `kv_namespaces` の `id` | ベータ用の id |

ベータ側にある `"remote": true` の行は消さずにそのまま残す。
それ以外（`name`、`durable_objects`、`migrations`）は変更不要。

### 3-7. シークレットを登録

本番とベータで別々に登録する必要がある（継承されない）。

```powershell
npx wrangler secret put REALTIME_APP_ID
npx wrangler secret put REALTIME_APP_SECRET
npx wrangler secret put REALTIME_APP_ID --env beta
npx wrangler secret put REALTIME_APP_SECRET --env beta
```

---

## 4. デプロイ

Durable Object（オフィス内の看板の保存先）は
**デプロイ時に自動で作られる**ので、事前の準備は不要。

```powershell
npm run deploy:beta      # まずベータで動作確認
npm run deploy           # 問題なければ本番
```

ベータは本番と別の Worker・別の KV・別の Durable Object になるため、
ベータで何をしても本番のデータには影響しない。

> デプロイ時に「環境が指定されていない」という警告が出るが、これは正常。

---

## 5. 移行後の作業

### 5-1. レイアウトデータを流し込む

管理者ページで作ったレイアウト・会話エリア・家具・看板は KV に入っているので移せる。
**旧アカウントにログインできるうちに書き出しておく**こと。

### 5-2. Slack の通知先を登録

Slack の Webhook URL はコードに入っていないため、
新環境の管理者ページから登録し直す。

### 5-3. 新しい URL を周知

あわせて、以下も伝える。

- ブックマークの差し替えが必要
- **オフィス内で作った看板は消える**（作り直し）
- 転送量のカウントが 0 に戻る

---

## 6. 独自ドメインを使う場合（任意・後からでよい）

条件は「そのドメインの DNS を Cloudflare で管理していること」だけ。

```
1. 組織のドメインを Cloudflare に登録（他社管理ならネームサーバーを変更）
2. Worker にカスタムドメインを追加
3. wrangler.jsonc に "workers_dev": false を追記して再デプロイ
4. 新しい URL を周知
```

独自ドメインにすると以下も可能になる。

- `workers.dev` の URL を塞げる
- Cloudflare Images の画像変換が使えるようになる（`workers.dev` では使えない）

DNS の確認や社内調整でリードタイムが読めないため、
**まず `workers.dev` で立ち上げ、落ち着いてから追加する**のが安全。
その場合、URL の周知が2回になる点に注意。

---

## 7. 修正を反映する手順（日常の運用）

```powershell
# ...修正...
npm run deploy:beta      # ベータで確認
npm run deploy           # 本番へ
```

- `npm run deploy` の前に、アバター画像の切り出しとマニフェスト生成が**自動で走る**
- 素材を追加したときは `assets-src/` に置くだけ（切り出しは自動）
- 素材を変えたら `npm run credits` でクレジット一覧を作り直す
- ログの確認は `npm run tail` / `npm run tail:beta`

---

## 8. NAS への保存

### zip に入れるもの / 入れないもの

| 入れる | 入れない |
|---|---|
| `src/` `public/` `scripts/` `assets-src/` | `node_modules/`（`npm install` で復元できる） |
| `package.json` `package-lock.json` | **`.dev.vars`（APP SECRET が平文で入っている）** |
| `wrangler.jsonc` | `.wrangler/`（キャッシュ） |
| `public/config.local.js`（組織名） | |
| `LICENSE` `BETA.md` `MIGRATION.md`（この文書） | |

- `node_modules` は数百 MB あり、その PC 用のバイナリが入っているため他の PC では動かない
- `public/assets/avatar/` は生成物。入っていてもいなくてもよい（デプロイ前に作り直される）

### 運用ルール

- zip のファイル名に日付を入れる（例: `virtual_office_20260930.zip`）
- **本番にデプロイしたタイミングで zip を作り直す**
- これで「NAS の最新 zip = 今動いているもの」が保てる

---

## 9. 引き継ぎで必ず伝えること

### 著作権・クレジット表示

- アバターと家具の素材は **OGA-BY 3.0 / CC-BY-SA 3.0 / GPL 3.0**
- **作者名の表示が義務**。入室画面から「クレジット」へ辿れるようにしてある
- **この導線を消すとライセンス違反になる**（見た目の都合でも消せない）
- クレジット一覧は自動生成。手で書き換えない

### 管理者ページが無認証

- URL を知っていれば誰でも開けて、レイアウト・家具・看板・Slack 通知先を変更できる
- 社内限定で URL を共有する前提で運用する
- 認証が必要なら追加開発

### 転送量の上限

無料枠は 1000 GB。使用量が増えると自動で機能が止まる。

| 使用量 | 動作 |
|---|---|
| 700 GB | 画面共有が停止 |
| 900 GB | 音声が停止 |

使用量はオフィス画面に表示される。上限に達した場合は、
有料プランに上げるか、止まったまま月替わりを待つ。

---

## 10. つまずきやすいところ

| 症状 | 原因と対処 |
|---|---|
| `node` コマンドが見つからない | PowerShell を開き直す |
| デプロイ先のアカウントが違う | `npx wrangler whoami` で確認。`logout` → `login` |
| ベータが本番のデータを見ている | `wrangler.jsonc` の `env.beta` の KV id が本番と同じになっていないか確認 |
| 音声がつながらない | シークレットが `--env beta` 側に登録されていない可能性 |
| アバターが丸で表示される | `assets-src/avatar/` が無い状態でビルドした可能性 |
