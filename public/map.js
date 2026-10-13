// マップの共通エンジン。オフィス画面（office/scene.js）と管理者ページ（admin/editor.js）が
// 同じマップを同じ大きさで描くために、大きさの定数・座標変換・下地の描画をここに集めている。
//
// 座標は3種類
//   ワールド座標 … マップ上の位置。画面の大きさに関係なく一定で、家具もコメントもこの値で保存する。
//   画面座標     … キャンバス上の位置。ワールド座標に倍率と余白を足したもの。
//   実ピクセル   … ディスプレイの物理的な点。高解像度画面では画面座標1つが2点以上になる。
//
// 外から使うのは ワールド ⇄ 画面 の変換（w2s / s2w）だけ。
// 実ピクセルは setViewport の中にしか出てこない。

export const GRID = 32;   // 1マスの大きさ（ワールド座標）

// COLS / ROWS は増やすぶんには影響がないが、減らすと保存済みの家具のうち
// 範囲外になったものが画面から消える（KV のデータ自体は残る）。
export const COLS = 50;   // 横のマス数
export const ROWS = 30;   // 縦のマス数

// マップ全体の大きさ（1600×960）。この枠が収まるように倍率を決める。
export const WORLD = { w: COLS * GRID, h: ROWS * GRID };

// 表示用の倍率と余白。setViewport が書き換え、w2s / s2w が読む。
// export しないのは、2ページとも「変換は必ずこの関数を通す」を崩さないため。
// 描く前に必ず setViewport を呼ぶこと。呼ばないと倍率1・余白0のまま描かれる。
let scale = 1, offX = 0, offY = 0;

// キャンバスの表示上の大きさ（setViewport が覚える）と、マップが収まりきっていないか。
let viewW = 0, viewH = 0;
let overflowX = false, overflowY = false;

// キャンバスの表示上の大きさに合わせて倍率と余白を決める。
// 画面サイズが変わるたびに呼び直す。
// 渡すのは見た目の大きさで、canvas.width（実ピクセル）ではない。高解像度画面では値が違う。
//
// minScale を渡すと、倍率をそれより小さくしない。そのぶんマップは画面に収まらなくなるので、
// 収まらない方向は lookAt で見る場所を動かす（オフィス画面）。渡さなければ、これまでどおり
// マップ全体が収まる倍率になる（管理者ページ）。
export function setViewport(w, h, minScale = 0) {
	const dpr = window.devicePixelRatio || 1;
	// マップ全体が収まる倍率。横と縦で余る方に余白がつく。
	const raw = Math.max(Math.min(w / WORLD.w, h / WORLD.h), minScale);
	// そのまま使うと1マスが実ピクセルの半端な大きさになり、タイルの継ぎ目に
	// 1点の隙間や重なりが出る。1マスが整数の実ピクセルになる倍率に丸めて防ぐ。
	const cellDev = Math.max(1, Math.round(GRID * raw * dpr));   // 最低1点（w/h が 0 のとき倍率0になるのを防ぐ）
	scale = cellDev / (GRID * dpr);
	viewW = w; viewH = h;
	overflowX = WORLD.w * scale > w + 0.5;
	overflowY = WORLD.h * scale > h + 0.5;
	// 余白も同じ理由で実ピクセルの整数に丸める（丸めた値を画面座標に戻している）。
	// 収まらない方向は、とりあえず左上に合わせておく（すぐ lookAt が置き直す）。
	offX = overflowX ? 0 : Math.round(((w - WORLD.w * scale) / 2) * dpr) / dpr;
	offY = overflowY ? 0 : Math.round(((h - WORLD.h * scale) / 2) * dpr) / dpr;
}

// マップが画面に収まっていないとき、ワールド座標 (x, y) が画面の中央に来るように
// 見る場所を動かす。マップの端より外は見せない（端に近づくと、中央ではなく端に寄る）。
// 収まっている方向は何もしない（setViewport が中央に置いたまま）。
export function lookAt(x, y) {
	const dpr = window.devicePixelRatio || 1;
	const snap = (v) => Math.round(v * dpr) / dpr;   // 実ピクセルの整数に揃える（タイルの継ぎ目を出さない）
	if (overflowX) offX = snap(Math.min(0, Math.max(viewW - WORLD.w * scale, viewW / 2 - x * scale)));
	if (overflowY) offY = snap(Math.min(0, Math.max(viewH - WORLD.h * scale, viewH / 2 - y * scale)));
}

// マップが画面に収まりきらず、見る場所を動かしている状態か
export function isScrolling() {
	return overflowX || overflowY;
}

