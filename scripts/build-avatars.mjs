// アバター画像を「歩行アニメだけ」に切り出して public/ へ用意する。
//
// 元画像は assets-src/avatar/ に置く（LPC のスプライトシート。1枚 832x3456 など）。
// そのうちアプリが描くのは歩行の4行×9コマ＝576x256 だけで、残りの約95%は
// ダウンロードされ展開されてメモリに載るだけだった。ここで切り出しておくことで、
// 5人が入室したときの画像メモリが約460MBから約24MBに下がる。
//
// 使い方: npm run build:avatars
//   npm の predev / predeploy から自動で呼ばれるので、普段は意識しなくてよい。
//   出力が元画像より新しければ何もしないので、何度実行しても安全。
//   素材を足したときは、その分だけが処理される。
//
// 出力先（public/assets/avatar/）は完全な生成物で .gitignore 済み。
// 元に無いファイルが残っていると公開サイトへ上がってしまうため、出力側だけにある
// ファイルは削除する。
import sharp from "sharp";
import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "assets-src", "avatar");
const DST = join(root, "public", "assets", "avatar");

const CELL = 64;   // スプライト1コマの大きさ
// 行8〜11＝歩行（up / left / down / right）、列0〜8＝1周ぶんのコマ。
// public/avatar.js の DIR_ROW・WALK_FRAMES と対になっている。片方だけ変えないこと。
const CROP = { left: 0, top: 8 * CELL, width: 9 * CELL, height: 4 * CELL };

// フォルダを再帰的にたどり、相対パスの一覧を返す
function listFiles(dir, base = dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
		else out.push(relative(base, p).replace(/\\/g, "/"));
	}
	return out;
}

// 出力が元より新しければ処理不要
function isFresh(src, dst) {
	if (!existsSync(dst)) return false;
	return statSync(dst).mtimeMs >= statSync(src).mtimeMs;
}

// clone しただけの環境では元画像が無いこともある。その場合は何もしない
// （公開リポジトリには切り出し済みが入っているので、それで動く）。
if (!existsSync(SRC)) {
	console.log("assets-src/avatar が無いので何もしません");
	process.exit(0);
}

const files = listFiles(SRC);
let cropped = 0, copied = 0, skipped = 0;

for (const rel of files) {
	const src = join(SRC, rel);
	const dst = join(DST, rel);
	if (isFresh(src, dst)) { skipped++; continue; }
	mkdirSync(dirname(dst), { recursive: true });
	if (rel.toLowerCase().endsWith(".png")) {
		// パレット化で色数を減らす。ドット絵は色数が少ないので大きく縮み、
		// 不透明な画素と α は元のまま（差が出るのは描画に使われない透明部分だけ）。
		await sharp(src).extract(CROP).png({ palette: true, compressionLevel: 9, effort: 10 }).toFile(dst);
		cropped++;
	} else {
		// *_credits.txt など。gen-credits.mjs が public/assets/ 以下を走査するので、
		// PNG 以外もそのまま持っていく。
		copyFileSync(src, dst);
		copied++;
	}
}

// 元に無いものを出力側から消す（manifest.json は別スクリプトの生成物なので残す）
let removed = 0;
if (existsSync(DST)) {
	const keep = new Set([...files, "manifest.json"]);
	for (const rel of listFiles(DST)) {
		if (keep.has(rel)) continue;
		rmSync(join(DST, rel));
		removed++;
	}
}

console.log(`切り出し ${cropped} / コピー ${copied} / 変更なし ${skipped} / 削除 ${removed}`);
