// 素材のクレジット・ライセンス一覧（public/assets/CREDITS.md）を生成する。
// 使い方: プロジェクト直下で `node scripts/gen-credits.mjs`（または npm run credits）
//
// public/assets/ 以下の *.txt を走査して、素材ごとの
// ライセンス・作者・出典リンクを1枚にまとめる。
// 元のクレジットファイルは正式な記録として残したまま、読む用の索引を作る位置づけ。
//
// 対応している2つの書式:
//   (A) タイル・家具系      "License: OGA-by 3.0"
//   (B) アバター生成ツール   "- Licenses:" の下にライセンスを列挙

import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(root, "public", "assets");
const outPath = join(assetsDir, "CREDITS.md");

// 表示だけで使える（継承義務のない）ライセンス
const PERMISSIVE = [/^OGA-BY/, /^CC0/, /^MIT/, /^CC-BY-\d/];

// ライセンス条文の所在（正規化後の名前 → URL）。到達確認済み。
const LICENSE_URL = {
	"OGA-BY-3.0": "https://static.opengameart.org/OGA-BY-3.0.txt",
	"OGA-BY-4.0": "https://opengameart.org/sites/default/files/archive/oga-by-40.txt",
	"CC0": "https://creativecommons.org/publicdomain/zero/1.0/",
	"CC-BY-3.0": "https://creativecommons.org/licenses/by/3.0/",
	"CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
	"CC-BY-SA-3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
	"CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
	"GPL-2.0": "https://www.gnu.org/licenses/old-licenses/gpl-2.0.html",
	"GPL-3.0": "https://www.gnu.org/licenses/gpl-3.0.html",
	"MIT": "https://opensource.org/license/mit",
};
// 末尾の "+"（以降のバージョンも可）は同じ条文を指す
const licenseUrl = (norm) => LICENSE_URL[norm] || LICENSE_URL[norm.replace(/\+$/, "")] || null;

function walk(dir) {
	const out = [];
	// 環境（OS・ファイルシステム）によらず同じ順序で出力されるよう名前順に固定する
	for (const name of readdirSync(dir).sort()) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (name.toLowerCase().endsWith(".txt")) out.push(p);
	}
	return out;
}

function normLicense(s) {
	return s
		.replace(/\(.*?\)/g, "")
		.trim()
		.toUpperCase()
		.replace(/\s+/g, "-")
		.replace(/_/g, "-")
		.replace(/[.\s-]+$/, "");
}

// 1ファイルを解析して素材ブロックの配列を返す
function parseFile(path) {
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const blocks = [];
	let asset = "";
	let i = 0;
	const indentOf = (s) => s.length - s.trimStart().length;

	while (i < lines.length) {
		const raw = lines[i];
		const s = raw.trim();

		// 見出し行（インデントなし・キー行でない）＝素材名
		if (s && indentOf(raw) === 0 && !/^(licenses?|credit|link|artist|author|note|details?)\s*:/i.test(s) && !s.startsWith("-")) {
			asset = s;
		}

		// 書式 (B)
		const mB = raw.match(/^\s*-\s*Licenses?\s*:\s*$/i);
		if (mB) {
			const base = indentOf(raw);
			const licenses = [];
			let j = i + 1;
			while (j < lines.length && lines[j].trim().startsWith("-") && indentOf(lines[j]) > base) {
				licenses.push(lines[j].trim().replace(/^-\s*/, ""));
				j++;
			}
			const { authors, links } = collectSiblings(lines, j, base);
			blocks.push({ file: path, asset, licenses, authors, links });
			i = j;
			continue;
		}

		// 書式 (A)
		const mA = raw.match(/^\s*License\s*:\s*(.+)$/i);
		if (mA) {
			const artist = (lines[i - 1] || "").match(/^\s*Artists?\s*:\s*(.+)$/i);
			blocks.push({
				file: path,
				asset,
				licenses: [mA[1].trim()],
				authors: artist ? artist[1].split(/,\s*| and /).map((x) => x.trim()).filter(Boolean) : [],
				links: [],
			});
		}
		i++;
	}
	return blocks;
}

// 同じ素材ブロックにぶら下がる Authors / Links を拾う
function collectSiblings(lines, start, baseIndent) {
	const authors = [], links = [];
	const indentOf = (s) => s.length - s.trimStart().length;
	let mode = null;
	for (let j = start; j < lines.length; j++) {
		const raw = lines[j];
		if (!raw.trim()) continue;
		const ind = indentOf(raw);
		if (ind < baseIndent) break;
		if (ind === baseIndent) {
			if (/^\s*-\s*Authors?\s*:/i.test(raw)) { mode = "a"; continue; }
			if (/^\s*-\s*Links?\s*:/i.test(raw)) { mode = "l"; continue; }
			if (/^\s*-\s*(Licenses?|Notes?|Details?)\s*:/i.test(raw)) break;
			continue;
		}
		const v = raw.trim().replace(/^-\s*/, "");
		if (mode === "a") authors.push(v);
		else if (mode === "l") links.push(v);
	}
	return { authors, links };
}

