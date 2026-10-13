// スマホ用の操作。画面の幅が狭いとき（style.css の @media (max-width: 760px)）だけ働く。
//
// PC の画面をそのまま使い、置き場所を CSS で変えている。ここが受け持つのは、
// スマホにしか無い部品の動きだけ。
//   下の帯（#m-bar）   … 左にマイク、真ん中にジョイスティック、右に退出
//   右上のボタン（#m-menu） … 左メニュー（#rail）を全画面のシートとして開く。チャットの未読を出す
//   シートの × （#m-close）… シートを閉じる
// マイクと退出は、左メニューにある本物のボタン（#mic-btn / #leave-btn）を押す。
// 処理を二重に持たないためで、見た目もそのボタンから写す。
import { isMobileLayout, setMobileSheet } from "./panel.js";
import { setJoystick } from "./move.js";

export function initMobile() {
	initSheet();
	initMicMirror();
	initLeave();
	initJoystick();
	// 画面共有を送れないブラウザ（iPhone の Safari など）では、共有のボタンを出さない
	if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
		const b = document.getElementById("screen-btn");
		if (b) b.style.display = "none";
	}
}

// ── 左メニューのシート ──
function initSheet() {
	const open = document.getElementById("m-menu");
	const close = document.getElementById("m-close");
	if (open) open.addEventListener("click", () => setMobileSheet(true));
	if (close) close.addEventListener("click", () => setMobileSheet(false));
}

// ── マイク ──
// 本物のマイクのボタン（voice.js が状態に合わせて書き換える）を見張り、絵と ON の色を写す。
function initMicMirror() {
	const src = document.getElementById("mic-btn");
	const dst = document.getElementById("m-mic");
	if (!src || !dst) return;
	const copy = () => {
		const ic = src.querySelector(".ic"), lb = src.querySelector(".lb");
		dst.querySelector(".ic").textContent = ic ? ic.textContent : "🔇";
		dst.querySelector(".lb").textContent = lb ? lb.textContent : "";
		dst.classList.toggle("on", src.classList.contains("on"));
		dst.disabled = src.disabled;
	};
	new MutationObserver(copy).observe(src, { subtree: true, childList: true, characterData: true, attributes: true });
	copy();
	dst.addEventListener("click", () => src.click());
}

// ── 退出 ──
// ジョイスティックのすぐ隣にあるので、押し間違えても切れないよう確かめてから出る。
function initLeave() {
	const src = document.getElementById("leave-btn");
	const dst = document.getElementById("m-leave");
	if (!src || !dst) return;
	dst.addEventListener("click", () => {
		if (confirm("退出しますか？")) src.click();
	});
}

// ── ジョイスティック ──
// 外側の丸の中で内側の丸を指で動かし、中心からの向きに歩く。中心からの距離で速さが変わる
// （端まで倒すとキーボードと同じ速さ）。指を離すと内側の丸は中心に戻り、止まる。
// 中心近くのわずかな動き（DEAD）は無視する。触れただけで歩き出さないようにするため。
const DEAD = 0.15;
function initJoystick() {
	const base = document.getElementById("joy");
	const knob = document.getElementById("joy-knob");
	if (!base || !knob) return;
	let pid = null;
	const move = (e) => {
		const r = base.getBoundingClientRect();
		const radius = r.width / 2;
		let x = e.clientX - (r.left + radius), y = e.clientY - (r.top + radius);
		const d = Math.hypot(x, y);
		if (d > radius) { x = (x / d) * radius; y = (y / d) * radius; }   // 外側の丸からは出さない
		knob.style.transform = `translate(${x}px, ${y}px)`;
		const nx = x / radius, ny = y / radius;
		if (Math.hypot(nx, ny) < DEAD) setJoystick(0, 0);
		else setJoystick(nx, ny);
	};
	const end = () => {
		pid = null;
		knob.style.transform = "";
		base.classList.remove("active");
		setJoystick(0, 0);
	};
	base.addEventListener("pointerdown", (e) => {
		if (pid !== null) return;
		pid = e.pointerId;
		base.setPointerCapture(e.pointerId);   // 丸の外へ指が出ても追い続ける
		base.classList.add("active");
		move(e);
		e.preventDefault();
	});
	base.addEventListener("pointermove", (e) => { if (e.pointerId === pid) move(e); });
	base.addEventListener("pointerup", (e) => { if (e.pointerId === pid) end(); });
	base.addEventListener("pointercancel", (e) => { if (e.pointerId === pid) end(); });
	// アプリを裏に回したときなど、指を離した通知が来ないことがある
	window.addEventListener("blur", end);
	document.addEventListener("visibilitychange", () => { if (document.hidden) end(); });
	// 幅が広がって PC の画面になったら、ジョイスティックの入力は捨てる
	window.addEventListener("resize", () => { if (!isMobileLayout()) end(); });
}
