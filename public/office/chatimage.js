// チャットに貼る画像を、送れる大きさに縮める。
//
// 画像はサーバーを中継して相手へそのまま届く（保存はしない）。WebSocket の1通には上限（1MiB）が
// あり、サーバー側も 900,000 文字までしか受けない（src/room.js の CHAT_IMG_MAX）。
// スクリーンショットはそのままだと数 MB になるので、長い辺を MAX_SIDE までに縮め、JPEG にする。
// それでも大きければ、画質と大きさを下げて収まるまでやり直す。
const MAX_SIDE = 1600;
const LIMIT = 880_000;   // data URL の文字数。サーバーの上限より少し小さくしておく

// File（貼り付け・選択した画像）→ data URL。送れる大きさにできなければ null
export async function shrinkImage(file) {
	if (!file || !/^image\//.test(file.type)) return null;
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise((resolve, reject) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = reject;
			i.src = url;
		});
		let side = MAX_SIDE, quality = 0.85;
		for (let tries = 0; tries < 6; tries++) {
			const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
			const w = Math.max(1, Math.round(img.naturalWidth * scale));
			const h = Math.max(1, Math.round(img.naturalHeight * scale));
			const c = document.createElement("canvas");
			c.width = w;
			c.height = h;
			const g = c.getContext("2d");
			g.fillStyle = "#ffffff";   // 透明な部分は白にする（JPEG は透明を持てないので黒くなる）
			g.fillRect(0, 0, w, h);
			g.drawImage(img, 0, 0, w, h);
			const data = c.toDataURL("image/jpeg", quality);
			if (data.length <= LIMIT) return data;
			side = Math.round(side * 0.8);
			quality = Math.max(0.5, quality - 0.1);
		}
		return null;
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

// data URL → 表示用の短い URL（blob:）。チャット欄は届くたびに描き直すので、
// 長い data URL をそのまま埋め込むと、そのたびに画像を読み直して重くなる
export function toBlobUrl(dataUrl) {
	try {
		const [head, b64] = dataUrl.split(",");
		const type = /^data:([^;]+);/.exec(head)[1];
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return URL.createObjectURL(new Blob([bytes], { type }));
	} catch {
		return null;
	}
}
