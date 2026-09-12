// サイドバーの操作：編集対象タブ・消去・表示切替・保存モード・反映・タイル選択モーダル・状態表示。
import { store, CATEGORIES, FURNITURE } from "./store.js";
import { saveLayout, saveZones, saveComments, saveFurniture } from "./data.js";

let redraw = () => { };   // キャンバス再描画（main から editor.draw を受け取る）

export function initUI(redrawFn) {
	redraw = redrawFn || (() => { });
	buildTabs();
	document.getElementById("erase-tool").addEventListener("click", toggleErase);
	document.getElementById("showall-tool").addEventListener("click", toggleShowAll);
	document.getElementById("savemode-tool").addEventListener("click", toggleSaveMode);
	document.getElementById("save-tool").addEventListener("click", saveNow);
	document.getElementById("reflect-tool").addEventListener("click", reflect);
	document.getElementById("modal-close").addEventListener("click", closeModal);
	document.getElementById("modal").addEventListener("click", (e) => {
		if (e.target.id === "modal") closeModal();   // 背景クリックで閉じる
	});
	refresh();
}

// ── 表示切替・保存モード・反映 ──
function toggleShowAll() {
	store.showAll = !store.showAll;
	if (store.showAll) {
		// 全体表示にしたら編集対象の選択を解除する
		store.target = null;
		store.activeCatKey = null;
		store.selectedTile = null;
		store.erase = false;
	}
	refresh();   // タブのハイライト・状態表示・保存UIもまとめて更新
}
function toggleSaveMode() {
	store.autoSave = !store.autoSave;
	if (store.autoSave && store.dirty) { saveLayout(); saveZones(); saveComments(); saveFurniture(); store.dirty = false; }
	updateSaveUI();
}
function saveNow() {
	saveLayout(); saveZones(); saveComments(); saveFurniture(); store.dirty = false; updateSaveUI();
}
async function reflect() {
	const btn = document.getElementById("reflect-tool");
	if (btn) btn.disabled = true;
	try {
		await saveLayout();
		await saveZones();
		await saveComments();
		await saveFurniture();
		store.dirty = false;
		updateSaveUI();
		await fetch("/api/refresh", { method: "POST" });   // 利用者に再取得を通知
	} catch (e) {
		console.warn("反映失敗", e);
	} finally {
		if (btn) btn.disabled = false;
	}
}

// 表示・保存まわりのボタン状態を更新
export function updateSaveUI() {
	const modeBtn = document.getElementById("savemode-tool");
	if (modeBtn) modeBtn.textContent = store.autoSave ? "保存モード：自動" : "保存モード：手動";
	const st = document.getElementById("save-state");
	if (st) { st.textContent = store.dirty ? "● 未保存の変更" : "保存済み"; st.classList.toggle("dirty", store.dirty); }
	const saveBtn = document.getElementById("save-tool");
	if (saveBtn) saveBtn.disabled = store.autoSave || !store.dirty;
	const showBtn = document.getElementById("showall-tool");
	if (showBtn) showBtn.classList.toggle("active", store.showAll);
}

// ── タブ（編集対象の選択） ──
function buildTabs() {
	const host = document.getElementById("tabs");
	host.replaceChildren();

	// タイル系タブ（壁・敷物・床）
	CATEGORIES.forEach((cat) => {
		const btn = makeTab(cat.name, cat.key);
		btn.addEventListener("click", () => {
			store.target = cat.layer;
			store.activeCatKey = cat.key;
			store.erase = false;
			store.showAll = false;   // 編集対象より上のレイヤーを隠す（全体表示を解除）
			refresh();
			openTileModal(cat);
		});
		host.appendChild(btn);
	});

	// 家具タブ（1つにまとめ、モーダル内でシートを切り替えて選ぶ）
	const fbtn = makeTab("家具", "furniture");
	fbtn.addEventListener("click", () => {
		store.target = "furniture";
		store.activeCatKey = "furniture";
		store.erase = false;
		store.showAll = false;
		refresh();
		openFurniturePicker();
	});
	host.appendChild(fbtn);

	// 会話エリアタブ（モーダルなし。ドラッグで作成、消去で削除）
	const zbtn = makeTab("会話エリア", "zone");
	zbtn.addEventListener("click", () => {
		store.target = "zone";
		store.activeCatKey = "zone";
		store.selectedTile = null;
		store.erase = false;
		store.showAll = false;
		refresh();
	});
	host.appendChild(zbtn);

	// 通行禁止マスタブ（モーダルなし。オフィスでは非表示）
	const bbtn = makeTab("通行禁止", "block");
	bbtn.addEventListener("click", () => {
		store.target = "block";
		store.activeCatKey = "block";
		store.selectedTile = null;
		store.erase = false;
		store.showAll = false;
		refresh();
	});
	host.appendChild(bbtn);

	// 看板（コメント）タブ（一番上のレイヤー。ドラッグで作成、クリックで文字編集）
	const cbtn = makeTab("看板", "comment");
	cbtn.addEventListener("click", () => {
		store.target = "comment";
		store.activeCatKey = "comment";
		store.selectedTile = null;
		store.erase = false;
		store.showAll = false;
		refresh();
	});
	host.appendChild(cbtn);
}
function makeTab(name, key) {
	const b = document.createElement("button");
	b.type = "button";
	b.className = "tab";
	b.textContent = name;
	b.dataset.key = key;
	return b;
}

