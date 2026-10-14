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
| **URL（Worker 名とサブドメイン）** | URL は `https://<Worker名>.<サブドメイン>.workers.dev`。2つとも決められる（4-2 と 4-5）。<br>・サブドメイン: アカウントに1つ。世界で一意なので候補を3つ用意する<br>・Worker 名: 今は `virtual-office`。変えるならここで決める。ベータは自動で `<Worker名>-beta` になる<br>どちらも、後から変えると全員の URL が変わる |
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
- NAS は受け渡しのためだけに使う。NAS の上で展開して作業はしない（3-3 のとおり業務用 PC の中に展開する）

---

## 3. 業務用 PC でやること（準備）

### 3-1. Node.js と Git

```powershell
node -v           # v20 以上なら OK（wrangler が Node.js 20 以上を要求する）
git --version     # 何か表示されれば OK
```

入っていなければ入れる。`winget` は会社の PC では使えないことが多いので、公式サイトから落とす。

**A. インストーラーで入れる（管理者権限がある場合）**

1. https://nodejs.org/ja/download を開き、上の「Docker を使って…」の欄ではなく、**下にスクロールした所**にある
   「Windows インストーラー (.msi)」を落とす（「x64」になっていることを確かめる）
2. 実行する。途中の **「Tools for Native Modules」のチェックは外す**。ほかは既定のままでよい
   - チェックしたままだと、終わったあとに管理者の PowerShell が開き、Visual Studio などを落とそうとして
     ネットワークのエラーを出し続ける。このアプリには不要なので、そのウィンドウは閉じてよい（Node.js 本体はもう入っている）
3. Git が無ければ https://git-scm.com/downloads/win から落として実行。設定は既定のままでよい
4. PowerShell を**開き直して** `node -v` を打つ

`node` が「認識されません」と出るとき（入ったのに場所が登録されていない）:

```powershell
Test-Path "C:\Program Files\nodejs\node.exe"     # True なら入っている。False ならもう一度インストールする
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";C:\Program Files\nodejs", "User")
```

PowerShell を開き直して `node -v` が出れば OK。

**B. 管理者権限がない場合（Node.js を zip で置く）**

1. 同じページで「LTS」「Windows」「x64」の **Standalone Binary (.zip)** を落とす
2. 展開して、中のフォルダ（`node.exe` が入っている所）を `C:\Users\<自分>\tools\node` に置く
3. 自分のユーザーの PATH に足して、PowerShell を開き直す

```powershell
$node = "$env:USERPROFILE\tools\node"
[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";$node", "User")
```

Git もない場合は、https://git-scm.com/downloads/win の **Portable** 版を同じように置いて、その中の `cmd` フォルダを PATH に足す。
どちらも会社の決まりで入れられないときは、情報システムの担当に依頼する。

**npm を使えるようにする（A・B 共通）**

`npm -v` で「このシステムではスクリプトの実行が無効になっている」と出たら、自分のユーザーだけ許可する。

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned    # 聞かれたら Y
npm -v                                                  # 番号が出れば OK
```

会社の設定で変えられないときは、以降の `npm` / `npx` を `npm.cmd` / `npx.cmd` と打つ。

### 3-2. 会社のプロキシを設定する

会社のネットワークがプロキシ経由だと、`npm install` が `ENOTFOUND registry.npmjs.org` で失敗する。
先に調べて、あれば npm・wrangler・git に教える。

```powershell
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable, ProxyServer, AutoConfigURL
```

`ProxyEnable` が `1` で `ProxyServer` に `アドレス:ポート` が出たら、その値を `<プロキシ>` として設定する
（`0` や空なら、このステップは飛ばす）。

```powershell
# npm 用
npm config set proxy http://<プロキシ>
npm config set https-proxy http://<プロキシ>

