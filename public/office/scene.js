// キャンバスへの描画と、マウスによる看板の操作。
//
// このファイルが唯一 ctx を持つ。左メニューなどの DOM は panel.js、
// キーボードによる移動は move.js。
//
// 重ね順は draw() の6行がすべて。レイヤーを足すときはそこへ挿す。
import { GRID, WORLD, w2s, s2w, setViewport, lookAt, isScrolling, getScale, drawBase, drawCommentBox } from "../map.js";
import { store, SHEETS, DEFAULT_AVATAR } from "./store.js";
import { sendComment, removeComment } from "./net.js";
import { layerImg, drawAvatar } from "../avatar.js";
import { faceDir, isBlockedBody, BODY_HALF } from "./move.js";
import { openCommentModal, isMobileLayout } from "./panel.js";

const stage = document.getElementById("stage");
const canvas = document.getElementById("plan");
const ctx = canvas.getContext("2d");

const LERP_DELAY = 120;     // 他人は120ms過去を補間して滑らかに描く

// これより小さくは縮めない倍率（1マスが 32px × この値で表示される）。
// ウィンドウを小さくしたとき、マップ全体を収めようとすると人も文字も読めなくなる。
// ここで縮小を止め、それ以降は自分のまわりだけを映して、歩くと映る範囲が動くようにする。
// 0.6 なら、1366×768 の画面や、1920×1080 を表示倍率 150% で使っている画面でも全体が映る。
const MIN_SCALE = 0.6;
// 見ている場所の中心（ワールド座標）。目標へ少しずつ寄せて、場面の切り替わりを滑らかにする。
let camX = null, camY = null;
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
		if (e.pointerType === "touch") return;   // 指では看板を動かさない（スマホでは表示だけ）
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
		if (isMobileLayout()) return;                    // スマホはジョイスティックで動く（誤タップで飛ばない）
		const p = s2w(canvas, e.clientX, e.clientY);
		for (const c of store.officeComments) if (!isExpired(c) && pointInRect(p, c)) return;   // 看板の上は対象外
		const x = Math.max(BODY_HALF, Math.min(WORLD.w - BODY_HALF, p.x));
		const y = Math.max(0, Math.min(WORLD.h, p.y));
		if (isBlockedBody(x, y)) return;                 // 通行禁止マスには行かない（体がかかる位置も不可）
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
	setViewport(w, h, MIN_SCALE);
	viewW = w; viewH = h;
	draw();
}

// ── ラベルを画面の中に収める ──
// 名前・離席・吹き出しは人の位置を基準に置くので、人がマップの端にいると、ラベルが
// マップの外（灰色の余白）へはみ出したり、画面の外に出て読めなくなったりする。
// 「マップが映っている範囲」と「キャンバス」の重なりを求め、その中へ押し戻す。
let viewW = 0, viewH = 0;   // キャンバスの見た目の大きさ（fit が覚える）
function labelBounds() {
	const a = w2s(0, 0), b = w2s(WORLD.w, WORLD.h);
	const pad = 2;
	return {
		l: Math.max(a.x, 0) + pad, t: Math.max(a.y, 0) + pad,
		r: Math.min(b.x, viewW) - pad, b: Math.min(b.y, viewH) - pad,
	};
}
// 幅 w のものの中心 x を、左右の端に収まるように直す（縦も同じ考え方）
function fitX(cx, w) {
	const bd = labelBounds();
	if (w >= bd.r - bd.l) return (bd.l + bd.r) / 2;   // 範囲より広いときは中央に置く
	return Math.max(bd.l + w / 2, Math.min(bd.r - w / 2, cx));
}
function fitY(cy, h) {
	const bd = labelBounds();
	if (h >= bd.b - bd.t) return (bd.t + bd.b) / 2;
	return Math.max(bd.t + h / 2, Math.min(bd.b - h / 2, cy));
}
// 吹き出しを置く。ふだんは名前の右隣、右に入らないときは左隣へ回す。
// right / left は名前（またはまとまりの一番上の段）の右端と左端、cy はその中央。
function placeBubble(left, right, cy) {
	const bw = u(24), gap = u(5);
	const x = right + gap + bw <= labelBounds().r ? right + gap : left - gap - bw;
	drawBubbleAt(x, cy);
}