// いまの表示倍率。画面座標で大きさを決めるもの（名前ラベルなど）を、マップに合わせて
// 縮めるために使う。座標の変換には使わないこと（変換は w2s / s2w を通す）。
export function getScale() {
	return scale;
}

// ワールド座標 → 画面座標
export function w2s(x, y) {
	return { x: offX + x * scale, y: offY + y * scale };
}

// 画面座標 → ワールド座標。マウス・タッチの clientX / clientY を渡す。
// clientX はページ全体から見た位置なので、キャンバス自身の位置を引いてから戻す。
export function s2w(canvas, clientX, clientY) {
	const rect = canvas.getBoundingClientRect();
	return { x: (clientX - rect.left - offX) / scale, y: (clientY - rect.top - offY) / scale };
}

// 毎フレームの最初に呼ぶ下地。前のフレームを消す役目も兼ねる。
// マップの外側の余白と、マップの床面を別の色で塗り分ける。
export function drawBase(ctx, canvas) {
	// canvas.width は実ピクセル。ここは画面座標で描いているので高解像度画面では
	// 必要より大きい矩形になるが、はみ出た分はキャンバス外なので捨てられる。
	ctx.fillStyle = "#dfe3dd";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	const o = w2s(0, 0);
	ctx.fillStyle = "#eff1ec";
	ctx.fillRect(o.x, o.y, WORLD.w * scale, WORLD.h * scale);
}

// コメント（看板）を描く：角丸・枠線なし・やわらかい影。admin / office 共通。
// 文字は枠の中央（左右・上下とも中央）に置き、枠の幅で折り返す。
// c = { x, y, w, h, text, bg, color, size, bold, italic, runs }
// runs（部分ごとの装飾。形は richtext.js を参照）があればそちらで描き、
// 無ければ text と全体の指定で描く（部分装飾が入る前に作られた看板）。
export function drawCommentBox(ctx, c) {
	const a = w2s(c.x, c.y), b = w2s(c.x + c.w, c.y + c.h);
	const w = b.x - a.x, h = b.y - a.y;
	const r = Math.min(12 * scale, w / 2, h / 2);

	// ctx は呼び出し元と共用なので、ここで変える設定（影・フォント・文字の揃え）を
	// 関数の外へ持ち出さない。全体を save / restore で挟んで最後に元へ戻す。
	ctx.save();

	ctx.shadowColor = "rgba(0,0,0,0.18)";
	ctx.shadowBlur = 6;
	ctx.shadowOffsetY = 2;
	ctx.beginPath();
	ctx.roundRect(a.x, a.y, w, h, r);
	ctx.fillStyle = c.bg || "#ffffff";
	ctx.fill();

	// 文字に枠と同じ影が付かないよう、描く前に影を消す
	ctx.shadowColor = "transparent";
	ctx.shadowBlur = 0;
	ctx.shadowOffsetY = 0;

	if (Array.isArray(c.runs) && c.runs.length) {
		drawRuns(ctx, c, a, w, h);
		ctx.restore();
		return;
	}

	// 文字の大きさ・行間・余白にも scale を掛ける。掛けないと拡大時に文字だけ小さく残る。
	const size = (c.size || 16) * scale;
	const weight = c.bold ? "700" : "400";
	const style = c.italic ? "italic " : "";
	ctx.font = `${style}${weight} ${size}px 'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif`;
	ctx.fillStyle = c.color || "#141815";
	const align = c.align === "left" || c.align === "right" ? c.align : "center";
	ctx.textAlign = align;
	ctx.textBaseline = "middle";
	const lines = wrapLines(ctx, c.text || "", w - 16 * scale);
	const lineH = size + 4 * scale;
	const cx = align === "left" ? a.x + 8 * scale : align === "right" ? a.x + w - 8 * scale : a.x + w / 2;
	// 行の集まり全体が枠の上下中央に来るよう、1行目の中心から描き始める
	let yy = a.y + h / 2 - (lines.length * lineH) / 2 + lineH / 2;
	for (const ln of lines) { ctx.fillText(ln, cx, yy); yy += lineH; }

	ctx.restore();
}

// ── 部分ごとに装飾した文字の描画 ──

const FONT_FAMILY = "'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif";

// 折り返しの計算結果。看板ごとに覚えておき、中身・幅・倍率が変わったときだけ計算し直す。
// 1文字ずつ幅を測るので、毎フレームやり直すと看板の数×文字数ぶんの計測が走る。
const layoutCache = new WeakMap();
// Web フォントが届くと文字幅が変わるので、そのときは全部計算し直す
let fontVersion = 0;
if (typeof document !== "undefined" && document.fonts) {
	document.fonts.addEventListener?.("loadingdone", () => { fontVersion++; });
}

