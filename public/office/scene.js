// 描画（マップ・タイル・エリア・アバター）とキーボード移動。
import { GRID, WORLD, w2s, s2w, setViewport, drawBase, drawCommentBox } from "../map.js";
import { store, SHEETS, zoneIdAt, DEFAULT_AVATAR } from "./store.js";
import { sendComment, removeComment, sendChat, sendAway, sendCall } from "./net.js";
import { layerImg, drawAvatar } from "../avatar.js";

const stage = document.getElementById("stage");
const canvas = document.getElementById("plan");
const ctx = canvas.getContext("2d");

const SPEED = 260;          // 移動速度（論理px/秒）
const LERP_DELAY = 120;     // 他人は120ms過去を補間して滑らかに描く
const NEAR = GRID * 2;      // エリア外で会話できる範囲（voice.js と同じ半径2マス）
const heldKeys = new Set();
let hover = null;           // カーソルの論理座標（会話エリアのホバー・コメント削除用）
let dragComment = null;     // 操作中のオフィス看板
let dragMode = null;        // "move" | "resize"
let dragCorner = null;      // リサイズ中の角（nw/ne/sw/se）
let dragOff = null;         // 移動時：つかんだ位置と左上のズレ
let dragOrig = null;        // リサイズ時：元の {x,y,w,h}
let dragStart = null;       // つかんだ論理座標（クリック判定用）
let dragMoved = false;      // しきい値を超えて動かしたか

