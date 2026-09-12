// 共通エンジン：ワールド定数・座標変換・下地とグリッドの描画。
// admin / office の両方から使う。

export const GRID = 32;               // 1マスのピクセル数
export const COLS = 50;               // 横のマス数
export const ROWS = 30;               // 縦のマス数
export const WORLD = { w: COLS * GRID, h: ROWS * GRID };

// 表示用の倍率と余白（このモジュール内で保持）
let scale = 1, offX = 0, offY = 0;

// キャンバスサイズに合わせて倍率と余白を計算する
export function setViewport(w, h) {
	const dpr = window.devicePixelRatio || 1;
	const raw = Math.min(w / WORLD.w, h / WORLD.h);
	// 1マス(GRID)がちょうど整数の実ピクセルになるよう倍率を丸める。
	// これで全タイルが同じ大きさ・境界が整数に揃い、継ぎ目や重なりが出ない。
	const cellDev = Math.max(1, Math.round(GRID * raw * dpr));
	scale = cellDev / (GRID * dpr);
	// 余白も実ピクセル格子に合わせる
	offX = Math.round(((w - WORLD.w * scale) / 2) * dpr) / dpr;
	offY = Math.round(((h - WORLD.h * scale) / 2) * dpr) / dpr;
}

// 論理座標 → 画面座標
export function w2s(x, y) {
	return { x: offX + x * scale, y: offY + y * scale };
}

// 画面座標 → 論理座標
export function s2w(canvas, clientX, clientY) {
	const rect = canvas.getBoundingClientRect();
	return { x: (clientX - rect.left - offX) / scale, y: (clientY - rect.top - offY) / scale };
}

// 余白（背景）とマップの床下地を描く
export function drawBase(ctx, canvas) {
	ctx.fillStyle = "#dfe3dd";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	const o = w2s(0, 0);
	ctx.fillStyle = "#eff1ec";
	ctx.fillRect(o.x, o.y, WORLD.w * scale, WORLD.h * scale);
}

// コメント（看板）を描く：角丸・枠線なし・やわらかい影。admin / office 共通。
// c = { x, y, w, h, text, bg, color, size, bold, italic }
export function drawCommentBox(ctx, c) {
	const a = w2s(c.x, c.y), b = w2s(c.x + c.w, c.y + c.h);
	const w = b.x - a.x, h = b.y - a.y;
	const r = Math.min(12 * scale, w / 2, h / 2);

	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.18)";
	ctx.shadowBlur = 6;
	ctx.shadowOffsetY = 2;
	ctx.beginPath();
	ctx.roundRect(a.x, a.y, w, h, r);
	ctx.fillStyle = c.bg || "#ffffff";
	ctx.fill();
	ctx.restore();

	// 文字は枠の中央（左右・上下とも中央）に描く
	const size = (c.size || 16) * scale;
	const weight = c.bold ? "700" : "400";
	const style = c.italic ? "italic " : "";
	ctx.font = `${style}${weight} ${size}px 'M PLUS Rounded 1c', system-ui, 'Noto Sans JP', sans-serif`;
	ctx.fillStyle = c.color || "#141815";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const lines = wrapLines(ctx, c.text || "", w - 16 * scale);
	const lineH = size + 4 * scale;
	const cx = a.x + w / 2;
	let yy = a.y + h / 2 - (lines.length * lineH) / 2 + lineH / 2;
	for (const ln of lines) { ctx.fillText(ln, cx, yy); yy += lineH; }
}

// 文字を折り返して行の配列にする（日本語は1文字ずつ折り返す）
function wrapLines(ctx, text, maxW) {
	const out = [];
	for (const para of String(text).split("\n")) {
		let line = "";
		for (const ch of para) {
			if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
			else line += ch;
		}
		out.push(line);
	}
	return out;
}

// マス目を描く（管理者ページで使用）
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
