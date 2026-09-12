// オフィスページの共有状態。各モジュールがこの store を読み書きする。
import { WORLD } from "../map.js";

// 描画に使う画像シート
// カテゴリのキーごとの画像シート（床と敷物は同じ floors.png を使う）
export const SHEETS = {
	floor: { src: "assets/floors.png", img: new Image(), ready: false },
	rug: { src: "assets/floors.png", img: new Image(), ready: false },
	wall: { src: "assets/walls.png", img: new Image(), ready: false },
	furniture: { src: "assets/dark_wood.png", img: new Image(), ready: false },
	laptop: { src: "assets/Laptop.png", img: new Image(), ready: false },
	tv: { src: "assets/TV, Widescreen.png", img: new Image(), ready: false },
};

// アバターの各レイヤーの既定（ログインで未設定のとき用）
export const DEFAULT_AVATAR = {
	head: "character-spritesheet.png",
	hair: "character-spritesheet.png",
	body: "character-spritesheet.png",
	tops: "character-spritesheet.png",
	bottoms: "character-spritesheet.png",
	shoes: "character-spritesheet.png",
	wings: null,
	accessory: null,
};

export const store = {
	// マップ内容
	layout: [],
	zones: [],
	furniture: [],        // 家具（壁の一つ上、配列順で手前）
	comments: [],         // 管理者が作成（編集・削除不可）
	messages: [],         // チャット（新着が先頭・保存しない。退出で消える）
	chatSeq: 0,           // 受信のたびに増やして再描画の判定に使う
	officeComments: [],   // オフィスで作成（全員共有・誰でも削除可）
	// 自分（位置は論理座標）
	me: { x: WORLD.w / 2, y: WORLD.h / 2, name: "ゲスト", away: false, awayMsg: "", dir: "down", moving: false, avatar: DEFAULT_AVATAR },
	// 他の接続者 id -> { name, sfu, buf: [{at,x,y}] }
	others: new Map(),
	// 接続
	ws: null,
	myId: null,
	myToken: null,
	// 転送量ガードのレベル "ok" | "screen_off" | "voice_off"
	budgetLevel: "ok",
	usedGb: 0,            // 今月の使用量（GB）
	limitGb: 1000,        // 無料枠（GB）
	// ロビーで選んだ入出力デバイス
	micId: null,
	speakerId: null,
	// 通行禁止マス（"col,row" の集合）。表示せず立入判定にだけ使う。
	blocked: new Set(),
};

// レイアウトから通行禁止マスの集合を作り直す
export function rebuildBlocked() {
	store.blocked = new Set(store.layout.filter((i) => i.layer === "block").map((i) => `${i.col},${i.row}`));
}
try {
	store.me.name = localStorage.getItem("office.name") || "ゲスト";
	store.micId = localStorage.getItem("office.micId") || null;
	store.speakerId = localStorage.getItem("office.speakerId") || null;
	const savedAv = JSON.parse(localStorage.getItem("office.avatar") || "null");
	if (savedAv) store.me.avatar = { ...DEFAULT_AVATAR, ...savedAv };
	// 前回退出した位置を復元（ワールド内にクランプ）
	const savedPos = JSON.parse(localStorage.getItem("office.pos") || "null");
	if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
		store.me.x = Math.max(0, Math.min(WORLD.w, savedPos.x));
		store.me.y = Math.max(0, Math.min(WORLD.h, savedPos.y));
	}
} catch { }

// 点がどの会話エリアにあるか（id または null）
export function zoneIdAt(x, y) {
	const zones = store.zones;
	for (let i = zones.length - 1; i >= 0; i--) {
		const z = zones[i];
		if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.id;
	}
	return null;
}