// ── 入力・移動 ──
export function initInput() {
	window.addEventListener("keydown", (e) => {
		if (isTyping(e.target)) return;   // 入力欄では移動キー（wasd等）を奪わない
		const k = e.key.toLowerCase();
		if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
			heldKeys.add(k);
			e.preventDefault();
		}
	});
	window.addEventListener("keyup", (e) => heldKeys.delete(e.key.toLowerCase()));
	window.addEventListener("blur", () => heldKeys.clear());
	window.addEventListener("resize", fit);

	// カーソル位置の記録＋看板の移動／リサイズ
	canvas.addEventListener("pointermove", (e) => {
		hover = s2w(canvas, e.clientX, e.clientY);
		if (!dragComment) return;
		if (!dragMoved && Math.hypot(hover.x - dragStart.x, hover.y - dragStart.y) > 4) dragMoved = true;
		if (!dragMoved) return;
		if (dragMode === "resize") {
			resizeComment(dragComment, dragCorner, hover, dragOrig);
		} else {
			dragComment.x = Math.max(0, Math.min(WORLD.w - dragComment.w, Math.round(hover.x - dragOff.x)));
			dragComment.y = Math.max(0, Math.min(WORLD.h - dragComment.h, Math.round(hover.y - dragOff.y)));
		}
	});
	canvas.addEventListener("pointerleave", () => { hover = null; });

	// オフィス作成の看板：×で削除、四隅ドラッグで拡大縮小、内部ドラッグで移動、クリックで再編集
	canvas.addEventListener("pointerdown", (e) => {
		const rect = canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
		const p = s2w(canvas, e.clientX, e.clientY);
		for (let i = store.officeComments.length - 1; i >= 0; i--) {
			const c = store.officeComments[i];
			if (isExpired(c)) continue;   // 期限切れは操作対象外
			const corner = cornerAtScreen(c, sx, sy);
			if (!corner && !pointInRect(p, c)) continue;
			const ctr = deleteBtnCenter(c);
			if (Math.hypot(sx - ctr.x, sy - ctr.y) <= 12) { removeComment(c.id); return; }   // ×で削除
			dragComment = c; dragStart = p; dragMoved = false;
			if (corner) { dragMode = "resize"; dragCorner = corner; dragOrig = { x: c.x, y: c.y, w: c.w, h: c.h }; }
			else { dragMode = "move"; dragOff = { x: p.x - c.x, y: p.y - c.y }; }
			canvas.setPointerCapture(e.pointerId);
			return;
		}
	});
	canvas.addEventListener("pointerup", () => {
		if (!dragComment) return;
		if (!dragMoved && dragMode === "move") openCommentModal(dragComment);   // 動かさずクリック＝再編集
		else if (dragMoved) sendComment(dragComment);                           // 移動・リサイズを全員へ共有
		dragComment = dragMode = dragCorner = dragOff = dragOrig = dragStart = null;
		dragMoved = false;
	});

	// ダブルクリックでその場所へ移動
	canvas.addEventListener("dblclick", (e) => {
		if (store.me.away) return;                       // 離席中は移動しない
		const p = s2w(canvas, e.clientX, e.clientY);
		for (const c of store.officeComments) if (!isExpired(c) && pointInRect(p, c)) return;   // 看板の上は対象外
		const x = Math.max(0, Math.min(WORLD.w, p.x));
		const y = Math.max(0, Math.min(WORLD.h, p.y));
		if (isBlocked(x, y)) return;                     // 通行禁止マスには行かない
		store.me.x = x;
		store.me.y = y;
	});
}
// テキスト入力欄などにフォーカスがあるか
function isTyping(t) {
	return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

// ── コメント作成モーダル（オフィス側） ──
let editingComment = null;   // 再編集中の看板（null＝新規作成）

export function initCommentUI() {
	const addBtn = document.getElementById("comment-add-btn");
	const cancel = document.getElementById("c-cancel");
	const save = document.getElementById("c-save");
	const modal = document.getElementById("comment-modal");
	if (addBtn) addBtn.addEventListener("click", () => openCommentModal());
	if (cancel) cancel.addEventListener("click", closeCommentModal);
	if (save) save.addEventListener("click", saveCommentModal);
	if (modal) modal.addEventListener("click", (e) => { if (e.target.id === "comment-modal") closeCommentModal(); });
	fillExpirySelects();
}

// 期限日時のプルダウン（年/月/日/時/分）を作る（初回のみ）
function fillExpirySelects() {
	const y = document.getElementById("c-year");
	if (!y || y.options.length) return;
	const mo = document.getElementById("c-month");
	const d = document.getElementById("c-day");
	const h = document.getElementById("c-hour");
	const mi = document.getElementById("c-min");
	const opt = (sel, val, label) => { const o = document.createElement("option"); o.value = String(val); o.textContent = label; sel.appendChild(o); };
	const yr = new Date().getFullYear();
	for (let i = 0; i <= 2; i++) opt(y, yr + i, String(yr + i));
	for (let m = 1; m <= 12; m++) opt(mo, m, String(m));
	for (let dd = 1; dd <= 31; dd++) opt(d, dd, String(dd));
	for (let hh = 0; hh <= 23; hh++) opt(h, hh, String(hh).padStart(2, "0"));
	for (let mm = 0; mm < 60; mm += 15) opt(mi, mm, String(mm).padStart(2, "0"));   // 15分刻み
}
function setExpirySelects(dt) {
	document.getElementById("c-year").value = String(dt.getFullYear());
	document.getElementById("c-month").value = String(dt.getMonth() + 1);
	document.getElementById("c-day").value = String(dt.getDate());
	document.getElementById("c-hour").value = String(dt.getHours());
	document.getElementById("c-min").value = String(Math.floor(dt.getMinutes() / 15) * 15);   // 15分刻みに合わせる
}
function openCommentModal(target) {
	editingComment = target && target.id ? target : null;
	const src = editingComment || {};
	heldKeys.clear();   // モーダル中はアバターを動かさない
	const title = document.getElementById("c-title");
	if (title) title.textContent = editingComment ? "看板の編集" : "看板の作成";
	const save = document.getElementById("c-save");
	if (save) save.textContent = editingComment ? "保存" : "作成";
	document.getElementById("c-text").value = src.text || "";
	document.getElementById("c-size").value = String(src.size || 16);
	document.getElementById("c-color").value = src.color || "#141815";
	document.getElementById("c-bg").value = src.bg || "#ffffff";
	document.getElementById("c-bold").checked = !!src.bold;
	document.getElementById("c-italic").checked = !!src.italic;
	// 期限日時：既存はその値、新規は「今から1時間後」を初期値に
	const base = src.expireAt ? new Date(src.expireAt) : new Date(Date.now() + 60 * 60 * 1000);
	base.setSeconds(0, 0);
	setExpirySelects(base);
	const err = document.getElementById("c-err");
	if (err) err.textContent = "";
	document.getElementById("comment-modal").classList.add("open");
	document.getElementById("c-text").focus();
}
function closeCommentModal() {
	document.getElementById("comment-modal").classList.remove("open");
	editingComment = null;
	if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // 入力欄からフォーカスを外す
}
function saveCommentModal() {
	const err = document.getElementById("c-err");
	const setErr = (m) => { if (err) err.textContent = m || ""; };
	// 期限日時は未来のみ許可。存在しない日付（例：2月30日）は弾く。
	const y = +document.getElementById("c-year").value;
	const mo = +document.getElementById("c-month").value;
	const d = +document.getElementById("c-day").value;
	const h = +document.getElementById("c-hour").value;
	const mi = +document.getElementById("c-min").value;
	const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
	if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) { setErr("その日付は存在しません。"); return; }
	const expireAt = dt.getTime();
	if (expireAt <= Date.now()) { setErr("未来の日時を指定してください。"); return; }
	const fields = {
		text: document.getElementById("c-text").value.trim(),
		size: Number(document.getElementById("c-size").value) || 16,
		color: document.getElementById("c-color").value,
		bg: document.getElementById("c-bg").value,
		bold: document.getElementById("c-bold").checked,
		italic: document.getElementById("c-italic").checked,
		expireAt,
	};
	if (editingComment) {
		Object.assign(editingComment, fields);   // 既存を更新（id・位置・大きさは維持）
		sendComment(editingComment);
	} else {
		const w = GRID * 6, h = GRID * 3;
		// 自分の少し上に置く（画面外にはみ出さないよう収める）
		const x = Math.max(0, Math.min(WORLD.w - w, store.me.x - w / 2));
		const y = Math.max(0, Math.min(WORLD.h - h, store.me.y - h - GRID));
		sendComment({ id: uid(), x: Math.round(x), y: Math.round(y), w, h, ...fields });
	}
	closeCommentModal();   // サーバーが全員へ配信し、返ってきたリストで表示される
}
function uid() {
	try { return crypto.randomUUID().slice(0, 8); } catch { return "c" + Math.floor(Math.random() * 1e9).toString(36); }
}