# wrangler（デプロイ・ログイン）と git 用。入れたら PowerShell を開き直す
[Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://<プロキシ>", "User")
[Environment]::SetEnvironmentVariable("HTTP_PROXY",  "http://<プロキシ>", "User")
[Environment]::SetEnvironmentVariable("NO_PROXY",    "localhost,127.0.0.1", "User")
```

`NO_PROXY` は、手元で動かすとき（`npm run dev`）の通信をプロキシに回さないため。
`AutoConfigURL`（.pac）しか出ないときは、その URL をブラウザで開くと中にプロキシのアドレスが書いてある。
プロキシが ID・パスワードを求める（`407`）場合や、証明書のエラーが出る場合は、情報システムの担当に開発ツールからの接続方法を確認する
（パスワードを設定ファイルに書かない）。

### 3-3. zip を展開して依存を入れる

NAS の zip を業務用 PC にコピーし、`C:\virtual_office` に展開する。
作業は必ずこの PC の中のフォルダで行う。NAS の上で直接作業すると、`npm install`（数万ファイル）や git が遅く、
ファイルのロックで失敗しやすい。移行後のコードの正本は組織の GitHub で、NAS の zip は受け渡しと控えにすぎない。

```powershell
cd C:\virtual_office
npm install
git status          # 履歴が見えることを確かめる
```

`npm install` で `wrangler` と `sharp`（アバター画像の切り出し）が、その PC 用に入る。

最後に `install-scripts ... not yet covered by allowScripts` と出て esbuild と workerd が並んだら、
それは wrangler が使う部品の準備スクリプトが止められている。許可して実行し直す。

```powershell
npm install-scripts approve esbuild workerd
npm rebuild esbuild workerd
npx wrangler --version      # 4.x.x のような番号が出れば OK
```

`high severity vulnerabilities` の警告は開発用の道具の中の話なので放っておいてよい。`npm audit fix --force` はしない
（wrangler の版が変わって動かなくなることがある）。

`git status` で `BETA.md` や `MIGRATION.md` などが「変更あり」と出たら、zip を作ったときに未コミットの変更が入っていた。
業務用 PC ではコミットしない。個人 PC でコミット・プッシュを済ませてから、業務用 PC を最新にそろえる
（3-4 で組織に送るのはこの PC の履歴なので、古いままだと最後のコミットが抜ける）。

```powershell
git restore .          # zip に入っていた未コミットの変更を捨てる（同じものが個人 PC でコミット済みのこと）
git pull               # 個人リポジトリから最新を取る（公開済みならログイン不要）
git log --oneline -1   # 個人 PC の最後のコミットと同じか確かめる
```

個人リポジトリがまだ非公開で `git pull` がログインを求めるときは、個人 PC で zip を作り直して 3-3 からやり直すほうが早い。

### 3-4. 組織の GitHub に非公開リポジトリを作って登録する

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

### 3-5. `.dev.vars`

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

### 4-5. Worker 名を変える場合（変えないなら飛ばす）

URL の最初の部分（`https://<Worker名>.<サブドメイン>.workers.dev`）を `virtual-office` から変えるときだけ行う。
**最初のデプロイ（5-2）より前に**済ませる。あとから変えると、別の Worker として新しく作られ、マップの書き込みや
シークレットの登録をやり直すことになる。

`wrangler.jsonc` の2か所を、同じ新しい名前に書き替える:

| 場所 | 書き替える値 | 意味 |
|---|---|---|
| トップレベルの `"name"` | 新しい Worker 名 | 本番の名前。URL の最初の部分になる |
| `env.beta` の `services` の `"service"` | 同じ新しい Worker 名 | ベータが毎日マップを読みに行く本番の名前（`BETA.md` の「本番のマップを毎日写す」） |

- ベータの名前は、自動で `<新しいWorker名>-beta` になる（書き替える場所は無い）
- 使える文字: 半角の英小文字・数字・ハイフン。63文字まで（ベータは `-beta` が付くので、58文字以内にしておく）
- コメント（`// デプロイ: npm run deploy → virtual-office` など）も、分かりやすいよう合わせて直しておく
- `"service"` を直し忘れると、ベータのデプロイで「Worker が見つからない」と言われるか、毎日の同期が失敗する
- `package.json` の `"name"` は npm の中だけの名前で、URL には関係しない。変えなくてよい
- この変更は組織のリポジトリにコミットする

以降の手順の `<Worker名>` は、この名前（変えなければ `virtual-office`）に読み替える。

### 4-6. KV を2つ作り、`wrangler.jsonc` を書き替える

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

### 4-7. シークレットを登録する

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
npm run layout:import -- https://<Worker名>-beta.<サブドメイン>.workers.dev layout-backup-<日付>
```

- ベータは本番の Worker（`<Worker名>`）につないで毎日マップを写す（`BETA.md` の「本番のマップを毎日写す」）。
  新しいアカウントにまだ本番が無いと、ベータのデプロイで `<Worker名>` が見つからないと言われることがある。
  その場合は、先に `npm run deploy` で本番を出してから（まだ URL を周知していないので、誰も使っていない）ベータを出す

ベータの URL を開き、次を確かめる（PC のブラウザを2つ、またはPCとスマホで2人分入る）。

| # | 確かめること | 見るところ |
|---|---|---|
| 1 | マップ・会話エリア・家具・管理者の看板が出る | 旧サイトと同じ見た目か |
| 2 | 2人で近づくと声が聞こえる。マイクの ON・OFF が相手の名前の印に出る | 新しい Realtime のアプリが使えているか（4-3、4-7） |
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
npm run layout:import -- https://<Worker名>.<サブドメイン>.workers.dev layout-backup-<日付>
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
npx wrangler delete --name virtual-office        # 旧環境の名前（新環境で Worker 名を変えても、ここは変えない）
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
- ログ: ダッシュボードの Workers & Pages → <Worker名> → Observability。サイトの `/api/server-log` と `/api/client-errors` でも見られる

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
| `node` は入っている（`C:\Program Files\nodejs\node.exe` がある）のに見つからない | ユーザーの PATH に `C:\Program Files\nodejs` を足して開き直す（3-1 の A の最後） |
| `npm install` で `ENOTFOUND registry.npmjs.org` | 会社のプロキシ経由になっている。`Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' \| Select-Object ProxyServer` で値を調べ、`npm config set proxy http://<値>` と `npm config set https-proxy http://<値>`。wrangler と git 用にユーザー環境変数 `HTTPS_PROXY` / `HTTP_PROXY` にも同じ値、`NO_PROXY` に `localhost,127.0.0.1` を入れて開き直す |
| `npm install` のあとに `install-scripts ... not yet covered by allowScripts`（esbuild、workerd） | `npm install-scripts approve esbuild workerd` のあと `npm rebuild esbuild workerd`。`npx wrangler --version` で番号が出れば OK |
| `npm install` で `high severity vulnerabilities` | 開発用の道具の警告。`npm audit fix --force` はしない（wrangler の版が変わって動かなくなることがある） |
| 3-4 の `git push` が `[rejected] main -> main (fetch first)` | 組織のリポジトリを作るときに README などを作ってしまい、空でない。`git fetch origin` と `git log origin/main --oneline` で中身が自動の最初のコミットだけと確かめてから `git push -u origin main --force`（または GitHub でリポジトリを空で作り直す） |
| `npm` で「スクリプトの実行が無効」 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。会社の設定で変えられないときは `npm.cmd` / `npx.cmd` と打つ |
| デプロイ先のアカウントが違う | `npx wrangler whoami` で確かめる。`$env:CLOUDFLARE_ACCOUNT_ID` で固定する |
| URL のサブドメインが意図と違う | 4-2 の前にデプロイした。ダッシュボードで変更する（全 URL が変わる） |
| URL の最初の部分が `virtual-office` のまま | 4-5 の `name` を書き替える前にデプロイした。書き替えてデプロイし直すと別の Worker ができるので、マップの書き込みとシークレットの登録をやり直し、古いほうは `npx wrangler delete --name virtual-office` で消す |
| ベータの毎日の同期が失敗する | `env.beta` の `services` の `"service"` が本番の Worker 名と違う（4-5） |
| ベータが本番のマップを見ている | `env.beta` の KV の id が本番と同じになっていないか |
| 音声がつながらない | シークレットが `--env beta` 側に入っていない／App ID と Secret の組み合わせ違い |
| マップが空 | `layout:import` の書き込み先 URL とフォルダを確かめる |
| アバターが丸で表示される | `assets-src/avatar/` が無い状態でデプロイした |
| `git switch main` で error | 未コミットの変更がある。先にコミットするか、作業ブランチを作ってから移る |
| 業務用 PC で `git status` が「not a git repository」 | zip に `.git` が入っていない。2-3 の手順で作り直す（エクスプローラーの「送る → 圧縮」や `Compress-Archive` では、隠しフォルダの `.git` が抜けることがある） |
| 業務用 PC で `git push` を拒否される | 組織のリポジトリへの書き込み権限が無い。組織の GitHub の管理者に依頼する |
