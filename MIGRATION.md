# 組織アカウントへの移行手順

個人の Cloudflare アカウントと個人の GitHub で動かしてきたバーチャルオフィスを、
組織の Cloudflare アカウントと組織の GitHub へ移す作業の手順書。

- 前提: Windows + PowerShell、作業する人は開発担当（1名で完結できる）
- 作業する PC: 移行後は**業務用 PC** で開発・デプロイする。個人の PC は、個人のアカウント（GitHub・Cloudflare）が要る作業と、
  コード一式を zip にして業務用 NAS へ置く作業だけに使う。業務用 PC では個人のアカウントにログインしない
- 想定所要時間: 準備（2〜4）は 1〜2 時間。当日の切り替え（5）は 30 分ほど
- 方針
  - コード: 移行の時点までを個人リポジトリで公開し、以降は組織の GitHub（非公開）で管理する
  - 旧 URL: 移行日に止める（転送はしない）
  - 引き継ぐもの: マップ（レイアウト・会話エリア・家具・管理者が作った看板）。
    引き継がないもの: オフィスで作った看板、今月の転送量のカウント、ログ

---

## 0. 全体の流れ

| 順番 | 内容 | どこで | いつ |
|---|---|---|---|
| 1 | 会議で決めること | — | 最初に |
| 2 | 個人リポジトリを仕上げて公開し、コード一式を zip で業務用 NAS へ置く | 個人 PC | 準備 |
| 3 | 業務用 PC の準備と、組織の GitHub への登録 | 業務用 PC | 準備 |
| 4 | 組織の Cloudflare アカウントの準備 | 業務用 PC | 準備 |
| 5 | 切り替え（書き出し → 新環境へデプロイ → 書き込み → 周知） | 業務用 PC | 移行日（通話の少ない時間帯） |
| 6 | 旧環境を止める | 個人 PC | 移行日（新環境が動いてから） |
| 7 | 移行後の運用 | 業務用 PC | 以降ずっと |

2〜4 は利用者に影響しない。利用者に影響するのは 5 と 6 だけ。

---

## 1. 会議で決めること

| 決めること | 備考 |
|---|---|
| **サブドメイン名** | URL に入る名前（`https://virtual-office.<サブドメイン>.workers.dev`）。世界で一意なので候補を3つ用意する。後から変えると全 URL が変わる |
| **Cloudflare アカウントの管理者** | 2名以上が望ましい |
| **組織の GitHub の置き場所と権限** | リポジトリを作る組織（Organization）と、書き込める人 |
| **移行日時** | 切り替えの間、数分〜十数分使えない時間がある。通話の少ない時間帯にする |
| **独自ドメインを使うか** | 使うなら後からでよい（8 を参照） |

---

## 2. 個人 PC でやること（移行前）

### 2-1. 公開してよいかを確かめる

個人リポジトリは公開するので、組織に関わる情報が入っていないことを確かめる。

- `public/config.local.js`（組織名などの表示設定）は `.gitignore` 済みで、履歴にも入っていない
- `.dev.vars`（Realtime の秘密の値）は `.gitignore` 済み
- Slack の Webhook URL はコードに無い（KV にだけある）
- `layout-backup-*/`（マップの書き出し）は `.gitignore` 済み
- `wrangler.jsonc` の KV の id は個人アカウントのもの。アカウントにログインしないと使えない値なので、公開してもよい

確かめ方（何も出なければよい）:

```powershell
git log --all --name-only --format= | Select-String "config.local|\.dev\.vars$|layout-backup"
git log --all -p -S"hooks.slack.com/services/T" --oneline
```

組織名など、ほかに気になる言葉があれば `-S"言葉"` で同じように探す。

### 2-2. 個人リポジトリを仕上げて公開する

1. 未コミットの変更が無いこと、main がプッシュ済みであることを確かめる（`git status`）
2. GitHub の個人リポジトリの Settings → General → Danger Zone → **Change visibility** で Public にする

この時点の内容が自分の成果として残る。以降はこちらを更新しない。

### 2-3. コード一式を zip にして業務用 NAS へ置く

履歴ごと移すため、`.git` フォルダも入れる。組織名の設定（`public/config.local.js`）も入れる。
入れないもの: `node_modules`（業務用 PC で入れ直す）、`.wrangler`（キャッシュ）、`.dev.vars`（秘密の値）、
`CLAUDE.md`（個人の作業用）、`Claude outputs`、`public/assets/avatar`（デプロイのたびに作り直される）。

