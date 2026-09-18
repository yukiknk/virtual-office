// 画面に出す文言の設定（既定値）。入室画面とオフィス画面の両方が読む。
//
// 同じ名前の src/config.js とは別物。あちらはサーバー側（Worker）の定数で、
// このファイルはブラウザ側の表示文言だけを持つ。
//
// 組織名など固有の情報はここに書かない。同じフォルダに config.local.js を作って
// 上書きする。config.local.js は .gitignore 済みなのでリポジトリには入らないが、
// デプロイ時は wrangler が public/ ごとアップロードするので公開サイトには反映される。
//
// config.local.js の中身:
//   Object.assign(window.OFFICE_CONFIG, {
//     orgName: "◯◯部",
//     namePlaceholder: "例：山田太郎",
//   });

// window に置くのは、config.local.js から触れるようにするため。
window.OFFICE_CONFIG = {
	orgName: "デモオフィス",           // ヘッダーとメニューバーに出す組織名
	namePlaceholder: "例：山田太郎",   // 入室画面の氏名欄のプレースホルダ
};

// 上書きを取り込むため DOMContentLoaded を待つ。
// このファイルは head で読まれるので、その時点では対象の要素がまだ無い。
//
// HTML 側は3種類の目印で受ける。
//   data-config="キー"             … 要素の文字を差し替える
//   data-config-placeholder="キー" … 入力欄のプレースホルダを差し替える
//   data-config-title="固定文字"   … タブのタイトルを「組織名 + 固定文字」にする
document.addEventListener("DOMContentLoaded", () => {
	const c = window.OFFICE_CONFIG || {};
	for (const el of document.querySelectorAll("[data-config]")) {
		const v = c[el.dataset.config];
		if (v) el.textContent = v;
	}
	for (const el of document.querySelectorAll("[data-config-placeholder]")) {
		const v = c[el.dataset.configPlaceholder];
		if (v) el.placeholder = v;
	}
	const t = document.querySelector("title[data-config-title]");
	if (t && c.orgName) document.title = `${c.orgName} ${t.dataset.configTitle}`.trim();
});
