// サーバーからマップの内容を取り直す。
// 起動時（main.js）と、管理者が「反映」したとき（net.js）の両方から使う。
//
// 以前は同じ処理が main.js と net.js に別々に書かれていて、
// 失敗したときの扱いだけが食い違っていた。ここに一本化してある。
import { store, rebuildBlocked } from "./store.js";

// 取れなかったときは store を触らない。
// 起動時は空のまま、反映時は前の内容が残るので、画面が真っ白にならない。
//
// なお fetch は 404 でも例外を投げないが、本文が JSON でないので .json() 側で
// 落ちて結局ここへ来る。通信エラーと 404 は同じ扱いになる。
async function refresh(path, key) {
	try { store[key] = await (await fetch(path)).json(); } catch { }
}

export async function loadLayout() {
	await refresh("/api/layout", "layout");
	rebuildBlocked();   // 通行禁止マスを作り直す
}
export const loadZones = () => refresh("/api/zones", "zones");
export const loadComments = () => refresh("/api/comments", "comments");
export const loadFurniture = () => refresh("/api/furniture", "furniture");

// 4つまとめて取り直す。待たないので、届いたものから順に反映される。
export function loadAll() {
	loadLayout();
	loadZones();
	loadComments();
	loadFurniture();
}