// ── 家具リンク：2マス以内に入ったら「開きますか？」を出す ──
let currentLink = null;

export function initLinkPrompt() {
	const btn = document.getElementById("link-open");
	if (btn) btn.addEventListener("click", () => {
		if (!currentLink) return;
		let u = currentLink;
		if (!/^https?:\/\//i.test(u)) u = "https://" + u;
		window.open(u, "_blank", "noopener");
	});
}

// リンク付き家具のうち、自分から2マス以内で一番近いもののプロンプトを出す
export function updateLinkPrompt() {
	const el = document.getElementById("link-prompt");
	if (!el) return;
	let best = null, bestD = Infinity;
	for (const f of store.furniture) {
		if (!f.url) continue;
		const nx = Math.max(f.x, Math.min(store.me.x, f.x + f.sw));   // 家具矩形上の最近点
		const ny = Math.max(f.y, Math.min(store.me.y, f.y + f.sh));
		const d = Math.hypot(store.me.x - nx, store.me.y - ny);
		if (d <= GRID * 2 && d < bestD) { best = f; bestD = d; }
	}
	if (best) {
		currentLink = best.url;
		document.getElementById("link-label").textContent = `「${best.label || best.url}」を開きますか？`;
		el.hidden = false;
	} else {
		currentLink = null;
		el.hidden = true;
	}
}

// ── 呼び出し：近くにいる人にボタンを出す ──
// 条件は「半径NEAR以内」かつ「離席中でない」。同じ条件をサーバーでも検査している。
// 表示中のボタンを作り直すと押せなくなるので、顔ぶれが変わったときだけ組み直す。
let callPromptKey = "";

function nearbyCallTargets() {
	const list = [];
	for (const [id, o] of store.others) {
		if (!o.name || o.away) continue;
		const p = o.buf[o.buf.length - 1];
		if (!p) continue;
		const d = Math.hypot(p.x - store.me.x, p.y - store.me.y);
		if (d <= NEAR) list.push({ id, name: o.name, d });
	}
	return list.sort((a, b) => a.d - b.d).slice(0, 3);   // 多すぎても押せないので近い順に3人まで
}

export function updateCallPrompt() {
	const el = document.getElementById("call-prompt");
	if (!el) return;
	if (store.me.away) { el.hidden = true; callPromptKey = ""; return; }   // 離席中は呼び出さない

	const targets = nearbyCallTargets();
	const key = targets.map((t) => `${t.id}:${t.name}`).join("|");
	if (key === callPromptKey) return;
	callPromptKey = key;

	if (!targets.length) { el.hidden = true; el.replaceChildren(); return; }

	el.replaceChildren(...targets.map((t) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "call-btn";
		btn.textContent = `${t.name}さんを呼び出す`;
		btn.addEventListener("click", () => {
			sendCall(t.id);
			btn.disabled = true;                                  // 連打防止（サーバー側でも弾く）
			setTimeout(() => { btn.disabled = false; }, 10_000);
		});
		return btn;
	}));
	el.hidden = false;
}

// 呼び出しを受けたときの画面バナー。数秒で自然に消す。
export function updateCallAlert() {
	const el = document.getElementById("call-alert");
	if (!el) return;
	const a = store.callAlert;
	if (!a) { if (!el.hidden) el.hidden = true; return; }
	if (Date.now() - a.at > 8000) { store.callAlert = null; el.hidden = true; return; }
	const text = `🔔 ${a.name}さんから呼び出しがあります`;
	if (el.textContent !== text) el.textContent = text;
	el.hidden = false;
}

