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
	// 軸ごとに判定して、壁沿いに滑れるようにする
	const nx = Math.max(0, Math.min(WORLD.w, store.me.x + (dx / len) * SPEED * dt));
	if (!isBlocked(nx, store.me.y)) store.me.x = nx;
	const ny = Math.max(0, Math.min(WORLD.h, store.me.y + (dy / len) * SPEED * dt));
	if (!isBlocked(store.me.x, ny)) store.me.y = ny;
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