// ── 消去トグル ──
function toggleErase() {
	store.erase = !store.erase;
	refresh();
}

// ── 表示更新（タブ強調・消去ボタン・状態文・選択プレビュー） ──
function refresh() {
	document.querySelectorAll("#tabs .tab").forEach((b) => {
		b.classList.toggle("active", b.dataset.key === store.activeCatKey);
	});
	const eraseBtn = document.getElementById("erase-tool");
	eraseBtn.classList.toggle("active", store.erase);
	eraseBtn.disabled = !store.target;   // 対象を選ぶまで消去は使えない
	updateStatus();
	updateCurrent();
	updateSaveUI();
	redraw();
}

function updateStatus() {
	const el = document.getElementById("mode-status");
	if (!el) return;
	if (!store.target) {
		el.textContent = "編集する対象をタブから選んでください";
		el.className = "status idle";
		return;
	}
	const name = targetName(store.target);
	let text, cls;
	if (store.erase) {
		text = `🧽 ${name}を消去中`;
		cls = "erase";
	} else if (store.target === "zone") {
		text = "▭ 空きをドラッグで作成／既存はドラッグで移動・クリックで名前変更";
		cls = "zone";
	} else if (store.target === "comment") {
		text = "▭ 空きをドラッグで作成／既存はドラッグで移動・クリックで文字編集";
		cls = "zone";
	} else if (store.target === "furniture") {
		text = store.furnitureBrush ? "🪑 クリックで配置／既存はドラッグで移動" : "🪑 家具を選んでください";
		cls = store.furnitureBrush ? "place" : "idle";
	} else if (store.target === "block") {
		text = "🚫 通行禁止マスを配置中（オフィスでは非表示）";
		cls = "erase";
	} else if (store.selectedTile) {
		text = `🖌 ${name}を配置中`;
		cls = "place";
	} else {
		text = `${name}：タイルを選んでください`;
		cls = "idle";
	}
	el.textContent = text;
	el.className = "status " + cls;
}
function targetName(t) {
	return t === "floor" ? "床" : t === "rug" ? "敷物" : t === "object" ? "壁"
		: t === "furniture" ? "家具" : t === "zone" ? "会話エリア" : t === "comment" ? "看板" : "通行禁止";
}

// ── タイル選択モーダル（シートをそのままの並びで拡大表示） ──
// タイル選択（1マスをクリックで選ぶ）
function openTileModal(cat) {
	const modal = document.getElementById("modal");
	const mcanvas = document.getElementById("modal-canvas");
	const mctx = mcanvas.getContext("2d");
	const sheetsBar = document.getElementById("furni-sheets");
	if (sheetsBar) sheetsBar.style.display = "none";   // タイルではシート切替を隠す

	document.getElementById("modal-title").textContent = cat.name;
	mcanvas.width = cat.img.width;
	mcanvas.height = cat.img.height;
	mctx.imageSmoothingEnabled = false;
	mctx.drawImage(cat.img, 0, 0);
	mctx.strokeStyle = "rgba(0,0,0,0.25)";
	mctx.lineWidth = 1;
	for (let x = 0; x <= mcanvas.width; x += 32) { mctx.beginPath(); mctx.moveTo(x, 0); mctx.lineTo(x, mcanvas.height); mctx.stroke(); }
	for (let y = 0; y <= mcanvas.height; y += 32) { mctx.beginPath(); mctx.moveTo(0, y); mctx.lineTo(mcanvas.width, y); mctx.stroke(); }

	mcanvas.style.width = Math.min(window.innerWidth * 0.9, cat.img.width * 4) + "px";
	mcanvas.style.height = "auto";
	mcanvas.onpointerdown = mcanvas.onpointermove = mcanvas.onpointerup = null;
	mcanvas.onclick = (e) => {
		const rect = mcanvas.getBoundingClientRect();
		const tileCol = Math.floor((e.clientX - rect.left) * (mcanvas.width / rect.width) / 32);
		const tileRow = Math.floor((e.clientY - rect.top) * (mcanvas.height / rect.height) / 32);
		if (isEmptyTile(mctx, tileCol * 32, tileRow * 32)) return;
		store.selectedTile = { catKey: cat.key, tileCol, tileRow, layer: cat.layer };
		store.target = cat.layer;
		store.activeCatKey = cat.key;
		store.erase = false;
		refresh();
		closeModal();
	};
	modal.classList.add("open");
}