PowerShell を開き、下の6行をまとめて貼り付けて Enter を押す（どのフォルダで実行してもよい）。

```powershell
$date = Get-Date -Format yyyyMMdd
$work = "$env:TEMP\virtual_office_$date"
robocopy C:\virtual_office $work /E /XD node_modules .wrangler "Claude outputs" C:\virtual_office\public\assets\avatar /XF .dev.vars CLAUDE.md
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($work, "$HOME\Desktop\virtual_office_$date.zip")
Remove-Item -Recurse -Force $work
```

- 各行の意味: 日付を決める → 一時フォルダへ必要なものだけ写す → 一時フォルダを zip にする → 一時フォルダを消す
- 終わるとデスクトップに `virtual_office_<日付>.zip` ができる。途中で `robocopy` がコピーした一覧を長く表示するが、正常
- 生成物の `public/assets/avatar` はフルパスで外している。`avatar` とだけ書くと、元画像の `assets-src/avatar` まで外れてしまい、業務用 PC でアバターが作れなくなる
- 圧縮に `Compress-Archive` を使わないのは、隠しフォルダの `.git` が抜けることがあるため
- zip を作る前に、`MIGRATION.md` などの変更がコミット済みであることを確かめる（未コミットの変更も zip には入るが、履歴には残らない）
- できた `virtual_office_<日付>.zip` を業務用 NAS へ置く
- NAS は受け渡しのためだけに使う。NAS の上で展開して作業はしない（3-2 のとおり業務用 PC の中に展開する）

---

## 3. 業務用 PC でやること（準備）

### 3-1. Node.js と Git

```powershell
node -v           # v20 以上なら OK（wrangler が Node.js 20 以上を要求する）
git --version     # 何か表示されれば OK
```

入っていなければ入れる（入れたら PowerShell を開き直す）。インストールが制限されている場合は、情報システムの担当に依頼する。

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

### 3-2. zip を展開して依存を入れる

NAS の zip を業務用 PC にコピーし、`C:\virtual_office` に展開する。
作業は必ずこの PC の中のフォルダで行う。NAS の上で直接作業すると、`npm install`（数万ファイル）や git が遅く、
ファイルのロックで失敗しやすい。移行後のコードの正本は組織の GitHub で、NAS の zip は受け渡しと控えにすぎない。

```powershell
cd C:\virtual_office
npm install
git status          # 履歴が見えること、変更が無いことを確かめる
```

`npm install` で `wrangler` と `sharp`（アバター画像の切り出し）が、その PC 用に入る。

### 3-3. 組織の GitHub に非公開リポジトリを作って登録する

1. 組織の GitHub で、空の**非公開**リポジトリを作る（README などは作らない）
2. zip の中のリポジトリは、送り先が個人リポジトリになっている。組織のリポジトリに付け替えて、ブランチとタグをすべて送る

```powershell
git remote remove origin
git remote add origin https://github.com/<組織>/<リポジトリ名>.git
git push -u origin main
git push origin --all
git push origin --tags
```

以降の `git push` は組織のリポジトリへ行く。

### 3-4. `.dev.vars`

`.dev.vars.example` をコピーして `.dev.vars` にする。中身は 4-3 で取得した値（ローカルで動かすときだけ使う）。

---

## 4. 組織の Cloudflare アカウントの準備

### 4-1. アカウントを作る

無料プランで可。管理者を2名以上登録しておく。

### 4-2. サブドメインを登録する ★デプロイより前に

ダッシュボード → **Workers & Pages** を開くと、初回にサブドメインを聞かれる。1 で決めた名前を入れる。
これを飛ばしてデプロイすると、意図しない名前で確定する。

### 4-3. Realtime のアプリを作る

ダッシュボード → **Realtime** → アプリを作成。**App ID と App Secret を控える**（Secret は後から読めない）。
控えはパスワード管理の仕組みなど、組織で決めた安全な場所に置く。git には入れない。

### 4-4. wrangler を組織アカウントでログインする

```powershell
npx wrangler login       # ブラウザで組織アカウントを承認
npx wrangler whoami      # 組織アカウントになったか
```

