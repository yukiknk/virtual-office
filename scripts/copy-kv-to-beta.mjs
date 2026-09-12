// 本番の KV（レイアウト・会話エリア・家具・看板）をベータの KV へコピーする。
//
// 使い方（プロジェクト直下で）:
//   npm run kv:copy-to-beta            … 実際にコピーする
//   npm run kv:copy-to-beta -- --dry-run … 取得だけして中身を確認する（書き込まない）
//
// 名前空間 id は wrangler.jsonc から自動で読み取ります。
//   コピー元 = トップレベル（本番）の LAYOUT_KV
//   コピー先 = env.beta の LAYOUT_KV
// 明示したい場合は --from <id> / --to <id> を付けてください。
//
// 注意: コピー先を上書きします。ベータ側で編集した内容は消えます。

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const KEYS = ["layout", "zones", "furniture", "comments"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 引数 ──
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const dryRun = argv.includes("--dry-run");

// ── wrangler.jsonc から名前空間 id を読む（コメントを除去して JSON として解釈） ──
function stripJsonc(text) {
  let out = "";
  let inStr = false, esc = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

const cfg = JSON.parse(stripJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
const pick = (obj) => (obj?.kv_namespaces || []).find((n) => n.binding === "LAYOUT_KV")?.id || null;

const FROM = flag("--from") || pick(cfg);
const TO = flag("--to") || pick(cfg.env?.beta);

if (!FROM) fail("コピー元の KV 名前空間 id が見つかりません（wrangler.jsonc のトップレベル）");
if (!TO) fail("コピー先の KV 名前空間 id が見つかりません（wrangler.jsonc の env.beta）");
if (TO.includes("PASTE_")) fail("env.beta の KV id がひな形のままです。先に `npm run kv:create-beta` を実行し、出力された id を wrangler.jsonc に貼り付けてください。");
if (FROM === TO) fail("コピー元とコピー先が同じ id です。中止します。");

function fail(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
function wrangler(args) {
  return execFileSync(npx, ["wrangler", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// wrangler の出力にバナー等が混ざっても JSON 部分だけを取り出す
function extractJson(text) {
  const t = text.trim();
  try { return { value: JSON.parse(t), text: t }; } catch { }
  const i = Math.min(...[t.indexOf("["), t.indexOf("{")].filter((n) => n >= 0));
  if (Number.isFinite(i)) {
    const sliced = t.slice(i);
    try { return { value: JSON.parse(sliced), text: sliced }; } catch { }
  }
  return null;
}

console.log(`コピー元 (本番): ${FROM}`);
console.log(`コピー先 (beta): ${TO}`);
console.log(dryRun ? "モード: dry-run（書き込みません）\n" : "モード: 実行\n");

const tmp = mkdtempSync(join(tmpdir(), "vo-kv-"));
let copied = 0, skipped = 0;

for (const key of KEYS) {
  let raw;
  try {
    raw = wrangler(["kv", "key", "get", key, "--namespace-id", FROM, "--remote", "--text"]);
  } catch (e) {
    console.log(`  - ${key}: 本番に値がありません（スキップ）`);
    skipped++;
    continue;
  }

  const parsed = extractJson(raw);
  if (!parsed) {
    console.error(`  - ${key}: JSON として読めませんでした。wrangler の出力:\n${raw}`);
    skipped++;
    continue;
  }

  const count = Array.isArray(parsed.value) ? `${parsed.value.length} 件` : "オブジェクト";
  if (dryRun) {
    console.log(`  - ${key}: ${count}（${parsed.text.length} バイト）… dry-run のため書き込みません`);
    continue;
  }

  const file = join(tmp, `${key}.json`);
  writeFileSync(file, parsed.text);
  wrangler(["kv", "key", "put", key, "--namespace-id", TO, "--remote", "--path", file]);
  console.log(`  - ${key}: ${count} をコピーしました`);
  copied++;
}

console.log(`\n完了: ${copied} 件コピー / ${skipped} 件スキップ`);
if (!dryRun) console.log("ベータのオフィスを開いて、レイアウトが表示されるか確認してください。");
