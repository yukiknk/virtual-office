// Worker のエントリ：HTTP ルーティングだけを担当する。
// - WebSocket / SFU中継 / 反映通知 → 部屋（Durable Object）へ委譲
// - レイアウト等の保存・取得 → KV
// 部屋の本体は room.js、共有の定数は config.js、純粋関数は helpers.js にある。

import { Room } from "./room.js";
import { json, readWebhookUrl } from "./helpers.js";
import { SLACK_WEBHOOK_PREFIX } from "./config.js";

// Durable Object クラスはエントリから公開する必要がある（wrangler.jsonc の class_name: "Room"）
export { Room };

// KV に JSON をそのまま読み書きするエンドポイント（GET=取得 / POST=保存）。
// 対応しないメソッドは null を返し、呼び出し側で 404 に落とす。
async function kvEndpoint(env, key, req) {
  if (req.method === "GET") {
    const data = await env.LAYOUT_KV.get(key);
    return new Response(data || "[]", { headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "POST") {
    const body = await req.text();
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

    // WebSocket・SFU中継・反映通知は部屋（Durable Object）へ渡す
    if (url.pathname === "/ws" || url.pathname.startsWith("/rtc/") || url.pathname === "/api/refresh") {
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

    // 組織固有の表示設定。ファイルがあればアセットとして配信されるのでここには来ない。
    // 公開リポジトリを clone した環境など、無い場合に空を返して 404 を避ける。
    if (url.pathname === "/config.local.js") {
      return new Response("", { headers: { "Content-Type": "application/javascript" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
