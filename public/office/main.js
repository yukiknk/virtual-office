// オフィスページの起動：画像・レイアウト・エリアを読み込み、接続とループを開始。
import { SHEETS, store, rebuildBlocked } from "./store.js";
import { KEY, writeJson } from "../storage.js";
import { connect, sendPos } from "./net.js";
import { updateVoice, initVoiceUI } from "./voice.js";
import { fit, draw, update, initInput, updateRoster, initCommentUI, initLinkPrompt, updateLinkPrompt, initChatUI, updateChat, initAwayUI, updateUsage, initPeopleUI, updatePeople, sweepExpiredComments, updateCallPrompt, updateCallAlert } from "./scene.js";
import { initAlarm } from "./alarm.js";

function loadSheets() {
	for (const k of Object.keys(SHEETS)) {
		SHEETS[k].img.onload = () => { SHEETS[k].ready = true; };
		SHEETS[k].img.src = SHEETS[k].src;
	}
}
async function loadLayout() {
	try { store.layout = await (await fetch("/api/layout")).json(); } catch { store.layout = []; }
	rebuildBlocked();
}
async function loadZones() {
	try { store.zones = await (await fetch("/api/zones")).json(); } catch { store.zones = []; }
}
async function loadComments() {
	try { store.comments = await (await fetch("/api/comments")).json(); } catch { store.comments = []; }
}
async function loadFurniture() {
	try { store.furniture = await (await fetch("/api/furniture")).json(); } catch { store.furniture = []; }
}

// 毎フレーム：移動 → 位置送信 → 音声更新（間引き）→ 在室者更新 → 描画
let lastT = 0, lastVoice = 0, lastRoster = 0;
function loop(t) {
	const dt = lastT ? Math.min((t - lastT) / 1000, 0.05) : 0;
	lastT = t;
	update(dt);
	sendPos();
	if (t - lastVoice > 400) { lastVoice = t; updateVoice(); }
	if (t - lastRoster > 500) { lastRoster = t; updateRoster(); updatePeople(); }
	updateLinkPrompt();
	updateCallPrompt();
	updateCallAlert();
	updateChat();
	updateUsage();
	draw();
	requestAnimationFrame(loop);
}

// タブが裏に回ると requestAnimationFrame は止まる。
// その間も位置送信・音声接続・在室者表示が動くように、タイマーで補う。
// （sendPos は内部間引き、updateVoice は多重実行ガードがあるので重複呼び出しは安全）
setInterval(() => {
	sendPos();
	updateVoice();
	updateRoster();
	savePos();
	sweepExpiredComments();   // 消える日時を過ぎた看板を撤去
}, 1000);

// 現在位置を保存（退出・タブを閉じたとき用。退出ボタンも location 遷移で発火する）
function savePos() {
	writeJson(KEY.pos, { x: Math.round(store.me.x), y: Math.round(store.me.y) });
}
window.addEventListener("beforeunload", savePos);
window.addEventListener("pagehide", savePos);

loadSheets();
loadLayout();
loadZones();
loadComments();
loadFurniture();
connect();
initInput();
initVoiceUI();
initCommentUI();
initLinkPrompt();
initChatUI();
initAwayUI();
initPeopleUI();
initAlarm();
fit();
requestAnimationFrame(loop);
