// スマホ用の操作。スマホの画面（panel.js の MOBILE_QUERY。縦持ちで幅が狭い、または横持ち）のときだけ働く。
//
// PC の画面をそのまま使い、置き場所を CSS で変えている。ここが受け持つのは、
// スマホにしか無い部品の動きだけ。
//   下の帯（#m-bar）   … 左にマイク、真ん中にジョイスティック、右に退出
//   右上のボタン（#m-menu） … 小さなメニュー（#m-pop）を開く。チャットの未読を出す
//     チャット   … 左メニュー（#rail）を、チャットだけの小窓として開く。下の帯は隠さない
//                  （マイクを押したり歩いたりしながらチャットできるように）
//     勤務者一覧・音声の設定 … 左メニューにある本物のボタンを押す（それぞれの画面が開く）
//   小窓の × （#m-close）… チャットを閉じる
//   共有画面の拡大（#share-big）… 画面いっぱいに出し、横向きの切り替え・マイク・閉じるを重ねる
//   キーボードを閉じたあと、ずれたままのページを元に戻す（iPhone）
// マイクと退出も、左メニューにある本物のボタン（#mic-btn / #leave-btn）を押す。
// 処理を二重に持たないためで、見た目もそのボタンから写す。
import { isMobileLayout, setMobileSheet } from "./panel.js";
import { setJoystick } from "./move.js";

export function initMobile() {
	initSheet();
	initMicMirror("m-mic");
	initMicMirror("m-share-mic");
	initShareView();
	initKeyboardFix();
	initLeave();
	initJoystick();
	// 画面共有を送れないブラウザ（iPhone の Safari など）では、共有のボタンを出さない
	if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
		const b = document.getElementById("screen-btn");
		if (b) b.style.display = "none";
	}
}

// ── メニュー ──
function initSheet() {
	const btn = document.getElementById("m-menu");
	const pop = document.getElementById("m-pop");
	const close = document.getElementById("m-close");
	if (!btn || !pop) return;
	const setPop = (open) => {
		pop.hidden = !open;
		btn.setAttribute("aria-expanded", String(open));
	};
	btn.addEventListener("click", (e) => { e.stopPropagation(); setPop(pop.hidden); });
	// メニューの外を触ったら閉じる
	document.addEventListener("pointerdown", (e) => {
		if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) setPop(false);
	});
	const press = (id) => { const b = document.getElementById(id); if (b) b.click(); };
	pop.addEventListener("click", (e) => {
		const item = e.target.closest ? e.target.closest("button[data-act]") : null;
		if (!item) return;
		setPop(false);
		const act = item.dataset.act;
		if (act === "chat") setMobileSheet(true);
		else if (act === "people") press("people-btn");
		else if (act === "audio") press("audio-settings-btn");
	});
	if (close) close.addEventListener("click", () => setMobileSheet(false));
}

// ── マイク ──
// 本物のマイクのボタン（voice.js が状態に合わせて書き換える）を見張り、絵と ON の色を写す。
function initMicMirror(id) {
	const src = document.getElementById("mic-btn");
	const dst = document.getElementById(id);
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
	dst.addEventListener("click", (e) => { e.stopPropagation(); src.click(); });
}

// ── 共有画面の拡大 ──
// スマホでは画面いっぱいに出す（style.css）。⟳ で 90 度回して横向きの全画面にする。
// 画面の向きを固定している人でも、端末を横に持てば大きく見られるようにするため。
// 拡大を閉じたら横向きも戻す。
function initShareView() {
	const big = document.getElementById("share-big");
	const rot = document.getElementById("m-share-rotate");
	const close = document.getElementById("m-share-close");
	if (!big) return;
	if (rot) rot.addEventListener("click", (e) => { e.stopPropagation(); big.classList.toggle("rot"); });
	// 拡大の外側を押すと閉じる作り（voice.js）なので、× はその外側を押したことにする
	if (close) close.addEventListener("click", (e) => { e.stopPropagation(); big.click(); });
	// 付いているときだけ外す。無条件に remove すると、それ自体がクラスの変更として通知され、無限に繰り返す
	new MutationObserver(() => { if (!big.classList.contains("on") && big.classList.contains("rot")) big.classList.remove("rot"); })
		.observe(big, { attributes: true, attributeFilter: ["class"] });
}

// ── キーボードを閉じたあとのずれ ──
// iPhone では、入力欄を押してキーボードが出るとページ全体が上へ押し上げられ、
// キーボードを閉じても戻らないことがある。2つの場合に、いちばん上へ戻す。
//   入力欄から離れたとき（送信ボタンを押した、ほかの場所を触った）
//   キーボードだけが閉じたとき（キーボードの「完了」や下へのスワイプ）。このときは入力欄から
//   離れたことにならないので、見えている範囲（visualViewport）の高さが元に戻ったことで判定する
function initKeyboardFix() {
	const typing = (el) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
	const reset = () => { if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0); };
	document.addEventListener("focusout", (e) => {
		if (!isMobileLayout() || !typing(e.target)) return;
		// 別の入力欄へ移っただけのときは戻さない（移った先の判定を待つ）
		setTimeout(() => { if (!typing(document.activeElement)) reset(); }, 80);
	});
	const vv = window.visualViewport;
	if (!vv) return;
	const onChange = () => {
		fitChatToKeyboard();
		if (!isMobileLayout()) return;
		// キーボードが閉じると、見えている範囲が画面の高さに戻る（少しの差はアドレスバーの出入り）
		if (vv.height >= window.innerHeight - 60) setTimeout(reset, 50);
	};
	vv.addEventListener("resize", onChange);
	vv.addEventListener("scroll", onChange);
}

// キーボードが出ている間は、チャットの小窓を「キーボードの上に見えている範囲」に収める。
// 特に横向きでは、キーボードが画面の半分以上を覆い、小窓の入力欄が隠れていた。
// キーボードが閉じたら、style.css の置き場所に戻す。
function fitChatToKeyboard() {
	const vv = window.visualViewport;
	const rail = document.getElementById("rail");
	if (!vv || !rail) return;
	const open = isMobileLayout() && document.getElementById("admin").classList.contains("m-sheet-open");
	const keyboard = window.innerHeight - vv.height > 80;
	if (open && keyboard) {
		rail.style.top = `${Math.round(vv.offsetTop + 6)}px`;
		rail.style.bottom = "auto";
		rail.style.height = `${Math.round(vv.height - 12)}px`;
	} else {
		rail.style.top = rail.style.bottom = rail.style.height = "";
	}
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
		try { base.setPointerCapture(e.pointerId); } catch { }   // 丸の外へ指が出ても追い続ける
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
