// キャンバス：描画・マウス操作。ドラッグで配置、消去モードなら削除。
// 対象（床/敷物/壁/会話エリア）は store.target で切り替わる。
import { GRID, COLS, ROWS, WORLD, w2s, s2w, setViewport, drawBase, drawGrid, drawCommentBox } from "../map.js";
import { store, CATEGORIES, FURNITURE } from "./store.js";
import { saveLayout, saveZones, saveComments, saveFurniture } from "./data.js";
import { updateSaveUI } from "./ui.js";

const stage = document.getElementById("stage");
const canvas = document.getElementById("plan");
const ctx = canvas.getContext("2d");

let painting = false, startCell = null, curCell = null;
let startPx = null, curPx = null;   // 看板の自由サイズ作成用（ピクセル座標）
// エリアの移動／リサイズ中の状態
let grabbedRect = null;    // つかんでいるエリア
let grabMode = null;       // "move" | "resize"
let resizeCorner = null;   // "nw" | "ne" | "sw" | "se"
let grabPointer = null;    // つかんだ時のポインタ論理座標
let grabOrig = null;       // つかんだ時の {x,y,w,h}
let grabMoved = false;     // 実際にドラッグしたか（クリックと区別）
// 家具の移動中の状態
let grabbedFurniture = null;
let grabFurOff = null;     // つかんだ位置と家具左上のズレ
let furStart = null;       // つかんだ論理座標（クリック判定用）
let furMoved = false;
let furJustPlaced = false; // 今置いたばかりか（配置直後にリンク設定を出さない）

function snapGrid(v) { return Math.round(v / GRID) * GRID; }
// 家具用：マス目の1/4（8px）刻みに吸着
function snapQuarter(v) { const q = GRID / 4; return Math.round(v / q) * q; }

// (cx,cy) がどのエリアの四隅の近くか（画面上14px以内）。なければ null。
function cornerAt(z, e) {
	const rect = canvas.getBoundingClientRect();
	const px = e.clientX - rect.left, py = e.clientY - rect.top;
	const corners = [["nw", z.x, z.y], ["ne", z.x + z.w, z.y], ["sw", z.x, z.y + z.h], ["se", z.x + z.w, z.y + z.h]];
	for (const [k, cx, cy] of corners) {
		const s = w2s(cx, cy);
		if (Math.hypot(s.x - px, s.y - py) <= 14) return k;
	}
	return null;
}

// レイヤーの重なり順。タイル編集中だけ、編集対象より上のレイヤーを隠す。
// （未選択・会話エリア・通行禁止のときは床・敷物・壁をすべて表示する）
const RANK = { floor: 0, rug: 1, object: 2 };
function layerVisible(layerKey) {
	if (store.showAll) return true;
	if (store.target === "floor" || store.target === "rug" || store.target === "object") {
		return RANK[layerKey] <= RANK[store.target];
	}
	return true;
}

// ── 初期化 ──
export function initEditor() {
	canvas.addEventListener("pointerdown", onDown);
	canvas.addEventListener("pointermove", onMove);
	canvas.addEventListener("pointerup", onUp);
	window.addEventListener("resize", fit);

	// コメント設定モーダルのボタン
	document.getElementById("c-cancel").addEventListener("click", closeCommentModal);
	document.getElementById("c-save").addEventListener("click", saveCommentModal);
	document.getElementById("comment-modal").addEventListener("click", (e) => {
		if (e.target.id === "comment-modal") closeCommentModal();   // 背景クリックで閉じる
	});

	// 家具のリンク設定モーダル
	document.getElementById("fu-cancel").addEventListener("click", closeFurniModal);
	document.getElementById("fu-save").addEventListener("click", saveFurniModal);
	document.getElementById("fu-clear").addEventListener("click", clearFurniLink);
	document.getElementById("furni-modal").addEventListener("click", (e) => {
		if (e.target.id === "furni-modal") closeFurniModal();
	});
}

