// 会話の範囲（誰と誰の声とチャットがつながるか）。サーバー（src/room.js・src/helpers.js）と
// オフィス画面（office/voice.js・office/panel.js）の両方がこのファイルを使う。
// 1か所にまとめているのは、判定がずれると「Aには聞こえるのにBには聞こえない」が起きるため。
//
// ── 決まり ──
//   会話エリアの中 … 同じエリアにいる人全員
//   会話エリアの外 … 次のどちらかでつながる人。つながりはたどれる（AとB、BとCがつながれば、AとCも同じ会話）
//     ・半径 NEAR 以内
//     ・名前のラベルが重なる位置にいる（画面で名前が1つのまとまりとして並ぶ人。scene.js の groupActors）
//
// 名前のまとまりは画面の倍率や書体で決まるので、そのままでは人によって結果が変わる。
// ここでは倍率 1 のときの名前の幅を文字数から見積もり、全員が同じ結果になるようにしている。
// 画面のまとまりとは、名前の幅の見積もりの分だけずれることがある。

export const NEAR = 64;   // エリアの外で会話できる半径（ワールド座標。2マス）

// 名前ラベルの幅の見積もり（倍率 1、ワールド座標）。scene.js の pillWidth と同じ組み立て:
// 文字（12px）＋左右の余白 9×2 ＋マイクの印 12＋すき間 3
export function labelWidth(name) {
	let w = 0;
	for (const ch of String(name || "")) w += ch.codePointAt(0) > 0xff ? 12 : 7;
	return w + 18 + 15;
}

// 名前のラベルが重なる位置か（scene.js の groupActors と同じ判定を、倍率 1 で行う）
function labelsOverlap(a, b) {
	return Math.abs(a.x - b.x) < (labelWidth(a.name) + labelWidth(b.name)) / 2 + 4 && Math.abs(a.y - b.y) < 24;
}

// 全員を会話ごとに分ける。people は [{ id, x, y, name }]、zoneOf(x, y) は会話エリアの id か null。
// 戻り値は id → 会話の目印 の Map。目印が同じ人どうしが同じ会話。
export function talkGroupKeys(people, zoneOf) {
	const keys = new Map();
	const outside = [];
	for (const p of people) {
		const z = zoneOf(p.x, p.y);
		if (z) keys.set(p.id, "z:" + z);
		else outside.push(p);
	}
	// エリアの外の人を、つながりでまとめる（人数が少ないので総当たり）
	const root = outside.map((_, i) => i);
	const find = (i) => { while (root[i] !== i) i = root[i] = root[root[i]]; return i; };
	for (let i = 0; i < outside.length; i++) {
		for (let j = i + 1; j < outside.length; j++) {
			const a = outside[i], b = outside[j];
			if (Math.hypot(a.x - b.x, a.y - b.y) <= NEAR || labelsOverlap(a, b)) root[find(i)] = find(j);
		}
	}
	outside.forEach((p, i) => keys.set(p.id, "g:" + outside[find(i)].id));
	return keys;
}
