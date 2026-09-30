// オフィス画面の共有状態。office/ の各モジュールがこの store を読み書きする。
//
// import された時点で localStorage から入室画面の設定を読み込む。
// 「定義」だけでなく「初期化」もここで済ませているファイル。
import { WORLD } from "../map.js";
import { KEY, read, readJson } from "../storage.js";

// 家具カテゴリごとの画像シート。
// キーはレイアウトデータの cat の値と一致していないといけない（scene.js が SHEETS[cat] で引く）。
// 読み込みは main.js が起動時にまとめて行い、届いたものから ready が true になる。
// floor と rug は同じ画像だが、ready を別々に持たせるため2エントリに分けている。
export const SHEETS = {
	floor: { src: "assets/floors.png", img: new Image(), ready: false },
	rug: { src: "assets/floors.png", img: new Image(), ready: false },
	wall: { src: "assets/walls.png", img: new Image(), ready: false },
	furniture: { src: "assets/dark_wood.png", img: new Image(), ready: false },
	laptop: { src: "assets/Laptop.png", img: new Image(), ready: false },
	tv: { src: "assets/TV, Widescreen.png", img: new Image(), ready: false },
};

// 入室画面でアバターを選ばなかったときの既定。null は「そのレイヤーを描かない」。
// 自分の初期値としてだけでなく、他人のアバターがまだ届いていないときの
// 代わりとしても使う（scene.js）。
//
// 実在しないファイル名を書くと画像が404になり、ready にならないまま
// scene.js の代替表示（丸）に落ちる。エラーも出ないので原因が分かりにくい。
// 素材を入れ替えたときは、ここも assets-src/avatar/ の中身と突き合わせること。
export const DEFAULT_AVATAR = {
	head: "person__light.png",
	hair: "afro__black.png",
	body: "person__light.png",
	tops: "longsleeve_laced__black.png",
	bottoms: "long_pants__black.png",
	shoes: "shoes__black.png",
	wings: null,
	accessory: null,
};

export const store = {
	// ── マップの内容（サーバーから受け取る） ──
	layout: [],
	zones: [],
	furniture: [],        // 家具（壁の一つ上、配列順で手前）

	// 看板は2種類あり、保存先と権限が違う。
	//   comments       … 管理者ページで作成。KV に保存。オフィスからは編集・削除できない
	//   officeComments … オフィスで作成。Durable Object に保存。誰でも削除できる
	comments: [],
	officeComments: [],

	messages: [],         // チャット（新着が先頭・保存しない。退出で消える）
	chatSeq: 0,           // 受信のたびに増やして再描画の判定に使う
	callAlert: null,      // 呼び出しを受けたときの画面バナー { name, at }。数秒で消す

	// ── 自分（位置はワールド座標） ──
	me: { x: WORLD.w / 2, y: WORLD.h / 2, name: "ゲスト", away: false, awayMsg: "", dir: "down", moving: false, avatar: { ...DEFAULT_AVATAR } },

	// ── 他の接続者 ──
	// id -> { name, sfu, buf: [{at,x,y}] }
	// buf は位置の受信履歴。受信は間欠なので、過去2点の間を時間で補間して滑らかに動かす。
	others: new Map(),

	// ── 接続 ──
	ws: null,
	myId: null,
	myToken: null,

	// ── 転送量ガード ──
	budgetLevel: "ok",    // "ok" | "screen_off" | "voice_off"
	usedGb: 0,            // 今月の使用量（GB）
	limitGb: 1000,        // 無料枠（GB）

	// ── 入室画面で選んだ入出力デバイス ──
	micId: null,
	speakerId: null,

	// 通行禁止マス（"col,row" の文字列の集合）。表示せず立入判定にだけ使う。
	// 文字列をキーにしているのは Set で一発で判定するため。
	blocked: new Set(),
};

// ── 入室画面からの引き継ぎ（import 時に1回だけ走る） ──

store.me.name = read(KEY.name, "ゲスト");
store.micId = read(KEY.micId, null);
store.speakerId = read(KEY.speakerId, null);

// 展開の順番が大事。保存データに無いレイヤーは既定で埋まるので、
// あとからレイヤーを増やしても古い保存データが壊れない。
const savedAv = readJson(KEY.avatar);
if (savedAv) store.me.avatar = { ...DEFAULT_AVATAR, ...savedAv };

// 前回退出した位置を復元。クランプの式は scene.js の移動時と同じ。
// blocked は見ていない（layout がまだ届いていないので判定できない）。
// 壁の中で復元されても、移動判定は「移動先」だけを見るので歩いて出られる。
const savedPos = readJson(KEY.pos);
if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
	store.me.x = Math.max(0, Math.min(WORLD.w, savedPos.x));
	store.me.y = Math.max(0, Math.min(WORLD.h, savedPos.y));
}

// layout から通行禁止マスの集合を作り直す。layout が届く・更新されるたびに呼ぶ。
export function rebuildBlocked() {
	store.blocked = new Set(store.layout.filter((i) => i.layer === "block").map((i) => `${i.col},${i.row}`));
}

// 点がどの会話エリアの中にあるか（id または null）。
// 後ろから探すので、重なっている場合は手前に描かれるほうが勝つ（drawZones と同じ順）。
// 右端・下端を含めないのは、隣り合うエリアで二重に当たらないようにするため。
export function zoneIdAt(x, y) {
	const zones = store.zones;
	for (let i = zones.length - 1; i >= 0; i--) {
		const z = zones[i];
		if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z.id;
	}
	return null;
}
