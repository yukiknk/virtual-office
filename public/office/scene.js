// キャンバスへの描画と、マウスによる看板の操作。
//
// このファイルが唯一 ctx を持つ。左メニューなどの DOM は panel.js、
// キーボードによる移動は move.js。
//
// 重ね順は draw() の6行がすべて。レイヤーを足すときはそこへ挿す。
import { GRID, WORLD, w2s, s2w, setViewport, drawBase, drawCommentBox } from "../map.js";
import { store, SHEETS, DEFAULT_AVATAR } from "./store.js";
import { sendComment, removeComment } from "./net.js";
import { layerImg, drawAvatar } from "../avatar.js";
import { faceDir, isBlocked } from "./move.js";
import { openCommentModal } from "./panel.js";

const stage = document.getElementById("stage");
const canvas = document.getElementById("plan");
const ctx = canvas.getContext("2d");

const LERP_DELAY = 120;     // 他人は120ms過去を補間して滑らかに描く
const SIGN_ALPHA = 0.7;     // 人と重なっている看板の濃さ（下の人が透けて見える程度）

// このフレームで描いた人の一覧。drawWallsAndActors が作り、drawComments が
// 「看板と重なっている人」を調べるのに使う。
let lastActors = [];
// 名前が重なるほど近くにいる人のまとまり。groupActors が作り、名前と吹き出しをまとめて描く。
let lastGroups = [];

// ポインタのイベントが書き、描画が読む状態。
// hover は drawZones と drawComments が、drag* は drawComments が見る。
let hover = null;           // カーソルのワールド座標。キャンバスの外へ出ると null
let dragComment = null;     // 操作中のオフィス看板
let dragMode = null;        // "move" | "resize"
let dragCorner = null;      // リサイズ中の角（nw/ne/sw/se）
let dragOff = null;         // 移動時：つかんだ位置と左上のズレ
let dragOrig = null;        // リサイズ時：元の {x,y,w,h}
let dragStart = null;       // つかんだ論理座標（クリック判定用）
let dragMoved = false;      // しきい値を超えて動かしたか

