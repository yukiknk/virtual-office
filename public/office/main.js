// オフィス画面の起動と進行。office.html から読まれる唯一のエントリ。
//
// 3つの層でできている。
//   起動     … 初期データの取得、接続、UI のイベント登録（ファイル末尾）
//   ループ   … requestAnimationFrame で毎フレーム。移動・送信・描画
//   タイマー … 1秒ごと。タブが裏に回ってループが止まっている間を埋める
import { SHEETS, store } from "./store.js";
import { loadAll } from "./api.js";
import { KEY, read, writeJson } from "../storage.js";
import { connect, sendPos } from "./net.js";
import { updateVoice, initVoiceUI } from "./voice.js";
import { initMove, update } from "./move.js";
import { fit, draw, initPointer, sweepExpiredComments, drawMode } from "./scene.js";
import {
	initCommentUI, initLinkPrompt, initChatUI, initAwayUI, initPeopleUI, initRailToggle,
	updateRoster, updatePeople, updateLinkPrompt, updateChat, updateChatPlaceholder, updateUsage,
	updateCallPrompt, updateCallAlert,
} from "./panel.js";
import { initAlarm } from "./alarm.js";
import { initAudioSettings } from "./audio.js";
import { initMobile } from "./mobile.js";

// 画像シートの読み込みを始める。onload を src より先に設定しないと、
// キャッシュ済みの画像で完了を取り逃す。
function loadSheets() {
	for (const k of Object.keys(SHEETS)) {
		SHEETS[k].img.onload = () => { SHEETS[k].ready = true; };
		SHEETS[k].img.src = SHEETS[k].src;
	}
}

// 毎フレーム：移動 → 位置送信 → 音声更新（間引き）→ 在室者更新 → 描画
//
// 間引きの基準は「呼ぶたびに DOM を作り直す関数かどうか」。
//   間引くもの   updateVoice / updateRoster / updatePeople … 判定の計算が重め（書き換えは変化があるときだけ）
//   間引かないもの updateChat / updateUsage / updateCallPrompt / updateCallAlert
//                 … 内部に「前回と同じなら即 return」のガードがある
let lastT = 0, lastVoice = 0, lastRoster = 0, lastDraw = 0;
// 描くのは毎秒30回まで。画面によっては requestAnimationFrame が毎秒120回来るが、
// ドット絵の動きには30回で足りる。移動の計算と位置の送信は毎回行う（操作の遅れを出さない）。
// 30ms にしているのは、60Hz の画面で2回に1回（33ms ごと）、120Hz で4回に1回になるようにするため。
const DRAW_EVERY_MS = 30;
// 人が動いているときは毎秒60回まで（scene.js の drawMode が "move"）。移動を滑らかに見せる。
// 15ms にしているのは、60Hz の画面で毎回、120Hz で2回に1回になるようにするため
const MOVE_DRAW_MS = 15;
// 誰も動いていないときは毎秒5回まで（drawMode が "idle"）。話している印の点の動きが追える程度
const IDLE_DRAW_MS = 200;
function loop(t) {
	// dt の上限は移動のワープ防止。タブから戻ったときに数秒分をまとめて
	// 進めてしまわないよう、1フレーム 50ms 相当で頭打ちにする。
	const dt = lastT ? Math.min((t - lastT) / 1000, 0.05) : 0;
	lastT = t;
	update(dt);
	sendPos();
	if (t - lastVoice > 400) { lastVoice = t; updateVoice(); }
	if (t - lastRoster > 500) { lastRoster = t; updateRoster(); updatePeople(); updateChatPlaceholder(); }
	updateLinkPrompt();
	updateCallPrompt();
	updateCallAlert();
	updateChat();
	updateUsage();
	const mode = drawMode();
	const every = mode === "move" ? MOVE_DRAW_MS : mode === "fast" ? DRAW_EVERY_MS : IDLE_DRAW_MS;
	if (t - lastDraw >= every) { lastDraw = t; draw(); }
	requestAnimationFrame(loop);
}

// タブが裏に回ると requestAnimationFrame は止まる。
// その間も位置送信・音声接続・在室者表示が動くように、タイマーで補う。
// （sendPos は内部間引き、updateVoice は多重実行ガードがあるので重複呼び出しは安全）
//
// savePos と sweepExpiredComments はこちらにしかない。
// 毎フレームやる必要がないものをタイマー側に寄せている。
setInterval(() => {
	sendPos();
	updateVoice();
	updateRoster();
	updateChatPlaceholder();
	savePos();
	sweepExpiredComments();   // 消える日時を過ぎた看板を撤去
}, 1000);

// 現在位置を保存（退出・タブを閉じたとき用。退出ボタンも location 遷移で発火する）。
//
// 保存の機会は3つあり、どれか1つでも通れば位置は残る。
//   beforeunload … PC のタブを閉じたとき。モバイルや強制終了では発火しないことがある
//   pagehide     … 上より確実に呼ばれる
//   1秒タイマー  … 両方とも発火しなくても、最大1秒前の位置は残る
function savePos() {
	writeJson(KEY.pos, { x: Math.round(store.me.x), y: Math.round(store.me.y) });
}
window.addEventListener("beforeunload", savePos);
window.addEventListener("pagehide", savePos);

// ── 起動 ──

// 氏名が保存されていない＝入室画面を通らずにこのページを直接開いた、ということ。
// そのまま進めると「ゲスト」として入室してしまう（URL を自動で開く検査ツールなどが
// 入室・退出を繰り返し、Slack にも流れる）。接続せずに入室画面へ送る。
if (!read(KEY.name)) {
	location.replace("index.html");
} else {
	// 初期データ。await しないのは、データが揃う前に画面を出すため。届いたものから反映される。
	loadSheets();
	loadAll();

	// サーバーへ接続（WebSocket）
	connect();

	// UI のイベント登録
	initMove();
	initPointer();
	initVoiceUI();
	initCommentUI();
	initLinkPrompt();
	initChatUI();
	initAwayUI();
	initPeopleUI();
	initAudioSettings();
	initRailToggle();   // マップの幅が変わるので、下の fit() より前に済ませる
	initAlarm();
	initMobile();   // スマホの画面の部品（幅が広いときは CSS で隠れていて、何もしない）

	// 初回描画とループ開始
	fit();
	requestAnimationFrame(loop);
}