// ── 家具のリンク設定モーダル ──
let linkTarget = null;   // 設定中の家具

function openFurniModal(f) {
	linkTarget = f;
	document.getElementById("fu-label").value = f.label || "";
	document.getElementById("fu-url").value = f.url || "";
	document.getElementById("furni-modal").classList.add("open");
	document.getElementById("fu-url").focus();
}
function closeFurniModal() {
	document.getElementById("furni-modal").classList.remove("open");
	linkTarget = null;
}
function saveFurniModal() {
	if (!linkTarget) return;
	let url = document.getElementById("fu-url").value.trim();
	if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;   // 先頭にスキームを補う
	linkTarget.url = url;
	linkTarget.label = document.getElementById("fu-label").value.trim();
	closeFurniModal();
	afterEdit("furniture");
	draw();
}
function clearFurniLink() {
	if (!linkTarget) return;
	delete linkTarget.url;
	delete linkTarget.label;
	closeFurniModal();
	afterEdit("furniture");
	draw();
}

// ── コメント設定モーダル ──
let commentDraft = null;   // { mode:"create"|"edit", target }

function openCommentModal(mode, target) {
	commentDraft = { mode, target };
	const src = mode === "edit" ? target : {};
	document.getElementById("c-text").value = src.text || "";
	document.getElementById("c-size").value = String(src.size || 16);
	document.getElementById("c-color").value = src.color || "#141815";
	document.getElementById("c-bg").value = src.bg || "#ffffff";
	document.getElementById("c-bold").checked = !!src.bold;
	document.getElementById("c-italic").checked = !!src.italic;
	document.getElementById("comment-modal").classList.add("open");
	document.getElementById("c-text").focus();
}
function closeCommentModal() {
	document.getElementById("comment-modal").classList.remove("open");
	commentDraft = null;
}
function saveCommentModal() {
	if (!commentDraft) return;
	const fields = {
		text: document.getElementById("c-text").value.trim(),
		size: Number(document.getElementById("c-size").value) || 16,
		color: document.getElementById("c-color").value,
		bg: document.getElementById("c-bg").value,
		bold: document.getElementById("c-bold").checked,
		italic: document.getElementById("c-italic").checked,
	};
	if (commentDraft.mode === "create") {
		const g = commentDraft.target;
		store.comments.push({ id: uid(), x: g.x, y: g.y, w: g.w, h: g.h, ...fields });
	} else {
		Object.assign(commentDraft.target, fields);
	}
	closeCommentModal();
	afterEdit("comment");
	draw();
}

