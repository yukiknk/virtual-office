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

import { GB, LIMIT_GB, NEAR, CALL_COOLDOWN_MS, LEAVE_GRACE_MS, STALE_MS } from "./config.js";
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
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return this.handleWs(req);
    if (url.pathname.startsWith("/rtc/")) return this.handleRtc(req, url);
    if (url.pathname === "/api/refresh") { this.broadcastReload(); return new Response("ok"); }
    if (url.pathname === "/api/client-errors") return json((await this.ctx.storage.get("clientErrors")) || []);
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
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(data); } catch { } }
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
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(data); } catch { } }
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
    for (const ws of this.ctx.getWebSockets()) {
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
    for (const w of this.ctx.getWebSockets()) {
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
    // つなぎ直しか：退出通知を待っている最中、または同じ cid の古い接続がまだ残っている
    const rejoin = this.cancelLeave(att.cid) | this.hasCid(att.cid, att.id);
    ws.serializeAttachment(att);
    ws.send(JSON.stringify({
      t: "welcome", id: att.id, token: att.token,
      budget: { level: this.budgetLevel, usedGb: this.usedGb(), limitGb: LIMIT_GB },
    }));
    await this.ensureComments();
    ws.send(JSON.stringify({ t: "comments", list: this.comments }));   // 入室時に現在のコメントを送る
    this.schedule();
    if (first && !rejoin) await this.notify(`${escapeSlack(att.name)}さんがスペースに入室しました。`);
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
    this.schedule();
    // 名前が無い＝入室前に切れた接続なので通知しない
    if (att && att.name) this.scheduleLeave(att);
  }

  // ── 退出の通知（再接続なら出さない） ──
  //
  // 接続が切れた時点では、退出なのか一時的な切断なのか区別できない。
  // LEAVE_GRACE_MS だけ待ち、同じ cid が戻ってこなければ退出として通知する。
  // そのぶん、本当の退出の通知も同じ時間だけ遅れる。

  // 同じ cid の（入室済みの）接続が、exceptId 以外にあるか
  hasCid(cid, exceptId) {
    for (const w of this.ctx.getWebSockets()) {
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
    for (const ws of this.ctx.getWebSockets()) {
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
    for (const ws of this.ctx.getWebSockets()) {
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
    await this.ensureBudgetLoaded();
    const sockets = this.ctx.getWebSockets();
    this.sweepStale(sockets);

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
    this.budgetBytes += bytesPerSec(users, zones) * 60;   // 60秒ぶん積算
    await this.ctx.storage.put("budget", { month: this.budgetMonth, bytes: this.budgetBytes });

    this.budgetLevel = levelFor(this.budgetBytes);
    const out = JSON.stringify({ t: "budget", level: this.budgetLevel, usedGb: this.usedGb(), limitGb: LIMIT_GB });
    for (const ws of sockets) { try { ws.send(out); } catch { } }

    if (sockets.length > 0) await this.ctx.storage.setAlarm(Date.now() + 60_000);
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
      att.name = "";
      att.audioTrack = att.screenTrack = att.screenSessionId = undefined;
      ws.serializeAttachment(att);
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
    for (const ws of this.ctx.getWebSockets()) {
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