// ── マウス操作 ──
// キーボードによる移動は move.js にある。
//
// 看板の操作は3つのイベントにまたがる状態機械になっている。
//   pointerdown … つかむ（どの看板か・移動かリサイズか・つかんだ位置を控える）
//   pointermove … 4px を超えて動かしたら dragMoved を立ててから反映する
//   pointerup   … dragMoved が false なら「クリック」＝再編集、true なら全員へ共有
// この 4px のしきい値が無いと、再編集しようとしたクリックが
// 「1px 動かした」と見なされて共有に化ける。
export function initPointer() {
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

	// オフィス作成の看板：×で削除、四隅ドラッグで拡大縮小、内部ドラッグで移動、クリックで再編集。
	// 後ろから探すのは、重なっているとき手前の看板を先に拾うため（描画は前から＝後ろほど手前）。
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
			canvas.setPointerCapture(e.pointerId);   // キャンバスの外へドラッグしても pointermove を受け続ける
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
//
// 看板は人より上に描くので、重なると人も名前も隠れてしまう。そこで
//   ・人と重なっている看板だけ半透明にする（重なっていない看板は読みやすいまま）
//   ・重なっている人の名前・離席・吹き出しを、看板の上にもう一度描く
// カーソルを乗せた看板と操作中の看板は、読めるよう不透明に戻す。
function drawComments() {
	for (const c of store.comments) drawSign(c);
	for (const c of store.officeComments) {
		if (isExpired(c)) continue;   // 期限切れは表示しない
		drawSign(c);
		// ホバー中・操作中は削除ボタンとリサイズ用のつまみを出す
		if ((hover && pointInRect(hover, c)) || c === dragComment) { drawDeleteBtn(c); drawHandles(c); }
	}
	for (const a of lastActors) if (underSign(a)) drawActorLabels(a);
	for (const g of lastGroups) if (g.members.some((m) => underSign(m.a))) drawGroupLabel(g);
	drawLocate();   // 場所の目印は看板より上（看板の下にいる人でも見つけられるように）
}

// 勤務者一覧で選んだ人の場所を示す。広がって消える輪を2つ、時間をずらして繰り返す。
// 時間が切れたとき・相手が退出したときは何も描かず、目印を片づける。
function drawLocate() {
	const loc = store.locate;
	if (!loc) return;
	const a = lastActors.find((x) => x.id === loc.id);
	if (!a || Date.now() > loc.until) { store.locate = null; return; }
	const c = w2s(a.x, a.y - DRAW_H / 2 + 6);   // アバターの中心あたり
	ctx.save();
	ctx.strokeStyle = "#e0a83f";
	for (const shift of [0, 0.5]) {
		const t = ((Date.now() / 1200) + shift) % 1;   // 0→1 を1.2秒で繰り返す
		ctx.globalAlpha = 1 - t;
		ctx.lineWidth = 4;
		ctx.beginPath();
		ctx.arc(c.x, c.y, 26 + t * 46, 0, Math.PI * 2);
		ctx.stroke();
	}
	// 輪が広がりきった瞬間にも位置が分かるよう、内側に細い輪を残す
	ctx.globalAlpha = 0.9;
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	ctx.arc(c.x, c.y, 26, 0, Math.PI * 2);
	ctx.stroke();
	ctx.restore();
}

// 人ひとりが画面上で占める範囲（アバター＋名前＋離席ラベルをおおまかに囲む。ワールド座標）
function actorBox(a) {
	return { x: a.x - 44, y: a.y - DRAW_H - 16, w: 88, h: DRAW_H + 48 };
}
function rectsOverlap(a, b) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
// 表示中の看板のどれかと重なっているか
function underSign(a) {
	const box = actorBox(a);
	for (const c of store.comments) if (rectsOverlap(box, c)) return true;
	for (const c of store.officeComments) if (!isExpired(c) && rectsOverlap(box, c)) return true;
	return false;
}
function drawSign(c) {
	const reading = (hover && pointInRect(hover, c)) || c === dragComment;
	const covered = !reading && lastActors.some((a) => rectsOverlap(actorBox(a), c));
	if (!covered) { drawCommentBox(ctx, c); return; }
	ctx.save();
	ctx.globalAlpha = SIGN_ALPHA;
	drawCommentBox(ctx, c);
	ctx.restore();
}
function pointInRect(p, c) { return p.x >= c.x && p.x < c.x + c.w && p.y >= c.y && p.y < c.y + c.h; }

// 消える日時を過ぎた看板か。
// 描画・pointerdown・dblclick・sweep の4か所で使う。期限切れの看板は
// 「見えない・触れない・避けない」を全部満たす必要があるため。
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
	for (const [id, o] of store.others) {
		const p = renderPos(o.buf, renderTime);
		if (!p) continue;
		// 直近の位置変化から向き・歩行を推定
		let moving = false;
		const b = o.buf;
		if (b.length >= 2) {
			const dx = b[b.length - 1].x - b[b.length - 2].x, dy = b[b.length - 1].y - b[b.length - 2].y;
			if (Math.hypot(dx, dy) > 1) { moving = true; o.dir = faceDir(dx, dy); }
		}
		actors.push({ id, x: p.x, y: p.y, name: o.name, color: "#b23a2a", away: o.away, awayMsg: o.awayMsg, talk: o.talk, dir: o.dir || "down", moving, avatar: o.avatar || DEFAULT_AVATAR });
	}
	actors.push({ x: store.me.x, y: store.me.y, name: store.me.name, color: "#1f3fb0", away: store.me.away, awayMsg: store.me.awayMsg, talk: store.me.talking, dir: store.me.dir, moving: store.me.moving, avatar: store.me.avatar });
	actors.sort((a, b) => a.y - b.y);   // 南（下）にいる人ほど後に描く＝手前になる
	lastActors = actors;
	lastGroups = groupActors(actors);

	// 3) アバターを描いた直後、そのアバターより上に来るべき壁だけを描き直す
	for (const a of actors) {
		drawActor(a.x, a.y, a.name, a.color, a);
		coverWalls(a.x, a.y, wallCells);
	}

	// 4) まとまっている人たちの名前は、全員を描いたあとにまとめて描く
	for (const g of lastGroups) drawGroupLabel(g);
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
		// 見る範囲を絞って軽くしている。数字はアバターの見た目の大きさから決めたもので、
		// ±4列は名前ラベルの幅、-3〜+2行はアバター（56px≒2マス）＋名前ラベルの高さ。
		// 狭めすぎると、壁の裏に隠れるべき頭やラベルがはみ出して見える。
		if (Math.abs(item.col - ac) > 4) continue;
		if (item.row < ar - 3 || item.row > ar + 2) continue;
		const cover = onWall ? true : item.row > ar;      // 床なら南（下）側の壁だけ上
		if (cover) drawTile(item);
	}
}

