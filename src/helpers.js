// 状態を持たない純粋関数のまとめ（レスポンス生成・入力検証・転送量推定など）。
// ここに置く関数は env も this も参照しない。テストしたくなったらここから。

import { talkGroupKeys } from "../public/talk.js";
import { GB, AUDIO_BPS, SCREEN_BPS, SCREEN_OFF_GB, VOICE_OFF_GB, SLACK_WEBHOOK_PREFIX, WORLD_W, WORLD_H } from "./config.js";

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

// オフィスコメントの受信データを検証・整形する（不正値や巨大文字列を防ぐ）。
//
// 受け取った値は必ずここを通す。クライアントは誰でも書き換えられるので、
// 描画側（public/map.js）が想定しない値（負の大きさなど）を入れさせない。
//
// w の上限がワールド幅なので、x が大きいと右へはみ出す矩形は作れる。
// はみ出した分はキャンバス外で捨てられるだけなので、そこまでは詰めていない。
export function cleanComment(c) {
  if (!c || typeof c !== "object") return null;
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const hex = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  const runs = cleanRuns(c.runs);
  return {
    id: (String(c.id || "").slice(0, 16)) || crypto.randomUUID().slice(0, 8),
    x: Math.max(0, Math.min(WORLD_W, num(c.x, 0))),
    y: Math.max(0, Math.min(WORLD_H, num(c.y, 0))),
    w: Math.max(16, Math.min(WORLD_W, num(c.w, 128))),
    h: Math.max(16, Math.min(WORLD_H, num(c.h, 64))),
    // runs があれば text はそこから作る（別々に送られてきた値を信用しない）
    text: runs ? runs.map((r) => r.t).join("") : String(c.text || "").slice(0, 300),
    ...(runs ? { runs } : {}),
    size: Math.max(8, Math.min(48, num(c.size, 16))),
    color: hex(c.color, "#141815"),
    bg: hex(c.bg, "#ffffff"),
    bold: !!c.bold,
    italic: !!c.italic,
    align: c.align === "left" || c.align === "right" ? c.align : "center",   // 文字の揃え（public/richtext.js）
    expireAt: Number.isFinite(+c.expireAt) ? Math.floor(+c.expireAt) : null,   // 消える日時（ms）。無ければ null
  };
}

// 部分ごとの装飾（public/richtext.js の runs）を検証する。使えるものが無ければ null。
//
// 文字数は全体で 300 まで（装飾なしの看板と同じ上限）。run の数にも上限を設けるのは、
// 1文字ずつ別の装飾にされると、文字数のわりに保存するデータが膨らむため。
function cleanRuns(list) {
  if (!Array.isArray(list)) return null;
  const hex = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
  const out = [];
  let left = 300;
  for (const r of list) {
    if (out.length >= 150 || left <= 0) break;
    if (!r || typeof r !== "object") continue;
    const t = String(r.t ?? "").slice(0, left);
    if (!t) continue;
    left -= t.length;
    const o = { t };
    if (r.b) o.b = 1;
    if (r.i) o.i = 1;
    if (r.u) o.u = 1;
    if (hex(r.c)) o.c = r.c;
    if (hex(r.m)) o.m = r.m;
    if (Number.isFinite(+r.s)) o.s = Math.max(8, Math.min(48, Math.round(+r.s)));
    out.push(o);
  }
  return out.length ? out : null;
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

// 点がどの会話エリアにあるか（id または null）。
//
// public/office/store.js の zoneIdAt と同じ処理を、サーバー側にも持っている
// （後ろから探す＝手前が勝つ／右端と下端は含めない）。サーバーからは public/ を
// import できないための二重実装。片方だけ変えると「画面では会話エリアの中にいるのに
// チャットが届かない」という気づきにくいずれ方をする。
export function zoneIdAtWorld(zones, x, y) {
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.id;
  }
  return null;
}

// 現在の購読グラフから 1秒あたりの下り転送量（バイト）を推定する。
//
// 「誰が誰の音声・画面を受け取っているか」を全員ぶん数え上げる。判定の条件は
// public/office/voice.js の currentTargets と同じ（public/talk.js）。
//
// 全員×全員の二重ループなので、人数が増えたときに最初に重くなるのはここ。
// 部屋が1つで人数が限られる前提で、そのまま書いてある。
export function bytesPerSec(users, zones) {
  let bps = 0;
  const keys = talkGroupKeys(users, (x, y) => zoneIdAtWorld(zones, x, y));   // 同じ会話かどうか（public/talk.js）
  for (const L of users) {
    for (const P of users) {
      if (P.id === L.id) continue;
      if (keys.get(P.id) !== keys.get(L.id)) continue;
      // config.js の値はビット毎秒なので、8で割ってバイト毎秒にする
      if (P.audio) bps += AUDIO_BPS / 8;
      if (P.screen) bps += SCREEN_BPS / 8;
    }
  }
  return bps;
}
