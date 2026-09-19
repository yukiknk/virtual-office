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
//     id / name / token / avatar / away / SFUの各ID
//     ※ 上限 16,384 バイト。大きいものは storage へ
//   ctx.storage（部屋ごと・残る）
//     officeComments / budget ※ どちらも遅延読み込み
//   this.positions（消える）
//     全員の座標。位置は止まっていても2秒ごとに届く（public/office/net.js の
//     sendPos）ので、消えても次の pos で戻る。戻るまでのあいだ {x:0, y:0} 扱いになる
//   this.callAt（消える）
//     呼び出しの連打防止。休眠を挟むとクールダウンが実質リセットされる
//   this.scheduled / this.budget*（消えるが問題ない）
//     前者は作り直され、後者は ensureBudgetLoaded が storage から読み直す

import { GB, LIMIT_GB, NEAR, CALL_COOLDOWN_MS } from "./config.js";
import { json, cleanAvatar, cleanComment, monthKey, levelFor, zoneIdAtWorld, bytesPerSec, readWebhookUrl, escapeSlack } from "./helpers.js";

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // 以下はすべてメモリ上の値。休眠で消えることを前提に扱う（冒頭の説明を参照）。
    this.positions = new Map();   // id -> {x,y}。消えても次の pos で戻る
    this.scheduled = false;
    this.budgetBytes = 0;
    this.budgetMonth = monthKey();
    this.budgetLevel = "ok";
    this.budgetLoaded = false;
    this.comments = null;         // オフィスで作られたコメント（全員共有）。遅延読み込み
    this.callAt = new Map();      // 呼び出しの連打防止。"送信者id>相手id" -> 最後に送った時刻
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return this.handleWs(req);
    if (url.pathname.startsWith("/rtc/")) return this.handleRtc(req, url);
    if (url.pathname === "/api/refresh") { this.broadcastReload(); return new Response("ok"); }
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
    const sp = this.positions.get(att.id) || { x: 0, y: 0 };
    const sz = zoneIdAtWorld(zones, sp.x, sp.y);
    const out = JSON.stringify({ t: "chat", id: att.id, name: att.name, text });
    for (const ws of this.ctx.getWebSockets()) {
      const a2 = ws.deserializeAttachment();
      if (!a2 || !a2.name) continue;
      if (a2.id === att.id) { try { ws.send(out); } catch { } continue; }   // 送信者にも表示
      const p2 = this.positions.get(a2.id) || { x: 0, y: 0 };
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

    const me = this.positions.get(att.id);
    const you = this.positions.get(toId);
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
    // 代わりに this.positions などがメモリに残り続ける（＝常時課金される）。
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

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const att = ws.deserializeAttachment();
    if (!att) return;

    if (msg.t === "hello") {
      await this.ensureBudgetLoaded();
      att.name = String(msg.name || "名無し").slice(0, 20);
      att.avatar = cleanAvatar(msg.avatar);
      ws.serializeAttachment(att);
      ws.send(JSON.stringify({
        t: "welcome", id: att.id, token: att.token,
        budget: { level: this.budgetLevel, usedGb: this.usedGb(), limitGb: LIMIT_GB },
      }));
      await this.ensureComments();
      ws.send(JSON.stringify({ t: "comments", list: this.comments }));   // 入室時に現在のコメントを送る
      this.schedule();
      await this.notify(`${escapeSlack(att.name)}さんがスペースに入室しました。`);
    } else if (msg.t === "comment_add") {
      await this.ensureComments();
      const c = cleanComment(msg.comment);
      if (c) {
        const idx = this.comments.findIndex((x) => x.id === c.id);
        if (idx >= 0) this.comments[idx] = c;                   // 同idは置き換え（移動・更新）
        else if (this.comments.length < 200) this.comments.push(c);
        else return;   // 200件を超えたら黙って捨てる（送った側にエラーは返らない）
        await this.ctx.storage.put("officeComments", this.comments);
        this.broadcastComments();
      }
    } else if (msg.t === "comment_remove") {
      await this.ensureComments();
      const before = this.comments.length;
      this.comments = this.comments.filter((c) => c.id !== msg.id);
      if (this.comments.length !== before) {
        await this.ctx.storage.put("officeComments", this.comments);
        this.broadcastComments();
      }
    } else if (msg.t === "chat") {
      // 送信者と同じ会話エリア内、またはエリア外なら近接の人だけに配信（保存はしない）
      const text = String(msg.text || "").slice(0, 500).trim();
      if (text) await this.relayChat(att, text);
    } else if (msg.t === "call") {
      this.relayCall(ws, att, msg.to);
    } else if (msg.t === "away") {
      const next = !!msg.away;
      const changed = next !== !!att.away;   // 同じ状態の送り直しでは通知しない
      att.away = next;
      att.awayMsg = att.away ? String(msg.msg || "").slice(0, 100) : "";
      ws.serializeAttachment(att);
      this.schedule();   // 離席状態を全員へ配信
      if (changed && att.name) {
        await this.notify(`${escapeSlack(att.name)}さんが${next ? "離席" : "着席"}しました。`);
      }
    } else if (msg.t === "pos") {
      this.positions.set(att.id, { x: Number(msg.x) || 0, y: Number(msg.y) || 0 });
      this.schedule();
    } else if (msg.t === "publish") {
      if (typeof msg.sessionId === "string") att.sfuSessionId = msg.sessionId;
      if (typeof msg.audio === "string") att.audioTrack = msg.audio;
      if (typeof msg.screen === "string") att.screenTrack = msg.screen;
      if (typeof msg.screenSessionId === "string") att.screenSessionId = msg.screenSessionId;
      ws.serializeAttachment(att);
      this.schedule();
    } else if (msg.t === "unpublish") {
      if (msg.kind === "screen") { att.screenTrack = undefined; att.screenSessionId = undefined; }
      else if (msg.kind === "audio") att.audioTrack = undefined;
      else { att.audioTrack = undefined; att.screenTrack = undefined; att.screenSessionId = undefined; }
      ws.serializeAttachment(att);
      this.schedule();
    }
  }

  async webSocketClose(ws) { await this.drop(ws); }
  async webSocketError(ws) { await this.drop(ws); }
  async drop(ws) {
    const att = ws.deserializeAttachment();
    if (att) this.positions.delete(att.id);
    this.schedule();
    // 名前が無い＝入室前に切れた接続なので通知しない
    if (att && att.name) {
      await this.notify(`${escapeSlack(att.name)}さんがスペースから退出しました。`);
    }
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
      const p = this.positions.get(att.id) || { x: 0, y: 0 };
      const user = { id: att.id, name: att.name, x: p.x, y: p.y };
      if (att.avatar) user.avatar = att.avatar;
      if (att.away) { user.away = true; if (att.awayMsg) user.awayMsg = att.awayMsg; }
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

    const nowMonth = monthKey();
    if (nowMonth !== this.budgetMonth) { this.budgetMonth = nowMonth; this.budgetBytes = 0; }

    let zones = [];
    try { zones = JSON.parse((await this.env.LAYOUT_KV.get("zones")) || "[]"); } catch { }

    const users = [];
    for (const ws of sockets) {
      const att = ws.deserializeAttachment();
      if (!att || !att.name) continue;
      const p = this.positions.get(att.id) || { x: 0, y: 0 };
      users.push({ id: att.id, x: p.x, y: p.y, audio: !!att.audioTrack, screen: !!att.screenTrack });
    }
    this.budgetBytes += bytesPerSec(users, zones) * 60;   // 60秒ぶん積算
    await this.ctx.storage.put("budget", { month: this.budgetMonth, bytes: this.budgetBytes });

    this.budgetLevel = levelFor(this.budgetBytes);
    const out = JSON.stringify({ t: "budget", level: this.budgetLevel, usedGb: this.usedGb(), limitGb: LIMIT_GB });
    for (const ws of sockets) { try { ws.send(out); } catch { } }

    if (sockets.length > 0) await this.ctx.storage.setAlarm(Date.now() + 60_000);
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
    const { ws, att } = owner;

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
        att.sessions = att.sessions || [];
        if (!att.sessions.includes(sid)) att.sessions.push(sid);
        if (!att.sfuSessionId) att.sfuSessionId = sid;   // 最初のセッション＝音声・購読用
        ws.serializeAttachment(att);
      }
      return json(body, res.status);
    }

    if (parts[1] === "sessions" && parts[2]) {
      const sid = parts[2];
      if (!(att.sessions || []).includes(sid)) return json({ error: "forbidden" }, 403);

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
