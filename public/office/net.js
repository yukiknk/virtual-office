// サーバーとの WebSocket。このファイルが通信のすべてを受け持つ。
//
//   受信 … 入室の返事・全員の位置・チャット・呼び出し・看板・転送量・反映通知
//   送信 … 自分の位置・チャット・離席・呼び出し・看板の追加と削除
//
// 使うのは main.js（connect / sendPos）と scene.js（各 send*）の2つだけ。
import { store } from "./store.js";
import { loadAll } from "./api.js";
import { applyBudget, resumeInfo, onServerLost, onServerJoined } from "./voice.js";
import { playAlarm, showCallNotification } from "./alarm.js";

// このタブを見分ける ID。再接続しても、ページを再読み込みしても変わらない。
// サーバーはこれを見て「同じ人がつなぎ直しただけ」を判別し、Slack へ
// 退出・入室を流さないようにする（src/room.js の onHello / scheduleLeave）。
//
// sessionStorage に置くのは、タブごとに別の値で、再読み込みでは残り、タブを閉じると
// 消えるため。localStorage だと同じ人の別タブと同じ値になり、片方を閉じたときの
// 退出が通知されなくなる。storage.js を通さないのは、あちらが localStorage 専用のため。
const CID_KEY = "office.cid";
let CID = loadCid();

function loadCid() {
	try {
		const saved = sessionStorage.getItem(CID_KEY);
		if (saved && /^[\w-]{1,32}$/.test(saved)) return saved;
	} catch { }   // プライベートモードなどで読めなくても、下で作った値で動く
	return newCid();
}

function newCid() {
	let id;
	try { id = crypto.randomUUID().replace(/-/g, "").slice(0, 16); }
	catch { id = "c" + Math.random().toString(36).slice(2, 12); }   // http のままの環境では randomUUID が使えない
	try { sessionStorage.setItem(CID_KEY, id); } catch { }
	return id;
}

export function connect() {
	// ローカル開発（http）と本番（https）の両方で動くようプロトコルを合わせる
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${proto}//${location.host}/ws`);
	store.ws = ws;

	// 名前とアバターは接続のたびに送る。サーバーは切断でこれらを忘れるため。
	// 離席状態も一緒に送る。あとから away で送り直すと、再接続のたびに Slack へ「離席しました」が流れる。
	// 音声と画面共有の接続も添えて、サーバーに引き継がせる（voice.js の resumeInfo）。
	ws.addEventListener("open", () => {
		ws.send(JSON.stringify({ t: "hello", name: store.me.name, avatar: store.me.avatar, cid: CID, away: store.me.away, awayMsg: store.me.awayMsg, resume: resumeInfo() || undefined }));
		// 位置もすぐ送る。止まっている人は2秒に1回しか送らないので、待つと
		// そのあいだサーバーが位置を知らず、他の人から見えない・声が届かない時間ができる。
		lastSent = 0;
		sendPos();
	});
	ws.addEventListener("message", onMessage);

	// error は listen していない。WebSocket はエラーの後に必ず close が来るので close だけで足りる。
	// 再接続の間隔は1秒固定。部屋が1つの小規模用途なので、バックオフは入れていない。
	ws.addEventListener("close", (e) => {
		if (store.ws !== ws) return;   // すでに新しい接続に替わっている
		// 音声はここでは畳まない。部屋の作り直しなどで切れても、つなぎ直せば引き継げる
		// （voice.js の onServerLost / onServerJoined）。id と合言葉は次の welcome まで無効にする。
		store.myId = null;
		store.myToken = null;
		onServerLost();
		// 4001 は「同じ ID の別の接続が入ってきたので退かされた」。タブを複製すると
		// sessionStorage ごと写るので、2つのタブが同じ ID になる。そのまま入り直すと
		// 互いに退かし合うので、退かされた側が ID を作り直して別のタブとして入る。
		if (e.code === 4001) CID = newCid();
		setTimeout(connect, 1000);   // 切れたら再接続
	});
}

// ページを離れるとき（退出ボタン・タブを閉じる・別のページへ移動）は、こちらから接続を閉じる。
// ブラウザ任せにすると、ページが「戻る」用に保持された場合などに切断が遅れ、
// そのあいだ他の人の画面にアバターが残る。戻ってきたときは close の処理が再接続する。
window.addEventListener("pagehide", () => {
	try { if (store.ws) store.ws.close(1000, "leave"); } catch { }
});

// ── 受信 ──

// 受け取ったメッセージを t の値で振り分ける。中身はそれぞれ下の関数にある。
function onMessage(ev) {
	let msg;
	try { msg = JSON.parse(ev.data); } catch { return; }   // 壊れたデータは黙って捨てる

	if (msg.t === "welcome") onWelcome(msg);
	else if (msg.t === "state") onState(msg);
	else if (msg.t === "chat") onChat(msg);
	else if (msg.t === "called") onCalled(msg);
	else if (msg.t === "call_sent") onCallSent(msg);
	else if (msg.t === "comments") store.officeComments = Array.isArray(msg.list) ? msg.list : [];
	else if (msg.t === "budget") applyBudgetInfo(msg);
	else if (msg.t === "reload") loadAll();   // 管理者が反映（音声・接続はそのまま）
}