export function update(dt) {
	if (store.me.away) { heldKeys.clear(); store.me.moving = false; return; }   // 離席中は移動できない
	let dx = 0, dy = 0;
	if (heldKeys.has("w") || heldKeys.has("arrowup")) dy -= 1;
	if (heldKeys.has("s") || heldKeys.has("arrowdown")) dy += 1;
	if (heldKeys.has("a") || heldKeys.has("arrowleft")) dx -= 1;
	if (heldKeys.has("d") || heldKeys.has("arrowright")) dx += 1;
	if (!dx && !dy) { store.me.moving = false; return; }
	store.me.moving = true;
	store.me.dir = faceDir(dx, dy);
	const len = Math.hypot(dx, dy);   // 斜めでも速さを一定に
	// 軸ごとに判定して、壁沿いに滑れるようにする
	const nx = Math.max(0, Math.min(WORLD.w, store.me.x + (dx / len) * SPEED * dt));
	if (!isBlocked(nx, store.me.y)) store.me.x = nx;
	const ny = Math.max(0, Math.min(WORLD.h, store.me.y + (dy / len) * SPEED * dt));
	if (!isBlocked(store.me.x, ny)) store.me.y = ny;
}

// 移動量から向き（up/left/down/right）を決める
function faceDir(dx, dy) {
	if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx > 0 ? "right" : "left";
	return dy > 0 ? "down" : "up";
}

// その論理座標のマスが通行禁止か
function isBlocked(x, y) {
	const col = Math.floor(x / GRID), row = Math.floor(y / GRID);
	return store.blocked.has(`${col},${row}`);
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
	drawLayer("floor");     // 床（下）
	drawLayer("rug");       // 敷物（中）
	drawWallsAndActors();   // 壁とアバターは足元の行で前後を判定して描く
	drawZones();            // 会話エリアのホバー表示
	drawComments();         // コメント（メモ）は一番上のレイヤー
}

// コメント（看板）：角丸・枠線なし。常に最前面に表示する。
// 管理者作成（store.comments）は表示のみ。オフィス作成（store.officeComments）はホバーで削除ボタン。
function drawComments() {
	for (const c of store.comments) drawCommentBox(ctx, c);
	for (const c of store.officeComments) {
		if (isExpired(c)) continue;   // 期限切れは表示しない
		drawCommentBox(ctx, c);
		// ホバー中・操作中は削除ボタンとリサイズ用のつまみを出す
		if ((hover && pointInRect(hover, c)) || c === dragComment) { drawDeleteBtn(c); drawHandles(c); }
	}
}
function pointInRect(p, c) { return p.x >= c.x && p.x < c.x + c.w && p.y >= c.y && p.y < c.y + c.h; }

// 消える日時を過ぎた看板か
function isExpired(c) { return !!(c && c.expireAt && c.expireAt <= Date.now()); }

