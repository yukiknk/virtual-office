// レイアウトと会話エリアの保存・読み込み（サーバーAPI / KV）。
import { store } from "./store.js";

// 読み込みに失敗した項目（"layout" など）。1つでも入っているあいだは保存しない。
// 失敗を空として扱って保存すると、本番のデータを空で上書きしてしまうため。
export const loadFailed = new Set();

// 一覧を取得する。失敗したら null を返し、loadFailed に記録する。
async function getList(path, key) {
	try {
		const res = await fetch(path);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const list = await res.json();
		if (!Array.isArray(list)) throw new Error("配列ではありません");
		loadFailed.delete(key);
		return list;
	} catch (e) {
		console.warn("読み込み失敗", path, e);
		loadFailed.add(key);
		return null;
	}
}

// 一覧を保存する。成功したら true。
// fetch は 400 や 413 でも例外を投げないので、res.ok を見ないと失敗に気づけない。
async function postList(path, data) {
	if (loadFailed.size) return false;
	try {
		const res = await fetch(path, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
		});
		if (!res.ok) console.warn("保存失敗", path, res.status);
		return res.ok;
	} catch (e) {
		console.warn("保存失敗", path, e);
		return false;
	}
}

// ── レイアウト ──
export async function loadLayout() {
	const list = await getList("/api/layout", "layout");
	if (!list) return;   // 失敗時は今の内容を触らない
	for (const m of Object.values(store.layers)) m.clear();
	store.blocked.clear();
	for (const item of list) {
		if (item.layer === "block") { store.blocked.add(`${item.col},${item.row}`); continue; }
		const layerKey = item.layer || "floor";
		if (!store.layers[layerKey]) continue;
		store.layers[layerKey].set(`${item.col},${item.row}`, {
			catKey: item.cat || "floor", tileCol: item.tileCol, tileRow: item.tileRow,
		});
	}
}

export function saveLayout() {
	const list = [];
	for (const layerKey of ["floor", "rug", "object"]) {
		for (const [key, ref] of store.layers[layerKey]) {
			const [col, row] = key.split(",").map(Number);
			list.push({ col, row, layer: layerKey, cat: ref.catKey, tileCol: ref.tileCol, tileRow: ref.tileRow });
		}
	}
	for (const key of store.blocked) {
		const [col, row] = key.split(",").map(Number);
		list.push({ col, row, layer: "block" });
	}
	return postList("/api/layout", list);
}

// ── 会話エリア ──
export async function loadZones() {
	const list = await getList("/api/zones", "zones");
	if (list) store.zones = list;
}

export function saveZones() {
	return postList("/api/zones", store.zones);
}

// ── 家具 ──
export async function loadFurniture() {
	const list = await getList("/api/furniture", "furniture");
	if (list) store.furniture = list;
}
export function saveFurniture() {
	return postList("/api/furniture", store.furniture);
}

// ── Slack 通知先（Webhook URL） ──
// URL 自体はサーバーから返ってこない（設定済みかどうかと末尾だけ）。
export async function loadWebhook() {
	try { return await (await fetch("/api/webhook")).json(); } catch { return { configured: false }; }
}

// url に空文字を渡すと登録解除。戻り値 { ok, configured, hint, error }
export async function saveWebhook(url) {
	try {
		const res = await fetch("/api/webhook", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
		});
		const body = await res.json().catch(() => ({}));
		return { ok: res.ok, ...body };
	} catch (e) {
		return { ok: false, error: "通信に失敗しました" };
	}
}

// ── コメント（メモ） ──
export async function loadComments() {
	const list = await getList("/api/comments", "comments");
	if (list) store.comments = list;
}

export function saveComments() {
	return postList("/api/comments", store.comments);
}
