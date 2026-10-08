// 部屋（Durable Object）：位置の配信＋チャット中継＋SFU中継＋転送量ガード。
// 1つのインスタンスに全員が接続する（src/index.js が idFromName("main") で選ぶ）。
//
// ── このファイル全体を支配している前提：休眠（WebSocket Hibernation）──
//
// handleWs の ctx.acceptWebSocket(server) が、接続を張ったまま部屋を眠らせる仕組み。
// 眠っているあいだ、利用者の WebSocket はつながったままだが、部屋はメモリから落とされる。
// 次のメッセージが届くと constructor から作り直される。
//
// つまり constructor で用意した this.xxx は、いつ消えてもおかしくない。
// どこに何が乗っているかは次のとおり。
//
//   serializeAttachment（接続ごと・残る）
//     id / name / token / avatar / away / SFUの各ID / 位置（x, y）と最後に届いた時刻（at）
//     位置をここに置くのは、休眠や作り直しを越えて残すためと、接続が閉じれば
//     一緒に消えるため（別の場所に保存すると、退出した人の位置が残る恐れがある）
//     ※ 上限 16,384 バイト。大きいものは storage へ
//   ctx.storage（部屋ごと・残る）
//     officeComments / budget ※ どちらも遅延読み込み
//   this.callAt（消える）
//     呼び出しの連打防止。休眠を挟むとクールダウンが実質リセットされる
//   this.leaving（消える）
//     退出通知の待ち。タイマーが残っているあいだ部屋は眠らないので、通常は消えない
//   this.scheduled / this.budget*（消えるが問題ない）
//     前者は作り直され、後者は ensureBudgetLoaded が storage から読み直す

