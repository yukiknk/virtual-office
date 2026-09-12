// レイアウトと会話エリアの保存・読み込み（サーバーAPI / KV）。
import { store } from "./store.js";

// ── レイアウト ──
export async function loadLayout() {
	let list;
	try { list = await (await fetch("/api/layout")).json(); } catch { list = []; }
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
	return fetch("/api/layout", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(list),
	}).catch((e) => console.warn("保存失敗", e));
}

// ── 会話エリア ──
export async function loadZones() {
	try { store.zones = await (await fetch("/api/zones")).json(); } catch { store.zones = []; }
}

export function saveZones() {
	return fetch("/api/zones", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(store.zones),
	}).catch((e) => console.warn("エリア保存失敗", e));
}

// ── 家具 ──
export async function loadFurniture() {
	try { store.furniture = await (await fetch("/api/furniture")).json(); } catch { store.furniture = []; }
}
export function saveFurniture() {
	return fetch("/api/furniture", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(store.furniture),
	}).catch((e) => console.warn("家具保存失敗", e));
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
	try { store.comments = await (await fetch("/api/comments")).json(); } catch { store.comments = []; }
}

export function saveComments() {
	return fetch("/api/comments", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(store.comments),
	}).catch((e) => console.warn("コメント保存失敗", e));
}