// 入室の返事。自分の id と、転送量の現状を受け取る。
function onWelcome(msg) {
	store.myId = msg.id;
	store.myToken = msg.token;
	applyBudgetInfo(msg.budget);
	onServerJoined(!!msg.resumed);
	if (store.me.away) sendAway(true, store.me.awayMsg);   // 再接続時に離席状態を送り直す
}

// 転送量レベルの反映。welcome の中（msg.budget）と budget メッセージ（msg 自身）で
// 同じ形が来るので、どちらもここを通す。
function applyBudgetInfo(b) {
	if (!b) return;
	store.budgetLevel = b.level;
	store.usedGb = b.usedGb ?? store.usedGb;
	store.limitGb = b.limitGb ?? store.limitGb;
	applyBudget();
}

// 全員の位置。自分以外を others に反映し、届かなかった人を消す。
function onState(msg) {
	const now = Date.now();
	const seen = new Set();
	for (const u of msg.users) {
		if (u.id === store.myId) continue;
		seen.add(u.id);
		let o = store.others.get(u.id);
		if (!o) { o = { name: u.name, buf: [] }; store.others.set(u.id, o); }
		o.name = u.name;
		o.sfu = u.sfu;
		o.away = !!u.away;
		o.awayMsg = u.awayMsg || "";
		o.talk = !!u.talk;   // 話しているか（アバターに吹き出しを出す）
		o.mic = !!u.mic;     // マイクが ON か（名前ラベルに印を出す）
		if (u.avatar) o.avatar = u.avatar;   // 未設定の人の情報で既存の値を消さない
		// 位置が変わった人がいれば、絵を毎秒30回に戻す（scene.js の drawMode）
		const prev = o.buf[o.buf.length - 1];
		if (!prev || prev.x !== u.x || prev.y !== u.y) store.motionAt = now;
		// 受信時刻つきで積む。scene.js が過去2点の間を補間して滑らかに動かす。
		o.buf.push({ at: now, x: u.x, y: u.y });
		if (o.buf.length > 10) o.buf.shift();   // 15回/秒なので約0.7秒分。補間には末尾2件しか使わない
	}
	for (const id of [...store.others.keys()]) if (!seen.has(id)) store.others.delete(id);   // 退出した人を消す
}

function onChat(msg) {
	pushMessage({ id: msg.id, name: msg.name, text: msg.text, self: msg.id === store.myId });
}

// 呼び出された：音・ブラウザ通知・画面のバナー・チャット欄への記録
function onCalled(msg) {
	playAlarm();
	showCallNotification(msg.name);
	store.callAlert = { name: msg.name, at: msg.at || Date.now() };
	pushCallLog(`${hhmm(msg.at)} に${msg.name}さんから呼び出しがありました`);
}

// 自分が呼び出した控え。呼んだ側にも同じ音を鳴らす（呼び出せたことが音で分かるように）
// 「全員」で呼び出すと控えが人数ぶん続けて届くので、音は最初の1回だけ鳴らす
let callSentSoundAt = 0;
function onCallSent(msg) {
	const now = Date.now();
	if (now - callSentSoundAt > 3000) { callSentSoundAt = now; playAlarm(); }
	pushCallLog(`${hhmm(msg.at)} に${msg.name}さんを呼び出しました`);
}

// ── チャット欄 ──

// 1件積む。古い順に並べ、新着は末尾。50件を超えたら古いものから落とす。
// at は受け取った時刻（この端末の時計）。チャット欄に時刻を出すのに使う。
// chatSeq を増やすのが panel.js への「変わった」の合図。
function pushMessage(m) {
	m.at = Date.now();
	store.messages.push(m);
	if (store.messages.length > 50) store.messages.splice(0, store.messages.length - 50);
	store.chatSeq++;
}

// 呼び出しの記録はチャット欄に混ぜて出す（kind: "call" で見た目を分ける）
function pushCallLog(text) {
	pushMessage({ kind: "call", text });
}

function hhmm(at) {
	const d = new Date(Number.isFinite(+at) ? +at : Date.now());
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── 送信 ──

// 接続していれば送る、切れていれば黙って捨てる。
// 捨てても、再接続時に hello と離席状態は送り直されるので状態は復旧する。
function send(obj) {
	const ws = store.ws;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

export const sendCall = (toId) => send({ t: "call", to: toId });          // 近接・離席・連打はサーバー側でも検査される
export const sendComment = (comment) => send({ t: "comment_add", comment });   // 看板の追加・移動（サーバーが全員へ配信）
export const removeComment = (id) => send({ t: "comment_remove", id });
export const sendChat = (text) => send({ t: "chat", text });              // サーバーがエリア内・近接の人へ配信
export const sendAway = (away, msg) => send({ t: "away", away, msg });

// 位置送信（動いていれば約15回/秒、止まっていても2秒ごと）。
// 止まっていても送り続けるのは、サーバー側の生存確認を兼ねるため。
let lastSent = 0, lastPos = { x: null, y: null };
export function sendPos() {
	const ws = store.ws;
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	const now = Date.now();
	const moved = lastPos.x !== store.me.x || lastPos.y !== store.me.y;
	const interval = moved ? 66 : 2000;
	if (now - lastSent >= interval) {
		ws.send(JSON.stringify({ t: "pos", x: Math.round(store.me.x), y: Math.round(store.me.y) }));
		lastSent = now;
		lastPos = { x: store.me.x, y: store.me.y };
	}
}
