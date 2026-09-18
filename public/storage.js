// 入室画面とオフィス画面のあいだで受け渡す値を localStorage に読み書きする。
//
// キー名はここだけに置く。他の場所で直接 localStorage を触ると、
// 片方だけ名前が変わったときにエラーも出ず既定値へ落ちる。
//
// localStorage はプライベートモードや設定で例外を投げることがある。
// 読み書きできなくても動作は続けられるので、失敗は既定値を返して飲む。

export const KEY = {
	name: "office.name",            // 氏名
	micId: "office.micId",          // マイクの deviceId
	speakerId: "office.speakerId",  // スピーカーの deviceId
	avatar: "office.avatar",        // アバターの選択（JSON）
	pos: "office.pos",              // 退出時の位置（JSON {x,y}）
};

// 空文字は「未設定」とみなして fallback を返す
export function read(key, fallback = "") {
	try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

// 壊れた JSON が入っていても fallback を返す。
// 1項目ずつ包むので、ある値が壊れても他の値の読み出しは続く。
export function readJson(key, fallback = null) {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : fallback;
	} catch { return fallback; }
}

export function write(key, value) {
	try { localStorage.setItem(key, value); } catch { }
}

export function writeJson(key, value) {
	write(key, JSON.stringify(value));
}