// ── 描画 ──
export function fit() {
	// 高解像度ディスプレイでもボケないよう、実ピクセル数で描く
	const dpr = window.devicePixelRatio || 1;
	const w = stage.clientWidth, h = stage.clientHeight;
	canvas.width = Math.round(w * dpr);
	canvas.height = Math.round(h * dpr);
	canvas.style.width = w + "px";
	canvas.style.height = h + "px";
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 以降はCSSピクセル基準で描ける
	setViewport(w, h);
	draw();
}
export function draw() {
	drawBase(ctx, canvas);
	if (layerVisible("floor")) drawLayer("floor");   // 床（下）
	if (layerVisible("rug")) drawLayer("rug");       // 敷物（中）
	if (layerVisible("object")) drawLayer("object"); // 壁（上）
	// 家具（壁の一つ上）：全体表示・家具編集・会話エリア/通行禁止/看板の編集中に表示
	if (store.showAll || store.target === "furniture" || store.target === "zone" || store.target === "block" || store.target === "comment") drawFurniture();
	if (!store.showAll && store.target !== "comment") drawGrid(ctx);   // 全体表示中・看板編集中はグリッドを隠す
	if (store.target === "zone") drawZones();                         // 会話エリアは編集中だけ表示
	if (store.showAll || store.target === "comment") drawComments();  // 全体表示中とコメント編集中に表示
	if (store.target === "block") drawBlocked();                      // 編集中のみ表示
	drawPreview();
}
// 通行禁止マス（赤の半透明。通行禁止タブのときだけ描く）
function drawBlocked() {
	ctx.fillStyle = "rgba(178,58,42,0.35)";
	for (const key of store.blocked) {
		const [col, row] = key.split(",").map(Number);
		const p = w2s(col * GRID, row * GRID);
		const q = w2s((col + 1) * GRID, (row + 1) * GRID);
		ctx.fillRect(p.x, p.y, q.x - p.x, q.y - p.y);
	}
}
function drawLayer(layerKey) {
	ctx.imageSmoothingEnabled = false;
	const dpr = window.devicePixelRatio || 1;
	const snap = (v) => Math.round(v * dpr) / dpr;   // 実ピクセル格子に合わせて継ぎ目をなくす
	for (const [key, ref] of store.layers[layerKey]) {
		const cat = CATEGORIES.find((c) => c.key === ref.catKey);
		if (!cat || !cat.ready) continue;
		const [col, row] = key.split(",").map(Number);
		const a = w2s(col * GRID, row * GRID);
		const b = w2s((col + 1) * GRID, (row + 1) * GRID);
		const x0 = snap(a.x), y0 = snap(a.y);
		const x1 = snap(b.x), y1 = snap(b.y);
		ctx.drawImage(cat.img, ref.tileCol * 32, ref.tileRow * 32, 32, 32, x0, y0, x1 - x0, y1 - y0);
	}
}
// 家具：配列順（後ろほど手前）に、シートの選択範囲を等倍で描く
function drawFurniture() {
	ctx.imageSmoothingEnabled = false;
	const dpr = window.devicePixelRatio || 1;
	const snap = (v) => Math.round(v * dpr) / dpr;
	for (const f of store.furniture) {
		const cat = FURNITURE.find((c) => c.key === f.cat);
		if (!cat || !cat.ready) continue;
		const a = w2s(f.x, f.y), b = w2s(f.x + f.sw, f.y + f.sh);
		const x0 = snap(a.x), y0 = snap(a.y), x1 = snap(b.x), y1 = snap(b.y);
		ctx.drawImage(cat.img, f.sx, f.sy, f.sw, f.sh, x0, y0, x1 - x0, y1 - y0);
		if (store.target === "furniture") {   // 編集中は枠を薄く表示
			ctx.strokeStyle = "rgba(31,63,176,0.5)";
			ctx.lineWidth = 1;
			ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
			if (f.url) {   // リンクありは右上に印
				ctx.fillStyle = "#1f3fb0";
				ctx.beginPath();
				ctx.arc(x1 - 6, y0 + 6, 5, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}
}
// 点を含む一番手前の家具を返す
function furnitureAt(x, y) {
	for (let i = store.furniture.length - 1; i >= 0; i--) {
		const f = store.furniture[i];
		if (x >= f.x && x < f.x + f.sw && y >= f.y && y < f.y + f.sh) return f;
	}
	return null;
}
function removeFurniture(f) {
	const i = store.furniture.indexOf(f);
	if (i >= 0) store.furniture.splice(i, 1);
}

function drawZones() {
	for (const z of store.zones) {
		const a = w2s(z.x, z.y), b = w2s(z.x + z.w, z.y + z.h);
		ctx.fillStyle = "rgba(31,63,176,0.06)";
		ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
		ctx.strokeStyle = "rgba(31,63,176,0.7)";
		ctx.lineWidth = 2;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
		ctx.setLineDash([]);
		ctx.fillStyle = "rgba(31,63,176,0.95)";
		ctx.font = "700 13px system-ui, 'Noto Sans JP', sans-serif";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText(z.name, a.x + 4, a.y + 4);

		// 会話エリアタブのときは四隅にリサイズ用のつまみを表示
		if (store.target === "zone") {
			const hs = 5;
			ctx.fillStyle = "rgba(31,63,176,0.9)";
			for (const [cx, cy] of [[z.x, z.y], [z.x + z.w, z.y], [z.x, z.y + z.h], [z.x + z.w, z.y + z.h]]) {
				const s = w2s(cx, cy);
				ctx.fillRect(s.x - hs, s.y - hs, hs * 2, hs * 2);
			}
		}
	}
}
// コメント（看板）：角丸・枠線なし・やわらかい影。コメントタブのときだけ四隅つまみも表示。
function drawComments() {
	for (const c of store.comments) {
		drawCommentBox(ctx, c);
		if (store.target === "comment") {
			const hs = 5;
			ctx.fillStyle = "#1f3fb0";
			for (const [cx, cy] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]]) {
				const s = w2s(cx, cy);
				ctx.fillRect(s.x - hs, s.y - hs, hs * 2, hs * 2);
			}
		}
	}
}

function drawPreview() {
	if (grabbedRect) return;   // 移動中はプレビュー矩形を出さない
	if (!painting) return;
	if (store.target === "comment" && !store.erase) return;   // 看板はクリックで作成（プレビュー不要）
	if (!startCell || !curCell) return;
	const { c0, c1, r0, r1 } = bounds(startCell, curCell);
	const a = w2s(c0 * GRID, r0 * GRID);
	const b = w2s((c1 + 1) * GRID, (r1 + 1) * GRID);
	ctx.fillStyle = store.erase ? "rgba(178,58,42,0.25)" : "rgba(31,63,176,0.20)";
	ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
	ctx.strokeStyle = store.erase ? "rgba(178,58,42,0.9)" : "rgba(31,63,176,0.9)";
	ctx.lineWidth = 2;
	ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
}

// ── マウス操作 ──
function pointerCell(e) {
	const p = s2w(canvas, e.clientX, e.clientY);
	const col = Math.max(0, Math.min(COLS - 1, Math.floor(p.x / GRID)));
	const row = Math.max(0, Math.min(ROWS - 1, Math.floor(p.y / GRID)));
	return { col, row };
}
// 会話エリア／コメントのように矩形を編集する対象か
function isRectTarget() { return store.target === "zone" || store.target === "comment"; }
// いま編集中の矩形リスト（会話エリア or コメント）
function activeRects() { return store.target === "comment" ? store.comments : store.zones; }

function onDown(e) {
	// 家具：クリックで配置、既存はドラッグで移動、消去で削除
	if (store.target === "furniture") {
		const p = s2w(canvas, e.clientX, e.clientY);
		const hit = furnitureAt(p.x, p.y);
		if (store.erase) {
			if (hit) { removeFurniture(hit); afterEdit("furniture"); }
		} else if (hit) {
			grabbedFurniture = hit; grabFurOff = { x: p.x - hit.x, y: p.y - hit.y };
			furStart = p; furMoved = false; furJustPlaced = false;
			canvas.setPointerCapture(e.pointerId);
		} else if (store.furnitureBrush) {
			const br = store.furnitureBrush;
			const nf = {
				id: uid(), cat: br.cat, sx: br.sx, sy: br.sy, sw: br.sw, sh: br.sh,
				x: Math.max(0, Math.min(WORLD.w - br.sw, snapQuarter(p.x - br.sw / 2))),
				y: Math.max(0, Math.min(WORLD.h - br.sh, snapQuarter(p.y - br.sh / 2))),
			};
			store.furniture.push(nf);   // 後ろ＝手前
			grabbedFurniture = nf; grabFurOff = { x: p.x - nf.x, y: p.y - nf.y };
			furStart = p; furMoved = false; furJustPlaced = true;
			canvas.setPointerCapture(e.pointerId);
			afterEdit("furniture");
		}
		draw();
		return;
	}
	// 会話エリア・コメントタブ（消去でない）：四隅ならリサイズ、内部なら移動を開始
	if (isRectTarget() && !store.erase) {
		const p = s2w(canvas, e.clientX, e.clientY);
		const list = activeRects();
		let target = null, corner = null;
		for (let i = list.length - 1; i >= 0; i--) {
			const c = cornerAt(list[i], e);
			if (c) { target = list[i]; corner = c; break; }
		}
		if (!target) target = rectAt(list, p.x, p.y);
		if (target) {
			grabbedRect = target;
			grabMode = corner ? "resize" : "move";
			resizeCorner = corner;
			grabPointer = p;
			grabOrig = { x: target.x, y: target.y, w: target.w, h: target.h };
			grabMoved = false;
		}
	}
	painting = true;
	startCell = pointerCell(e);
	curCell = startCell;
	startPx = curPx = s2w(canvas, e.clientX, e.clientY);
	canvas.setPointerCapture(e.pointerId);
	draw();
}
function onMove(e) {
	if (grabbedFurniture) {   // 家具のドラッグ移動（自由位置・1/4マス吸着）
		const p = s2w(canvas, e.clientX, e.clientY);
		if (!furMoved && Math.hypot(p.x - furStart.x, p.y - furStart.y) > 4) furMoved = true;
		if (furMoved) {
			grabbedFurniture.x = Math.max(0, Math.min(WORLD.w - grabbedFurniture.sw, snapQuarter(p.x - grabFurOff.x)));
			grabbedFurniture.y = Math.max(0, Math.min(WORLD.h - grabbedFurniture.sh, snapQuarter(p.y - grabFurOff.y)));
		}
		draw();
		return;
	}
	if (!painting) return;
	if (grabbedRect) {
		const p = s2w(canvas, e.clientX, e.clientY);
		if (Math.hypot(p.x - grabPointer.x, p.y - grabPointer.y) > 4) grabMoved = true;
		if (grabMode === "move") {
			// 看板はグリッドに合わせず自由に、会話エリアはマス単位で移動
			let nx = grabOrig.x + (p.x - grabPointer.x);
			let ny = grabOrig.y + (p.y - grabPointer.y);
			if (store.target !== "comment") { nx = snapGrid(nx); ny = snapGrid(ny); }
			grabbedRect.x = Math.round(Math.max(0, Math.min(WORLD.w - grabbedRect.w, nx)));
			grabbedRect.y = Math.round(Math.max(0, Math.min(WORLD.h - grabbedRect.h, ny)));
		} else {
			resizeTo(p);
		}
		draw();
		return;
	}
	curCell = pointerCell(e);
	curPx = s2w(canvas, e.clientX, e.clientY);
	draw();
}
function onUp() {
	if (grabbedFurniture) {   // 家具：移動を確定、動かさずクリックならリンク設定
		if (furMoved) afterEdit("furniture");
		else if (!furJustPlaced) openFurniModal(grabbedFurniture);
		grabbedFurniture = null; grabFurOff = null; furStart = null; furMoved = false; furJustPlaced = false;
		draw();
		return;
	}
	if (!painting) return;
	painting = false;
	const a = startCell, b = curCell;
	startCell = curCell = null;
	let changed = false, kind = "tile";

	if (grabbedRect) {
		kind = store.target;   // "zone" または "comment"
		if (!grabMoved) {
			// 動かしていない：移動つかみならクリック＝編集、四隅つかみなら何もしない
			if (grabMode === "move") changed = editRectAt(a);
		} else if (store.target === "zone" && overlapsExisting(grabbedRect.x, grabbedRect.y, grabbedRect.w, grabbedRect.h, grabbedRect)) {
			Object.assign(grabbedRect, grabOrig);   // 会話エリアは重ねられないので元に戻す
			alert("会話エリア同士は重ねられません");
		} else {
			changed = true;
		}
		grabbedRect = grabMode = resizeCorner = grabPointer = grabOrig = null;
		grabMoved = false;
	} else if (store.target === "zone") {
		kind = "zone";
		if (store.erase) changed = eraseZones(a, b);
		else if (!(a.col === b.col && a.row === b.row)) changed = createZone(a, b);   // 空きをドラッグ＝作成
	} else if (store.target === "comment") {
		kind = "comment";
		if (store.erase) changed = eraseComments(a, b);
		else changed = createCommentPx();   // 看板は自由サイズ（ピクセル）で作成
	} else if (store.target === "block") {
		changed = store.erase ? eraseBlocked(a, b) : placeBlocked(a, b);   // レイアウトとして保存
	} else {
		if (store.erase) changed = eraseTiles(a, b);
		else changed = placeTiles(a, b);
	}
	startPx = curPx = null;
	if (changed) afterEdit(kind);
	draw();
}

// 四隅ドラッグでのリサイズ（グリッド吸着・最小1マス・ワールド内に収める）
function resizeTo(p) {
	// 看板はグリッドに合わせず自由・最小半マス、会話エリアはマス単位・最小1マス
	const isComment = store.target === "comment";
	const snap = isComment ? (v) => v : snapGrid;
	const minH = isComment ? GRID / 2 : GRID;
	let x0 = grabOrig.x, y0 = grabOrig.y, x1 = grabOrig.x + grabOrig.w, y1 = grabOrig.y + grabOrig.h;
	if (resizeCorner === "nw" || resizeCorner === "sw") x0 = snap(p.x); else x1 = snap(p.x);
	if (resizeCorner === "nw" || resizeCorner === "ne") y0 = snap(p.y); else y1 = snap(p.y);
	let left = Math.max(0, Math.min(x0, x1)), right = Math.min(WORLD.w, Math.max(x0, x1));
	let top = Math.max(0, Math.min(y0, y1)), bottom = Math.min(WORLD.h, Math.max(y0, y1));
	if (right - left < GRID) right = left + GRID;
	if (bottom - top < minH) bottom = top + minH;
	grabbedRect.x = Math.round(left); grabbedRect.y = Math.round(top);
	grabbedRect.w = Math.round(right - left); grabbedRect.h = Math.round(bottom - top);
}

// 編集後：自動保存なら保存、手動保存なら「未保存」にする
function afterEdit(kind) {
	if (store.autoSave) {
		if (kind === "zone") saveZones();
		else if (kind === "comment") saveComments();
		else if (kind === "furniture") saveFurniture();
		else saveLayout();
	} else store.dirty = true;
	updateSaveUI();
}

// ── 範囲ヘルパー ──
function bounds(a, b) {
	return {
		c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col),
		r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row),
	};
}