// ワールド座標の矩形を、実ピクセル格子に吸着させた画面座標の矩形にする。
// ドット絵は4辺が半端な位置に来ると継ぎ目やにじみが出るので、整数に揃える。
// タイル・家具・アバターの3か所が同じ吸着を必要とするのでここにまとめてある。
function snapRect(wx, wy, ww, wh) {
	const dpr = window.devicePixelRatio || 1;
	const snap = (v) => Math.round(v * dpr) / dpr;
	const a = w2s(wx, wy), b = w2s(wx + ww, wy + wh);
	const x0 = snap(a.x), y0 = snap(a.y);
	return { x: x0, y: y0, w: snap(b.x) - x0, h: snap(b.y) - y0 };
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
	const r = snapRect(item.col * GRID, item.row * GRID, GRID, GRID);
	ctx.drawImage(sheet.img, item.tileCol * 32, item.tileRow * 32, 32, 32, r.x, r.y, r.w, r.h);
}

// 家具（壁の一つ上）：配列順（後ろほど手前）に、シートの選択範囲を等倍で描く
function drawFurniture() {
	ctx.imageSmoothingEnabled = false;
	for (const f of store.furniture) {
		const sheet = SHEETS[f.cat];
		if (!sheet || !sheet.ready) continue;
		const r = snapRect(f.x, f.y, f.sw, f.sh);
		ctx.drawImage(sheet.img, f.sx, f.sy, f.sw, f.sh, r.x, r.y, r.w, r.h);
	}
}

// 会話エリアは普段は非表示。カーソルを乗せたエリアだけ薄く表示する。
function drawZones() {
	if (!hover) return;
	for (let i = store.zones.length - 1; i >= 0; i--) {
		const z = store.zones[i];
		if (hover.x < z.x || hover.x >= z.x + z.w || hover.y < z.y || hover.y >= z.y + z.h) continue;
		const a = w2s(z.x, z.y), b = w2s(z.x + z.w, z.y + z.h);
		ctx.save();
		ctx.fillStyle = "rgba(31,63,176,0.05)";
		ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
		ctx.strokeStyle = "rgba(31,63,176,0.35)";
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
		ctx.fillStyle = "rgba(31,63,176,0.6)";
		ctx.font = "700 13px system-ui, 'Noto Sans JP', sans-serif";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText(z.name, a.x + 4, a.y + 4);   // 破線は塗りには効かないので、消さずにそのまま文字を描ける
		ctx.restore();
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
		// Date.now() を基準にしているので、全員のアニメーションが自然に揃う。
		const frame = opt.moving ? 1 + (Math.floor(Date.now() / 120) % 8) : 0;
		const wl = wx - DRAW_W / 2, wt = wy - DRAW_H + 6;   // 足元を(wx,wy)付近に、上へ立たせる
		const r = snapRect(wl, wt, DRAW_W, DRAW_H);
		ctx.save();
		if (opt.away) ctx.globalAlpha = 0.4;   // 離席中は薄く描く
		drawAvatar(ctx, cfg, { dir: opt.dir || "down", frame, dx: r.x, dy: r.y, dw: r.w, dh: r.h });
		ctx.restore();
	} else {
		// 画像未読込のあいだは丸で代用
		ctx.save();
		if (opt.away) ctx.globalAlpha = 0.4;
		ctx.beginPath(); ctx.arc(feet.x, feet.y, 10, 0, Math.PI * 2);
		ctx.fillStyle = color; ctx.fill();
		ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
		ctx.restore();
	}

	drawActorLabels({ x: wx, y: wy, name, color, away: opt.away, awayMsg: opt.awayMsg, talk: opt.talk, avatar: cfg, group: opt.group });
}