// 見る場所を決める。マップが画面に収まっているときは何もしない。
// 基本は自分が中央。勤務者一覧で人を選んでいるあいだは、その人を映す
// （画面の外にいると、場所を示す輪が見えないため）。
function updateCamera() {
	if (!isScrolling()) { camX = camY = null; return; }
	let tx = store.me.x, ty = store.me.y;
	const loc = store.locate;
	const o = loc && Date.now() <= loc.until ? store.others.get(loc.id) : null;
	const p = o && o.buf[o.buf.length - 1];
	if (p) { tx = p.x; ty = p.y; }
	if (camX === null) { camX = tx; camY = ty; }
	// 目標との差の一部だけ進む。歩いているときはほぼ遅れずについていき、
	// 映す相手が切り替わったときは滑るように移る。
	camX += (tx - camX) * 0.25;
	camY += (ty - camY) * 0.25;
	if (Math.abs(tx - camX) < 0.5) camX = tx;
	if (Math.abs(ty - camY) < 0.5) camY = ty;
	lookAt(camX, camY);
}

export function draw() {
	updateCamera();
	drawBase(ctx, canvas);
	drawGround();           // 床（下）と敷物（中）。作り置きの1枚を貼るだけ
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
//       → そのアバターより手前に来るべき壁だけ描き直し、体を壁の裏に隠す。
//       → 最後に、名前などのラベルを壁より上に描く（壁に隠れると読めないため）。
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
		// 話している人はマイクが ON のはず。マイクの状態を送らない古い画面の人も、話していれば ON と見せる
		actors.push({ id, x: p.x, y: p.y, name: o.name, color: "#b23a2a", away: o.away, awayMsg: o.awayMsg, talk: o.talk, mic: !!(o.mic || o.talk), dir: o.dir || "down", moving, avatar: o.avatar || DEFAULT_AVATAR });
	}
	actors.push({ x: store.me.x, y: store.me.y, name: store.me.name, color: "#1f3fb0", away: store.me.away, awayMsg: store.me.awayMsg, talk: store.me.talking, mic: !!store.me.mic, dir: store.me.dir, moving: store.me.moving, avatar: store.me.avatar });
	actors.sort((a, b) => a.y - b.y);   // 南（下）にいる人ほど後に描く＝手前になる
	lastActors = actors;
	lastGroups = groupActors(actors);

	// 3) アバターを描いた直後、そのアバターより上に来るべき壁だけを描き直す
	for (const a of actors) {
		drawActor(a.x, a.y, a.name, a.color, a);
		coverWalls(a.x, a.y, wallCells);
	}

	// 4) 名前・離席・吹き出しは、全員と壁を描き終えてから描く。
	//    アバターと一緒に描くと、直後の「手前の壁の描き直し」に上書きされて隠れる。
	//    離席の文字は足元より下に出るので、マップの端（下が壁）にいると丸ごと見えなくなっていた。
	//    アバター本体は、これまでどおり壁との前後関係に従う。
	for (const a of actors) drawActorLabels(a);
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