// ── タイルの配置／消去（対象レイヤーのみ） ──
function placeTiles(a, b) {
	if (!store.selectedTile) return false;
	const { c0, c1, r0, r1 } = bounds(a, b);
	for (let row = r0; row <= r1; row++) {
		for (let col = c0; col <= c1; col++) {
			store.layers[store.selectedTile.layer].set(`${col},${row}`, {
				catKey: store.selectedTile.catKey,
				tileCol: store.selectedTile.tileCol,
				tileRow: store.selectedTile.tileRow,
			});
		}
	}
	return true;
}
function eraseTiles(a, b) {
	const { c0, c1, r0, r1 } = bounds(a, b);
	let changed = false;
	for (let row = r0; row <= r1; row++) {
		for (let col = c0; col <= c1; col++) {
			if (store.layers[store.target].delete(`${col},${row}`)) changed = true;
		}
	}
	return changed;
}
function placeBlocked(a, b) {
	const { c0, c1, r0, r1 } = bounds(a, b);
	for (let row = r0; row <= r1; row++) {
		for (let col = c0; col <= c1; col++) store.blocked.add(`${col},${row}`);
	}
	return true;
}
function eraseBlocked(a, b) {
	const { c0, c1, r0, r1 } = bounds(a, b);
	let changed = false;
	for (let row = r0; row <= r1; row++) {
		for (let col = c0; col <= c1; col++) {
			if (store.blocked.delete(`${col},${row}`)) changed = true;
		}
	}
	return changed;
}