// アバターに付く文字や印（名前・離席・吹き出し）。
// drawActor から呼ぶほか、看板と重なっている人のぶんは drawComments が看板の上に描き直す。
//
// ほかの人とまとまっている人（a.group あり）は、ここでは離席の表示だけを描く。
// 名前と吹き出しは、まとまり全体のぶんを drawGroupLabel が一度に描く。
function drawActorLabels(a) {
	if (a.away) {
		const feet = w2s(a.x, a.y);
		drawAwayLabel(feet.x, feet.y, a.awayMsg);
	}
	if (a.group) return;
	const top = w2s(a.x, labelTopY(a));
	const w = drawPillAt(top.x, top.y - 6, a.name, a.color, a.away, false);
	// 吹き出しは名前の右隣。まとまりのときと同じ位置関係にして、名前とも重ならないようにする
	if (a.talk && !a.away) drawBubbleAt(top.x + w / 2 + 5, top.y - 6);
}

// 名前ラベルを置く高さ（ワールド座標）。画像未読込（丸で代用）のときは丸のすぐ上。
function labelTopY(a) {
	const bodyImg = layerImg("body", (a.avatar || DEFAULT_AVATAR).body);
	return (bodyImg && bodyImg.ready) ? a.y - DRAW_H + 6 : a.y - 24;
}

// ── 近くにいる人たちをひとまとまりとして扱う ──
//
// 人が近づくと名前ラベルどうしが重なって読めなくなる。そういうときは会話や共同作業を
// していることがほとんどなので、1人ずつではなく「まとまり」として名前を並べ直す。
//   2人 … 横に2つ
//   3人 … 上に1つ・下に2つ（山の形）
//   4人 … 2×2
//   それ以上も同じ考え方（1段の数は人数の平方根を切り上げ、端数は一番上の段）
// 吹き出しも、まとまりの中の誰かが話していれば1つだけ出す。誰が話しているかは、
// その人の名前の枠を緑にして示す。

const PILL_FONT = "500 12px 'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif";
const PILL_H = 20;      // 名前ラベルの高さ（画面座標）
const PILL_PAD = 9;     // 名前ラベルの左右の余白

// 名前ラベルが重なる人どうしをまとめる。2人以上のまとまりだけを返し、
// 属している人には a.group を付ける（drawActorLabels が個別の名前を描かない目印）。
//
// 「重なる」は画面上のラベルの矩形で判定する。距離で決めると、名前の長さやマップの
// 縮尺によって、重なっているのにまとまらない・離れているのにまとまる、がずれる。
// A と B、B と C が重なっていれば A と C が離れていても同じまとまりになる。
function groupActors(actors) {
	ctx.save();
	ctx.font = PILL_FONT;
	const items = actors.map((a) => {
		const top = w2s(a.x, labelTopY(a));
		return { a, cx: top.x, cy: top.y - 6, w: ctx.measureText(a.name).width + PILL_PAD * 2 };
	});
	ctx.restore();

	// 重なる組を同じ根につなぐ（人数が少ないので総当たりで足りる）
	const root = items.map((_, i) => i);
	const find = (i) => { while (root[i] !== i) i = root[i] = root[root[i]]; return i; };
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const p = items[i], q = items[j];
			if (Math.abs(p.cx - q.cx) < (p.w + q.w) / 2 + 4 && Math.abs(p.cy - q.cy) < PILL_H + 4) root[find(i)] = find(j);
		}
	}
	const byRoot = new Map();
	items.forEach((it, i) => {
		const r = find(i);
		if (!byRoot.has(r)) byRoot.set(r, []);
		byRoot.get(r).push(it);
	});

	const groups = [];
	for (const members of byRoot.values()) {
		if (members.length < 2) continue;
		// 左にいる人から順に並べる。同じ位置なら名前順にして、毎フレーム入れ替わらないようにする
		members.sort((p, q) => (p.cx - q.cx) || (p.a.name < q.a.name ? -1 : 1));
		const g = { members };
		for (const m of members) m.a.group = g;
		groups.push(g);
	}
	return groups;
}

// まとまりの名前を、全員の頭上にまとめて描く。
function drawGroupLabel(g) {
	const ms = g.members, n = ms.length;
	const cols = Math.ceil(Math.sqrt(n));
	const first = n % cols || cols;   // 端数は一番上の段へ（3人なら 1+2、5人なら 2+3）
	const rows = [ms.slice(0, first)];
	for (let i = first; i < n; i += cols) rows.push(ms.slice(i, i + cols));

	const GAP = 4, ROW = PILL_H + 4;
	const cx = ms.reduce((sum, m) => sum + m.cx, 0) / n;   // 横はまとまりの中央
	const baseY = Math.min(...ms.map((m) => m.cy));          // 一番下の段を、いちばん上にいる人の頭上に
	const talking = (m) => m.a.talk && !m.a.away;
	let bubble = null;
	rows.forEach((row, r) => {
		const y = baseY - (rows.length - 1 - r) * ROW;
		const total = row.reduce((sum, m) => sum + m.w, 0) + GAP * (row.length - 1);
		let x = cx - total / 2;
		for (const m of row) {
			drawPillAt(x + m.w / 2, y, m.a.name, m.a.color, m.a.away, talking(m));
			x += m.w + GAP;
		}
		if (r === 0) bubble = { x: cx + total / 2 + 5, y };   // 吹き出しは一番上の段の右
	});
	if (ms.some(talking)) drawBubbleAt(bubble.x, bubble.y);
}

