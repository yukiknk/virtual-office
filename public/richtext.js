// 看板の文字を部分ごとに装飾する編集欄。オフィス画面（office/panel.js）と
// 管理者ページ（admin/editor.js）の両方が使う。描くほうは map.js の drawCommentBox。
//
// ── データの形 ──
// 看板は runs（装飾が同じ文字のかたまりの並び）を持つ。
//   runs: [{ t: "文字", b: 1, i: 1, u: 1, c: "#rrggbb", s: 16, m: "#rrggbb" }, ...]
//     t … 文字（改行は "\n"）   b … 太字   i … 斜体   u … 下線
//     c … 文字色               s … 大きさ（px。SIZES のどれか）
//     m … マーカー（文字の背景色）
// 文字の揃え（align: "left" | "center" | "right"）は看板全体に1つ。無ければ中央。
// 無い項目は「指定なし」。runs を持たない古い看板は、これまでどおり
// text と size / color / bold / italic（看板全体の指定）で描かれる。
//
// ── 編集欄のしくみ ──
// contenteditable の中で、選んだ範囲に document.execCommand で装飾を付ける。
// execCommand は非推奨とされているが、範囲選択への装飾を全ブラウザで同じように
// 扱える手段がほかに無く、どのブラウザでも動く。保存するときは、できあがった DOM を
// たどって「見えているとおり」の runs に読み直す（serialize）。ブラウザごとに
// 作る DOM の形（<b> か <span style> か等）が違っても、結果が同じになるようにするため。

export const SIZES = [
	{ px: 12, label: "小" },
	{ px: 16, label: "中" },
	{ px: 22, label: "大" },
	{ px: 30, label: "特大" },
];
export const DEFAULT_SIZE = 16;
export const DEFAULT_COLOR = "#141815";
const DEFAULT_MARKER = "#ffe66d";
export const ALIGNS = ["left", "center", "right"];
export const DEFAULT_ALIGN = "center";

// 看板1枚ぶんの runs を返す。runs を持たない古い看板は、全体の指定を1つの run にして返す。
export function runsOf(c) {
	if (Array.isArray(c.runs) && c.runs.length) return c.runs;
	if (!c.text) return [];
	const r = { t: String(c.text) };
	if (c.bold) r.b = 1;
	if (c.italic) r.i = 1;
	if (c.color) r.c = c.color;
	if (c.size) r.s = c.size;
	return [r];
}

// runs を装飾なしの文字列にする（文字数の確認と、古い画面向けの text に使う）
export function plainOf(runs) {
	return runs.map((r) => r.t).join("");
}