// ── 会話エリアの作成／消去 ──
function uid() {
	try { return crypto.randomUUID().slice(0, 8); } catch { return "z" + Math.floor(Math.random() * 1e9).toString(36); }
}
function createZone(a, b) {
	const { c0, c1, r0, r1 } = bounds(a, b);
	const x = c0 * GRID, y = r0 * GRID;
	const w = (c1 - c0 + 1) * GRID, h = (r1 - r0 + 1) * GRID;
	if (w < GRID || h < GRID) return false;
	if (overlapsExisting(x, y, w, h)) { alert("会話エリア同士は重ねられません"); return false; }
	store.zones.push({ id: uid(), x, y, w, h, name: `会話エリア${store.zones.length + 1}` });
	return true;
}
// 既存エリアと重なるか（except は判定から除外＝移動中の自分）
function overlapsExisting(x, y, w, h, except) {
	return store.zones.some((z) => z !== except && z.x < x + w && z.x + z.w > x && z.y < y + h && z.y + z.h > y);
}
// 点を含む矩形を返す（リストの上にあるものを優先。無ければ null）
function rectAt(list, wx, wy) {
	for (let i = list.length - 1; i >= 0; i--) {
		const z = list[i];
		if (wx >= z.x && wx < z.x + z.w && wy >= z.y && wy < z.y + z.h) return z;
	}
	return null;
}
function zoneAt(wx, wy) { return rectAt(store.zones, wx, wy); }