import { GB, LIMIT_GB, NEAR, CALL_COOLDOWN_MS, LEAVE_GRACE_MS, STALE_MS, BOOT_GRACE_MS, ROSTER_QUIET_MS } from "./config.js";
import { json, cleanAvatar, cleanComment, monthKey, levelFor, zoneIdAtWorld, bytesPerSec, readWebhookUrl, escapeSlack } from "./helpers.js";

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // 以下はすべてメモリ上の値。休眠で消えることを前提に扱う（冒頭の説明を参照）。
    this.scheduled = false;
    this.budgetBytes = 0;
    this.budgetMonth = monthKey();
    this.budgetLevel = "ok";
    this.budgetLoaded = false;
    this.comments = null;         // オフィスで作られたコメント（全員共有）。遅延読み込み
    this.callAt = new Map();      // 呼び出しの連打防止。"送信者id>相手id" -> 最後に送った時刻
    this.leaving = new Map();     // 退出通知の待ち。cid -> タイマー
    this.errCount = new Map();    // エラー記録の件数。接続id -> 件数（消えても問題ない）

    // ── 在室者の名簿（Slack 通知の判定専用） ──
    // 「いま在室している人」を storage にも残しておく。部屋が作り直されると this.leaving などの
    // メモリ上の記憶が消え、入り直してきた全員が初めて来た人に見えて、人数ぶんの入室通知が
    // 流れてしまう。名簿が残っていれば、作り直しのあとでも「さっきまでいた人」と分かる。
    //
    // 【重要】名簿は通知を出すかどうかの判定にしか使わない。マップ上のアバター・在室者・
    // 勤務者一覧は、これまでどおり sockets()（いま実際につながっている接続）だけから作る。
    // 名簿に名前が残っていても、接続が無ければ画面には出ない。表示に使い始めると、
    // 「退出したのにアバターが残る」が再発するので、絶対に混ぜないこと。
    this.roster = new Map();      // cid -> { name, at }
    this.bootAt = Date.now();     // この個体が動き始めた時刻（休眠から起きたときも更新される）
    this.grace = null;            // 作り直しのあとの待ち { until, quiet }。待っていなければ null
    this.lastTick = 0;            // 転送量を最後に積んだ時刻（alarm が使う）
    // 起動の記録と名簿の読み込みが済むまで、ほかの処理を待たせる。
    this.ticketKey = null;        // 合札の鍵（ticketFor が storage から読む）
    this.ctx.blockConcurrencyWhile(() => this.boot());
  }

  // 起動時に1回だけ走る。名簿を読み込み、起動したことを記録する。
  //
  // 「起動」には2種類ある。
  //   休眠から起きた … 接続は残っている。メモリ上の値が消えただけで、利用者には何も起きていない。
  //                     全員がタブを裏に置いていると（位置の送信が1分おきになる）、毎分のように起こる。
  //   作り直された   … 接続が1本も無い。人がいたなら、全員が一斉に切断されたということ。
  // 記録（boots）に残すのは後者だけ。前者まで残すと、調べたい作り直しの記録が埋もれる。
  //   roster  … 名簿に残っていた人数。1 以上なら「人がいたのに作り直された」と読める。
  //   downSec … 最後に動いていた記録（alive）から起動までの秒数。
  async boot() {
    try {
      const saved = (await this.ctx.storage.get("roster")) || {};
      for (const [cid, v] of Object.entries(saved)) {
        if (v && typeof v.name === "string") this.roster.set(cid, { name: v.name, at: +v.at || 0 });
      }
      const alive = (await this.ctx.storage.get("alive")) || 0;
      this.lastTick = alive;   // 休眠でメモリから消えても、転送量を続きから積めるようにする
      const sockets = this.ctx.getWebSockets().length;
      if (sockets > 0) {
        // 休眠から起きただけ。作り直しのあとの待ち時間がまだ残っていれば、それを引き継ぐ
        this.grace = (await this.ctx.storage.get("grace")) || null;
        return;
      }
      const downMs = alive ? Math.max(0, this.bootAt - alive) : 0;
      const boots = (await this.ctx.storage.get("boots")) || [];
      boots.push({ at: new Date(this.bootAt).toISOString(), roster: this.roster.size, downSec: alive ? Math.round(downMs / 1000) : null });
      if (boots.length > 200) boots.splice(0, boots.length - 200);
      await this.ctx.storage.put("boots", boots);
      console.log("[boot]", JSON.stringify(boots[boots.length - 1]));
      if (this.roster.size) {
        // 名簿に人が残っている。つなぎ直しを待ったあとで照合する（alarm の reconcileRoster）。
        // 待ち時間を storage にも置くのは、待っている途中で部屋が休眠しても忘れないため。
        // setTimeout ではなく alarm を使うのも同じ理由（誰も戻ってこないと部屋はすぐ眠る）。
        this.grace = { until: this.bootAt + BOOT_GRACE_MS, quiet: downMs > ROSTER_QUIET_MS };
        await this.ctx.storage.put("grace", this.grace);
        await this.ctx.storage.setAlarm(this.grace.until);
      }
    } catch (e) {
      console.log("[boot] failed", String(e && e.message || e));
    }
  }

  // サーバー側で起きた例外の記録。直近30件を storage に残す（/api/server-log で読める）。
  // 部屋が落ちる直前に何か起きていないかを、あとから調べるためのもの。
  async logError(where, e) {
    try {
      console.log("[error]", where, String(e && e.stack || e));
      const list = (await this.ctx.storage.get("serverErrors")) || [];
      list.push({ at: new Date().toISOString(), where, message: String(e && e.message || e).slice(0, 300) });
      if (list.length > 30) list.splice(0, list.length - 30);
      await this.ctx.storage.put("serverErrors", list);
    } catch { }
  }

  async saveRoster() {
    await this.ctx.storage.put("roster", Object.fromEntries(this.roster));
  }

  // 名簿と実際の接続を突き合わせる（alarm から）。
  // 名簿にいるのに接続が無く、退出通知の待ちにも入っていない人は、部屋の作り直しなどで
  // 退出を見届けられなかった人。名簿から外し、退出を通知する。
  // 部屋が作り直された直後は、まだ入り直してくる途中の人がいるので待つ（this.grace）。
  async reconcileRoster() {
    if (!this.roster.size) return;
    if (this.grace && Date.now() < this.grace.until) return;   // まだ入り直してくる途中の人がいる
    // 長く止まっていたあとの最初の照合では、古い退出を通知しない（何時間も前の話になるため）
    const quiet = !!(this.grace && this.grace.quiet);
    let changed = false;
    for (const [cid, v] of [...this.roster]) {
      if (this.hasCid(cid, null) || this.leaving.has(cid)) continue;
      this.roster.delete(cid);
      changed = true;
      if (!quiet) await this.notify(`${escapeSlack(v.name)}さんがスペースから退出しました。`);
    }
    if (this.grace) { this.grace = null; await this.ctx.storage.delete("grace"); }
    if (changed) await this.saveRoster();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return this.handleWs(req);
    if (url.pathname.startsWith("/rtc/")) return this.handleRtc(req, url);
    if (url.pathname === "/api/refresh") { this.broadcastReload(); return new Response("ok"); }
    if (url.pathname === "/api/client-errors") return json((await this.ctx.storage.get("clientErrors")) || []);
    // 部屋の起動の記録と、サーバー側で起きた例外。部屋がなぜ・どのくらい作り直されているかを調べる用
    if (url.pathname === "/api/server-log") {
      return json({
        now: new Date().toISOString(),
        bootAt: new Date(this.bootAt).toISOString(),
        connected: this.sockets().length,
        roster: this.roster.size,
        boots: (await this.ctx.storage.get("boots")) || [],
        errors: (await this.ctx.storage.get("serverErrors")) || [],
      });
    }
    return new Response("Not found", { status: 404 });
  }

  // ── Slack 通知（入室・離席・着席・退出） ──
  // 送信先が未登録なら何もしない。通知の失敗でオフィス側の動作を止めないよう、
  // 例外はすべてここで握って捨てる。
  async notify(text) {
    const url = await readWebhookUrl(this.env);
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch { }
  }

  // 管理者の「反映」：全利用者に再取得を促す（音声・接続はそのまま）
  broadcastReload() {
    const data = JSON.stringify({ t: "reload" });
    for (const ws of this.sockets()) { try { ws.send(data); } catch { } }
  }

  // ── オフィスで作られたコメント（全員共有・誰でも削除可） ──
  async ensureComments() {
    if (this.comments === null) this.comments = (await this.ctx.storage.get("officeComments")) || [];
    await this.pruneExpiredComments();
  }
  // 消える日時を過ぎた看板を取り除く（変化があれば保存）
  async pruneExpiredComments() {
    if (!this.comments || !this.comments.length) return false;
    const now = Date.now();
    const before = this.comments.length;
    this.comments = this.comments.filter((c) => !(c.expireAt && c.expireAt <= now));
    if (this.comments.length !== before) {
      await this.ctx.storage.put("officeComments", this.comments);
      return true;
    }
    return false;
  }
  broadcastComments() {
    const data = JSON.stringify({ t: "comments", list: this.comments || [] });
    for (const ws of this.sockets()) { try { ws.send(data); } catch { } }
  }

  // チャット中継：送信者のエリア内 or 近接の人（＋送信者本人）へ送る。
  // 配信範囲の条件は public/office/voice.js の currentTargets と同じにしてある
  // （声が届く相手とチャットが届く相手を一致させるため）。
  //
  // 1通ごとに KV から zones を読み直している。会話エリアは管理者が変えたときしか
  // 変わらないので毎回読む必要はないが、KV の読み出しは安く、持ち回すと管理者の
  // 「反映」との整合を取る手間が増えるため、そのままにしてある。
  async relayChat(att, text) {
    let zones = [];
    try { zones = JSON.parse((await this.env.LAYOUT_KV.get("zones")) || "[]"); } catch { }
    // 位置がまだ届いていない人（接続直後・休眠明け）は、近いかどうか判定できないので
    // 配信の対象にしない。{0,0} 扱いにすると、左上にいる人どうしとして届いてしまう。
    const sp = posOf(att);
    const sz = sp ? zoneIdAtWorld(zones, sp.x, sp.y) : null;
    const out = JSON.stringify({ t: "chat", id: att.id, name: att.name, text });
    for (const ws of this.sockets()) {
      const a2 = ws.deserializeAttachment();
      if (!a2 || !a2.name) continue;
      if (a2.id === att.id) { try { ws.send(out); } catch { } continue; }   // 送信者にも表示
      const p2 = posOf(a2);
      if (!sp || !p2) continue;
      const z2 = zoneIdAtWorld(zones, p2.x, p2.y);
      const ok = sz ? (z2 === sz) : (z2 === null && Math.hypot(p2.x - sp.x, p2.y - sp.y) <= NEAR);
      if (ok) { try { ws.send(out); } catch { } }
    }
  }

  // 呼び出しの中継：相手にだけアラームを送り、送信者には控えを返す。
  //
  // 条件（近接・離席でない・連打でない）はクライアントでも見ているが、
  // 画面の出し分けだけでは細工したメッセージを防げない。アラームが鳴る機能なので
  // ここでも同じ条件を検査する。弾く場合は黙って捨てる。
  relayCall(ws, att, toId) {
    if (!att.name || typeof toId !== "string" || toId === att.id) return;

    let target = null;
    for (const w of this.sockets()) {
      const a = w.deserializeAttachment();
      if (a && a.id === toId) { target = { ws: w, att: a }; break; }
    }
    if (!target || !target.att.name) return;
    if (target.att.away) return;                                   // 離席中は呼び出せない

    const me = posOf(att);
    const you = posOf(target.att);
    if (!me || !you) return;
    if (Math.hypot(you.x - me.x, you.y - me.y) > NEAR) return;      // 近くにいないと呼べない

    // クールダウンはメモリ上の this.callAt で見ているので、休眠を挟むと実質リセットされる。
    // 相手が10秒以内にもう一度鳴らされる程度なので、storage までは使っていない。
    const now = Date.now();
    const key = `${att.id}>${toId}`;
    if (now - (this.callAt.get(key) || 0) < CALL_COOLDOWN_MS) return;
    this.callAt.set(key, now);
    for (const [k, t] of this.callAt) if (now - t > CALL_COOLDOWN_MS) this.callAt.delete(k);   // 古い記録を掃除

    try { target.ws.send(JSON.stringify({ t: "called", name: att.name, at: now })); } catch { }
    try { ws.send(JSON.stringify({ t: "call_sent", name: target.att.name, at: now })); } catch { }
  }

  async handleWs(req) {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.ensureBudgetLoaded();
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    // これが休眠を有効にする1行。server.accept() にすると休眠しなくなり、
    // 代わりに this.callAt などがメモリに残り続ける（＝常時課金される）。
    this.ctx.acceptWebSocket(server);

    // 接続ごとの情報。休眠を越えて残る唯一の置き場所。
    // name が空のあいだは「まだ hello を受け取っていない接続」の意味で、
    // 配信や退出通知の対象から外す目印にもなっている。
    // token は SFU 中継の認可に使う。welcome で本人にだけ渡す。
    const att = {
      id: crypto.randomUUID().slice(0, 8),
      name: "",
      token: crypto.randomUUID().replace(/-/g, ""),
    };
    server.serializeAttachment(att);

    await this.ensureAlarm();   // 転送量推定の周期アラームを起動
    return new Response(null, { status: 101, webSocket: client });
  }

  // 受け取ったメッセージを t の値で振り分ける。中身はそれぞれ下の on〜 にある。
  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }   // 壊れたデータは黙って捨てる
    const att = ws.deserializeAttachment();
    if (!att) return;
    try {
      await this.dispatch(ws, att, msg);
    } catch (e) {
      await this.logError(`message:${String(msg.t).slice(0, 20)}`, e);
    }
  }

  async dispatch(ws, att, msg) {
    if (msg.t === "hello") await this.onHello(ws, att, msg);
    else if (msg.t === "comment_add") await this.onCommentAdd(msg);
    else if (msg.t === "comment_remove") await this.onCommentRemove(msg);
    else if (msg.t === "chat") await this.onChat(att, msg);
    else if (msg.t === "call") this.relayCall(ws, att, msg.to);
    else if (msg.t === "away") await this.onAway(ws, att, msg);
    else if (msg.t === "pos") this.onPos(ws, att, msg);
    else if (msg.t === "talk") this.onTalk(ws, att, msg);
    else if (msg.t === "clienterr") await this.onClientErr(att, msg);
    else if (msg.t === "publish") this.onPublish(ws, att, msg);
    else if (msg.t === "unpublish") this.onUnpublish(ws, att, msg);
  }

  // 入室。名前とアバターを受け取り、本人にだけ id とトークンを返す。
  // 現在の看板も併せて送る（以後は変更のたびに broadcastComments が配る）。
  async onHello(ws, att, msg) {
    await this.ensureBudgetLoaded();
    // つなぎ直しのとき、音声と画面共有の接続をそのまま引き継ぐ（checkResume）。
    // 検証に await を挟むので、att を読み直す前に済ませておく。
    const sfu = await this.checkResume(msg.resume);
    att = ws.deserializeAttachment() || att;   // await のあいだに届いた変更を上書きしない
    att.at = Date.now();       // 位置が届く前に「応答なし」と判定されないようにする
    const first = !att.name;   // 同じ接続で hello を送り直しても入室通知は出さない
    att.name = String(msg.name || "名無し").slice(0, 20);
    att.avatar = cleanAvatar(msg.avatar);
    // cid はタブごとの ID（public/office/net.js）。再接続しても変わらないので、
    // 「同じ人がつなぎ直しただけ」を見分けるのに使う。送ってこない場合は接続の id で代用する。
    att.cid = (typeof msg.cid === "string" && /^[\w-]{1,32}$/.test(msg.cid)) ? msg.cid : att.id;
    // 離席状態もここで受け取る。再接続時に away で送り直させると、そのたびに通知が出る。
    att.away = !!msg.away;
    att.awayMsg = att.away ? String(msg.awayMsg || "").slice(0, 100) : "";
    if (sfu) Object.assign(att, sfu);
    // つなぎ直しか：退出通知を待っている最中、同じ cid の古い接続がまだ残っている、
    // または名簿に残っている（部屋が作り直されて、上の2つの記憶が消えた場合はこれで分かる）
    const rejoin = this.cancelLeave(att.cid) | this.hasCid(att.cid, att.id) | this.roster.has(att.cid);
    // 同じタブの古い接続が残っていたら、ここで退かせる。
    // 切断の通知が届かないまま入り直すと（ページの移動のしかたや回線によっては起こる）、
    // 古い接続が生きているように見え、「さっき退出した自分」がオフィスに残ってしまう。
    // 4001 を受け取った側は、別のタブとして ID を作り直して入り直す（public/office/net.js）。
    for (const w of this.sockets()) {
      const a = w.deserializeAttachment();
      if (!a || !a.name || a.cid !== att.cid || a.id === att.id) continue;
      this.retire(w, a);
      try { w.close(4001, "replaced"); } catch { }
    }
    ws.serializeAttachment(att);
    ws.send(JSON.stringify({
      t: "welcome", id: att.id, token: att.token, resumed: !!sfu,
      budget: { level: this.budgetLevel, usedGb: this.usedGb(), limitGb: LIMIT_GB },
    }));
    await this.ensureComments();
    ws.send(JSON.stringify({ t: "comments", list: this.comments }));   // 入室時に現在のコメントを送る
    this.schedule();
    // 名簿に載せる（通知の判定専用。表示には使わない）。中身が変わったときだけ保存する
    const prev = this.roster.get(att.cid);
    this.roster.set(att.cid, { name: att.name, at: Date.now() });
    if (!prev || prev.name !== att.name) await this.saveRoster();
    if (first && !rejoin) await this.notify(`${escapeSlack(att.name)}さんがスペースに入室しました。`);
  }

  // ── 音声の接続の引き継ぎ ──
  //
  // 部屋が作り直されると全員の WebSocket が切れるが、音声と画面共有は Cloudflare Realtime と
  // 直接つながっているので、ブラウザ側で畳まなければ流れ続ける。つなぎ直したブラウザは
  // hello に「自分の音声セッション」を添えてくるので、それを新しい接続に引き継ぐ。
  // これで、作り直しのたびに通話が途切れ、画面共有が止まることがなくなる。
  //
  // セッション ID は配信（broadcast）で全員に配っているので、ID を名乗れるだけでは本人と
  // 言えない。セッションを作ったときに本人にだけ渡す合札（ticket）を一緒に出させる。
  // 合札は storage の鍵で作る HMAC なので、部屋が作り直されても確かめられる。
  //
  // 受け取ったものが確かめられなければ null を返す。ブラウザは resumed: false を見て、
  // これまでどおり音声を張り直す。
  async checkResume(r) {
    try {
      if (!r || typeof r !== "object" || typeof r.sessionId !== "string") return null;
      const ok = [];
      for (const s of (Array.isArray(r.sessions) ? r.sessions.slice(0, 4) : [])) {
        if (!s || typeof s.id !== "string" || !/^[\w-]{1,128}$/.test(s.id) || typeof s.ticket !== "string") continue;
        if (s.ticket === await this.ticketFor(s.id)) ok.push(s.id);
      }
      if (!ok.includes(r.sessionId)) return null;   // 音声用のセッションが確かめられなければ引き継がない
      const track = (v) => (typeof v === "string" && /^[\w-]{1,64}$/.test(v)) ? v : undefined;
      const out = { sessions: ok, sfuSessionId: r.sessionId, audioTrack: track(r.audio), screenTrack: undefined, screenSessionId: undefined };
      if (typeof r.screenSessionId === "string" && ok.includes(r.screenSessionId) && track(r.screen)) {
        out.screenSessionId = r.screenSessionId;
        out.screenTrack = track(r.screen);
      }
      return out;
    } catch (e) {
      await this.logError("resume", e);
      return null;
    }
  }

  // セッション ID に対する合札。鍵は部屋ごとに1回だけ作り、storage に残す。
  async ticketFor(sid) {
    if (!this.ticketKey) {
      let raw = await this.ctx.storage.get("ticketKey");
      if (!raw) {
        raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
        await this.ctx.storage.put("ticketKey", raw);
      }
      this.ticketKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    }
    const sig = await crypto.subtle.sign("HMAC", this.ticketKey, new TextEncoder().encode(sid));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // 看板の追加・更新。同じ id が来たら置き換え（移動やリサイズもこの経路）。
  async onCommentAdd(msg) {
    await this.ensureComments();
    const c = cleanComment(msg.comment);
    if (!c) return;
    const idx = this.comments.findIndex((x) => x.id === c.id);
    if (idx >= 0) this.comments[idx] = c;
    else if (this.comments.length < 200) this.comments.push(c);
    else return;   // 200件を超えたら黙って捨てる（送った側にエラーは返らない）
    await this.ctx.storage.put("officeComments", this.comments);
    this.broadcastComments();
  }

  async onCommentRemove(msg) {
    await this.ensureComments();
    const before = this.comments.length;
    this.comments = this.comments.filter((c) => c.id !== msg.id);
    if (this.comments.length !== before) {
      await this.ctx.storage.put("officeComments", this.comments);
      this.broadcastComments();
    }
  }

  // 送信者と同じ会話エリア内、またはエリア外なら近接の人だけに配信（保存はしない）
  async onChat(att, msg) {
    const text = String(msg.text || "").slice(0, 500).trim();
    if (text) await this.relayChat(att, text);
  }

  // 離席・着席。同じ状態の送り直し（再接続時など）では Slack へ通知しない。
  async onAway(ws, att, msg) {
    const next = !!msg.away;
    const changed = next !== !!att.away;
    att.away = next;
    att.awayMsg = att.away ? String(msg.msg || "").slice(0, 100) : "";
    ws.serializeAttachment(att);
    this.schedule();   // 離席状態を全員へ配信
    if (changed && att.name) {
      await this.notify(`${escapeSlack(att.name)}さんが${next ? "離席" : "着席"}しました。`);
    }
  }

  // 位置。接続（attachment）に保存するので、休眠や部屋の作り直しを越えて残る。
  // at は最後に届いた時刻で、応答のない接続を見つけるのに使う（alarm の sweepStale）。
  onPos(ws, att, msg) {
    att.x = Number(msg.x) || 0;
    att.y = Number(msg.y) || 0;
    att.at = Date.now();
    ws.serializeAttachment(att);
    this.schedule();
  }

  // SFU で何を送っているかの申告。ここで受けた内容を broadcast が全員へ配り、
  // 受け取った側が購読する相手を決める。
  onPublish(ws, att, msg) {
    if (typeof msg.sessionId === "string") att.sfuSessionId = msg.sessionId;
    if (typeof msg.audio === "string") att.audioTrack = msg.audio;
    if (typeof msg.screen === "string") att.screenTrack = msg.screen;
    if (typeof msg.screenSessionId === "string") att.screenSessionId = msg.screenSessionId;
    ws.serializeAttachment(att);
    this.schedule();
  }

  // クライアントで起きたマイクまわりの失敗の記録（public/office/voice.js の reportVoiceError）。
  // 利用者の環境でしか起きない不具合を調べるためのもの。直近50件を storage に残し、
  // /api/client-errors で読める。ログにも出すので `wrangler tail` でも見られる。
  // 1接続あたり30件まで（壊れたクライアントが送り続けても storage を埋めない）。
  async onClientErr(att, msg) {
    const n = (this.errCount.get(att.id) || 0) + 1;
    this.errCount.set(att.id, n);
    if (n > 30) return;
    const str = (v, max) => String(v ?? "").slice(0, max);
    const rec = {
      at: new Date().toISOString(),
      user: att.name || "",
      where: str(msg.where, 20),       // unmute=ボタン操作 / auto=自動の付け直し / cycle=周期処理
      stage: str(msg.stage, 20),       // session / open / publish
      name: str(msg.name, 40),         // エラー名（NotAllowedError など）
      message: str(msg.message, 200),
      perm: str(msg.perm, 20),         // マイクの許可の状態
      savedMic: !!msg.savedMic,
      visible: !!msg.visible,
      ua: str(msg.ua, 200),
    };
    console.log("[clienterr]", JSON.stringify(rec));
    const list = (await this.ctx.storage.get("clientErrors")) || [];
    list.push(rec);
    if (list.length > 50) list.splice(0, list.length - 50);
    await this.ctx.storage.put("clientErrors", list);
  }

  // 話している／いないの申告。全員のアバターに吹き出しを出すために配る。
  // 音声を publish していない人の申告は受けない（声が届かないのに吹き出しだけ出るのを防ぐ）。
  onTalk(ws, att, msg) {
    const next = !!msg.on && !!att.audioTrack && !att.away;
    if (next === !!att.talk) return;
    att.talk = next;
    ws.serializeAttachment(att);
    this.schedule();
  }

  // 送信の取り下げ。kind 指定が無ければ音声も画面も取り下げる。
  onUnpublish(ws, att, msg) {
    if (msg.kind === "screen") { att.screenTrack = undefined; att.screenSessionId = undefined; }
    else if (msg.kind === "audio") { att.audioTrack = undefined; att.talk = false; }
    else { att.audioTrack = undefined; att.screenTrack = undefined; att.screenSessionId = undefined; att.talk = false; }
    ws.serializeAttachment(att);
    this.schedule();
  }

  async webSocketClose(ws) { await this.drop(ws); }
  async webSocketError(ws) { await this.drop(ws); }
  async drop(ws) {
    const att = ws.deserializeAttachment();
    // 名前が無い＝入室前に切れた接続なので通知しない
    if (att && att.name) {
      this.scheduleLeave(att);
      this.retire(ws, att);
    }
    this.schedule();
  }

  // 開いている接続だけを返す。配信・判定はすべてこれを通す。
  //
  // ctx.getWebSockets() は、閉じかけ（CLOSING）の接続をしばらく返し続けることがある。
  // 位置は接続に保存しているので、そのまま数えると「退出した人がまだいる」ように見える。
  sockets() {
    // 2 = CLOSING, 3 = CLOSED。「開いている」ではなく「閉じていない」で絞るのは、
    // 状態が読めない場合に全員を消してしまわないため。
    return this.ctx.getWebSockets().filter((ws) => ws.readyState !== 2 && ws.readyState !== 3);
  }

  // 接続を「いない人」にする。名前を空にすると入室前の接続と同じ扱いになり、
  // 配信・チャット・呼び出し・転送量推定のすべてから外れる。
  // sockets() の絞り込みと二重に守っているのは、接続の状態の見え方が実行環境任せのため。
  retire(ws, att) {
    att.name = "";
    att.talk = false;
    att.audioTrack = att.screenTrack = att.screenSessionId = undefined;
    try { ws.serializeAttachment(att); } catch { }   // 閉じた接続では書けないことがある
  }

  // ── 退出の通知（再接続なら出さない） ──
  //
  // 接続が切れた時点では、退出なのか一時的な切断なのか区別できない。
  // LEAVE_GRACE_MS だけ待ち、同じ cid が戻ってこなければ退出として通知する。
  // そのぶん、本当の退出の通知も同じ時間だけ遅れる。

  // 同じ cid の（入室済みの）接続が、exceptId 以外にあるか
  hasCid(cid, exceptId) {
    for (const w of this.sockets()) {
      const a = w.deserializeAttachment();
      if (a && a.name && a.cid === cid && a.id !== exceptId) return true;
    }
    return false;
  }

  // 待っている退出通知を取り消す。取り消したものがあれば true。
  cancelLeave(cid) {
    const timer = this.leaving.get(cid);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.leaving.delete(cid);
    return true;
  }

  scheduleLeave(att) {
    const cid = att.cid || att.id;
    const id = att.id, name = att.name;   // 呼び出し元があとで att を書き換えても影響を受けないよう控える
    if (this.hasCid(cid, id)) return;   // 新しい接続が先に張られている＝つなぎ直し
    this.cancelLeave(cid);                  // close と error の両方が来ても通知は1回
    const timer = setTimeout(async () => {
      this.leaving.delete(cid);
      if (this.hasCid(cid, id)) return;
      if (this.roster.delete(cid)) await this.saveRoster();
      await this.notify(`${escapeSlack(name)}さんがスペースから退出しました。`);
    }, LEAVE_GRACE_MS);
    this.leaving.set(cid, timer);
  }

  // 配信をまとめる。全員が15回/秒で位置を送ってくるので、届くたびに全員へ配信すると
  // 人数の二乗で膨らむ。50ms まとめることで、配信は最大20回/秒に収まる。
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; this.broadcast(); }, 50);
  }

  // 全員の状態を全員へ送る。
  // avatar / away / sfu は値があるときだけ入れて、送信量を削っている。
  broadcast() {
    const users = [];
    for (const ws of this.sockets()) {
      const att = ws.deserializeAttachment();
      if (!att || !att.name) continue;
      // 位置がまだ届いていない人は載せない（左上 {0,0} にいる扱いにしない）。
      // クライアントは接続直後に位置を送るので、載らないのは一瞬だけ。
      const p = posOf(att);
      if (!p) continue;
      const user = { id: att.id, name: att.name, x: p.x, y: p.y };
      if (att.avatar) user.avatar = att.avatar;
      if (att.away) { user.away = true; if (att.awayMsg) user.awayMsg = att.awayMsg; }
      else if (att.talk && att.audioTrack) user.talk = true;
      if (att.sfuSessionId && (att.audioTrack || att.screenTrack)) {
        user.sfu = { sessionId: att.sfuSessionId };
        if (att.audioTrack) user.sfu.audio = att.audioTrack;
        if (att.screenTrack) {
          user.sfu.screen = att.screenTrack;
          user.sfu.screenSessionId = att.screenSessionId || att.sfuSessionId;   // 画面は別セッション
        }
      }
      users.push(user);
    }
    const data = JSON.stringify({ t: "state", users });
    for (const ws of this.sockets()) {
      try { ws.send(data); } catch { }
    }
  }

  // ── 転送量ガード ──
  usedGb() {
    return Math.round((this.budgetBytes / GB) * 10) / 10;
  }
  async ensureBudgetLoaded() {
    if (this.budgetLoaded) return;
    const saved = await this.ctx.storage.get("budget");
    const m = monthKey();
    if (saved && saved.month === m) {
      this.budgetBytes = saved.bytes;
      this.budgetMonth = m;
    } else {
      this.budgetBytes = 0;
      this.budgetMonth = m;
      await this.ctx.storage.put("budget", { month: m, bytes: 0 });
    }
    this.budgetLevel = levelFor(this.budgetBytes);
    this.budgetLoaded = true;
  }
  // 転送量を積む周期アラーム。接続が来るたびに呼ぶが、既に予約済みなら何もしない。
  async ensureAlarm() {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  // 60秒ごとに、いまの購読の組み合わせから転送量を推定して積む。
  // 実測ではなく推定（helpers.js の bytesPerSec）。無料枠を超えないための目安。
  //
  // 最後に、接続が残っているときだけ次を予約する。誰もいない部屋では
  // アラームが止まり、実行時間も課金されない。次の接続で ensureAlarm が起こし直す。
  async alarm() {
    try {
      await this.tick();
    } catch (e) {
      await this.logError("alarm", e);
      // 失敗しても次の周期は予約する（止まったままだと、転送量の積算も名簿の照合も止まる）
      try { if (this.sockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + 60_000); } catch { }
    }
  }

  async tick() {
    await this.ensureBudgetLoaded();
    const sockets = this.sockets();
    this.sweepStale(sockets);
    await this.reconcileRoster();

    const nowMonth = monthKey();
    if (nowMonth !== this.budgetMonth) { this.budgetMonth = nowMonth; this.budgetBytes = 0; }

    let zones = [];
    try { zones = JSON.parse((await this.env.LAYOUT_KV.get("zones")) || "[]"); } catch { }

    const users = [];
    for (const ws of sockets) {
      const att = ws.deserializeAttachment();
      if (!att || !att.name) continue;
      const p = posOf(att);
      if (!p) continue;   // 位置が分からない人は数えない
      users.push({ id: att.id, x: p.x, y: p.y, audio: !!att.audioTrack, screen: !!att.screenTrack });
    }
    // 前回からの経過時間ぶんを積む。ふだんは60秒おきだが、起動直後の照合のために早く来ることが
    // あるので、固定の60秒で積むと多く数えてしまう。長く空いた場合は1周期ぶんまでにする
    // （止まっていたあいだの通信は発生していないため）。
    const now = Date.now();
    const elapsed = this.lastTick ? Math.min(60, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    this.budgetBytes += bytesPerSec(users, zones) * elapsed;
    await this.ctx.storage.put("budget", { month: this.budgetMonth, bytes: this.budgetBytes });
    await this.ctx.storage.put("alive", now);   // 「この時刻までは動いていた」の記録（boot が止まっていた時間を測るのに使う）

    this.budgetLevel = levelFor(this.budgetBytes);
    const out = JSON.stringify({ t: "budget", level: this.budgetLevel, usedGb: this.usedGb(), limitGb: LIMIT_GB });
    for (const ws of sockets) { try { ws.send(out); } catch { } }

    // 名簿に人が残っている間は、接続が 0 でも次を予約する（照合を終えて名簿を空にするため）
    if (sockets.length > 0 || this.roster.size > 0) await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  // 応答のない接続を退出扱いにする（alarm から60秒ごと）。
  //
  // PC のスリープや回線断では、切断の通知（webSocketClose）が来ないまま接続だけが
  // 残ることがある。位置は接続に保存しているので、放っておくとアバターが残り続ける。
  // 名前を空にすると「入室前の接続」と同じ扱いになり、配信・チャット・呼び出し・
  // 転送量推定のすべてから外れる。close も送るので、相手が実は生きていれば
  // 切断を検知して自動で入り直してくる。
  sweepStale(sockets) {
    const now = Date.now();
    let changed = false;
    for (const ws of sockets) {
      const att = ws.deserializeAttachment();
      if (!att || !att.name) continue;
      if (now - (att.at || 0) < STALE_MS) continue;
      this.scheduleLeave(att);   // Slack への退出通知（戻ってくれば取り消される）
      this.retire(ws, att);
      try { ws.close(4000, "stale"); } catch { }
      changed = true;
    }
    if (changed) this.schedule();
  }

  // ── SFU 中継（App Secret は Worker/DO だけが持つ） ──
  //
  // クライアントから SFU を直接叩かせず、必ずここを通す。認可は2段階。
  //   1. x-office-token → findByToken で接続の持ち主を特定する
  //      （トークンは welcome で本人にだけ渡すので、他人は名乗れない）
  //   2. att.sessions.includes(sid) → 自分が作ったセッション以外は操作させない
  // 2 が無いと、トークンさえ持っていれば他人のセッションを閉じられてしまう。
  async handleRtc(req, url) {
    const token = req.headers.get("x-office-token") || "";
    const owner = this.findByToken(token);
    if (!owner) return json({ error: "unauthorized" }, 403);
    const { ws } = owner;
    const sessions = owner.att.sessions || [];

    const parts = url.pathname.split("/").filter(Boolean);   // ["rtc","sessions",...]

    if (req.method === "POST" && parts[1] === "sessions" && parts[2] === "new") {
      const res = await this.sfu("POST", "/sessions/new");
      const body = await res.json().catch(() => null);
      const sid = body && body.sessionId;
      if (res.ok && typeof sid === "string") {
        // 画面共有を始めるたびに1件増え、止めても減らない。
        // attachment の上限 16,384 バイトに対して1件約40バイトなので、
        // 1回の接続で400回近く共有し直さないと問題にならない。
        // 上限を設けると、先頭（音声用）を誤って追い出したときに通話が壊れるため触っていない。
        //
        // SFU の応答を待つあいだに位置や離席が更新されているので、書き戻す前に読み直す。
        // 待つ前に読んだ att をそのまま書くと、その間の変更を古い値で上書きしてしまう。
        const att = ws.deserializeAttachment() || owner.att;
        att.sessions = att.sessions || [];
        if (!att.sessions.includes(sid)) att.sessions.push(sid);
        if (!att.sfuSessionId) att.sfuSessionId = sid;   // 最初のセッション＝音声・購読用
        ws.serializeAttachment(att);
        body.ticket = await this.ticketFor(sid);   // つなぎ直しで引き継ぐための合札（checkResume）
      }
      return json(body, res.status);
    }

    if (parts[1] === "sessions" && parts[2]) {
      const sid = parts[2];
      if (!sessions.includes(sid)) return json({ error: "forbidden" }, 403);

      let bodyIn;
      try { bodyIn = await req.json(); } catch { bodyIn = undefined; }
      const action = parts[3];
      let res;
      if (req.method === "POST" && action === "tracks" && parts[4] === "new") {
        res = await this.sfu("POST", `/sessions/${sid}/tracks/new`, bodyIn);
      } else if (req.method === "PUT" && action === "renegotiate") {
        res = await this.sfu("PUT", `/sessions/${sid}/renegotiate`, bodyIn);
      } else if (req.method === "PUT" && action === "tracks" && parts[4] === "close") {
        res = await this.sfu("PUT", `/sessions/${sid}/tracks/close`, bodyIn);
      } else {
        return json({ error: "not found" }, 404);
      }
      const body = await res.json().catch(() => null);
      return json(body, res.status);
    }

    return json({ error: "not found" }, 404);
  }

  findByToken(token) {
    if (!token) return null;
    for (const ws of this.sockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.token === token) return { ws, att };
    }
    return null;
  }

  // SFU への実際のリクエスト。App Secret を持つのはここだけで、
  // クライアントには決して渡らない。
  sfu(method, path, body) {
    const url = `https://rtc.live.cloudflare.com/v1/apps/${this.env.REALTIME_APP_ID}${path}`;
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.env.REALTIME_APP_SECRET}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

// 接続に保存された位置。まだ一度も届いていなければ null。
function posOf(att) {
  return (att && Number.isFinite(att.x) && Number.isFinite(att.y)) ? { x: att.x, y: att.y } : null;
}
