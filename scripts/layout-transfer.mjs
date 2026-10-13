// オフィスのレイアウト（レイアウト・会話エリア・家具・管理者の看板）を、サイトの API を通して
// 書き出す／書き込む。Cloudflare のアカウントをまたいで移すとき（MIGRATION.md）に使う。
//
// 使い方（プロジェクト直下で）:
//   npm run layout:export -- https://旧サイト            … layout-backup-日付/ に4つの JSON を保存する
//   npm run layout:import -- https://新サイト <フォルダ>  … そのフォルダの JSON を新サイトへ書き込む
//   npm run layout:import -- https://新サイト <フォルダ> --dry-run … 書き込まずに中身だけ確認する
//
// wrangler やアカウントのログインは要らない。読み書きは管理者ページと同じ API（/api/layout など）。
// Slack の通知先（/api/webhook）は、API が URL を返さない作りなので移せない。新サイトの管理者ページで登録し直す。
// オフィスで作った看板と転送量は、部屋（Durable Object）の中にあるので移らない。
//
// 注意: import は書き込み先の内容を上書きする。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const KEYS = ["layout", "zones", "furniture", "comments"];
const [mode, site, dirArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");

function fail(msg) {
	console.error(`エラー: ${msg}`);
	process.exit(1);
}
function base(url) {
	if (!url || !/^https?:\/\//.test(url)) fail("サイトの URL（https:// から）を指定してください。");
	return url.replace(/\/+$/, "");
}
const count = (v) => (Array.isArray(v) ? `${v.length} 件` : "オブジェクト");

if (mode === "export") {
	const from = base(site);
	const d = new Date();
	const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
	const dir = dirArg || `layout-backup-${stamp}`;
	mkdirSync(dir, { recursive: true });
	console.log(`書き出し元: ${from}\n保存先: ${dir}\n`);
	for (const key of KEYS) {
		const res = await fetch(`${from}/api/${key}`);
		if (!res.ok) fail(`${key} の取得に失敗しました（${res.status}）`);
		const text = await res.text();
		let value;
		try { value = JSON.parse(text); } catch { fail(`${key} の中身を JSON として読めませんでした`); }
		writeFileSync(join(dir, `${key}.json`), text);
		console.log(`  - ${key}: ${count(value)}（${text.length} バイト）`);
	}
	console.log(`\n完了。このフォルダを import で使います。`);
} else if (mode === "import") {
	const to = base(site);
	if (!dirArg) fail("書き込むフォルダ（export で作ったもの）を指定してください。");
	if (!existsSync(dirArg)) fail(`フォルダが見つかりません: ${dirArg}`);
	console.log(`書き込み先: ${to}\n読み込むフォルダ: ${dirArg}\n${dryRun ? "モード: dry-run（書き込みません）" : "モード: 実行"}\n`);
	for (const key of KEYS) {
		const file = join(dirArg, `${key}.json`);
		if (!existsSync(file)) { console.log(`  - ${key}: ファイルがありません（スキップ）`); continue; }
		const text = readFileSync(file, "utf8");
		let value;
		try { value = JSON.parse(text); } catch { fail(`${file} を JSON として読めませんでした`); }
		if (dryRun) { console.log(`  - ${key}: ${count(value)} … dry-run のため書き込みません`); continue; }
		const res = await fetch(`${to}/api/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
		if (!res.ok) fail(`${key} の書き込みに失敗しました（${res.status}）: ${await res.text()}`);
		console.log(`  - ${key}: ${count(value)} を書き込みました`);
	}
	if (!dryRun) {
		// 開いている画面があれば読み直させる（管理者ページの「反映」と同じ）
		await fetch(`${to}/api/refresh`).catch(() => { });
		console.log(`\n完了。新サイトのオフィスを開いて、マップが表示されるか確認してください。`);
	}
} else {
	fail("使い方: layout-transfer.mjs export <URL> [フォルダ] / import <URL> <フォルダ> [--dry-run]");
}