// ── 収集 ──
const files = walk(assetsDir).filter((p) => p !== outPath);
const blocks = files.flatMap(parseFile).filter((b) => b.licenses.length);

const licenseCount = new Map();
const authorSet = new Set();
for (const b of blocks) {
	for (const l of b.licenses) licenseCount.set(normLicense(l), (licenseCount.get(normLicense(l)) || 0) + 1);
	for (const a of b.authors) authorSet.add(a);
}

const shareAlikeOnly = blocks.filter(
	(b) => !b.licenses.map(normLicense).some((l) => PERMISSIVE.some((re) => re.test(l)))
);

// ── 出力 ──
const rel = (p) => relative(assetsDir, p).replace(/\\/g, "/");

// クレジットファイル名から、同じフォルダの該当画像を表すグロブを作る。
// 例: avatar/hair/bangs_credit.txt -> avatar/hair/bangs__*.png
function affectedGlob(creditPath) {
	const r = rel(creditPath);
	const dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "";
	const base = r.slice(r.lastIndexOf("/") + 1);
	const prefix = base
		.replace(/\.txt$/i, "")
		.replace(/_{0,2}credits?$/i, "")
		.replace(/_+$/, "");
	if (!prefix) return `${dir}/（フォルダ全体）`;
	return `${dir ? dir + "/" : ""}${prefix}__*.png`;
}
const L = [];

L.push("# 素材のクレジットとライセンス");
L.push("");
L.push("> このファイルは `node scripts/gen-credits.mjs` で自動生成しています。直接編集しないでください。");
L.push("> 正式な記録は各フォルダの `*_credits.txt` です。素材を追加・変更したら再生成してください。");
L.push("");
L.push("このプロジェクトのソースコードのライセンスは、リポジトリ直下の `LICENSE` を参照してください。");
L.push("`public/assets/` 以下のドット絵素材は**第三者の著作物**で、コードとは別のライセンスが適用されます。");
L.push("素材は Liberated Pixel Cup (LPC) 系のもので、");
L.push("アバターは [Universal LPC Spritesheet Character Generator](https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/) で生成しています。");
L.push("");
L.push("なお配信しているアバター画像は、配布物から**歩行アニメの部分（4方向×9コマ）だけを切り出したもの**です。");
L.push("切り出し前の画像は `assets-src/avatar/` にあります。");
L.push("");

L.push("## 含まれるライセンス");
L.push("");
L.push("| ライセンス | 宣言数 | 条文 |");
L.push("|---|---:|---|");
for (const [k, v] of [...licenseCount].sort((a, b) => b[1] - a[1])) {
	const u = licenseUrl(k);
	L.push(`| ${k} | ${v} | ${u ? `<${u}>` : "—"} |`);
}
L.push("");
L.push("LPC 素材の多くは複数ライセンスの**選択制**です。選択肢がある素材については、");
L.push("本プロジェクトは表示のみを求める OGA-BY 3.0（または CC0 / CC-BY）を選択します。");
L.push("");

L.push("## 継承義務のある素材");
L.push("");
if (!shareAlikeOnly.length) {
	L.push("該当なし。すべての素材に、表示のみで利用できる選択肢があります。");
} else {
	L.push(`次の ${shareAlikeOnly.length} 素材には CC-BY-SA / GPL しか選択肢がありません。`);
	L.push("**これらの画像とその色違いは CC-BY-SA 3.0 で配布されます**（GPL ではなく CC-BY-SA を選択）。");
	L.push("同じリポジトリに同梱されているだけのソースコードには、この義務は及びません");
	L.push("（CC-BY-SA 3.0 の Collections 条項）。");
	L.push("");
	L.push("| 本リポジトリの該当ファイル | 元素材 | ライセンス |");
	L.push("|---|---|---|");
	for (const b of shareAlikeOnly) {
		L.push(`| \`${affectedGlob(b.file)}\` | \`${b.asset}\` | ${b.licenses.join(" / ")} |`);
	}
}
L.push("");

L.push("## 作者");
L.push("");
L.push("素材の作者は以下の方々です（五十音・アルファベット順）。");
L.push("");
for (const a of [...authorSet].sort((x, y) => x.localeCompare(y))) L.push(`- ${a}`);
L.push("");

L.push("## 素材ごとの一覧");
L.push("");
let curFile = null;
for (const b of blocks) {
	if (b.file !== curFile) {
		curFile = b.file;
		L.push("");
		L.push(`### \`${rel(b.file)}\``);
		L.push("");
	}
	L.push(`- **${b.asset || "(名称なし)"}**`);
	L.push(`  - ライセンス: ${b.licenses.join(" / ")}`);
	if (b.authors.length) L.push(`  - 作者: ${b.authors.join(", ")}`);
	for (const u of b.links) L.push(`  - ${u}`);
}
L.push("");

