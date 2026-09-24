// アバター画像の読み込みと描画。入室画面とオフィス画面の両方から使う。
//
// 素材は LPC（Liberated Pixel Cup）のスプライトシート。1コマ 64×64px。
//
// 配布物は1枚に全ポーズ（呪文・突き・歩行・斬り・射撃など）が並んだ
// 832×3456 のシートだが、このアプリが使うのは歩行の4行×9コマだけ。
// 残りまで読み込むと展開時間とメモリの無駄になるため、歩行部分だけを
// 切り出したもの（576×256）を配信している。
// 切り出しは scripts/build-avatars.mjs がデプロイ前に行う。
//
// 8レイヤー（頭・髪・体・トップス・ボトムス・靴・羽・持ち物）のPNGを
// 同じ位置に重ねて1人分の絵になる。

export const SPRITE = 64;                                   // シート1コマの大きさ(px)
export const WALK_FRAMES = 9;                               // 歩行1周のコマ数（列0〜8）
// 切り出し済みシートの行。配布物では 8/9/10/11 行目にあたる。
// scripts/build-avatars.mjs の CROP と対になっている。片方だけ変えないこと。
export const DIR_ROW = { up: 0, left: 1, down: 2, right: 3 };

// 重ね順（奥→手前）。後ろ向きのときだけ入れ替える。
// 背中を向けると羽は体より手前に、持ち物は体の奥に回り込むため。
const ORDER_DEFAULT = ["wings", "body", "shoes", "bottoms", "tops", "head", "hair", "accessory"];
const ORDER_UP = ["accessory", "body", "shoes", "bottoms", "tops", "wings", "head", "hair"];

export function orderFor(dir) {
	return dir === "up" ? ORDER_UP : ORDER_DEFAULT;
}

// ── 画像の読み込み ──
// 同じPNGを何度も読まないようキャッシュする。キーは URL。
const cache = new Map();
const onLoadCallbacks = [];

// 画像が読み終わったときに呼ぶ処理を登録する。
// 画像は遅れて届くため、一度描いたきりの画面ではレイヤーが抜けたままになる。
// 毎フレーム描き直すオフィス画面には不要で、入室画面のプレビューが使う。
export function onImageLoad(fn) {
	onLoadCallbacks.push(fn);
}

// カテゴリとファイル名から画像を得る。未読込でも {img, ready:false} をすぐ返す。
// ファイル名は manifest 由来だが、想定外の値でパスを組み立てないよう形を検査する。
export function layerImg(cat, file) {
	if (!file || !/^[\w.\-]+\.png$/.test(file)) return null;
	const src = `assets/avatar/${cat}/${file}`;
	let entry = cache.get(src);
	if (!entry) {
		entry = { img: new Image(), ready: false };
		entry.img.onload = () => {
			entry.ready = true;
			for (const fn of onLoadCallbacks) fn();
		};
		entry.img.src = src;
		cache.set(src, entry);
	}
	return entry;
}

// ── 描画 ──
// cfg … { head:"person__light.png", hair:..., ... } レイヤーごとのファイル名。null は「なし」
// opt … dir:向き / frame:コマ番号 / dx,dy,dw,dh:描画先の矩形
//
// 読み込みが終わっているレイヤーだけを描く。まだのものは次回以降に現れる。
export function drawAvatar(ctx, cfg, opt) {
	const sx = (opt.frame || 0) * SPRITE;
	const sy = (DIR_ROW[opt.dir] ?? DIR_ROW.down) * SPRITE;
	ctx.imageSmoothingEnabled = false;   // ドット絵なので補間しない
	for (const cat of orderFor(opt.dir)) {
		const entry = layerImg(cat, cfg[cat]);
		if (entry && entry.ready) {
			ctx.drawImage(entry.img, sx, sy, SPRITE, SPRITE, opt.dx, opt.dy, opt.dw, opt.dh);
		}
	}
}
