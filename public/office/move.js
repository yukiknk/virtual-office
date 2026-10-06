// キーボードによる自分の移動。
//
// キャンバスには触らない。store.me（自分の位置と向き）と store.blocked
// （通行禁止マス）だけを読み書きする。描いているのは scene.js。
import { GRID, WORLD } from "../map.js";
import { store } from "./store.js";

const SPEED = 260;          // 移動速度（ワールドpx/秒）
const heldKeys = new Set();

export function initMove() {
	window.addEventListener("keydown", (e) => {
		if (isTyping(e.target)) return;   // 入力欄では移動キー（wasd等）を奪わない
		// Ctrl+S や Ctrl+D などブラウザのショートカットは奪わない（アバターも動かさない）
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const k = e.key.toLowerCase();
		if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
			heldKeys.add(k);
			e.preventDefault();
		}
	});
	window.addEventListener("keyup", (e) => heldKeys.delete(e.key.toLowerCase()));
	// タブを離れている間に離したキーは keyup が来ないので、戻ったときに押しっぱなしになる
	window.addEventListener("blur", () => heldKeys.clear());
}

// テキスト入力欄などにフォーカスがあるか
function isTyping(t) {
	return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

// 押しっぱなしの状態を捨てる。モーダルを開くときに呼んで、
// 裏でアバターが歩き続けるのを防ぐ。
export function stopMoving() {
	heldKeys.clear();
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
	// 軸ごとに判定して、壁沿いに滑れるようにする。
	// 横はマップの端から体の半分だけ内側までにする（体が半分マップの外へ出ないように）。
	const nx = Math.max(BODY_HALF, Math.min(WORLD.w - BODY_HALF, store.me.x + (dx / len) * SPEED * dt));
	if (canStep(nx, store.me.y)) store.me.x = nx;
	const ny = Math.max(0, Math.min(WORLD.h, store.me.y + (dy / len) * SPEED * dt));
	if (canStep(store.me.x, ny)) store.me.y = ny;
	else if (!dx) slideIntoGap(ny, dt);
}

// 上下にまっすぐ進もうとして、体の端だけが引っかかったときの助け。
// 足元の点は通れるのに左右どちらかの端だけが通行禁止マスにかかっている場合、
// かかっていない側へ少しずつ寄せる。これが無いと、1マス幅の通路やドアに入るのに
// 横位置をぴったり合わせる必要があり（通れる幅は 12px しかない）、何度も切り返すことになる。
// 横のキーを押しているときは、利用者の操作を優先して何もしない。
function slideIntoGap(ny, dt) {
	const x = store.me.x;
	if (isBlocked(x, ny)) return;   // 正面が塞がっている。寄せても通れない
	const left = isBlocked(x - BODY_HALF, ny), right = isBlocked(x + BODY_HALF, ny);
	if (left === right) return;
	const nx = Math.max(BODY_HALF, Math.min(WORLD.w - BODY_HALF, x + (left ? 1 : -1) * SPEED * dt));
	if (canStep(nx, store.me.y)) store.me.x = nx;
}

// 体の横幅の半分（ワールドpx）。アバターの絵のうち、実際に体が描かれている幅に合わせてある。
// 大きくすると見た目のめり込みは減るが、1マス幅（32px）の通路を通れる位置が狭くなり、
// 通路に入りにくくなる（通れる幅 = 32 - BODY_HALF×2）。
export const BODY_HALF = 10;

// 体の幅を考えて、その位置に立てないか。足元の点だけで判定すると、体の横半分が
// 通行禁止マスに入り込む。左右の端も見ることで、体ごと手前で止まる。
// 縦方向は足元の点だけで見る。絵は足元から上へ伸びるので、上のマスに頭が重なるのは
// 「手前に立っている」見た目として自然なため。
export function isBlockedBody(x, y) {
	return isBlocked(x, y) || isBlocked(x - BODY_HALF, y) || isBlocked(x + BODY_HALF, y);
}

// (x, y) へ進めるか。
// すでに体が通行禁止マスにかかっている場合（この判定が入る前の位置を復元したときや、
// 管理者がマスを足したとき）は、足元の点が入らない限り動けるようにする。そうしないと、
// かかっている方向と直角にしか動けず、その場から抜け出しにくくなる。
function canStep(x, y) {
	if (!isBlockedBody(x, y)) return true;
	return isBlockedBody(store.me.x, store.me.y) && !isBlocked(x, y);
}

// 移動量から向き（up/left/down/right）を決める
export function faceDir(dx, dy) {
	if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) return dx > 0 ? "right" : "left";
	return dy > 0 ? "down" : "up";
}

// そのワールド座標のマスが通行禁止か
export function isBlocked(x, y) {
	const col = Math.floor(x / GRID), row = Math.floor(y / GRID);
	return store.blocked.has(`${col},${row}`);
}
