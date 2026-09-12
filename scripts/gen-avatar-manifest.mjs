// アバター画像のファイル一覧（manifest.json）を作る。
// 使い方: プロジェクト直下で `node scripts/gen-avatar-manifest.mjs`
// 各フォルダの *.png を走査し、`種類__色.png` を { type, color } に分解して書き出す。
import { readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "assets", "avatar");
const CATS = ["head", "hair", "body", "tops", "bottoms", "shoes", "wings", "accessory"];

const out = {};
for (const cat of CATS) {
	let files = [];
	try {
		files = readdirSync(join(root, cat)).filter((f) => f.toLowerCase().endsWith(".png"));
	} catch { /* フォルダが無ければ空 */ }
	files.sort();
	out[cat] = files.map((file) => {
		const base = file.replace(/\.png$/i, "");
		const i = base.indexOf("__");   // 種類__色
		return i >= 0
			? { file, type: base.slice(0, i), color: base.slice(i + 2) }
			: { file, type: base, color: "" };
	});
}

writeFileSync(join(root, "manifest.json"), JSON.stringify(out, null, 2));
console.log("wrote", join(root, "manifest.json"));
for (const cat of CATS) console.log(`  ${cat}: ${out[cat].length} 件`);
