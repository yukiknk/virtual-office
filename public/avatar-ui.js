// 入室画面のアバター作成UI。プレビューと、8レイヤーの選択。
//
// 素材の一覧は assets/avatar/manifest.json から読む。
// manifest.json は scripts/gen-avatar-manifest.mjs が生成するので、
// 素材を足したら `npm run avatar-manifest` を実行すること。
//
// 選んだ内容は getAvatar() で login.js に渡す。

import { SPRITE, WALK_FRAMES, DIR_ROW, layerImg, onImageLoad, drawAvatar } from "./avatar.js";
import { KEY, readJson } from "./storage.js";

// 選択UIに並べるレイヤー。この順にボタンが出る。
const LAYERS = [
	{ key: "head", name: "頭" }, { key: "hair", name: "髪" },
	{ key: "body", name: "体" }, { key: "tops", name: "トップス" },
	{ key: "bottoms", name: "ボトムス" }, { key: "shoes", name: "靴" },
	{ key: "wings", name: "羽" }, { key: "accessory", name: "持ち物" },
];
const REQUIRED = ["body", "head"];              // 「なし」を選べないレイヤー
const DEFAULT_OFF = new Set(["wings", "accessory"]);   // 初期状態で「なし」にするレイヤー
const DIR_CYCLE = ["down", "right", "up", "left"];     // プレビューで順に回す向き

let manifest = {};        // { head:[{file,type,color}], ... } 素材の一覧
let avatar = {};          // { head:"person__light.png", ... } 選択中。null は「なし」
let activeLayer = null;   // ピッカーを開いているレイヤー

// 現在の選択を返す。login.js が入室時に localStorage へ保存する。
export function getAvatar() {
	return avatar;
}

export async function initAvatarUI() {
	try { manifest = await (await fetch("assets/avatar/manifest.json")).json(); } catch { manifest = {}; }

	// 既定は各レイヤーの先頭の素材。羽と持ち物だけ「なし」から始める。
	for (const { key } of LAYERS) {
		const list = manifest[key] || [];
		avatar[key] = (list.length && !DEFAULT_OFF.has(key)) ? list[0].file : null;
	}
	// 前回の選択があれば上書きする
	const saved = readJson(KEY.avatar);
	if (saved) for (const { key } of LAYERS) if (key in saved) avatar[key] = saved[key];

	const randomBtn = document.getElementById("av-random");
	if (randomBtn) randomBtn.addEventListener("click", randomizeAvatar);

	onImageLoad(drawPreview);   // 画像が届いたらプレビューを描き直す
	buildLayerButtons();
	drawPreview();
	startPreviewAnim();
}

// ランダムに着せ替える。任意レイヤーは3割で「なし」にする。
function randomizeAvatar() {
	if (!Object.keys(manifest).length) return;   // manifest がまだ読めていない
	for (const { key } of LAYERS) {
		const list = manifest[key] || [];
		if (!list.length) { avatar[key] = null; continue; }
		if (!REQUIRED.includes(key) && Math.random() < 0.3) { avatar[key] = null; continue; }
		avatar[key] = list[Math.floor(Math.random() * list.length)].file;
	}
	if (activeLayer) openPicker(activeLayer);   // 開いているピッカーの選択状態も更新する
	drawPreview();
}

// 「頭」「髪」…のボタンを #av-layers に作る（HTML では空のまま置かれている）
function buildLayerButtons() {
	const host = document.getElementById("av-layers");
	host.replaceChildren();
	for (const { key, name } of LAYERS) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "av-layer-btn";
		b.textContent = name;
		b.dataset.key = key;
		b.addEventListener("click", () => openPicker(key));
		host.appendChild(b);
	}
}

