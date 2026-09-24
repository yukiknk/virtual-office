// 切り出した画像が、元画像の該当部分と見た目として同一かを全数で確かめる。
//
// 「見た目として同一」の定義:
//   ・α（透明度）が全画素で完全一致
//   ・α > 0 の画素の RGB が完全一致
// 完全に透明な画素の RGB は描画に使われないため比較から外している
// （パレット化でここだけ値が変わる）。
//
// 使い方: node scripts/verify-avatars.mjs
//   差があればファイル名と箇所数を出し、終了コード 1 で終わる。
import sharp from "sharp";
import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "assets-src", "avatar");
const DST = join(root, "public", "assets", "avatar");

const CELL = 64;
const CROP = { left: 0, top: 8 * CELL, width: 9 * CELL, height: 4 * CELL };

function listPngs(dir, base = dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...listPngs(p, base));
		else if (name.toLowerCase().endsWith(".png")) out.push(relative(base, p).replace(/\\/g, "/"));
	}
	return out;
}

if (!existsSync(SRC)) {
	console.log("assets-src/avatar が無いので確認できません");
	process.exit(0);
}

const files = listPngs(SRC);
let ok = 0;
const bad = [];

for (const rel of files) {
	const dst = join(DST, rel);
	if (!existsSync(dst)) { bad.push(`${rel}: 出力がありません`); continue; }

	// 元画像から同じ範囲を切り出した生データと、出力の生データを比べる
	const a = await sharp(join(SRC, rel)).extract(CROP).ensureAlpha().raw().toBuffer();
	const b = await sharp(dst).ensureAlpha().raw().toBuffer();
	if (a.length !== b.length) { bad.push(`${rel}: 大きさが違います`); continue; }

	let rgbDiff = 0, alphaDiff = 0;
	for (let p = 0; p < a.length; p += 4) {
		if (a[p + 3] !== b[p + 3]) alphaDiff++;
		if (a[p + 3] === 0) continue;   // 透明な画素の RGB は描画に使われない
		if (a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2]) rgbDiff++;
	}
	if (rgbDiff || alphaDiff) bad.push(`${rel}: 色 ${rgbDiff}画素 / 透明度 ${alphaDiff}画素 が不一致`);
	else ok++;
}

console.log(`確認 ${files.length} 枚 … 一致 ${ok} / 不一致 ${bad.length}`);
for (const m of bad) console.log("  " + m);
process.exit(bad.length ? 1 : 0);
