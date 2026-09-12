// 管理者ページの起動：画像シート → レイアウト → エリアの順に読み込み、UIとエディタを初期化。
import { CATEGORIES, FURNITURE } from "./store.js";
import { loadLayout, loadZones, loadComments, loadFurniture } from "./data.js";
import { initUI } from "./ui.js";
import { initEditor, fit, draw } from "./editor.js";

function loadSheets() {
	const all = [...CATEGORIES, ...FURNITURE];
	return Promise.all(all.map((s) => new Promise((resolve) => {
		s.img.onload = () => { s.ready = true; resolve(); };
		s.img.onerror = () => resolve();
		s.img.src = s.src;
	})));
}

(async () => {
	await loadSheets();
	await loadLayout();
	await loadZones();
	await loadComments();
	await loadFurniture();
	initEditor();
	initUI(draw);   // タブ切替や表示切替で editor.draw を呼べるように渡す
	fit();          // 初回描画
	if (document.fonts) document.fonts.ready.then(draw);   // Webフォント読込後に描き直す
})();
