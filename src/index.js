// Worker のエントリ：HTTP ルーティングだけを担当する。
// - WebSocket / SFU中継 / 反映通知 → 部屋（Durable Object）へ委譲
// - レイアウト等の保存・取得 → KV
// 部屋の本体は room.js、共有の定数は config.js、純粋関数は helpers.js にある。
//
// 【未実装】管理者ページ（/admin.html）と POST /api/* に認証が無い。
// URL を知っていれば誰でもレイアウト・家具・看板・Slack通知先を書き換えられる。
// 社内限定での利用を前提にした暫定状態で、ID/パスワードによる認証は別途入れる予定。
// Webhook URL だけは、登録できる接頭辞を絞ることで踏み台化を防いである（config.js）。

import { Room } from "./room.js";
import { json, readWebhookUrl } from "./helpers.js";
import { SLACK_WEBHOOK_PREFIX } from "./config.js";

// Durable Object クラスはエントリから公開する必要がある（wrangler.jsonc の class_name: "Room"）
export { Room };

// KV に JSON をそのまま読み書きするエンドポイント（GET=取得 / POST=保存）。
// 中身の形は見ない（レイアウトも家具も看板も、そのまま預かって返すだけ）。
// 対応しないメソッドは null を返し、呼び出し側で 404 に落とす。
async function kvEndpoint(env, key, req) {
  if (req.method === "GET") {
    const data = await env.LAYOUT_KV.get(key);
    return new Response(data || "[]", { headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "POST") {
    const body = await req.text();
    // 形は見ないが、JSON として読めることと大きさだけは確かめる。
    // 認証の代わりにはならないが、壊れた値が保存されて気づけなくなるのは防げる。
    // （保存できてしまうと GET がそれを返し、クライアントは握りつぶすので表に出ない）
    if (body.length > 1_000_000) return json({ error: "データが大きすぎます" }, 413);
    try { JSON.parse(body); } catch { return json({ error: "JSON として読めませんでした" }, 400); }
    await env.LAYOUT_KV.put(key, body);
    return new Response("ok");
  }
  return null;
}

// Slack 通知先の Webhook URL（KV キー "webhook"）。
// この URL は「知っていれば誰でもそのチャンネルに投稿できる」認証情報なので、
// GET では URL 本体を返さず、設定済みかどうかと末尾数文字だけを返す。
// POST は Slack の Incoming Webhook 以外を弾く（Worker を踏み台にした
// 任意ホストへの POST を防ぐため）。空文字を送ると登録解除。
async function webhookEndpoint(env, req) {
  if (req.method === "GET") {
    const url = await readWebhookUrl(env);
    return json({ configured: !!url, hint: url ? `…${url.slice(-8)}` : "" });
  }
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "JSON として読めませんでした" }, 400); }
    const u = String((body && body.url) || "").trim();
    if (!u) {
      await env.LAYOUT_KV.delete("webhook");
      return json({ configured: false });
    }
    if (!u.startsWith(SLACK_WEBHOOK_PREFIX) || u.length > 300) {
      return json({ error: `${SLACK_WEBHOOK_PREFIX} で始まる URL のみ登録できます` }, 400);
    }
    await env.LAYOUT_KV.put("webhook", JSON.stringify({ url: u }));
    return json({ configured: true, hint: `…${u.slice(-8)}` });
  }
  return null;
}

