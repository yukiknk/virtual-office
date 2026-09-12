// 表示用の設定（既定値）。
//
// 組織名など固有の情報はこのファイルに書かず、同じフォルダに config.local.js を作って
// 上書きしてください。config.local.js は .gitignore 済みなので、リポジトリには入りません。
// デプロイ時には wrangler がフォルダごとアップロードするため、公開サイトには反映されます。
//
// public/config.local.js の例:
//   Object.assign(window.OFFICE_CONFIG, {
//     orgName: "◯◯部",
//     namePlaceholder: "例：山田太郎",
//   });

window.OFFICE_CONFIG = {
	orgName: "デモオフィス",           // ヘッダーとメニューバーに出す組織名
	namePlaceholder: "例：山田太郎",   // 入室画面の氏名欄のプレースホルダ
};

// config.local.js はこのファイルの後に読み込まれる。
// 上書き後の値を DOM に反映するため、DOMContentLoaded まで待ってから適用する。
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
