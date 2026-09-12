// 管理者ページの共有状態とタイルカテゴリ定義。

// カテゴリ（タブ）：上から順に表示。家具などを足すならここに1行追加するだけ。
export const CATEGORIES = [
	{ key: "wall", name: "壁", src: "assets/walls.png", layer: "object" },
	{ key: "rug", name: "敷物", src: "assets/floors.png", layer: "rug" },   // 床と同じシートだが別レイヤー
	{ key: "floor", name: "床タイル", src: "assets/floors.png", layer: "floor" },
];
for (const cat of CATEGORIES) {
	cat.img = new Image();
	cat.ready = false;
}

// 家具シート：1つの「家具」タブの中で切り替えて選ぶ。自由配置・ドラッグ移動・重ね置き可（壁の一つ上）。
export const FURNITURE = [
	{ key: "furniture", name: "木製家具", src: "assets/dark_wood.png" },
	{ key: "laptop", name: "ラップトップ", src: "assets/Laptop.png" },
	{ key: "tv", name: "TV", src: "assets/TV, Widescreen.png" },
];
for (const s of FURNITURE) {
	s.img = new Image();
	s.ready = false;
}

export const store = {
	// 配置データ（レイヤーごとの Map）。値 = { catKey, tileCol, tileRow }
	// 描画順（下→上）：floor → rug → object
	layers: { floor: new Map(), rug: new Map(), object: new Map() },
	// 会話エリア一覧 { id, x, y, w, h, name }
	zones: [],
	// 家具一覧 { id, cat, sx, sy, sw, sh, x, y }。壁の一つ上、配列の後ろほど手前。
	furniture: [],
	// 家具の配置ブラシ（モーダルで範囲選択した絵）。{ cat, sx, sy, sw, sh } or null
	furnitureBrush: null,
	// コメント（メモ）一覧 { id, x, y, w, h, text }。一番上のレイヤー。
	comments: [],
	// 通行禁止マス（"col,row" の集合）。オフィスでは非表示・立入不可。
	blocked: new Set(),
	// 編集状態
	selectedTile: null,     // { catKey, tileCol, tileRow, layer }
	target: null,           // 編集対象：null=未選択 | "floor" | "rug" | "object" | "zone" | "block"
	activeCatKey: null,     // ハイライトするタブ（未選択なら null）
	erase: false,           // 消去モードか（対象＝target を消す）
	showAll: true,          // 入室時は全体表示（壁・敷物・床・コメントを表示、グリッド非表示）
	autoSave: false,        // 既定は手動保存
	dirty: false,           // 手動保存モードで未保存の変更があるか
};
