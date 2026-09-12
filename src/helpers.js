// 状態を持たない純粋関数のまとめ（レスポンス生成・入力検証・転送量推定など）

import { GB, AUDIO_BPS, SCREEN_BPS, SCREEN_OFF_GB, VOICE_OFF_GB, NEAR, SLACK_WEBHOOK_PREFIX } from "./config.js";

// JSON レスポンスを作る
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// アバター設定（レイヤー→ファイル名）を検証。値はファイル名か null のみ。
export function cleanAvatar(a) {
  if (!a || typeof a !== "object") return null;
  const keys = ["head", "hair", "body", "tops", "bottoms", "shoes", "wings", "accessory"];
  const out = {};
  for (const k of keys) {
    const v = a[k];
    out[k] = (typeof v === "string" && /^[\w.\-]+\.png$/.test(v)) ? v : null;
  }
  return out;
}

// オフィスコメントの受信データを検証・整形する（不正値や巨大文字列を防ぐ）
export function cleanComment(c) {
  if (!c || typeof c !== "object") return null;
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  return {
    id: (String(c.id || "").slice(0, 16)) || crypto.randomUUID().slice(0, 8),
    x: Math.max(0, Math.min(1600, num(c.x, 0))),
    y: Math.max(0, Math.min(960, num(c.y, 0))),
    w: Math.max(16, Math.min(1600, num(c.w, 128))),
    h: Math.max(16, Math.min(960, num(c.h, 64))),
    text: String(c.text || "").slice(0, 300),
    size: Math.max(8, Math.min(48, num(c.size, 16))),
    color: hex(c.color, "#141815"),
    bg: hex(c.bg, "#ffffff"),
    bold: !!c.bold,
    italic: !!c.italic,
    expireAt: Number.isFinite(+c.expireAt) ? Math.floor(+c.expireAt) : null,   // 消える日時（ms）。無ければ null
  };
}

// ── Slack 通知 ──

// KV から Webhook URL を取り出す。未登録・壊れたデータ・想定外のホストなら空文字。
// 保存時にも接頭辞を検査しているが、KV を直接書き換えられた場合に備えて読み出し側でも見る。
export async function readWebhookUrl(env) {
  try {
    const raw = await env.LAYOUT_KV.get("webhook");
    if (!raw) return "";
    const u = String(JSON.parse(raw).url || "");
    return u.startsWith(SLACK_WEBHOOK_PREFIX) ? u : "";
  } catch { return ""; }
}

// Slack の text に入れる文字列を無害化する。
// 氏名は利用者が自由に入力できるため、そのまま入れると <!channel> のような
// 制御記法が効いてしまう。Slack の仕様どおり & < > だけを実体参照に置き換える。
export function escapeSlack(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 月キー（UTC。転送量の月替わり判定に使う）
export function monthKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// 積算した転送量から停止レベルを決める
export function levelFor(bytes) {
  const gb = bytes / GB;
  if (gb >= VOICE_OFF_GB) return "voice_off";
  if (gb >= SCREEN_OFF_GB) return "screen_off";
  return "ok";
}

// 点がどの会話エリアにあるか（id または null）
export function zoneIdAtWorld(zones, x, y) {
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.id;
  }
  return null;
}

// 現在の購読グラフから 1秒あたりの下り転送量（バイト）を推定
export function bytesPerSec(users, zones) {
  let bps = 0;
  for (const L of users) {
    const lz = zoneIdAtWorld(zones, L.x, L.y);
    for (const P of users) {
      if (P.id === L.id) continue;
      const pz = zoneIdAtWorld(zones, P.x, P.y);
      let sub;
      if (lz) sub = (pz === lz);                                   // エリア内：同じエリア
      else sub = (pz === null && Math.hypot(P.x - L.x, P.y - L.y) <= NEAR);  // エリア外：近接
      if (!sub) continue;
      if (P.audio) bps += AUDIO_BPS / 8;
      if (P.screen) bps += SCREEN_BPS / 8;
    }
  }
  return bps;
}
