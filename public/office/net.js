// WebSocket 接続：入室・全員の位置受信・自分の位置送信・転送量レベル受信。
import { store, rebuildBlocked } from "./store.js";
import { applyBudget, teardownSfu } from "./voice.js";

export function connect() {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${proto}//${location.host}/ws`);
	store.ws = ws;

	ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", name: store.me.name, avatar: store.me.avatar })));
	ws.addEventListener("message", onMessage);
	ws.addEventListener("close", () => {
		teardownSfu();
		setTimeout(connect, 1000);   // 切れたら再接続
	});
}

function onMessage(ev) {
	let msg;
	try { msg = JSON.parse(ev.data); } catch { return; }

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
			if (u.avatar) o.avatar = u.avatar;
			o.buf.push({ at: now, x: u.x, y: u.y });
			if (o.buf.length > 10) o.buf.shift();
		}
		for (const id of [...store.others.keys()]) if (!seen.has(id)) store.others.delete(id);
	} else if (msg.t === "chat") {
		store.messages.unshift({ id: msg.id, name: msg.name, text: msg.text, self: msg.id === store.myId });
		if (store.messages.length > 50) store.messages.length = 50;   // 上限
		store.chatSeq++;
	} else if (msg.t === "comments") {
		store.officeComments = Array.isArray(msg.list) ? msg.list : [];   // オフィス作成コメントの全員共有
	} else if (msg.t === "budget") {
		store.budgetLevel = msg.level;
		store.usedGb = msg.usedGb ?? store.usedGb;
		store.limitGb = msg.limitGb ?? store.limitGb;
		applyBudget();
	} else if (msg.t === "reload") {
		// 管理者が反映：レイアウト・エリア・コメントを取り直す（音声・接続はそのまま）
		fetch("/api/layout").then((r) => r.json()).then((d) => { store.layout = d; rebuildBlocked(); }).catch(() => { });
		fetch("/api/zones").then((r) => r.json()).then((d) => { store.zones = d; }).catch(() => { });
		fetch("/api/comments").then((r) => r.json()).then((d) => { store.comments = d; }).catch(() => { });
		fetch("/api/furniture").then((r) => r.json()).then((d) => { store.furniture = d; }).catch(() => { });
	}
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

// 位置送信（動いていれば約15回/秒、止まっていても2秒ごと）
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