業務用 PC では個人アカウントにはログインしない。
組織のアカウントに同じメールアドレスで複数入れる場合、デプロイ先を聞かれることがある。
間違えないよう、組織のアカウント ID を固定しておく:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "組織アカウントのID"   # ダッシュボードの右側に出ている
```

### 4-5. KV を2つ作り、`wrangler.jsonc` を書き替える

```powershell
npx wrangler kv namespace create LAYOUT_KV   # 本番用
npm run kv:create-beta                       # ベータ用
```

表示された id を `wrangler.jsonc` の2か所に書く。

| 場所 | 値 |
|---|---|
| トップレベルの `kv_namespaces` の `id` | 本番用の id |
| `env.beta` の `kv_namespaces` の `id` | ベータ用の id |

それ以外（`name`、`durable_objects`、`migrations`、`observability`）は変えない。
この変更は組織のリポジトリにコミットする。

### 4-6. シークレットを登録する

本番とベータで別々に登録する（引き継がれない）。値は 4-3 の App ID と App Secret。

```powershell
npx wrangler secret put REALTIME_APP_ID
npx wrangler secret put REALTIME_APP_SECRET
npx wrangler secret put REALTIME_APP_ID --env beta
npx wrangler secret put REALTIME_APP_SECRET --env beta
```

シークレットは Worker が無いと登録できない。「Worker が無い」と言われたら、先に 5-2 のデプロイを1回してから登録する。

---

## 5. 切り替え（移行日・業務用 PC）

### 5-1. 旧サイトのマップを書き出す

```powershell
npm run layout:export -- https://<旧サイトのURL>
```

`layout-backup-<日付>/` に4つの JSON（レイアウト・会話エリア・家具・管理者の看板）ができる。
**旧サイトを止める前に必ず行う**。このフォルダは控えとしても残しておく（git には入らない）。

### 5-2. 新環境のベータで確かめる

```powershell
npm run deploy:beta
npm run layout:import -- https://virtual-office-beta.<サブドメイン>.workers.dev layout-backup-<日付>
```

ベータの URL を開き、次を確かめる（PC のブラウザを2つ、またはPCとスマホで2人分入る）。

| # | 確かめること | 見るところ |
|---|---|---|
| 1 | マップ・会話エリア・家具・管理者の看板が出る | 旧サイトと同じ見た目か |
| 2 | 2人で近づくと声が聞こえる。マイクの ON・OFF が相手の名前の印に出る | 新しい Realtime のアプリが使えているか（4-3、4-6） |
| 3 | 画面共有が相手に映る | 同上 |
| 4 | チャットが届く。会話エリアの中と外で届く相手が変わる | |
| 5 | 呼び出しが鳴る（呼んだ側と呼ばれた側） | |
| 6 | スマホで入れる（ジョイスティック、マイク、☰ のメニュー） | |
| 7 | 通話中にもう一度 `npm run deploy:beta` しても、声と画面共有が切れない | 部屋の作り直しの引き継ぎ |
| 8 | 転送量の上限で、画面共有と音声が止まる | 下の手順 |

**8 の手順**（上限を小さくしてベータに出し、終わったら元に戻す。詳しくは `BETA.md` の「転送量の上限を試す」）:

```powershell
npx wrangler deploy --env beta --var SCREEN_OFF_GB:0.001 --var VOICE_OFF_GB:0.002 --var LIMIT_GB:0.003 --var BUDGET_KEY:budget-test1
```

- 2人で近くに立ち、両方ともマイクを ON にして待つ（画面共有はしない）。約2分で画面共有が止まり、約4分で音声も止まる
- 終わったら `npm run deploy:beta` で元の上限に戻す
- 本番では行わない（上限の仕組みは本番もベータも同じコード）

`/api/client-errors` と `/api/server-log` に、想定外のエラーが出ていないことも見ておく。

### 5-3. 新環境の本番に出す

```powershell
npm run deploy
npm run layout:import -- https://virtual-office.<サブドメイン>.workers.dev layout-backup-<日付>
```

- 管理者ページ（`/admin.html`）で **Slack の通知先を登録し直す**（Webhook URL は移らない）
- 2人で入室し、音声・画面共有・チャット・Slack の入室通知を確かめる（細かいテストは 5-2 のベータで済んでいる）
- タグを打つ: `git tag v<次の番号>` → `git push --tags`

### 5-4. 新しい URL を周知する

あわせて伝えること:

- ブックマークの差し替え（旧 URL はこのあと止める）
- スマホでも使える（再読み込みは不要。新しい URL を開くだけ）
- オフィスで作った看板は消えている（作り直し）

## 6. 旧環境を止める（移行日・個人 PC）

**新サイトが動いていること、5-1 の書き出しが済んでいることを確かめてから**行う。元に戻せない。

```powershell
cd C:\virtual_office
npx wrangler whoami                   # 個人アカウントであることを必ず確かめる
npx wrangler delete --name virtual-office
npx wrangler delete --name virtual-office-beta
```

- `delete` すると、その Worker の部屋（Durable Object）のデータも消える
- 個人アカウントの Realtime のアプリと KV も、ダッシュボードから消してよい
- 個人 PC で wrangler が使えない場合は、個人アカウントでダッシュボードにログインし、
  Workers & Pages → 各 Worker → Settings → Delete でも消せる

---

## 7. 移行後の運用（業務用 PC）

変更を本番に出すまでの流れ（今までと同じ）:

```powershell
git switch -c <ブランチ名>
# ...修正...
git commit -am "..."
git push -u origin <ブランチ名>
npm run deploy:beta                   # ベータで確かめる
git switch main                       # 「Switched to branch 'main'」と出たことを確かめる
git pull
git merge --no-ff <ブランチ名> -m "Merge <ブランチ名>"
git push
npm run deploy                        # 通話の少ないタイミングで
git tag v<番号>
git push --tags
```

- デプロイすると部屋が作り直され、全員の接続が一度切れる（自動でつなぎ直し、通話と画面共有は引き継がれる）
- 画面側の変更は、利用者が再読み込みするまで反映されない
- 本番のマップをベータへ写す: `npm run kv:copy-to-beta`
- マップの控えを取る: `npm run layout:export -- <本番のURL>`
- ログ: ダッシュボードの Workers & Pages → virtual-office → Observability。サイトの `/api/server-log` と `/api/client-errors` でも見られる

---

## 8. 独自ドメインを使う場合（任意・後からでよい）

条件は「そのドメインの DNS を Cloudflare で管理していること」。

1. 組織のドメインを Cloudflare に登録する（他社管理ならネームサーバーを変更）
2. Worker にカスタムドメインを追加する
3. `wrangler.jsonc` に `"workers_dev": false` を足して再デプロイする（workers.dev の URL を塞ぐ）
4. 新しい URL を周知する（周知が2回になる）

---

## 9. 引き継ぎで必ず伝えること

### 著作権・クレジット表示

- アバターと家具の素材は **OGA-BY 3.0 / CC-BY-SA 3.0 / GPL 3.0**。**作者名の表示が義務**
- 入室画面から「クレジット」へ辿れるようにしてある。**この導線を消すとライセンス違反になる**
- クレジット一覧は `npm run credits` で自動生成する。手で書き換えない

### 管理者ページと API に認証が無い

- URL を知っていれば、誰でもマップの編集、Slack の通知先の変更、ログの閲覧ができる
- 社内限定で URL を共有する前提で運用する。ログイン機能は未実装（今後の課題）

### 転送量の上限

無料枠は月 1000 GB。推定の使用量がオフィス画面に出ている。

| 使用量 | 動作 |
|---|---|
| 700 GB | 画面共有が止まる |
| 900 GB | 音声も止まる |

### 部屋の作り直し

Cloudflare 側の都合で、部屋（Durable Object）が数時間おきに作り直される。そのたびに接続が一度切れ、
自動でつなぎ直す。音声と画面共有は引き継がれるので、利用者にはほぼ気づかれない。

---

## 10. つまずきやすいところ

| 症状 | 原因と対処 |
|---|---|
| `node` / `git` が見つからない | PowerShell を開き直す |
| デプロイ先のアカウントが違う | `npx wrangler whoami` で確かめる。`$env:CLOUDFLARE_ACCOUNT_ID` で固定する |
| URL のサブドメインが意図と違う | 4-2 の前にデプロイした。ダッシュボードで変更する（全 URL が変わる） |
| ベータが本番のマップを見ている | `env.beta` の KV の id が本番と同じになっていないか |
| 音声がつながらない | シークレットが `--env beta` 側に入っていない／App ID と Secret の組み合わせ違い |
| マップが空 | `layout:import` の書き込み先 URL とフォルダを確かめる |
| アバターが丸で表示される | `assets-src/avatar/` が無い状態でデプロイした |
| `git switch main` で error | 未コミットの変更がある。先にコミットするか、作業ブランチを作ってから移る |
| 業務用 PC で `git status` が「not a git repository」 | zip に `.git` が入っていない。2-3 の手順で作り直す（エクスプローラーの「送る → 圧縮」や `Compress-Archive` では、隠しフォルダの `.git` が抜けることがある） |
| 業務用 PC で `git push` を拒否される | 組織のリポジトリへの書き込み権限が無い。組織の GitHub の管理者に依頼する |
