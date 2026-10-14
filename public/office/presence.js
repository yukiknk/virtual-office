// 「作業中」の判定。オフィスの画面から目を離しているか（ほかのタブ・最小化・ほかのアプリ）を
// 全員に知らせ、マップ上のアバターを薄くして足元に「作業中」と出す（scene.js）。
//
//   作業中   … ほかのタブにしている、ウィンドウを最小化している、ほかのアプリを触っている
//   見ている … オフィスのタブが前にあり、そのウィンドウを触っている
//
// 目を離して WORK_AFTER_MS 続いたら「作業中」にする。アドレスバーを一瞬触った、別のアプリへ
// 一瞬切り替えた、程度で切り替わらないようにするため。戻ったときはすぐに外す。
// 離席中は離席の表示を優先する（サーバーが離席中の人の「作業中」は配らない）。
import { store } from "./store.js";
import { sendWork } from "./net.js";

const WORK_AFTER_MS = 5000;
let timer = null;

export function initPresence() {
	const check = () => {
		const away = document.hidden || !document.hasFocus();
		if (!away) {
			clearTimeout(timer);
			timer = null;
			setWorking(false);
			return;
		}
		if (timer || store.me.working) return;
		timer = setTimeout(() => {
			timer = null;
			if (document.hidden || !document.hasFocus()) setWorking(true);
		}, WORK_AFTER_MS);
	};
	document.addEventListener("visibilitychange", check);
	window.addEventListener("focus", check);
	window.addEventListener("blur", check);
	check();
}

function setWorking(on) {
	if (store.me.working === on) return;
	store.me.working = on;
	sendWork(on);
}