// パス → KV キーの対応（レイアウト・会話エリア・家具・コメント）
const KV_ENDPOINTS = {
  "/api/layout": "layout",
  "/api/zones": "zones",
  "/api/furniture": "furniture",
  "/api/comments": "comments",
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // 以下は上から順に試し、どれにも当たらなければ 404。
    // 静的ファイル（public/ 以下）はここに来る前に assets 設定が返している。

    // WebSocket・SFU中継・反映通知は部屋（Durable Object）へ渡す
    if (url.pathname === "/ws" || url.pathname.startsWith("/rtc/") || url.pathname === "/api/refresh" || url.pathname === "/api/client-errors" || url.pathname === "/api/server-log") {
      const id = env.ROOM.idFromName("main");   // 部屋は1つ（全員同じ）
      return env.ROOM.get(id).fetch(req);
    }

    // Slack 通知先の設定（KV。読み出しは URL を伏せる）
    if (url.pathname === "/api/webhook") {
      const res = await webhookEndpoint(env, req);
      if (res) return res;
    }

    // レイアウト・会話エリア・家具・コメントの各API（KV）
    const kvKey = KV_ENDPOINTS[url.pathname];
    if (kvKey) {
      const res = await kvEndpoint(env, kvKey, req);
      if (res) return res;
    }

    // 本番のマップをこのサイトへ写す（ベータだけ。本番への接続 PROD があるときだけ動く）。
    // 毎日の自動の同期（scheduled）を待たずに、すぐ写したいとき用
    if (url.pathname === "/api/sync-from-prod" && req.method === "POST" && env.PROD) {
      return json(await syncFromProd(env));
    }
    if (url.pathname === "/api/sync-from-prod" && req.method === "GET" && env.PROD) {
      return json(JSON.parse((await env.LAYOUT_KV.get("lastSync")) || "null"));   // 前回の同期の結果
    }

    // 組織固有の表示設定。ファイルがあればアセットとして配信されるのでここには来ない。
    // 公開リポジトリを clone した環境など、無い場合に空を返して 404 を避ける。
    if (url.pathname === "/config.local.js") {
      return new Response("", { headers: { "Content-Type": "application/javascript" } });
    }

    return new Response("Not found", { status: 404 });
  },

  // 決まった時刻に動く（wrangler.jsonc の env.beta の triggers）。ベータに本番のマップを写す
  async scheduled(event, env, ctx) {
    if (env.PROD) ctx.waitUntil(syncFromProd(env));
  },
};

// ── 本番のマップをベータへ写す ──
//
// ベータを、試す場所であると同時に、本番のマップの控えにもするためのもの。
// 本番の API（/api/layout など。管理者ページが読むのと同じ）から読み、このサイトの KV に書く。
// 写すのはマップの4つ（レイアウト・会話エリア・家具・管理者の看板）だけ。Slack の通知先は写さない
// （ベータから本番のチャンネルへ通知が流れないように）。
//
// 本番へは、サービスバインディング PROD（wrangler.jsonc の env.beta の services）でつなぐ。
// 同じアカウントの Worker どうしを直接つなぐ仕組みで、URL は要らない（同じアカウントの workers.dev の
// URL を fetch すると断られることがあるため、こちらにしている）。本番には PROD を置かないので、本番では動かない。
// 本番に対しては読み出し（GET）しかしない。
//
// 本番の値が空（[]）なのにベータに中身がある場合は、そのキーは写さない。本番のマップを
// 誤って消してしまったときに、控えまで消えないようにするため。
const SYNC_KEYS = ["layout", "zones", "furniture", "comments"];
async function syncFromProd(env) {
  const result = { at: new Date().toISOString(), keys: {} };
  let changed = false;
  for (const key of SYNC_KEYS) {
    try {
      const res = await env.PROD.fetch(`https://prod/api/${key}`);
      if (!res.ok) { result.keys[key] = `失敗（${res.status}）`; continue; }
      const text = await res.text();
      const value = JSON.parse(text);
      const current = (await env.LAYOUT_KV.get(key)) || "[]";
      if (Array.isArray(value) && value.length === 0 && current !== "[]") { result.keys[key] = "本番が空なので写さない"; continue; }
      if (text === current) { result.keys[key] = "変化なし"; continue; }
      await env.LAYOUT_KV.put(key, text);
      result.keys[key] = Array.isArray(value) ? `${value.length} 件を写した` : "写した";
      changed = true;
    } catch (e) {
      result.keys[key] = `失敗（${String(e && e.message || e).slice(0, 100)}）`;
    }
  }
  // 開いている画面があれば読み直させる（管理者ページの「反映」と同じ）
  if (changed) {
    try { await env.ROOM.get(env.ROOM.idFromName("main")).fetch("https://room/api/refresh"); } catch { }
  }
  await env.LAYOUT_KV.put("lastSync", JSON.stringify(result));
  console.log("[sync]", JSON.stringify(result));
  return result;
}