// host の中に編集欄を作る。戻り値で中身の出し入れをする。
//   set(c)   … 看板 c の内容を編集欄へ入れる
//   get()    … いまの内容を { runs, text, align } で返す
//   setBg(v) … 編集欄の背景色（看板の背景色を写して、仕上がりを見せる）
//   focus()  … 編集欄にカーソルを置く
export function createRichEditor(host) {
	host.classList.add("rt");
	host.innerHTML = `
		<div class="rt-bar">
			<button type="button" class="rt-btn" data-cmd="bold" title="太字"><b>B</b></button>
			<button type="button" class="rt-btn" data-cmd="italic" title="斜体"><i>I</i></button>
			<button type="button" class="rt-btn" data-cmd="underline" title="下線"><u>U</u></button>
			<select class="rt-size" title="文字の大きさ">
				${SIZES.map((s) => `<option value="${s.px}"${s.px === DEFAULT_SIZE ? " selected" : ""}>${s.label}</option>`).join("")}
			</select>
			<label class="rt-color" title="文字の色"><span>色</span><input type="color" class="rt-fg" value="${DEFAULT_COLOR}" /></label>
			<label class="rt-color" title="マーカー（文字の背景色）"><span>マーカー</span><input type="color" class="rt-mk" value="${DEFAULT_MARKER}" /></label>
			<button type="button" class="rt-btn rt-wide" data-act="unmark" title="マーカーを消す">消す</button>
			<span class="rt-sep"></span>
			<button type="button" class="rt-btn" data-align="left" title="左揃え"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg></button>
			<button type="button" class="rt-btn" data-align="center" title="中央揃え"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 3.5h12M4 6.5h8M2 9.5h12M4 12.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg></button>
			<button type="button" class="rt-btn" data-align="right" title="右揃え"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 3.5h12M6 6.5h8M2 9.5h12M6 12.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg></button>
		</div>
		<div class="rt-edit" contenteditable="true" spellcheck="false" data-placeholder="文字を入力する"></div>
		<div class="rt-hint">文字を選んでからボタンを押すと、その部分だけ変わります</div>`;
	const ed = host.querySelector(".rt-edit");
	const sizeSel = host.querySelector(".rt-size");
	const fg = host.querySelector(".rt-fg");
	const mk = host.querySelector(".rt-mk");

	// ── 文字の揃え（看板全体に1つ） ──
	let align = DEFAULT_ALIGN;
	const setAlign = (v) => {
		align = ALIGNS.includes(v) ? v : DEFAULT_ALIGN;
		ed.style.textAlign = align;
		for (const b of host.querySelectorAll(".rt-btn[data-align]")) b.classList.toggle("on", b.dataset.align === align);
	};

	// ── 選択範囲の保存と復元 ──
	// 大きさのプルダウンや色の選択を触ると、フォーカスが編集欄から外れて選択が消える。
	// 編集欄の中に選択があるあいだ控えておき、装飾を付ける直前に戻す。
	let saved = null;
	document.addEventListener("selectionchange", () => {
		const sel = document.getSelection();
		if (!sel || !sel.rangeCount) return;
		const r = sel.getRangeAt(0);
		if (ed.contains(r.commonAncestorContainer)) { saved = r.cloneRange(); syncBar(); }
	});
	const restore = () => {
		const sel = document.getSelection();
		// いまの選択が編集欄の中にあるなら、それをそのまま使う。控え（saved）は少し遅れて
		// 更新されるうえ、装飾を付けて DOM が変わると古い控えは位置がずれる。
		if (sel && sel.rangeCount && ed.contains(sel.getRangeAt(0).commonAncestorContainer)) { ed.focus(); return; }
		ed.focus();
		if (!saved || !sel) return;
		sel.removeAllRanges();
		sel.addRange(saved);
	};
	const exec = (cmd, value) => {
		restore();
		document.execCommand("styleWithCSS", false, true);
		return document.execCommand(cmd, false, value);   // そのコマンドに対応していなければ false
	};

	// ボタンは mousedown でフォーカスを奪わないようにする（選択を保ったまま押せる）
	for (const b of host.querySelectorAll(".rt-btn")) {
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", () => {
			if (b.dataset.cmd) exec(b.dataset.cmd);
			else if (b.dataset.align) { setAlign(b.dataset.align); return; }
			else if (b.dataset.act === "unmark") setMarker("transparent");
			syncBar();
		});
	}

	// ── 大きさ ──
	// execCommand の fontSize は 1〜7 の段階しか受け付けない。いったん 7 を付け、
	// できた要素を探して px に書き換える。範囲を選ばずに指定した場合は、このあと打つ
	// 文字に 7 が付くので、入力のたびに同じ書き換えをする（pendingSize）。
	let pendingSize = DEFAULT_SIZE;
	const fixSizes = () => {
		for (const el of ed.querySelectorAll("font[size]")) {
			const span = document.createElement("span");
			span.style.fontSize = pendingSize + "px";
			while (el.firstChild) span.appendChild(el.firstChild);
			el.replaceWith(span);
		}
		for (const el of ed.querySelectorAll("[style*='xxx-large']")) el.style.fontSize = pendingSize + "px";
	};
	sizeSel.addEventListener("change", () => {
		pendingSize = +sizeSel.value || DEFAULT_SIZE;
		exec("fontSize", "7");
		fixSizes();
	});

	// ── 色とマーカー ──
	fg.addEventListener("input", () => exec("foreColor", fg.value));
	// マーカーは Chrome 系が hiliteColor、Safari が backColor。効いたほうだけが使われる。
	const setMarker = (v) => { exec("hiliteColor", v) || exec("backColor", v); };
	mk.addEventListener("input", () => setMarker(mk.value));
	// 色を変えずに「いまの色でもう一度塗る」ための操作。input は値が変わらないと発火しない。
	mk.addEventListener("click", () => { if (saved && !saved.collapsed) setMarker(mk.value); });

	// ── 入力まわり ──
	ed.addEventListener("input", fixSizes);
	// Enter は <br> を入れる。ブラウザ任せだと <div> で段落を作り、読み直しが複雑になる。
	// 日本語入力の変換確定の Enter には手を出さない（chat と同じ判定）。
	ed.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		document.execCommand("insertLineBreak");
	});
	// 貼り付けは文字だけ。ほかのページの装飾や画像を持ち込ませない。
	ed.addEventListener("paste", (e) => {
		e.preventDefault();
		const text = (e.clipboardData || window.clipboardData).getData("text/plain");
		document.execCommand("insertText", false, text);
	});
	ed.addEventListener("drop", (e) => e.preventDefault());

	// ボタンの見た目を、カーソル位置の装飾に合わせる（太字の中にいれば B が押された見た目に）
	function syncBar() {
		for (const b of host.querySelectorAll(".rt-btn[data-cmd]")) {
			let on = false;
			try { on = document.queryCommandState(b.dataset.cmd); } catch { }
			b.classList.toggle("on", on);
		}
		const node = saved && (saved.startContainer.nodeType === 1 ? saved.startContainer : saved.startContainer.parentElement);
		if (node && ed.contains(node)) {
			const px = Math.round(parseFloat(getComputedStyle(node).fontSize));
			if (SIZES.some((s) => s.px === px)) sizeSel.value = String(px);
		}
	}

	return {
		set(c) {
			ed.replaceChildren(...runsToNodes(runsOf(c)));
			saved = null;
			pendingSize = DEFAULT_SIZE;
			sizeSel.value = String(DEFAULT_SIZE);
			setAlign(c.align);
			syncBar();
		},
		get() {
			const runs = serialize(ed);
			return { runs, text: plainOf(runs), align };
		},
		setBg(v) { ed.style.background = v || "#ffffff"; },
		focus() { ed.focus(); },
	};
}

