// 本番の KV（レイアウト・会話エリア・家具・看板）をベータの KV へコピーする。
//
// 使い方（プロジェクト直下で）:
//   npm run kv:copy-to-beta              … 実際にコピーする
//   npm run kv:copy-to-beta -- --dry-run … 取得だけして中身を確認する（書き込まない）
//
// 名前空間 id は wrangler.jsonc から自動で読み取る。
//   コピー元 = トップレベル（本番）の LAYOUT_KV
//   コピー先 = env.beta の LAYOUT_KV
// 明示したい場合は --from <id> / --to <id> を付ける。
//
// 注意: コピー先を上書きする。ベータ側で編集した内容は消える。

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const KEYS = ["layout", "zones", "furniture", "comments"];
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
	console.error(`エラー: ${msg}`);
	process.exit(1);
}

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
if (TO.includes("PASTE_")) fail("env.beta の KV id がひな形のままです。先に `npm run kv:create-beta` を実行してください。");
if (FROM === TO) fail("コピー元とコピー先が同じ id です。中止します。");

// ── wrangler の起動 ──
// npx 経由にすると Windows では npx.cmd になり、Node が shell なしの .cmd 起動を
// 拒否する（CVE-2024-27980 対応）ため失敗する。node_modules の wrangler.js を
// Node で直接実行して回避する。
const WRANGLER_JS = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
if (!existsSync(WRANGLER_JS)) {
	fail(`wrangler が見つかりません: ${WRANGLER_JS}\n      先に \`npm install\` を実行してください。`);
}

function wrangler(args) {
	return execFileSync(process.execPath, [WRANGLER_JS, ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});
}

// エラーの種類を見分ける。キーが無いだけなら続行、それ以外は中止する。
function isKeyNotFound(err) {
	const s = `${err.stderr || ""}${err.stdout || ""}`.toLowerCase();
	return s.includes("key not found") || s.includes("not found") && s.includes("key");
}
function reportAndExit(label, err) {
	console.error(`\nエラー: ${label} に失敗しました（終了コード ${err.status ?? "不明"}）`);
	const detail = (err.stderr || err.stdout || err.message || "").trim();
	if (detail) console.error(detail.split("\n").map((l) => `      ${l}`).join("\n"));
	process.exit(1);
}

// wrangler の出力にバナー等が混ざっても JSON 部分だけを取り出す
function extractJson(text) {
	const t = text.trim();
	try { return { value: JSON.parse(t), text: t }; } catch { }
	const idx = [t.indexOf("["), t.indexOf("{")].filter((n) => n >= 0);
	if (idx.length) {
		const sliced = t.slice(Math.min(...idx));
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
		if (isKeyNotFound(e)) {
			console.log(`  - ${key}: 本番にこのキーがありません（スキップ）`);
			skipped++;
			continue;
		}
		reportAndExit(`${key} の取得`, e);
	}

	const parsed = extractJson(raw);
	if (!parsed) {
		console.error(`\nエラー: ${key} の値を JSON として読めませんでした。wrangler の出力:\n${raw}`);
		process.exit(1);
	}

	const count = Array.isArray(parsed.value) ? `${parsed.value.length} 件` : "オブジェクト";
	if (dryRun) {
		console.log(`  - ${key}: ${count}（${parsed.text.length} バイト）… dry-run のため書き込みません`);
		continue;
	}

	const file = join(tmp, `${key}.json`);
	writeFileSync(file, parsed.text);
	try {
		wrangler(["kv", "key", "put", key, "--namespace-id", TO, "--remote", "--path", file]);
	} catch (e) {
		reportAndExit(`${key} の書き込み`, e);
	}
	console.log(`  - ${key}: ${count} をコピーしました`);
	copied++;
}

console.log(`\n完了: ${copied} 件コピー / ${skipped} 件スキップ`);
if (!dryRun && copied > 0) console.log("ベータのオフィスを開いて、レイアウトが表示されるか確認してください。");
