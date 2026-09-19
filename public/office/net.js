// サーバーとの WebSocket。このファイルが通信のすべてを受け持つ。
//
//   受信 … 入室の返事・全員の位置・チャット・呼び出し・看板・転送量・反映通知
//   送信 … 自分の位置・チャット・離席・呼び出し・看板の追加と削除
//
// 使うのは main.js（connect / sendPos）と scene.js（各 send*）の2つだけ。
import { store, rebuildBlocked } from "./store.js";
import { applyBudget, teardownSfu } from "./voice.js";
import { playAlarm, showCallNotification } from "./alarm.js";

export function connect() {
	// ローカル開発（http）と本番（https）の両方で動くようプロトコルを合わせる
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${proto}//${location.host}/ws`);
	store.ws = ws;

	// 名前とアバターは接続のたびに送る。サーバーは切断でこれらを忘れるため。
	ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", name: store.me.name, avatar: store.me.avatar })));
	ws.addEventListener("message", onMessage);

	// error は listen していない。WebSocket はエラーの後に必ず close が来るので close だけで足りる。
	// 再接続の間隔は1秒固定。部屋が1つの小規模用途なので、バックオフは入れていない。
	ws.addEventListener("close", () => {
		teardownSfu();
		setTimeout(connect, 1000);   // 切れたら再接続
	});
}

function onMessage(ev) {
	let msg;
	try { msg = JSON.parse(ev.data); } catch { return; }   // 壊れたデータは黙って捨てる

	if (msg.t === "welcome") {
		store.myId = msg.id;
		store.myToken = msg.token;
		if (msg.budget) {
			store.budgetLevel = msg.budget.level;
			store.usedGb = msg.budget.usedGb ?? store.usedGb;
			store.limitGb = msg.budget.limitGb ?? store.limitGb;
			applyBudget();
		}
		if (store.me.away) sendAway(true, store.me.awayMsg);   // 再接続時に離席状態を送り直す
	} else if (msg.t === "state") {
		// 全員の位置。自分以外を others に反映し、届かなかった人を消す。
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
			if (u.avatar) o.avatar = u.avatar;   // 未設定の人の情報で既存の値を消さない
			// 受信時刻つきで積む。scene.js が過去2点の間を補間して滑らかに動かす。
			o.buf.push({ at: now, x: u.x, y: u.y });
			if (o.buf.length > 10) o.buf.shift();   // 15回/秒なので約0.7秒分。補間には末尾2件しか使わない
		}
		for (const id of [...store.others.keys()]) if (!seen.has(id)) store.others.delete(id);   // 退出した人を消す
	} else if (msg.t === "chat") {
		store.messages.unshift({ id: msg.id, name: msg.name, text: msg.text, self: msg.id === store.myId });
		if (store.messages.length > 50) store.messages.length = 50;   // 上限
		store.chatSeq++;
	} else if (msg.t === "called") {
		// 呼び出された：音・ブラウザ通知・画面のバナー・チャット欄への記録
		playAlarm();
		showCallNotification(msg.name);
		store.callAlert = { name: msg.name, at: msg.at || Date.now() };
		pushCallLog(`${hhmm(msg.at)} に${msg.name}さんから呼び出しがありました`);
	} else if (msg.t === "call_sent") {
		// 自分が呼び出した控え（音は鳴らさない）
		pushCallLog(`${hhmm(msg.at)} に${msg.name}さんを呼び出しました`);
	} else if (msg.t === "comments") {
		store.officeComments = Array.isArray(msg.list) ? msg.list : [];   // オフィス作成コメントの全員共有
	} else if (msg.t === "budget") {
		store.budgetLevel = msg.level;
		store.usedGb = msg.usedGb ?? store.usedGb;
		store.limitGb = msg.limitGb ?? store.limitGb;
		applyBudget();
	} else if (msg.t === "reload") {
		// 管理者が反映：レイアウト・エリア・コメントを取り直す（音声・接続はそのまま）。
		// 失敗しても何もしない＝前の内容が残るので、反映に失敗しても画面は白くならない。
		fetch("/api/layout").then((r) => r.json()).then((d) => { store.layout = d; rebuildBlocked(); }).catch(() => { });
		fetch("/api/zones").then((r) => r.json()).then((d) => { store.zones = d; }).catch(() => { });
		fetch("/api/comments").then((r) => r.json()).then((d) => { store.comments = d; }).catch(() => { });
		fetch("/api/furniture").then((r) => r.json()).then((d) => { store.furniture = d; }).catch(() => { });
	}
}

// 呼び出しの記録はチャット欄に混ぜて出す（kind: "call" で見た目を分ける）
function hhmm(at) {
	const d = new Date(Number.isFinite(+at) ? +at : Date.now());
	return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function pushCallLog(text) {
	store.messages.unshift({ kind: "call", text });
	if (store.messages.length > 50) store.messages.length = 50;
	store.chatSeq++;   // scene.js への「変わった」の合図
}

// ── 送信 ──
// どれも「接続していれば送る、切れていれば黙って捨てる」。
// 捨てても、再接続時に hello と離席状態は送り直されるので状態は復旧する。

// 呼び出しを送る（近接・離席・連打はサーバー側でも検査される）
export function sendCall(toId) {
	const ws = store.ws;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "call", to: toId }));
}

// オフィスコメントの追加・削除（サーバーが全員へ配信する）
export function sendComment(comment) {
	const ws = store.ws;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "comment_add", comment }));
}
export function removeComment(id) {
	const ws = store.ws;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "comment_remove", id }));
}

// チャット送信（サーバーがエリア内・近接の人へ配信）
export function sendChat(text) {
	const ws = store.ws;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "chat", text }));
}

// 離席状態の送信
export function sendAway(away, msg) {
	const ws = store.ws;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "away", away, msg }));
}

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
