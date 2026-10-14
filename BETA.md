# ベータ（テスト）環境

本番 `virtual-office` とは別の Worker `virtual-office-beta` を立てる。
**KV・Durable Object・URL がすべて分かれる**ので、ベータで何をしても本番には影響しない。

| | 本番 | ベータ |
|---|---|---|
| Worker 名 | `virtual-office` | `virtual-office-beta` |
| デプロイ | `npm run deploy` | `npm run deploy:beta` |
| KV | 既存の名前空間 | 新規に作る名前空間 |
| Durable Object (`Room`) | 本番の部屋 | 別の部屋（位置・チャット・看板・転送量カウンタが独立） |
| URL | 現在の workers.dev | `virtual-office-beta.<サブドメイン>.workers.dev` |

ブランチは分けない。`main` が唯一の正で、**どの環境に出したかはデプロイ先とタグで区別する**。

---

## 初回セットアップ（1回だけ）

プロジェクト直下（`wrangler.jsonc` がある場所）で実行する。

### 1. 依存をインストール

```
npm install
```

### 2. ベータ用の KV 名前空間を作る

```
npm run kv:create-beta
```

出力された `id` を `wrangler.jsonc` の `env.beta.kv_namespaces[0].id` に貼る
（`PASTE_BETA_KV_NAMESPACE_ID_HERE` の部分）。

> wrangler が設定ファイルの更新を提案してきた場合は、はいを選べば自動で書き込まれる。

### 3. ベータをデプロイ

```
npm run deploy:beta
```

デプロイ後に表示される `https://virtual-office-beta.<サブドメイン>.workers.dev` がベータの URL。

### 4. シークレット（Realtime / SFU）を設定

音声・画面共有に必要。本番と同じ App ID・Secret を入れる。

```
npx wrangler secret put REALTIME_APP_ID --env beta
npx wrangler secret put REALTIME_APP_SECRET --env beta
```

> 未設定でも、位置共有・チャット・看板・マップ編集は動く。音声と画面共有だけが使えない。

### 5. 本番のレイアウトをコピー

```
npm run kv:copy-to-beta
```

`layout` / `zones` / `furniture` / `comments` の4つを本番 → ベータへ一度だけコピーする。
中身だけ確認したいときは `npm run kv:copy-to-beta -- --dry-run`。

コピー後、ベータの `/office.html` を開いてマップが表示されれば成功。

---

## 日常の流れ

変更を入れるとき:

```
git switch -c feat/<変更の名前>
# ...編集...
git commit -am "..."
git push -u origin feat/<変更の名前>
# GitHub で PR を作って main にマージ
```

`main` に入ったらベータで確認し、問題なければ本番へ出してタグを打つ:

```
git switch main && git pull
npm run deploy:beta      # ベータで確認
npm run deploy           # 本番へ
git tag v1.0.0 && git push --tags
```

その他:

```
npm run dev              # ローカル起動（本番設定）
npm run dev:beta         # ローカル起動（beta 設定）
npm run tail:beta        # ベータのログをリアルタイムで見る
```

ローカルでシークレットを使うには `.dev.vars.example` を `.dev.vars` にコピーして値を入れる。
`.dev.vars` は git 管理外。

---

## 注意点

**Realtime の無料枠は本番と共有。**
同じ App ID を使うため、ベータでの通話・画面共有も本番と同じ枠を消費する。
一方 `src/room.js` の転送量ガード（700GB で画面共有停止 / 900GB で音声停止）は
Durable Object ごとのカウンタなので、本番とベータで**別々に数えられる**。
合算では枠を超えうるので、ベータで長時間の画面共有テストはしないこと。
分離したい場合は Cloudflare ダッシュボードでベータ専用の Realtime アプリを作り、手順4でその値を入れる。

**`/admin.html` と `POST /api/*` は誰でも叩ける。**
ベータ URL を共有した相手は全員マップを編集できる。本番も同じ状態。
認証は別途対応予定。

**ベータを消すとき**

```
npx wrangler delete --env beta
```

KV 名前空間はダッシュボードの Workers & Pages → KV から削除する。

---

## 転送量の上限を試す

上限（画面共有の停止・音声の停止）が働くかを、ベータで小さな上限にして確かめる。本番では行わない。

```powershell
npx wrangler deploy --env beta --var SCREEN_OFF_GB:0.001 --var VOICE_OFF_GB:0.002 --var LIMIT_GB:0.003 --var BUDGET_KEY:budget-test1
```

- `BUDGET_KEY` を変えると、別の入れ物で 0 から数え直す。いつもの積算には触れない。試し直すときは `budget-test2` のように変える
- 転送量は推定で、60秒ごとに積まれる。数えるのは、マイクを一度でも ON にした人の声と、画面共有だけ
- 2人で近くに立ち、両方ともマイクを ON にして待つ（画面共有はしない。一瞬で上限を越えるため）
  - 約2分で 0.001 GB を越え、画面共有が止まる（ボタンが押せなくなり、上部に案内が出る）
  - 約4分で 0.002 GB を越え、音声も止まる（マイクのボタンが「停止中」になる）
- 画面の「推定通信量」は、上限が 1 GB 未満のときだけ小数3桁で出る

終わったら、変数を付けずにデプロイし直す（上限が元に戻る）:

```powershell
npm run deploy:beta
```

---

## 本番のマップを毎日写す（ベータを本番の控えにする）

ベータは毎日 3:00（日本時間）に、本番のマップ（レイアウト・会話エリア・家具・管理者の看板）を自分へ写す。
試す場所であると同時に、本番のマップの1日遅れの控えにもなる。

- 仕組み: `wrangler.jsonc` の `env.beta` の `triggers`（毎日の起動）と `services`（本番の Worker への接続 `PROD`）。
  中身は `src/index.js` の `syncFromProd`。本番には何も書かない（読むだけ）
- 写さないもの: Slack の通知先（ベータから本番のチャンネルへ通知が流れないように）、オフィスで作った看板、転送量
- 本番の値が空（何も無い）のときは、そのキーは写さない（本番を誤って消したときに、控えまで消えないように）
- ベータで編集したマップは、次の 3:00 に本番の内容で上書きされる。ベータで試したレイアウトを残したいときは、先に書き出しておく（`npm run layout:export -- <ベータのURL>`）

すぐ写したいとき（デプロイ直後の確認など）:

```powershell
Invoke-RestMethod -Method Post https://virtual-office-beta.<サブドメイン>.workers.dev/api/sync-from-prod
```

前回の同期の結果を見る: ブラウザで `https://virtual-office-beta.<サブドメイン>.workers.dev/api/sync-from-prod` を開く。

### 本番のマップをベータの控えから戻す

本番のマップを誤って壊したときは、**次の 3:00 の同期より前に**、ベータから本番へ書き戻す:

```powershell
npm run layout:export -- https://virtual-office-beta.<サブドメイン>.workers.dev
npm run layout:import -- https://virtual-office.<サブドメイン>.workers.dev layout-backup-<日付>
```

