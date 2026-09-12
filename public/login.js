// ログイン画面：氏名とマイク/スピーカーを選んで入室。合言葉 "admin" で管理者ページへ。
const form = document.getElementById("gateform");
const nm = document.getElementById("nm");
const micSel = document.getElementById("mic-select");
const spkSel = document.getElementById("spk-select");
const note = document.getElementById("dev-note");

// 保存済みの選択があれば復元
try {
	nm.value = localStorage.getItem("office.name") || "";
} catch { }

// 氏名が空のあいだは入室ボタンを無効化
const submitBtn = form.querySelector('button[type="submit"]');
function syncSubmit() { if (submitBtn) submitBtn.disabled = !nm.value.trim(); }
nm.addEventListener("input", syncSubmit);
syncSubmit();

// マイク許可を取り、デバイス一覧を出す
initDevices();
async function initDevices() {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		stream.getTracks().forEach((t) => t.stop());   // 許可を得る目的なのですぐ止める
	} catch {
		note.textContent = "マイクが許可されていません。音声なしでも入室できます。";
		return;
	}
	const devices = await navigator.mediaDevices.enumerateDevices();
	let savedMic = "", savedSpk = "";
	try { savedMic = localStorage.getItem("office.micId") || ""; savedSpk = localStorage.getItem("office.speakerId") || ""; } catch { }
	for (const d of devices) {
		if (d.kind === "audioinput") addOption(micSel, d, savedMic);
		else if (d.kind === "audiooutput") addOption(spkSel, d, savedSpk);
	}
	if (!spkSel.options.length) spkSel.disabled = true;   // 出力選択に非対応のブラウザ
}
function addOption(sel, device, selectedId) {
	const o = document.createElement("option");
	o.value = device.deviceId;
	o.textContent = device.label || (sel === micSel ? "マイク" : "スピーカー");
	if (device.deviceId === selectedId) o.selected = true;
	sel.appendChild(o);
}

// 入室
form.addEventListener("submit", (e) => {
	e.preventDefault();
	const name = nm.value.trim();
	if (!name) return;

	if (name === "admin") {
		location.href = "admin.html";
		return;
	}
	try {
		localStorage.setItem("office.name", name);
		localStorage.setItem("office.micId", micSel.value || "");
		localStorage.setItem("office.speakerId", spkSel.value || "");
		localStorage.setItem("office.avatar", JSON.stringify(avatar));
	} catch { }
	location.href = "office.html";
});

// ── アバター設定（プレビュー＋8レイヤーの選択） ──
const LAYERS = [
	{ key: "head", name: "頭" }, { key: "hair", name: "髪" },
	{ key: "body", name: "体" }, { key: "tops", name: "トップス" },
	{ key: "bottoms", name: "ボトムス" }, { key: "shoes", name: "靴" },
	{ key: "wings", name: "羽" }, { key: "accessory", name: "持ち物" },
];
const REQUIRED = ["body", "head"];   // 「なし」を許さないレイヤー
const DRAW_ORDER = ["wings", "body", "shoes", "bottoms", "tops", "head", "hair", "accessory"];
const DRAW_ORDER_UP = ["accessory", "body", "shoes", "bottoms", "tops", "wings", "head", "hair"]; // 後ろ向きは羽・持ち物を体の奥に
const DIR_ROW = { up: 8, left: 9, down: 10, right: 11 };   // 歩行行
const WALK_FRAMES = 9;   // 各行の有効コマ数（列0〜8）
const DIR_CYCLE = ["down", "right", "up", "left"];   // プレビューで回す向き

let manifest = {};      // { head:[{file,type,color}], ... }
let avatar = {};        // { head:file|null, ... } 選択中
let activeLayer = null; // ピッカーを開いているレイヤー
const imgCache = new Map();

initAvatar();
async function initAvatar() {
	try { manifest = await (await fetch("assets/avatar/manifest.json")).json(); } catch { manifest = {}; }
	// 既定：各レイヤーの先頭ファイル（羽・持ち物は最初はなし）
	const offByDefault = new Set(["wings", "accessory"]);
	for (const { key } of LAYERS) {
		const list = manifest[key] || [];
		avatar[key] = (list.length && !offByDefault.has(key)) ? list[0].file : null;
	}
	// 保存済みの選択を復元
	try {
		const saved = JSON.parse(localStorage.getItem("office.avatar") || "null");
		if (saved) for (const { key } of LAYERS) if (key in saved) avatar[key] = saved[key];
	} catch { }
	buildLayerButtons();
	drawPreview();
	startPreviewAnim();
}