// 話している印の吹き出し。x は左端、y は上下の中央（画面座標）。
// 遠くからでも「この人たちは会話中だ」と分かるようにするためのもの。
// 大きさは画面座標で固定（マップを縮小しても読める大きさを保つ）。
function drawBubbleAt(x0, yc) {
	const w = 24, h = 17, r = 8;
	const x = x0, y = yc - h / 2;
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, r);
	// しっぽ（左下、頭のほうへ向ける）
	ctx.moveTo(x + 5, y + h - 2);
	ctx.lineTo(x - 2, y + h + 5);
	ctx.lineTo(x + 11, y + h - 1);
	ctx.closePath();
	ctx.fillStyle = "#2a7d3f";
	ctx.fill();
	ctx.shadowColor = "transparent";
	// 点3つを順に明るくして、動きで目に留まるようにする
	const phase = Math.floor(Date.now() / 280) % 3;
	for (let i = 0; i < 3; i++) {
		ctx.globalAlpha = i === phase ? 1 : 0.45;
		ctx.beginPath();
		ctx.arc(x + 6 + i * 6, y + h / 2, 2, 0, Math.PI * 2);
		ctx.fillStyle = "#ffffff";
		ctx.fill();
	}
	ctx.restore();
}

// 名前の角丸ラベル。cx / cy は中心（画面座標）。
// talking が true のときは枠を緑で太くする（まとまりの中で誰が話しているかの印）。幅を返す。
function drawPillAt(cx, cy, name, color, away, talking) {
	ctx.save();
	if (away) ctx.globalAlpha = 0.6;
	ctx.font = PILL_FONT;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const h = PILL_H;
	const w = ctx.measureText(name).width + PILL_PAD * 2;
	ctx.shadowColor = "rgba(0,0,0,0.28)"; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
	ctx.fillStyle = "#ffffff"; ctx.fill();
	ctx.shadowColor = "transparent";
	ctx.lineWidth = talking ? 2.5 : 1.5;
	ctx.strokeStyle = talking ? "#2a7d3f" : color;
	ctx.stroke();
	ctx.fillStyle = "#141815";
	ctx.fillText(name, cx, cy + 0.5);
	ctx.restore();   // font・文字の揃え・globalAlpha はここで呼び出し元の値に戻る
	return w;        // ラベルの幅。呼び出し元が隣に吹き出しを置くのに使う
}

// 離席バッジ＋理由をアバターの下に表示
function drawAwayLabel(sx, sy, msg) {
	ctx.save();
	ctx.font = "600 11px 'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	// 長い理由は末尾を削って「…」に収める（幅186pxまで）
	let text = "離席中" + (msg ? "：" + msg : "");
	while (text.length > 4 && ctx.measureText(text).width > 186) text = text.slice(0, -2) + "…";
	const w = ctx.measureText(text).width + 14;
	const h = 18, cx = sx, cy = sy + 22;
	ctx.shadowColor = "rgba(0,0,0,0.25)";
	ctx.shadowBlur = 4;
	ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
	ctx.fillStyle = "#4a5046";
	ctx.fill();
	// 文字に枠と同じ影が付かないよう、描く前に影を消す
	ctx.shadowColor = "transparent";
	ctx.shadowBlur = 0;
	ctx.shadowOffsetY = 0;
	ctx.fillStyle = "#fff";
	ctx.fillText(text, cx, cy + 0.5);
	ctx.restore();
}

// 履歴バッファから renderTime 時点の位置を線形補間で求める。
// LERP_DELAY だけ過去を描くことで、次の位置が届くまでの猶予を作っている。
// 猶予を過ぎても次が来ていなければ、最後の位置で止める（行き過ぎて戻るより自然）。
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