function fontOf(c, run) {
	const size = (run.s || c.size || 16) * scale;
	return { size, font: `${run.i ? "italic " : ""}${run.b ? "700" : "400"} ${size}px ${FONT_FAMILY}` };
}

// runs を行に分ける。1行は「同じ装飾が続く部分（seg）」の並び。
// 折り返しは1文字単位（日本語は単語の区切りが無いため。wrapLines と同じ考え方）。
function layoutRuns(ctx, c, maxW) {
	const hit = layoutCache.get(c);
	if (hit && hit.runs === c.runs && hit.maxW === maxW && hit.scale === scale && hit.ver === fontVersion) return hit.lines;

	const baseSize = (c.size || 16) * scale;
	const newLine = () => ({ segs: [], w: 0, size: 0 });
	const lines = [newLine()];
	for (const run of c.runs) {
		const f = fontOf(c, run);
		ctx.font = f.font;
		for (const ch of String(run.t || "")) {
			if (ch === "\n") { lines.push(newLine()); continue; }
			let line = lines[lines.length - 1];
			const cw = ctx.measureText(ch).width;
			if (line.segs.length && line.w + cw > maxW) { line = newLine(); lines.push(line); }
			const last = line.segs[line.segs.length - 1];
			if (last && last.run === run) { last.text += ch; last.w += cw; }
			else line.segs.push({ run, text: ch, w: cw, size: f.size, font: f.font });
			line.w += cw;
			line.size = Math.max(line.size, f.size);
		}
	}
	for (const line of lines) {
		if (!line.size) line.size = baseSize;   // 空行は基準の大きさぶんの高さを取る
		line.h = line.size * 1.3;
	}
	layoutCache.set(c, { runs: c.runs, maxW, scale, ver: fontVersion, lines });
	return lines;
}

// 行ごとに揃えて描く（c.align。無ければ中央）。左右の余白は 8px ずつで、折り返しの幅（w - 16）と合わせてある。
// 大きさの違う文字は、行の中で下端（ベースライン）を揃える。
function drawRuns(ctx, c, a, w, h) {
	const lines = layoutRuns(ctx, c, w - 16 * scale);
	const total = lines.reduce((sum, l) => sum + l.h, 0);
	const pad = 8 * scale;
	const startX = (line) => c.align === "left" ? a.x + pad : c.align === "right" ? a.x + w - pad - line.w : a.x + w / 2 - line.w / 2;
	let y = a.y + h / 2 - total / 2;
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	for (const line of lines) {
		const baseline = y + line.h * 0.5 + line.size * 0.35;
		let x = startX(line);
		for (const seg of line.segs) {
			const r = seg.run;
			if (r.m) {   // マーカーは行の高さいっぱいではなく、その文字の高さぶんだけ塗る
				ctx.fillStyle = r.m;
				ctx.fillRect(x, baseline - seg.size * 0.9, seg.w, seg.size * 1.15);
			}
			ctx.font = seg.font;
			ctx.fillStyle = r.c || c.color || "#141815";
			ctx.fillText(seg.text, x, baseline);
			if (r.u) ctx.fillRect(x, baseline + seg.size * 0.1, seg.w, Math.max(1, seg.size * 0.07));
			x += seg.w;
		}
		y += line.h;
	}
}

// 文字を枠の幅で折り返して行の配列にする。
// 日本語は単語の区切りが無いので、空白ではなく1文字ずつ測って折り返す。
// for...of は絵文字のようなサロゲートペアを1文字として扱うので、文字が割れない。
// 幅は ctx.measureText で測るため、呼ぶ前に ctx.font を設定しておくこと。
function wrapLines(ctx, text, maxW) {
	const out = [];
	for (const para of String(text).split("\n")) {   // 改行は折り返しとは別に扱う
		let line = "";
		for (const ch of para) {
			if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
			else line += ch;
		}
		out.push(line);
	}
	return out;
}

// マス目の線。位置合わせの目安なので管理者ページでだけ描く。
// 線は COLS+1 本・ROWS+1 本（右端と下端の枠線も引くため）。
export function drawGrid(ctx) {
	ctx.strokeStyle = "#b4bbb0";
	ctx.lineWidth = 1;
	for (let c = 0; c <= COLS; c++) {
		const a = w2s(c * GRID, 0), b = w2s(c * GRID, WORLD.h);
		ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
	}
	for (let r = 0; r <= ROWS; r++) {
		const a = w2s(0, r * GRID), b = w2s(WORLD.w, r * GRID);
		ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
	}
}