// ランダムに着せ替え
const randomBtn = document.getElementById("av-random");
if (randomBtn) randomBtn.addEventListener("click", randomizeAvatar);
function randomizeAvatar() {
	if (!Object.keys(manifest).length) return;   // まだ読み込めていない
	for (const { key } of LAYERS) {
		const list = manifest[key] || [];
		if (!list.length) { avatar[key] = null; continue; }
		// 任意レイヤーはたまに「なし」に
		if (!REQUIRED.includes(key) && Math.random() < 0.3) { avatar[key] = null; continue; }
		avatar[key] = list[Math.floor(Math.random() * list.length)].file;
	}
	if (activeLayer) openPicker(activeLayer);   // 開いているピッカーの選択状態を更新
	drawPreview();
}

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

	// ファイル名「種類__色」で種類ごとにまとめる
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

	// いま選ばれている種類の中で選択中のファイル（色）
	function currentFileOf(t) {
		const list = byType.get(t) || [];
		const hit = list.find((it) => it.file === avatar[key]);
		return hit ? hit.file : (list[0] && list[0].file);
	}

	function refreshActive() {
		[...typeRow.children].forEach((b) => {
			const on = b.dataset.type === "__none__" ? avatar[key] === null : (avatar[key] !== null && selType === b.dataset.type);
			b.classList.toggle("active", on);
		});
		[...colorRow.children].forEach((b) => b.classList.toggle("active", (avatar[key] || "") === b.dataset.file));
	}

	// 色の選択（選択中の種類のバリアントを色名で）
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
					redrawTypeThumb(selType);   // 種類サムネイルも選んだ色にする
					refreshActive();
				});
				colorRow.appendChild(b);
			}
		}
		colorRow.hidden = !hasColors;
		colorLabel.hidden = !hasColors;
	}

	// 種類サムネイルを、その種類で選択中の色に描き直す
	function redrawTypeThumb(t) {
		const btn = [...typeRow.children].find((b) => b.dataset.type === t);
		if (btn) btn.replaceChildren(optThumb(key, currentFileOf(t)));
	}

	// 種類（同じ種類は1つにまとめて代表を表示。任意レイヤーは「なし」も）
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
		b.appendChild(optThumb(key, currentFileOf(t)));   // 代表サムネイル（選択中の色を反映）
		b.addEventListener("click", () => {
			selType = t;
			if (!byType.get(t).some((it) => it.file === avatar[key])) avatar[key] = byType.get(t)[0].file;
			drawPreview();
			fillColors();
			refreshActive();
		});
		typeRow.appendChild(b);
	}

	fillColors();
	picker.appendChild(typeLabel);
	picker.appendChild(typeRow);
	picker.appendChild(colorLabel);
	picker.appendChild(colorRow);
	refreshActive();
}

// ピッカーの見出し（種類／色）
function rowLabel(text) {
	const s = document.createElement("div");
	s.className = "av-row-label";
	s.textContent = text;
	return s;
}

// ピッカーの選択肢用のサムネイル（正面・静止ポーズの単一レイヤー）
function optThumb(cat, file) {
	const cv = document.createElement("canvas");
	cv.width = 72; cv.height = 72;
	cv.className = "av-thumb";
	const c = cv.getContext("2d");
	c.imageSmoothingEnabled = false;
	const draw = () => {
		c.clearRect(0, 0, cv.width, cv.height);
		const e = layerImg(cat, file);
		if (e && e.ready) c.drawImage(e.img, 0, 10 * 64, 64, 64, 0, 0, cv.width, cv.height);
	};
	const e = layerImg(cat, file);
	if (e) {
		if (e.ready) draw();
		else e.img.addEventListener("load", draw);
	}
	return cv;
}

// レイヤー画像を読み込む（キャッシュ）。不正なファイル名は無視。
function layerImg(cat, file) {
	if (!file || !/^[\w.\-]+\.png$/.test(file)) return null;
	const src = `assets/avatar/${cat}/${file}`;
	let e = imgCache.get(src);
	if (!e) {
		e = { img: new Image(), ready: false };
		e.img.onload = () => { e.ready = true; drawPreview(); };
		e.img.src = src;
		imgCache.set(src, e);
	}
	return e;
}

// プレビュー（歩きながら向きが回るアニメ）
let animFrame = 0, animDirIdx = 0, animDir = "down", animTimer = null;

function drawPreview(frame = animFrame, dir = animDir) {
	const cv = document.getElementById("av-preview");
	if (!cv) return;
	const c = cv.getContext("2d");
	c.imageSmoothingEnabled = false;
	c.clearRect(0, 0, cv.width, cv.height);
	const sx = frame * 64, sy = DIR_ROW[dir] * 64;
	const order = dir === "up" ? DRAW_ORDER_UP : DRAW_ORDER;
	for (const cat of order) {
		const e = layerImg(cat, avatar[cat]);
		if (e && e.ready) c.drawImage(e.img, sx, sy, 64, 64, 0, 0, cv.width, cv.height);
	}
}

function startPreviewAnim() {
	if (animTimer) clearInterval(animTimer);
	animTimer = setInterval(() => {
		animFrame = (animFrame + 1) % WALK_FRAMES;
		if (animFrame === 0) {   // 1周したら次の向きへ
			animDirIdx = (animDirIdx + 1) % DIR_CYCLE.length;
			animDir = DIR_CYCLE[animDirIdx];
		}
		drawPreview();
	}, 130);
}