// ── 選択ピッカー ──
// 素材のファイル名は「種類__色.png」という規則になっている（例: bangs__black.png）。
// これを種類と色に分け、上段で種類、下段で色を選ぶ2段の画面を組み立てる。
// 色のバリエーションが無い種類では、下段ごと隠す。
function openPicker(key) {
	activeLayer = key;
	document.querySelectorAll(".av-layer-btn").forEach((b) => b.classList.toggle("active", b.dataset.key === key));
	const picker = document.getElementById("av-picker");
	picker.replaceChildren();
	picker.hidden = false;

	const items = manifest[key] || [];
	if (!items.length && REQUIRED.includes(key)) {
		const p = document.createElement("span");
		p.className = "av-opt";
		p.style.cursor = "default";
		p.textContent = "画像がありません";
		picker.appendChild(p);
		return;
	}

	// 種類ごとにまとめる。types は manifest の並び順を保つための配列。
	const types = [];
	const byType = new Map();
	for (const it of items) {
		if (!byType.has(it.type)) { byType.set(it.type, []); types.push(it.type); }
		byType.get(it.type).push(it);
	}
	const cur = items.find((it) => it.file === avatar[key]);
	let selType = cur ? cur.type : (types[0] || null);

	const typeRow = document.createElement("div"); typeRow.className = "av-picker-row av-type-row";
	const colorRow = document.createElement("div"); colorRow.className = "av-picker-row";
	const typeLabel = rowLabel("種類");
	const colorLabel = rowLabel("色");

	// その種類で今選ばれている色。未選択なら先頭の色。
	function currentFileOf(t) {
		const list = byType.get(t) || [];
		const hit = list.find((it) => it.file === avatar[key]);
		return hit ? hit.file : (list[0] && list[0].file);
	}

	// 選択中のボタンにハイライトを付け直す
	function refreshActive() {
		[...typeRow.children].forEach((b) => {
			const on = b.dataset.type === "__none__" ? avatar[key] === null : (avatar[key] !== null && selType === b.dataset.type);
			b.classList.toggle("active", on);
		});
		[...colorRow.children].forEach((b) => b.classList.toggle("active", (avatar[key] || "") === b.dataset.file));
	}

	// 下段（色）を、選択中の種類のバリエーションで作り直す
	function fillColors() {
		colorRow.replaceChildren();
		const list = (selType ? byType.get(selType) : []) || [];
		const hasColors = list.length > 1 && list.some((it) => it.color);
		if (hasColors) {
			for (const it of list) {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "av-swatch";
				b.dataset.file = it.file;
				b.textContent = it.color || "既定";
				b.addEventListener("click", () => {
					avatar[key] = it.file;
					drawPreview();
					redrawTypeThumb(selType);   // 上段のサムネイルも選んだ色にする
					refreshActive();
				});
				colorRow.appendChild(b);
			}
		}
		colorRow.hidden = !hasColors;
		colorLabel.hidden = !hasColors;
	}

	// 上段のサムネイルを、その種類で選択中の色で描き直す
	function redrawTypeThumb(t) {
		const btn = [...typeRow.children].find((b) => b.dataset.type === t);
		if (btn) btn.replaceChildren(optThumb(key, currentFileOf(t)));
	}

	// 上段（種類）。任意レイヤーには先頭に「なし」を置く。
	if (!REQUIRED.includes(key)) {
		const none = document.createElement("button");
		none.type = "button";
		none.className = "av-opt";
		none.title = "なし";
		none.dataset.type = "__none__";
		const x = document.createElement("span");
		x.className = "av-thumb-none";
		x.textContent = "なし";
		none.appendChild(x);
		none.addEventListener("click", () => { avatar[key] = null; drawPreview(); refreshActive(); });
		typeRow.appendChild(none);
	}
	for (const t of types) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "av-opt";
		b.title = t;
		b.dataset.type = t;
		b.appendChild(optThumb(key, currentFileOf(t)));
		b.addEventListener("click", () => {
			selType = t;
			// 別の種類に切り替えたら、その種類が持たない色は選べないので先頭に寄せる
			if (!byType.get(t).some((it) => it.file === avatar[key])) avatar[key] = byType.get(t)[0].file;
			drawPreview();
			fillColors();
			refreshActive();
		});
		typeRow.appendChild(b);
	}

	fillColors();
	picker.append(typeLabel, typeRow, colorLabel, colorRow);
	refreshActive();
}

// ピッカーの見出し（種類／色）
function rowLabel(text) {
	const s = document.createElement("div");
	s.className = "av-row-label";
	s.textContent = text;
	return s;
}

// 選択肢のサムネイル。1レイヤーだけを正面・静止ポーズで描いた小さなキャンバスを返す。
// 画像が未読込のときは load を待って描く。
function optThumb(cat, file) {
	const cv = document.createElement("canvas");
	cv.width = 72; cv.height = 72;
	cv.className = "av-thumb";
	const c = cv.getContext("2d");
	c.imageSmoothingEnabled = false;
	const entry = layerImg(cat, file);
	const draw = () => {
		c.clearRect(0, 0, cv.width, cv.height);
		if (entry && entry.ready) {
			c.drawImage(entry.img, 0, DIR_ROW.down * SPRITE, SPRITE, SPRITE, 0, 0, cv.width, cv.height);
		}
	};
	if (entry) {
		if (entry.ready) draw();
		else entry.img.addEventListener("load", draw);
	}
	return cv;
}

// ── プレビュー ──
// 歩きながら向きが一定間隔で変わる。128×128 のキャンバスに 64×64 を拡大して描く。
let animFrame = 0, animDirIdx = 0, animDir = "down", animTimer = null;

function drawPreview() {
	const cv = document.getElementById("av-preview");
	if (!cv) return;
	const c = cv.getContext("2d");
	c.clearRect(0, 0, cv.width, cv.height);
	drawAvatar(c, avatar, { dir: animDir, frame: animFrame, dx: 0, dy: 0, dw: cv.width, dh: cv.height });
}

// 130msごとに次のコマへ。1周したら向きを変える。
// 画面遷移で破棄されるため、タイマーを止める処理は置いていない。
function startPreviewAnim() {
	if (animTimer) clearInterval(animTimer);
	animTimer = setInterval(() => {
		animFrame = (animFrame + 1) % WALK_FRAMES;
		if (animFrame === 0) {
			animDirIdx = (animDirIdx + 1) % DIR_CYCLE.length;
			animDir = DIR_CYCLE[animDirIdx];
		}
		drawPreview();
	}, 130);
}