// 期限切れの看板を削除依頼（サーバーが全員へ反映）。多重送信を防ぐ。
const expiredRequested = new Set();
export function sweepExpiredComments() {
	for (const c of store.officeComments) {
		if (isExpired(c) && !expiredRequested.has(c.id)) {
			expiredRequested.add(c.id);
			removeComment(c.id);
		}
	}
}
function deleteBtnCenter(c) { const tr = w2s(c.x + c.w, c.y); return { x: tr.x - 12, y: tr.y + 12 }; }
function drawDeleteBtn(c) {
	const ctr = deleteBtnCenter(c);
	ctx.beginPath();
	ctx.arc(ctr.x, ctr.y, 11, 0, Math.PI * 2);
	ctx.fillStyle = "#b23a2a";
	ctx.fill();
	ctx.strokeStyle = "#fff";
	ctx.lineWidth = 2;
	const r = 4;
	ctx.beginPath();
	ctx.moveTo(ctr.x - r, ctr.y - r); ctx.lineTo(ctr.x + r, ctr.y + r);
	ctx.moveTo(ctr.x + r, ctr.y - r); ctx.lineTo(ctr.x - r, ctr.y + r);
	ctx.stroke();
}
// 四隅のリサイズつまみ
function drawHandles(c) {
	const hs = 5;
	ctx.fillStyle = "#1f3fb0";
	for (const [wx, wy] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]]) {
		const s = w2s(wx, wy);
		ctx.fillRect(s.x - hs, s.y - hs, hs * 2, hs * 2);
	}
}
// 画面上(sx,sy)がどの角の近くか（12px以内）。なければ null。
function cornerAtScreen(c, sx, sy) {
	const pts = [["nw", c.x, c.y], ["ne", c.x + c.w, c.y], ["sw", c.x, c.y + c.h], ["se", c.x + c.w, c.y + c.h]];
	for (const [k, wx, wy] of pts) {
		const s = w2s(wx, wy);
		if (Math.hypot(s.x - sx, s.y - sy) <= 12) return k;
	}
	return null;
}
// 四隅ドラッグでのリサイズ（最小1マス・ワールド内に収める）
function resizeComment(c, corner, p, orig) {
	let x0 = orig.x, y0 = orig.y, x1 = orig.x + orig.w, y1 = orig.y + orig.h;
	if (corner === "nw" || corner === "sw") x0 = p.x; else x1 = p.x;
	if (corner === "nw" || corner === "ne") y0 = p.y; else y1 = p.y;
	let left = Math.max(0, Math.min(x0, x1)), right = Math.min(WORLD.w, Math.max(x0, x1));
	let top = Math.max(0, Math.min(y0, y1)), bottom = Math.min(WORLD.h, Math.max(y0, y1));
	if (right - left < GRID) right = left + GRID;           // 横幅は最小1マス
	if (bottom - top < GRID / 2) bottom = top + GRID / 2;   // 縦幅は最小半マス（16px）
	c.x = Math.round(left); c.y = Math.round(top);
	c.w = Math.round(right - left); c.h = Math.round(bottom - top);
}

// 壁とアバターの前後関係を描く。
// 手順：壁を全部描く → アバターを全身描く（手前の壁には切られない）
//       → そのアバターより北（上）の壁だけ描き直し、頭や名前を奥の壁の裏に隠す。
function drawWallsAndActors() {
	// 1) 壁（objectレイヤー）→ 家具（壁の一つ上）の順に描く。アバターはこの上。
	drawLayer("object");
	drawFurniture();

	// 壁セルの集合（アバターが壁の上に立っているかの判定に使う）
	const wallCells = new Set();
	for (const item of store.layout) {
		if ((item.layer || "floor") === "object") wallCells.add(`${item.col},${item.row}`);
	}

	// 2) アバターを集める（自分＋補間後の他人）。南（下）の人ほど後に描く。
	const actors = [];
	const renderTime = Date.now() - LERP_DELAY;
	for (const o of store.others.values()) {
		const p = renderPos(o.buf, renderTime);
		if (!p) continue;
		// 直近の位置変化から向き・歩行を推定
		let moving = false;
		const b = o.buf;
		if (b.length >= 2) {
			const dx = b[b.length - 1].x - b[b.length - 2].x, dy = b[b.length - 1].y - b[b.length - 2].y;
			if (Math.hypot(dx, dy) > 1) { moving = true; o.dir = faceDir(dx, dy); }
		}
		actors.push({ x: p.x, y: p.y, name: o.name, color: "#b23a2a", away: o.away, awayMsg: o.awayMsg, dir: o.dir || "down", moving, avatar: o.avatar || DEFAULT_AVATAR });
	}
	actors.push({ x: store.me.x, y: store.me.y, name: store.me.name, color: "#1f3fb0", away: store.me.away, awayMsg: store.me.awayMsg, dir: store.me.dir, moving: store.me.moving, avatar: store.me.avatar });
	actors.sort((a, b) => a.y - b.y);

	// 3) アバターを描いた直後、そのアバターより上に来るべき壁だけを描き直す
	for (const a of actors) {
		drawActor(a.x, a.y, a.name, a.color, a);
		coverWalls(a.x, a.y, wallCells);
	}
}

// アバターと重なる壁のうち「壁が上」になるものだけ描き直す。
//  ・壁の上に立っている       → 重なる壁はすべて上（＝全身が壁の裏に隠れる）
//  ・床の上にいて下（南）側の壁 → その壁が上（足元が隠れる）
//  ・床の上にいて上（北）側の壁 → 何もしない（アバターが手前のまま）
function coverWalls(wx, wy, wallCells) {
	const ar = Math.floor(wy / GRID), ac = Math.floor(wx / GRID);
	const onWall = wallCells.has(`${ac},${ar}`);
	for (const item of store.layout) {
		if ((item.layer || "floor") !== "object") continue;
		if (Math.abs(item.col - ac) > 4) continue;        // 名前の幅ぶんだけ見る（軽量化）
		if (item.row < ar - 3 || item.row > ar + 2) continue;
		const cover = onWall ? true : item.row > ar;      // 床なら南（下）側の壁だけ上
		if (cover) drawTile(item);
	}
}