// 矩形のクリック編集：会話エリアは名前、コメントは文字を変更
function editRectAt(cell) {
	return store.target === "comment" ? editCommentAt(cell) : renameZoneAt(cell);
}
// クリックしたエリアの名前を変更
function renameZoneAt(cell) {
	const wx = cell.col * GRID + GRID / 2, wy = cell.row * GRID + GRID / 2;
	const z = zoneAt(wx, wy);
	if (!z) return false;
	const name = prompt("会話エリアの名前", z.name);
	if (name === null) return false;                 // キャンセル
	const trimmed = name.trim();
	if (!trimmed || trimmed === z.name) return false;
	z.name = trimmed;
	return true;
}
function eraseZones(a, b) {
	const { c0, c1, r0, r1 } = bounds(a, b);
	const x0 = c0 * GRID, y0 = r0 * GRID, x1 = (c1 + 1) * GRID, y1 = (r1 + 1) * GRID;
	const before = store.zones.length;
	// ドラッグ範囲と重なるエリアを削除
	store.zones = store.zones.filter((z) => !(z.x < x1 && z.x + z.w > x0 && z.y < y1 && z.y + z.h > y0));
	return store.zones.length !== before;
}

// ── コメント（看板）の作成／編集／消去 ──
// 作成・編集は設定モーダルで行う（保存はモーダルの「保存」ボタン側）。
function createCommentPx() {
	if (!startPx) return false;
	// クリック位置を中心に、デフォルトサイズで作成（あとで自由に移動・リサイズ）
	const w = GRID * 6, h = GRID * 3;
	const x = Math.round(Math.max(0, Math.min(WORLD.w - w, startPx.x - w / 2)));
	const y = Math.round(Math.max(0, Math.min(WORLD.h - h, startPx.y - h / 2)));
	openCommentModal("create", { x, y, w, h });
	return false;   // 追加はモーダルの保存で行うので、ここでは保存しない
}
function editCommentAt(cell) {
	const wx = cell.col * GRID + GRID / 2, wy = cell.row * GRID + GRID / 2;
	const c = rectAt(store.comments, wx, wy);
	if (!c) return false;
	openCommentModal("edit", c);
	return false;   // 変更はモーダルの保存で行う
}
function eraseComments(a, b) {
	const { c0, c1, r0, r1 } = bounds(a, b);
	const x0 = c0 * GRID, y0 = r0 * GRID, x1 = (c1 + 1) * GRID, y1 = (r1 + 1) * GRID;
	const before = store.comments.length;
	store.comments = store.comments.filter((c) => !(c.x < x1 && c.x + c.w > x0 && c.y < y1 && c.y + c.h > y0));
	return store.comments.length !== before;
}