// 家具選択：モーダル上部でシートを切り替え、ドラッグで範囲選択して配置ブラシにする
function openFurniturePicker() {
	const modal = document.getElementById("modal");
	const sheetsBar = document.getElementById("furni-sheets");
	document.getElementById("modal-title").textContent = "家具を選ぶ（ドラッグで範囲選択）";
	sheetsBar.style.display = "flex";
	sheetsBar.replaceChildren();
	FURNITURE.forEach((sheet, i) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "sheet-btn" + (i === 0 ? " active" : "");
		b.textContent = sheet.name;
		b.addEventListener("click", () => {
			sheetsBar.querySelectorAll(".sheet-btn").forEach((x) => x.classList.remove("active"));
			b.classList.add("active");
			showFurnitureSheet(sheet);
		});
		sheetsBar.appendChild(b);
	});
	showFurnitureSheet(FURNITURE[0]);
	modal.classList.add("open");
}

function showFurnitureSheet(sheet) {
	const mcanvas = document.getElementById("modal-canvas");
	const mctx = mcanvas.getContext("2d");
	mcanvas.width = sheet.img.width;
	mcanvas.height = sheet.img.height;
	const drawSheet = () => {
		mctx.imageSmoothingEnabled = false;
		mctx.clearRect(0, 0, mcanvas.width, mcanvas.height);
		mctx.drawImage(sheet.img, 0, 0);
		mctx.strokeStyle = "rgba(0,0,0,0.25)";
		mctx.lineWidth = 1;
		for (let x = 0; x <= mcanvas.width; x += 32) { mctx.beginPath(); mctx.moveTo(x, 0); mctx.lineTo(x, mcanvas.height); mctx.stroke(); }
		for (let y = 0; y <= mcanvas.height; y += 32) { mctx.beginPath(); mctx.moveTo(0, y); mctx.lineTo(mcanvas.width, y); mctx.stroke(); }
	};
	drawSheet();
	mcanvas.style.width = Math.min(window.innerWidth * 0.9, sheet.img.width * 4) + "px";
	mcanvas.style.height = "auto";

	const toSheet = (e) => {
		const rect = mcanvas.getBoundingClientRect();
		return { x: (e.clientX - rect.left) * (mcanvas.width / rect.width), y: (e.clientY - rect.top) * (mcanvas.height / rect.height) };
	};
	mcanvas.onclick = null;
	let selecting = false, c0 = 0, r0 = 0, c1 = 0, r1 = 0;
	mcanvas.onpointerdown = (e) => {
		const p = toSheet(e);
		c0 = c1 = Math.floor(p.x / 32); r0 = r1 = Math.floor(p.y / 32);
		selecting = true; mcanvas.setPointerCapture(e.pointerId);
	};
	mcanvas.onpointermove = (e) => {
		if (!selecting) return;
		const p = toSheet(e);
		c1 = Math.floor(p.x / 32); r1 = Math.floor(p.y / 32);
		drawSheet();
		const x = Math.min(c0, c1) * 32, y = Math.min(r0, r1) * 32;
		const w = (Math.abs(c1 - c0) + 1) * 32, h = (Math.abs(r1 - r0) + 1) * 32;
		mctx.strokeStyle = "#1f3fb0"; mctx.lineWidth = 2; mctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
		mctx.fillStyle = "rgba(31,63,176,0.15)"; mctx.fillRect(x, y, w, h);
	};
	mcanvas.onpointerup = () => {
		if (!selecting) return;
		selecting = false;
		const sx = Math.min(c0, c1) * 32, sy = Math.min(r0, r1) * 32;
		const sw = (Math.abs(c1 - c0) + 1) * 32, sh = (Math.abs(r1 - r0) + 1) * 32;
		store.furnitureBrush = { cat: sheet.key, sx, sy, sw, sh };
		store.target = "furniture";
		store.activeCatKey = "furniture";
		store.erase = false;
		refresh();
		closeModal();
	};
}
function closeModal() {
	document.getElementById("modal").classList.remove("open");
}
function isEmptyTile(octx, sx, sy) {
	const data = octx.getImageData(sx, sy, 32, 32).data;
	for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return false;
	return true;
}

// ── 選択中タイルのプレビュー ──
function updateCurrent() {
	const cv = document.getElementById("current-preview");
	const c = cv.getContext("2d");
	c.clearRect(0, 0, cv.width, cv.height);
	if (!store.selectedTile) return;
	const cat = CATEGORIES.find((x) => x.key === store.selectedTile.catKey);
	if (!cat) return;
	c.imageSmoothingEnabled = false;
	c.drawImage(cat.img, store.selectedTile.tileCol * 32, store.selectedTile.tileRow * 32, 32, 32, 0, 0, cv.width, cv.height);
}