function drawLayer(layerKey) {
	for (const item of store.layout) {
		if ((item.layer || "floor") !== layerKey) continue;
		drawTile(item);
	}
}

// 1マス分のタイルを描く（隣のマスの境界と合わせて継ぎ目なく描く）
function drawTile(item) {
	const sheet = SHEETS[item.cat || "floor"];
	if (!sheet || !sheet.ready) return;
	ctx.imageSmoothingEnabled = false;
	const dpr = window.devicePixelRatio || 1;
	const snap = (v) => Math.round(v * dpr) / dpr;   // 実ピクセル格子に合わせて継ぎ目をなくす
	const a = w2s(item.col * GRID, item.row * GRID);
	const b = w2s((item.col + 1) * GRID, (item.row + 1) * GRID);
	const x0 = snap(a.x), y0 = snap(a.y);
	const x1 = snap(b.x), y1 = snap(b.y);
	ctx.drawImage(sheet.img, item.tileCol * 32, item.tileRow * 32, 32, 32, x0, y0, x1 - x0, y1 - y0);
}

// 家具（壁の一つ上）：配列順（後ろほど手前）に、シートの選択範囲を等倍で描く
function drawFurniture() {
	ctx.imageSmoothingEnabled = false;
	const dpr = window.devicePixelRatio || 1;
	const snap = (v) => Math.round(v * dpr) / dpr;
	for (const f of store.furniture) {
		const sheet = SHEETS[f.cat];
		if (!sheet || !sheet.ready) continue;
		const a = w2s(f.x, f.y), b = w2s(f.x + f.sw, f.y + f.sh);
		const x0 = snap(a.x), y0 = snap(a.y), x1 = snap(b.x), y1 = snap(b.y);
		ctx.drawImage(sheet.img, f.sx, f.sy, f.sw, f.sh, x0, y0, x1 - x0, y1 - y0);
	}
}

// 会話エリアは普段は非表示。カーソルを乗せたエリアだけ薄く表示する。
function drawZones() {
	if (!hover) return;
	for (let i = store.zones.length - 1; i >= 0; i--) {
		const z = store.zones[i];
		if (hover.x < z.x || hover.x >= z.x + z.w || hover.y < z.y || hover.y >= z.y + z.h) continue;
		const a = w2s(z.x, z.y), b = w2s(z.x + z.w, z.y + z.h);
		ctx.fillStyle = "rgba(31,63,176,0.05)";
		ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
		ctx.strokeStyle = "rgba(31,63,176,0.35)";
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
		ctx.setLineDash([]);
		ctx.fillStyle = "rgba(31,63,176,0.6)";
		ctx.font = "700 13px system-ui, 'Noto Sans JP', sans-serif";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText(z.name, a.x + 4, a.y + 4);
		break;   // 一番上のエリアだけ
	}
}

// ── アバター ──
// 画像の読み込みと8レイヤーの重ね描きは avatar.js にある（入室画面と共通）。
// このファイルが持つのは、ワールド座標から画面上の描画先を求める部分だけ。
const DRAW_W = 56, DRAW_H = 56;   // オフィス上でのアバターの大きさ（ワールドpx）

function drawActor(wx, wy, name, color, opt = {}) {
	const cfg = opt.avatar || DEFAULT_AVATAR;
	const feet = w2s(wx, wy);
	const bodyImg = layerImg("body", cfg.body);

	if (bodyImg && bodyImg.ready) {
		// 0コマ目は静止ポーズ。歩いているあいだだけ 1〜8 コマを繰り返す。
		const frame = opt.moving ? 1 + (Math.floor(Date.now() / 120) % 8) : 0;
		// ドット絵がにじまないよう、描画先をデバイス画素の格子に合わせる
		const dpr = window.devicePixelRatio || 1;
		const snap = (v) => Math.round(v * dpr) / dpr;
		const wl = wx - DRAW_W / 2, wt = wy - DRAW_H + 6;   // 足元を(wx,wy)付近に、上へ立たせる
		const a = w2s(wl, wt), b = w2s(wl + DRAW_W, wt + DRAW_H);
		const x0 = snap(a.x), y0 = snap(a.y), x1 = snap(b.x), y1 = snap(b.y);
		ctx.save();
		if (opt.away) ctx.globalAlpha = 0.4;   // 離席中は薄く描く
		drawAvatar(ctx, cfg, { dir: opt.dir || "down", frame, dx: x0, dy: y0, dw: x1 - x0, dh: y1 - y0 });
		ctx.restore();
		drawNamePill(wx, wt, name, color, opt.away);        // 名前は頭上に
	} else {
		// 画像未読込のあいだは丸で代用
		ctx.save();
		if (opt.away) ctx.globalAlpha = 0.4;
		ctx.beginPath(); ctx.arc(feet.x, feet.y, 10, 0, Math.PI * 2);
		ctx.fillStyle = color; ctx.fill();
		ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
		ctx.restore();
		drawNamePill(wx, wy - 24, name, color, opt.away);
	}

	if (opt.away) drawAwayLabel(feet.x, feet.y, opt.awayMsg);
}