writeFileSync(outPath, L.join("\n"), "utf8");

// ── アプリから見せるクレジットページ（public/credits.html） ──
// デプロイ先でも表示義務を満たせるよう、リポジトリ内の CREDITS.md とは別に
// 単体で開ける HTML を出す。スタイルは埋め込みで完結させる。
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const licLinks = (licenses) =>
	licenses.map((l) => {
		const u = licenseUrl(normLicense(l));
		return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)}</a>` : esc(l);
	}).join(" / ");

const H = [];
H.push("<!doctype html>");
H.push('<html lang="ja">');
H.push("<head>");
H.push('<meta charset="utf-8" />');
H.push('<meta name="viewport" content="width=device-width, initial-scale=1" />');
H.push("<title>素材のクレジット</title>");
H.push("<style>");
H.push(`:root{color-scheme:light}
body{margin:0;background:#eff1ec;color:#141815;font-family:"M PLUS Rounded 1c",system-ui,sans-serif;line-height:1.7}
main{max-width:900px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;border-bottom:2px solid #141815;padding-bottom:10px}
h2{font-size:16px;margin-top:32px}
h3{font-size:13px;color:#737a70;margin-top:24px;font-family:ui-monospace,monospace}
a{color:#2c6e49}
table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}
th,td{border:1px solid #b4bbb0;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#dfe3dd}
code{background:#dfe3dd;padding:1px 4px;border-radius:4px;font-size:12px}
ul{padding-left:20px}
li{margin:2px 0}
.note{background:#dfe3dd;border-left:4px solid #737a70;padding:10px 14px;border-radius:0 8px 8px 0;font-size:13px}
.asset{font-size:13px;margin:10px 0}
.asset b{font-family:ui-monospace,monospace;font-weight:600}
.meta{color:#4a5147;font-size:12px}`);
H.push("</style>");
H.push("</head>");
H.push("<body><main>");
H.push("<h1>素材のクレジット</h1>");
H.push('<p class="note">このサイトで使用しているドット絵素材は第三者の著作物です。素材は Liberated Pixel Cup (LPC) 系のもので、アバターは <a href="https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/" target="_blank" rel="noopener">Universal LPC Spritesheet Character Generator</a> で生成しています。</p>');

H.push("<h2>含まれるライセンス</h2>");
H.push("<table><tr><th>ライセンス</th><th>宣言数</th><th>条文</th></tr>");
for (const [k, v] of [...licenseCount].sort((a, b) => b[1] - a[1])) {
	const u = licenseUrl(k);
	H.push(`<tr><td>${esc(k)}</td><td>${v}</td><td>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">条文</a>` : "—"}</td></tr>`);
}
H.push("</table>");
H.push("<p>選択肢がある素材については OGA-BY 3.0（または CC0 / CC-BY）を選択しています。</p>");

if (shareAlikeOnly.length) {
	H.push("<h2>継承義務のある素材</h2>");
	H.push(`<p>次の ${shareAlikeOnly.length} 素材は CC-BY-SA / GPL しか選択肢がないため、<b>これらの画像とその色違いは CC-BY-SA 3.0 で配布されます</b>。</p>`);
	H.push("<table><tr><th>ファイル</th><th>元素材</th><th>ライセンス</th></tr>");
	for (const b of shareAlikeOnly) {
		H.push(`<tr><td><code>${esc(affectedGlob(b.file))}</code></td><td><code>${esc(b.asset)}</code></td><td>${licLinks(b.licenses)}</td></tr>`);
	}
	H.push("</table>");
}

H.push("<h2>作者</h2><ul>");
for (const a of [...authorSet].sort((x, y) => x.localeCompare(y))) H.push(`<li>${esc(a)}</li>`);
H.push("</ul>");

H.push("<h2>素材ごとの一覧</h2>");
let curH = null;
for (const b of blocks) {
	if (b.file !== curH) { curH = b.file; H.push(`<h3>${esc(rel(b.file))}</h3>`); }
	H.push('<div class="asset">');
	H.push(`<b>${esc(b.asset || "(名称なし)")}</b><br />`);
	H.push(`<span class="meta">ライセンス: ${licLinks(b.licenses)}`);
	if (b.authors.length) H.push(`<br />作者: ${esc(b.authors.join(", "))}`);
	for (const u of b.links) H.push(`<br /><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`);
	H.push("</span></div>");
}
H.push("</main></body></html>");

const htmlPath = join(root, "public", "credits.html");
writeFileSync(htmlPath, H.join("\n"), "utf8");

console.log(`wrote ${outPath}`);
console.log(`wrote ${htmlPath}`);
console.log(`  クレジットファイル: ${files.length} 件`);
console.log(`  素材ブロック:       ${blocks.length} 件`);
console.log(`  ライセンス種類:     ${licenseCount.size} 種`);
console.log(`  継承義務のある素材: ${shareAlikeOnly.length} 件`);
console.log(`  作者:               ${authorSet.size} 名`);