// runs → 編集欄に入れる DOM
function runsToNodes(runs) {
	const out = [];
	for (const r of runs) {
		const span = document.createElement("span");
		if (r.b) span.style.fontWeight = "700";
		if (r.i) span.style.fontStyle = "italic";
		if (r.u) span.style.textDecoration = "underline";
		if (r.c) span.style.color = r.c;
		if (r.s) span.style.fontSize = r.s + "px";
		if (r.m) span.style.backgroundColor = r.m;
		String(r.t).split("\n").forEach((part, i) => {
			if (i) span.appendChild(document.createElement("br"));
			if (part) span.appendChild(document.createTextNode(part));
		});
		out.push(span);
	}
	return out;
}

// 編集欄の DOM → runs。タグの種類ではなく、実際に適用されている見た目（computed style）を読む。
function serialize(ed) {
	const runs = [];
	const same = (a, b) => a.b === b.b && a.i === b.i && a.u === b.u && a.c === b.c && a.s === b.s && a.m === b.m;
	const push = (t, st) => {
		if (!t) return;
		const last = runs[runs.length - 1];
		if (last && same(last, st)) { last.t += t; return; }
		runs.push({ ...st, t });
	};
	const base = styleOf(ed, { u: 0, m: "" }, true);
	let started = false;   // 何か出力したか（最初のブロックの前には改行を入れない）
	const walk = (node, st) => {
		if (node.nodeType === 3) {
			// ゼロ幅スペースはブラウザがカーソル用に入れることがある。nbsp は普通の空白に戻す。
			const t = node.nodeValue.replace(/​/g, "").replace(/ /g, " ");
			if (t) { push(t, st); started = true; }
			return;
		}
		if (node.nodeType !== 1) return;
		if (node.tagName === "BR") { push("\n", st); started = true; return; }
		// Enter は <br> にしているが、貼り付けやブラウザの都合で <div> / <p> ができることがある
		if (/^(DIV|P)$/.test(node.tagName) && started && !runs[runs.length - 1].t.endsWith("\n")) push("\n", st);
		const next = styleOf(node, st, false);
		for (const child of node.childNodes) walk(child, next);
	};
	for (const child of ed.childNodes) walk(child, base);

	// 末尾の改行は落とす（ブラウザが行末に置く見えない <br> もここで消える）
	while (runs.length) {
		const last = runs[runs.length - 1];
		last.t = last.t.replace(/\n+$/, "");
		if (last.t) break;
		runs.pop();
	}
	// 「指定なし」と同じ値は書かない（保存するデータを小さくする）
	return runs.map((r) => {
		const o = { t: r.t };
		if (r.b) o.b = 1;
		if (r.i) o.i = 1;
		if (r.u) o.u = 1;
		if (r.c && r.c !== DEFAULT_COLOR) o.c = r.c;
		if (r.s && r.s !== DEFAULT_SIZE) o.s = r.s;
		if (r.m) o.m = r.m;
		return o;
	});
}

// 要素に適用されている装飾。下線とマーカーは子へ「継承」されない性質なので、親の値を引き継ぐ。
function styleOf(el, parent, isRoot) {
	const cs = getComputedStyle(el);
	const px = Math.round(parseFloat(cs.fontSize));
	// 用意した大きさ以外（貼り付けなどで紛れ込んだ値）は、いちばん近いものに寄せる
	const s = SIZES.reduce((best, x) => (Math.abs(x.px - px) < Math.abs(best - px) ? x.px : best), DEFAULT_SIZE);
	const bg = isRoot ? "" : toHex(cs.backgroundColor);   // 編集欄そのものの背景は看板の背景なので数えない
	return {
		b: (parseInt(cs.fontWeight, 10) || 400) >= 600 ? 1 : 0,
		i: cs.fontStyle === "italic" ? 1 : 0,
		u: parent.u || /underline/.test(cs.textDecorationLine || cs.textDecoration || "") ? 1 : 0,
		c: toHex(cs.color) || DEFAULT_COLOR,
		s,
		m: bg || parent.m,
	};
}

// "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" → "#010203"。透明なら ""。
function toHex(v) {
	const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(v || "");
	if (!m) return "";
	if (m[4] !== undefined && parseFloat(m[4]) === 0) return "";
	return "#" + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, "0")).join("");
}