// 名前の角丸ラベル（ワールド座標 wx / wtop の少し上に描く）
function drawNamePill(wx, wtop, name, color, away) {
	const top = w2s(wx, wtop);
	ctx.save();
	if (away) ctx.globalAlpha = 0.6;
	ctx.font = "500 12px 'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const padX = 9, h = 20;
	const w = ctx.measureText(name).width + padX * 2;
	const cx = top.x, cy = top.y - 6;
	ctx.shadowColor = "rgba(0,0,0,0.28)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
	ctx.fillStyle = "#ffffff"; ctx.fill();
	ctx.shadowColor = "transparent";
	ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();
	ctx.fillStyle = "#141815";
	ctx.fillText(name, cx, cy + 0.5);
	ctx.restore();
	ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}

// 離席バッジ＋理由をアバターの下に表示
function drawAwayLabel(sx, sy, msg) {
	ctx.font = "600 11px 'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	let text = "離席中" + (msg ? "：" + msg : "");
	while (text.length > 4 && ctx.measureText(text).width > 186) text = text.slice(0, -2) + "…";
	const w = ctx.measureText(text).width + 14;
	const h = 18, cx = sx, cy = sy + 22;
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.25)";
	ctx.shadowBlur = 4;
	ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
	ctx.fillStyle = "#4a5046";
	ctx.fill();
	ctx.restore();
	ctx.fillStyle = "#fff";
	ctx.fillText(text, cx, cy + 0.5);
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
}

// ── 在室者リスト（左メニュー）──
// 会話エリアごとに中の人をまとめる。エリア外にいるときは、いま会話できる
// 「近くの人」（同じくエリア外で半径NEAR以内）を自分視点でまとめて表示する。
export function updateRoster() {
	const el = document.getElementById("roster");
	if (!el) return;

	const myZone = zoneIdAt(store.me.x, store.me.y);

	// 他人を最新位置つきで集める
	const others = [];
	for (const o of store.others.values()) {
		const p = o.buf[o.buf.length - 1];
		if (!p) continue;
		others.push({ name: o.name, x: p.x, y: p.y });
	}

	// 自分が今いるグループだけを表示する
	const members = [{ name: store.me.name, self: true }];
	let title;
	if (myZone) {
		const z = store.zones.find((z) => z.id === myZone);
		title = z ? z.name : "会話エリア";
		for (const p of others) if (zoneIdAt(p.x, p.y) === myZone) members.push({ name: p.name, self: false });
		el.innerHTML = renderGroup(title, members, false);
	} else {
		title = "近くの人";
		for (const p of others) {
			if (zoneIdAt(p.x, p.y) !== null) continue;   // エリア内の人は対象外
			if (Math.hypot(p.x - store.me.x, p.y - store.me.y) <= NEAR) members.push({ name: p.name, self: false });
		}
		el.innerHTML = renderGroup(title, members, true);
	}
}

// ── チャット（左メニュー） ──
export function initChatUI() {
	const form = document.getElementById("chat-form");
	if (!form) return;
	const input = document.getElementById("chat-input");
	const submit = () => {
		const text = input.value.trim();
		if (!text) return;
		sendChat(text);
		input.value = "";
	};
	form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
	// Enterで送信、Shift+Enterで改行
	if (input) input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
	});
}

// ── 勤務者一覧（接続中の全員） ──
export function initPeopleUI() {
	const btn = document.getElementById("people-btn");
	const modal = document.getElementById("people-modal");
	const close = document.getElementById("people-close");
	if (btn) btn.addEventListener("click", () => { renderPeople(); if (modal) modal.classList.add("open"); });
	if (close) close.addEventListener("click", () => { if (modal) modal.classList.remove("open"); });
	if (modal) modal.addEventListener("click", (e) => { if (e.target.id === "people-modal") modal.classList.remove("open"); });
}
// 一覧を開いている間だけ、最新の接続者に更新する
export function updatePeople() {
	const modal = document.getElementById("people-modal");
	if (modal && modal.classList.contains("open")) renderPeople();
}
function renderPeople() {
	const el = document.getElementById("people-list");
	if (!el) return;
	const people = [{ name: store.me.name, self: true, away: store.me.away }];
	for (const o of store.others.values()) people.push({ name: o.name, self: false, away: o.away });
	let html = `<div class="people-count">${people.length}人が接続中</div>`;
	for (const p of people) {
		html += `<div class="person-row${p.self ? " self" : ""}"><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.self ? "（自分）" : ""}${p.away ? '<span class="away-tag">離席中</span>' : ""}</div>`;
	}
	el.innerHTML = html;
}