// ── 床と敷物の作り置き ──
// 床と敷物は人の前後関係に関わらず、管理者が「反映」するまで変わらない。毎フレーム
// 1マスずつ描くと、マス数（最大1500）ぶんの drawImage が毎回走り、高解像度で
// 毎秒120回描く Mac ではファンが回るほど重くなっていた。そこでマップ全体を1枚の
// キャンバスに描いておき、毎フレームはそれを貼るだけにする。
//
// 描き直すのは、倍率・画面の解像度・レイアウト・画像シートの読み込み状況が変わったときだけ。
// setViewport が1マスを実ピクセルの整数に丸めているので、マスごとに描いたときと
// 同じ位置に同じ絵が並ぶ（継ぎ目は出ない）。
let ground = null;   // { canvas, key, layout }
function drawGround() {
	const dpr = window.devicePixelRatio || 1;
	const cell = Math.round(GRID * getScale() * dpr);   // 1マスの実ピクセル
	const key = `${cell}|${Object.values(SHEETS).map((s) => (s.ready ? 1 : 0)).join("")}`;
	if (!ground || ground.key !== key || ground.layout !== store.layout) {
		const c = (ground && ground.canvas) || document.createElement("canvas");
		c.width = Math.round(WORLD.w / GRID) * cell;
		c.height = Math.round(WORLD.h / GRID) * cell;
		const g = c.getContext("2d");
		g.clearRect(0, 0, c.width, c.height);
		g.imageSmoothingEnabled = false;
		for (const layer of ["floor", "rug"]) {
			for (const item of store.layout) {
				if ((item.layer || "floor") !== layer) continue;
				const sheet = SHEETS[item.cat || "floor"];
				if (!sheet || !sheet.ready) continue;
				g.drawImage(sheet.img, item.tileCol * 32, item.tileRow * 32, 32, 32, item.col * cell, item.row * cell, cell, cell);
			}
		}
		ground = { canvas: c, key, layout: store.layout };
	}
	const o = w2s(0, 0);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(ground.canvas, o.x, o.y, ground.canvas.width / dpr, ground.canvas.height / dpr);
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
	const p = drawPillAt(top.x, top.y - u(6), a.name, a.color, a.away, false, a.mic);
	// 吹き出しは名前の隣。まとまりのときと同じ位置関係にして、名前とも重ならないようにする
	if (a.talk && !a.away) placeBubble(p.cx - p.w / 2, p.cx + p.w / 2, p.cy);
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

// 名前・離席・吹き出しの大きさは、マップの表示倍率に合わせて変える。
// 固定の大きさで描くと、ウィンドウを小さくしたときにマップやアバターだけが縮み、
// 名前が相対的に大きくなって重なりやすくなる。
// 下限を設けているのは、縮めすぎると名前が読めなくなるため（倍率 1 で 12px、下限で約 10px）。
// マップは MIN_SCALE（0.6）まで縮むので、それより手前で名前だけ縮むのを止めている。
// u(n) は「倍率 1 のときの n px」をいまの倍率に直す。
const LABEL_MIN = 0.8, LABEL_MAX = 1.5;
function labelScale() { return Math.max(LABEL_MIN, Math.min(LABEL_MAX, getScale())); }
function u(n) { return n * labelScale(); }

const LABEL_FAMILY = "'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif";
function pillFont() { return `500 ${u(12)}px ${LABEL_FAMILY}`; }
const PILL_H = 20;      // 名前ラベルの高さ（倍率 1 のとき。使うときは u() を通す）
const PILL_PAD = 9;     // 名前ラベルの左右の余白（同上）
const MIC_W = 12;       // 名前の左に付けるマイクの印の幅（同上）。印と名前のあいだは MIC_GAP
const MIC_GAP = 3;

// 名前ラベルの幅（印・名前・余白の合計）。ctx.font が pillFont() になっていること。
// まとまりの判定（groupActors）と描画（drawPillAt）で同じ幅を使うため、ここ1か所で計算する。
function pillWidth(name) {
	return ctx.measureText(name).width + u(PILL_PAD) * 2 + u(MIC_W + MIC_GAP);
}

// マイクの印。cx / cy は印の中心（画面座標）。
//   ON  … 緑のマイク
//   OFF … 灰色のマイクに赤い斜線（ミュート中・マイクを使っていない・離席中）
function drawMicIcon(cx, cy, on) {
	const s = u(1);
	ctx.save();
	ctx.lineCap = "round";
	ctx.strokeStyle = ctx.fillStyle = on ? "#2a7d3f" : "#8a9086";
	ctx.beginPath();
	ctx.roundRect(cx - 2.5 * s, cy - 5.5 * s, 5 * s, 7.5 * s, 2.5 * s);   // 頭
	ctx.fill();
	ctx.lineWidth = Math.max(1, 1.3 * s);
	ctx.beginPath();
	ctx.arc(cx, cy - 0.5 * s, 4.2 * s, 0.15 * Math.PI, 0.85 * Math.PI);    // 受け
	ctx.moveTo(cx, cy + 3.7 * s);
	ctx.lineTo(cx, cy + 5.5 * s);                                          // 柄
	ctx.stroke();
	if (!on) {
		ctx.strokeStyle = "#c2412d";
		ctx.lineWidth = Math.max(1, 1.6 * s);
		ctx.beginPath();
		ctx.moveTo(cx - 5 * s, cy - 5.5 * s);
		ctx.lineTo(cx + 5 * s, cy + 5.5 * s);
		ctx.stroke();
	}
	ctx.restore();
}

// 名前ラベルが重なる人どうしをまとめる。2人以上のまとまりだけを返し、
// 属している人には a.group を付ける（drawActorLabels が個別の名前を描かない目印）。
//
// 「重なる」は画面上のラベルの矩形で判定する。距離で決めると、名前の長さやマップの
// 縮尺によって、重なっているのにまとまらない・離れているのにまとまる、がずれる。
// A と B、B と C が重なっていれば A と C が離れていても同じまとまりになる。
function groupActors(actors) {
	ctx.save();
	ctx.font = pillFont();
	const items = actors.map((a) => {
		const top = w2s(a.x, labelTopY(a));
		return { a, cx: top.x, cy: top.y - u(6), w: pillWidth(a.name) };
	});
	ctx.restore();

	// 重なる組を同じ根につなぐ（人数が少ないので総当たりで足りる）
	const root = items.map((_, i) => i);
	const find = (i) => { while (root[i] !== i) i = root[i] = root[root[i]]; return i; };
	for (let i = 0; i < items.length; i++) {
		for (let j = i + 1; j < items.length; j++) {
			const p = items[i], q = items[j];
			if (Math.abs(p.cx - q.cx) < (p.w + q.w) / 2 + u(4) && Math.abs(p.cy - q.cy) < u(PILL_H + 4)) root[find(i)] = find(j);
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

	const GAP = u(4), ROW = u(PILL_H + 4);
	const widthOf = (row) => row.reduce((sum, m) => sum + m.w, 0) + GAP * (row.length - 1);
	// まとまり全体（いちばん幅の広い段 × 段数）を1つの箱とみなして、画面の中へ収める。
	// 名前を1つずつ押し戻すと、端で並びが崩れて重なるため、箱ごと動かす。
	const boxW = Math.max(...rows.map(widthOf));
	const boxH = (rows.length - 1) * ROW + u(PILL_H);
	const cx = fitX(ms.reduce((sum, m) => sum + m.cx, 0) / n, boxW);   // 横はまとまりの中央
	// 一番下の段を、いちばん上にいる人の頭上に。箱の中心に直してから収め、また下の段の位置へ戻す
	const bottomY = Math.min(...ms.map((m) => m.cy));
	const baseY = fitY(bottomY - (boxH - u(PILL_H)) / 2, boxH) + (boxH - u(PILL_H)) / 2;
	const talking = (m) => m.a.talk && !m.a.away;
	let topRow = null;
	rows.forEach((row, r) => {
		const y = baseY - (rows.length - 1 - r) * ROW;
		const total = widthOf(row);
		let x = cx - total / 2;
		for (const m of row) {
			drawPillAt(x + m.w / 2, y, m.a.name, m.a.color, m.a.away, talking(m), m.a.mic);
			x += m.w + GAP;
		}
		if (r === 0) topRow = { left: cx - total / 2, right: cx + total / 2, y };   // 吹き出しは一番上の段の隣
	});
	if (ms.some(talking)) placeBubble(topRow.left, topRow.right, topRow.y);
}

// 話している印の吹き出し。x は左端、y は上下の中央（画面座標）。
// 遠くからでも「この人たちは会話中だ」と分かるようにするためのもの。
// 大きさは画面座標で固定（マップを縮小しても読める大きさを保つ）。
function drawBubbleAt(x0, yc) {
	const w = u(24), h = u(17), r = u(8);
	const x = x0, y = yc - h / 2;
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = u(4); ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, r);
	// しっぽ（左下、頭のほうへ向ける）
	ctx.moveTo(x + u(5), y + h - u(2));
	ctx.lineTo(x - u(2), y + h + u(5));
	ctx.lineTo(x + u(11), y + h - u(1));
	ctx.closePath();
	ctx.fillStyle = "#2a7d3f";
	ctx.fill();
	ctx.shadowColor = "transparent";
	// 点3つを順に明るくして、動きで目に留まるようにする
	const phase = Math.floor(Date.now() / 280) % 3;
	for (let i = 0; i < 3; i++) {
		ctx.globalAlpha = i === phase ? 1 : 0.45;
		ctx.beginPath();
		ctx.arc(x + u(6) + i * u(6), y + h / 2, u(2), 0, Math.PI * 2);
		ctx.fillStyle = "#ffffff";
		ctx.fill();
	}
	ctx.restore();
}

// 名前の角丸ラベル。cx / cy は中心（画面座標）。
// talking が true のときは枠を緑で太くする（まとまりの中で誰が話しているかの印）。
// 名前の左にマイクの印（mic が true なら ON）を付ける。
// 画面の外へ出る場合は中へ押し戻し、実際に描いた位置を返す。
function drawPillAt(cx, cy, name, color, away, talking, mic) {
	ctx.save();
	if (away) ctx.globalAlpha = 0.6;
	ctx.font = pillFont();
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const h = u(PILL_H);
	const w = pillWidth(name);
	cx = fitX(cx, w);   // マップの端にいても、名前が外へはみ出さないようにする
	cy = fitY(cy, h);
	ctx.shadowColor = "rgba(0,0,0,0.28)"; ctx.shadowBlur = u(4); ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
	ctx.fillStyle = "#ffffff"; ctx.fill();
	ctx.shadowColor = "transparent";
	ctx.lineWidth = Math.max(1, u(talking ? 2.5 : 1.5));   // 枠は 1px より細くしない（かすれて見えなくなる）
	ctx.strokeStyle = talking ? "#2a7d3f" : color;
	ctx.stroke();
	const left = cx - w / 2 + u(PILL_PAD);
	drawMicIcon(left + u(MIC_W) / 2, cy, !!mic && !away);
	ctx.fillStyle = "#141815";
	ctx.fillText(name, cx + u(MIC_W + MIC_GAP) / 2, cy + 0.5);   // 印のぶん右へずらす
	ctx.restore();   // font・文字の揃え・globalAlpha はここで呼び出し元の値に戻る
	return { w, cx, cy };   // 実際に描いた位置と幅。呼び出し元が隣に吹き出しを置くのに使う
}

// 離席バッジ＋理由をアバターの下に表示
function drawAwayLabel(sx, sy, msg) {
	ctx.save();
	ctx.font = `600 ${u(11)}px ${LABEL_FAMILY}`;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	// 理由は最後まで出す。1行に収まらないぶんは折り返して行を足す（理由は最長100文字）。
	// 以前は1行に切り詰めて「…」にしていたので、長い理由は途中までしか読めなかった。
	// 折り返しは1文字単位（日本語は単語の区切りが無いため）。
	const maxW = u(220);
	const lines = [];
	let line = "";
	for (const ch of "離席中" + (msg ? "：" + msg : "")) {
		if (ch === "\n") { lines.push(line); line = ""; continue; }
		// 句読点や閉じかっこは行の先頭に送らない（少しはみ出しても前の行に付ける）
		if (line && !"、。，．）」』】！？".includes(ch) && ctx.measureText(line + ch).width > maxW) { lines.push(line); line = ch; }
		else line += ch;
	}
	lines.push(line);

	const lineH = u(15);
	const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + u(14);
	const h = lineH * lines.length + u(3);
	// 1行目の位置は、1行だけのときと変えない。増えた行は下へ伸びる。
	// マップの端にいて外へはみ出す場合は、中へ押し戻す（下端では、そのぶんアバターに重なる）。
	const cx = fitX(sx, w);
	const top = fitY(sy + u(22) - u(9) + h / 2, h) - h / 2;
	ctx.shadowColor = "rgba(0,0,0,0.25)";
	ctx.shadowBlur = u(4);
	ctx.shadowOffsetY = 1;
	ctx.beginPath();
	ctx.roundRect(cx - w / 2, top, w, h, Math.min(h / 2, u(9)));
	ctx.fillStyle = "#4a5046";
	ctx.fill();
	// 文字に枠と同じ影が付かないよう、描く前に影を消す
	ctx.shadowColor = "transparent";
	ctx.shadowBlur = 0;
	ctx.shadowOffsetY = 0;
	ctx.fillStyle = "#fff";
	lines.forEach((l, k) => ctx.fillText(l, cx, top + u(1.5) + lineH * (k + 0.5) + 0.5));
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