// ── 退出・離席 ──
export function initAwayUI() {
	const awayBtn = document.getElementById("away-btn");
	const leaveBtn = document.getElementById("leave-btn");
	const modal = document.getElementById("away-modal");
	const saveBtn = document.getElementById("away-save");
	const text = document.getElementById("away-text");

	if (leaveBtn) leaveBtn.addEventListener("click", () => { window.location.href = "index.html"; });

	if (awayBtn) awayBtn.addEventListener("click", () => {
		if (!store.me.away) {
			store.me.away = true;
			setAwayBtn(true);
			sendAway(true, store.me.awayMsg || "");
			if (text) text.value = store.me.awayMsg || "";
			if (modal) modal.classList.add("open");
			if (text) text.focus();
		} else {
			// 着席：離席解除し、モーダルも閉じる
			store.me.away = false;
			store.me.awayMsg = "";
			setAwayBtn(false);
			sendAway(false, "");
			if (modal) modal.classList.remove("open");
		}
	});

	// 更新は理由を反映するだけ。モーダルは閉じない（着席するまで出したまま）
	if (saveBtn) saveBtn.addEventListener("click", () => {
		store.me.awayMsg = text ? text.value.trim() : "";
		sendAway(true, store.me.awayMsg);
	});
}
function setAwayBtn(away) {
	const b = document.getElementById("away-btn");
	if (!b) return;
	b.textContent = away ? "着席" : "離席";
	b.classList.toggle("on", away);
}

// ── 転送量の表示（使用量 / 1000GB） ──
let lastUsage = -1;
export function updateUsage() {
	const el = document.getElementById("usage");
	if (!el) return;
	const used = store.usedGb || 0, limit = store.limitGb || 1000;
	if (used === lastUsage) return;
	lastUsage = used;
	const pct = Math.min(100, (used / limit) * 100);
	const color = pct >= 90 ? "#b23a2a" : pct >= 70 ? "#e0a83f" : "#2a7d3f";
	el.innerHTML =
		`<div class="usage-label">推定通信量 ${used} / ${limit} GB</div>` +
		`<div class="usage-bar"><span style="width:${pct}%;background:${color}"></span></div>`;
}

let lastChatSeq = -1;
export function updateChat() {
	const el = document.getElementById("chat-log");
	if (!el || store.chatSeq === lastChatSeq) return;   // 変化がなければ何もしない
	lastChatSeq = store.chatSeq;
	let html = "";
	for (const m of store.messages) {   // 新着が先頭＝上から新しい順
		if (m.kind === "call") {        // 呼び出しの記録は発言者名を出さず、見た目を分ける
			html += `<div class="chat-msg call">${esc(m.text)}</div>`;
			continue;
		}
		html += `<div class="chat-msg${m.self ? " self" : ""}"><span class="chat-name">${esc(m.name)}</span>${esc(m.text)}</div>`;
	}
	el.innerHTML = html;
}

function renderGroup(title, members, isFree) {
	let h = `<div class="rgroup${isFree ? " free" : ""}">`;
	h += `<div class="rh">${esc(title)}（${members.length}）</div>`;
	if (members.length === 0) {
		h += `<div class="rempty">誰もいません</div>`;
	} else {
		for (const p of members) {
			h += `<div class="rperson${p.self ? " self" : ""}"><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.self ? '<span class="you">あなた</span>' : ""}</div>`;
		}
	}
	return h + "</div>";
}

function esc(s) {
	return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 履歴バッファから renderTime 時点の位置を線形補間で求める
function renderPos(buf, renderTime) {
	if (!buf || buf.length === 0) return null;
	if (buf.length === 1) return { x: buf[0].x, y: buf[0].y };
	for (let i = buf.length - 1; i > 0; i--) {
		const a = buf[i - 1], b = buf[i];
		if (a.at <= renderTime && renderTime <= b.at) {
			const f = (renderTime - a.at) / (b.at - a.at || 1);
			return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
		}
	}
	const last = buf[buf.length - 1];
	return { x: last.x, y: last.y };
}
