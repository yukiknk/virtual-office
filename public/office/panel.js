// 画面の DOM を書き換える側。左メニューバーと、ステージに重ねる表示を扱う。
//
// キャンバス（ctx）には一切触れない。描画は scene.js、移動は move.js。
//
// 関数は init〜 と update〜 の2種類しかない。
//   init〜   … 起動時に1回だけ。イベントを登録する
//   update〜 … main.js のループから繰り返し呼ばれる。今の store を画面へ写す
// update〜 は何度呼ばれても構わないように書く。毎フレーム呼ばれるものは
// 「前回と同じなら即 return」のガードを自分で持ち、持たないものは main.js 側で間引く。
//
// 参照する要素の id は office.html にある。id を変えると片方だけ壊れる。
import { GRID, WORLD } from "../map.js";
import { store, zoneIdAt } from "./store.js";
import { sendComment, sendChat, sendAway, sendCall } from "./net.js";
import { stopMoving } from "./move.js";
import { updateVoice } from "./voice.js";
import { createRichEditor } from "../richtext.js";
import { KEY, read, write } from "../storage.js";

// エリア外にいる人どうしが会話できる範囲。voice.js が音声をつなぐ距離と、
// サーバーがチャットを配る距離と、同じ値を別々に持っている。変えるときは3か所。
const NEAR = GRID * 2;

// ── コメント作成モーダル（オフィス側） ──
let editingComment = null;   // 再編集中の看板（null＝新規作成）
let commentEditor = null;    // 文字の編集欄（richtext.js）。initCommentUI が作る
const COMMENT_MAX = 300;     // 看板の文字数の上限。サーバー（src/helpers.js の cleanRuns）と揃えてある

export function initCommentUI() {
	const addBtn = document.getElementById("comment-add-btn");
	const cancel = document.getElementById("c-cancel");
	const save = document.getElementById("c-save");
	const modal = document.getElementById("comment-modal");
	if (addBtn) addBtn.addEventListener("click", () => openCommentModal());
	if (cancel) cancel.addEventListener("click", closeCommentModal);
	if (save) save.addEventListener("click", saveCommentModal);
	if (modal) modal.addEventListener("click", (e) => { if (e.target.id === "comment-modal") closeCommentModal(); });
	const host = document.getElementById("c-editor");
	if (host) commentEditor = createRichEditor(host);
	// 背景色を変えたら編集欄にも写す（仕上がりの色の組み合わせを見ながら決められる）
	const bg = document.getElementById("c-bg");
	if (bg) bg.addEventListener("input", () => commentEditor && commentEditor.setBg(bg.value));
	fillExpirySelects();
}

// 期限日時のプルダウン（年/月/日/時/分）の選択肢を作る。
// HTML 側の select は空で、中身はここが作る。
// 「初回のみ」の判定は y.options.length（既に入っていれば何もしない）。
function fillExpirySelects() {
	const y = document.getElementById("c-year");
	if (!y || y.options.length) return;
	const mo = document.getElementById("c-month");
	const d = document.getElementById("c-day");
	const h = document.getElementById("c-hour");
	const mi = document.getElementById("c-min");
	const opt = (sel, val, label) => { const o = document.createElement("option"); o.value = String(val); o.textContent = label; sel.appendChild(o); };
	const yr = new Date().getFullYear();
	for (let i = 0; i <= 2; i++) opt(y, yr + i, String(yr + i));
	for (let m = 1; m <= 12; m++) opt(mo, m, String(m));
	for (let dd = 1; dd <= 31; dd++) opt(d, dd, String(dd));
	for (let hh = 0; hh <= 23; hh++) opt(h, hh, String(hh).padStart(2, "0"));
	for (let mm = 0; mm < 60; mm += 15) opt(mi, mm, String(mm).padStart(2, "0"));   // 15分刻み
}
function setExpirySelects(dt) {
	document.getElementById("c-year").value = String(dt.getFullYear());
	document.getElementById("c-month").value = String(dt.getMonth() + 1);
	document.getElementById("c-day").value = String(dt.getDate());
	document.getElementById("c-hour").value = String(dt.getHours());
	document.getElementById("c-min").value = String(Math.floor(dt.getMinutes() / 15) * 15);   // 15分刻みに合わせる
}
// 看板の作成／編集を開く。
// 引数ありは既存の看板の再編集（scene.js のクリックから）、なしは新規作成。
// 同じモーダルを使い回し、editingComment がどちらかを覚えている。
export function openCommentModal(target) {
	editingComment = target && target.id ? target : null;
	const src = editingComment || {};
	stopMoving();   // モーダル中はアバターを動かさない
	const title = document.getElementById("c-title");
	if (title) title.textContent = editingComment ? "看板の編集" : "看板の作成";
	const save = document.getElementById("c-save");
	if (save) save.textContent = editingComment ? "保存" : "作成";
	document.getElementById("c-bg").value = src.bg || "#ffffff";
	commentEditor.set(src);
	commentEditor.setBg(src.bg || "#ffffff");
	// 期限日時：既存はその値、新規は「今から1時間後」を初期値に
	const base = src.expireAt ? new Date(src.expireAt) : new Date(Date.now() + 60 * 60 * 1000);
	base.setSeconds(0, 0);
	setExpirySelects(base);
	const err = document.getElementById("c-err");
	if (err) err.textContent = "";
	document.getElementById("comment-modal").classList.add("open");
	commentEditor.focus();
}
function closeCommentModal() {
	document.getElementById("comment-modal").classList.remove("open");
	editingComment = null;
	// 入力欄にフォーカスが残ったままだと、move.js の isTyping が効いて移動キーが使えない
	if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
function saveCommentModal() {
	const err = document.getElementById("c-err");
	const setErr = (m) => { if (err) err.textContent = m || ""; };
	// 期限日時は未来のみ許可。存在しない日付（例：2月30日）は弾く。
	const y = +document.getElementById("c-year").value;
	const mo = +document.getElementById("c-month").value;
	const d = +document.getElementById("c-day").value;
	const h = +document.getElementById("c-hour").value;
	const mi = +document.getElementById("c-min").value;
	const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
	if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) { setErr("その日付は存在しません。"); return; }
	const expireAt = dt.getTime();
	if (expireAt <= Date.now()) { setErr("未来の日時を指定してください。"); return; }
	const { runs, text } = commentEditor.get();
	if (text.length > COMMENT_MAX) { setErr(`文字は${COMMENT_MAX}文字までです（いま${text.length}文字）。`); return; }
	// 装飾は runs が持つ。size / color / bold / italic は「指定なし」の値に戻しておく
	// （runs を知らない古い画面で開いている人には、text がこの指定で表示される）。
	const fields = {
		text, runs,
		size: 16, color: "#141815", bold: false, italic: false,
		bg: document.getElementById("c-bg").value,
		expireAt,
	};
	// 保存はどちらも「サーバーへ送るだけ」。画面には自分で書かず、
	// サーバーが全員へ配った結果が返ってきて初めて表示に反映される。
	if (editingComment) {
		Object.assign(editingComment, fields);   // 既存を更新（id・位置・大きさは維持）
		sendComment(editingComment);
	} else {
		const w = GRID * 6, h = GRID * 3;
		// 自分の少し上に置く（画面外にはみ出さないよう収める）
		const x = Math.max(0, Math.min(WORLD.w - w, store.me.x - w / 2));
		const y = Math.max(0, Math.min(WORLD.h - h, store.me.y - h - GRID));
		sendComment({ id: uid(), x: Math.round(x), y: Math.round(y), w, h, ...fields });
	}
	closeCommentModal();   // サーバーが全員へ配信し、返ってきたリストで表示される
}
// crypto.randomUUID は安全でない接続（http のままの自前サーバーなど）では使えないので、
// 失敗したら乱数で代用する。id は同じ看板を見分けられれば足りる。
function uid() {
	try { return crypto.randomUUID().slice(0, 8); } catch { return "c" + Math.floor(Math.random() * 1e9).toString(36); }
}

// ── 家具リンク：2マス以内に入ったら「開きますか？」を出す ──
let currentLink = null;
// 直前に出していた内容。毎フレーム呼ばれるので、変わらないときは DOM を触らない。
let linkKey = "";

export function initLinkPrompt() {
	const btn = document.getElementById("link-open");
	if (btn) btn.addEventListener("click", () => {
		if (!currentLink) return;
		let u = currentLink;
		// 管理者が "example.com" のように書いていても開けるようにする。
		// ここで補わないと、いまのページからの相対パスとして解釈される。
		if (!/^https?:\/\//i.test(u)) u = "https://" + u;
		window.open(u, "_blank", "noopener");   // noopener で開いた先から元のページを触らせない
	});
}

// リンク付き家具のうち、自分から2マス以内で一番近いもののプロンプトを出す。
// 距離は家具の矩形までの距離（中心ではない）なので、大きな家具でも端に寄れば届く。
// ここの2マスは NEAR と同じ値だが、意味が違う（会話できる距離ではない）ので別に書いてある。
export function updateLinkPrompt() {
	const el = document.getElementById("link-prompt");
	if (!el) return;
	let best = null, bestD = Infinity;
	for (const f of store.furniture) {
		if (!f.url) continue;
		const nx = Math.max(f.x, Math.min(store.me.x, f.x + f.sw));   // 家具矩形上の最近点
		const ny = Math.max(f.y, Math.min(store.me.y, f.y + f.sh));
		const d = Math.hypot(store.me.x - nx, store.me.y - ny);
		if (d <= GRID * 2 && d < bestD) { best = f; bestD = d; }
	}
	// 距離の判定は自分が動くたびに要るが、書き込みは表示が変わるときだけでよい
	const key = best ? `${best.url}|${best.label || ""}` : "";
	if (key === linkKey) return;
	linkKey = key;

	if (best) {
		currentLink = best.url;
		const label = document.getElementById("link-label");
		label.textContent = `🔗 ${best.label || best.url}`;
		label.title = best.label || best.url;   // 長くて切れたときも、乗せれば全部読める
		el.hidden = false;
	} else {
		currentLink = null;
		el.hidden = true;
	}
}

// ── 呼び出し：近くにいる人にボタンを出す ──
// 条件は「半径NEAR以内」かつ「離席中でない」。同じ条件をサーバーでも検査している。
// 表示中のボタンを作り直すと押せなくなるので、顔ぶれが変わったときだけ組み直す。
let callPromptKey = "";

function nearbyCallTargets() {
	const list = [];
	for (const [id, o] of store.others) {
		if (!o.name || o.away) continue;
		const p = o.buf[o.buf.length - 1];
		if (!p) continue;
		const d = Math.hypot(p.x - store.me.x, p.y - store.me.y);
		if (d <= NEAR) list.push({ id, name: o.name, d });
	}
	return list.sort((a, b) => a.d - b.d).slice(0, 6);   // 多すぎても押せないので近い順に6人まで
}

export function updateCallPrompt() {
	const el = document.getElementById("call-prompt");
	if (!el) return;
	if (store.me.away) { el.hidden = true; callPromptKey = ""; return; }   // 離席中は呼び出さない

	const targets = nearbyCallTargets();
	const key = targets.map((t) => `${t.id}:${t.name}`).join("|");
	if (key === callPromptKey) return;
	callPromptKey = key;

	if (!targets.length) { el.hidden = true; el.replaceChildren(); return; }

	// 「呼び出す」の見出しを1つ置き、相手の名前だけの小さな札を横に並べる。
	// 1人ずつ「◯◯さんを呼び出す」と書いた大きなボタンを縦に積むと、人が集まったときに
	// マップを覆ってしまう。
	const cap = document.createElement("span");
	cap.className = "prompt-cap";
	cap.textContent = "🔔 呼び出す";
	el.replaceChildren(cap, ...targets.map((t) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "call-btn";
		btn.textContent = t.name;
		btn.title = `${t.name}さんを呼び出す`;
		btn.addEventListener("click", () => {
			sendCall(t.id);
			btn.disabled = true;                                  // 連打防止（サーバー側でも弾く）
			setTimeout(() => { btn.disabled = false; }, 10_000);
		});
		return btn;
	}));
	el.hidden = false;
}

// 呼び出しを受けたときの画面バナー。数秒で自然に消す。
export function updateCallAlert() {
	const el = document.getElementById("call-alert");
	if (!el) return;
	const a = store.callAlert;
	if (!a) { if (!el.hidden) el.hidden = true; return; }
	if (Date.now() - a.at > 8000) { store.callAlert = null; el.hidden = true; return; }
	const text = `🔔 ${a.name}さんから呼び出しがあります`;
	if (el.textContent !== text) el.textContent = text;
	el.hidden = false;
}

// ── 在室者リスト（左メニュー）──
// 会話エリアごとに中の人をまとめる。エリア外にいるときは、いま会話できる
// 「近くの人」（同じくエリア外で半径NEAR以内）を自分視点でまとめて表示する。
//
// つまり「いま自分の声が届く相手」の一覧であって、接続者の一覧ではない。
// 接続者の全員を見るのは勤務者一覧（下）のほう。
//
// 呼ぶたびに innerHTML を作り直すので、main.js 側で500msに間引いている。
export function updateRoster() {
	const el = document.getElementById("roster");
	if (!el) return;

	// 自分が今いるグループだけを表示する
	const g = myGroup();
	const members = [{ name: store.me.name, self: true }, ...g.names.map((name) => ({ name, self: false }))];
	el.innerHTML = renderGroup(g.zone ? g.zone.name : "近くの人", members, !g.zone);
}

// いま自分と同じ範囲にいる人（自分を除く）。声とチャットが届く相手。
//
// 会話エリアの中にいれば同じエリアの人、外にいれば半径 NEAR 以内でエリア外の人。
// サーバーがチャットを配る条件（src/room.js の relayChat）と同じ式で、離席中の人も含む。
// 戻り値の zone は自分がいる会話エリア（外にいれば null）。
function myGroup() {
	const myZone = zoneIdAt(store.me.x, store.me.y);
	const names = [];
	for (const o of store.others.values()) {
		const p = o.buf[o.buf.length - 1];
		if (!p) continue;
		const oz = zoneIdAt(p.x, p.y);
		if (myZone ? oz === myZone : (oz === null && Math.hypot(p.x - store.me.x, p.y - store.me.y) <= NEAR)) names.push(o.name);
	}
	const zone = myZone ? (store.zones.find((z) => z.id === myZone) || { name: "会話エリア" }) : null;
	return { zone, names };
}

// いまチャットを送ると誰に届くかを、入力欄のプレースホルダに出す。
// チャットは全員には届かない。会話エリアの中ならそのエリアの人、外なら近くの人だけ。
// それが分からないと、遠くの人に送ったつもりで返事を待ち続けることになる。
let chatPlaceholder = "";
export function updateChatPlaceholder() {
	const input = document.getElementById("chat-input");
	if (!input) return;
	const zone = myGroup().zone;
	const text = zone ? `${zone.name}にいる人へのメッセージ` : "近くの人へのメッセージ";
	if (text === chatPlaceholder) return;
	chatPlaceholder = text;
	input.placeholder = text;
	// 長いエリア名だとプレースホルダが折り返すので、高さを合わせ直す（initChatUI が聞いている）
	input.dispatchEvent(new Event("input"));
}

// ── チャット（左メニュー） ──
export function initChatUI() {
	const form = document.getElementById("chat-form");
	if (!form) return;
	const input = document.getElementById("chat-input");
	// 入力欄の高さを内容に合わせる（上限は style.css の max-height。超えたら中でスクロール）。
	// 一度 auto に戻すのは、文字を消したときに縮めるため。
	const autosize = (e) => {
		// 空のときはプレースホルダの長さに合わせる。scrollHeight はプレースホルダを
		// 数えないので、測るあいだだけ中身として入れる（会話エリア名が長いと折り返すため）。
		// 変換中は触らない（中身を書き換えると日本語入力の変換が壊れる）。
		const empty = !input.value && !(e && e.isComposing);
		if (empty) input.value = input.placeholder;
		input.style.height = "auto";
		input.style.height = input.scrollHeight + 2 + "px";   // +2 は上下の枠線ぶん
		if (empty) input.value = "";
	};
	const submit = () => {
		const text = input.value.trim();
		if (!text) return;
		sendChat(text);
		input.value = "";
		autosize();
	};
	if (input) { input.addEventListener("input", autosize); autosize(); }

	// 「一番下を見ているか」は、利用者がスクロールしたときにだけ更新する。
	// 描き直すたびに位置から測る方式だと、入力欄が伸びる・在室者が増えるなどで
	// チャット欄の高さが変わっただけで「一番下ではない」と判定され、追従が止まる。
	const log = document.getElementById("chat-log");
	if (log) {
		log.addEventListener("scroll", () => { chatStick = atBottom(log); });
		// 高さが変わったとき、一番下を見ていたなら下へ送り直す（最新のメッセージを隠さない）
		if (window.ResizeObserver) new ResizeObserver(() => { if (chatStick) log.scrollTop = log.scrollHeight; }).observe(log);
	}
	form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
	// Enterで送信、Shift+Enterで改行
	if (input) input.addEventListener("keydown", (e) => {
		// 日本語入力の変換を確定する Enter では送らない。
		// isComposing だけでは足りない。Mac の Safari は確定の Enter を「変換が終わったあと」の
		// キーとして届けるため isComposing が false になる。そのとき keyCode は 229 なので併せて見る。
		if (e.isComposing || e.keyCode === 229) return;
		if (e.key !== "Enter") return;
		// 改行は Shift+Enter のほか、Ctrl+Enter（Mac は Cmd+Enter）と Alt+Enter でも入れられる。
		// Shift+Enter は textarea がもともと改行を入れるので何もしない。
		// Ctrl などは押しても何も入らないので、カーソルの位置に自分で改行を入れる。
		if (e.shiftKey) return;
		e.preventDefault();
		if (e.ctrlKey || e.metaKey || e.altKey) {
			input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
			autosize();
			input.scrollTop = input.scrollHeight;   // 上限まで伸びたあとも、入れた行が見えるように
			return;
		}
		submit();
	});
}

// ── 勤務者一覧（接続中の全員） ──
// 距離やエリアに関係なく、いま接続している人を全員並べる。
export function initPeopleUI() {
	const btn = document.getElementById("people-btn");
	const modal = document.getElementById("people-modal");
	const close = document.getElementById("people-close");
	if (btn) btn.addEventListener("click", () => { renderPeople(); if (modal) modal.classList.add("open"); });
	if (close) close.addEventListener("click", () => { if (modal) modal.classList.remove("open"); });
	if (modal) modal.addEventListener("click", (e) => { if (e.target.id === "people-modal") modal.classList.remove("open"); });

	// 人の行を押すと、一覧を閉じてマップ上でその人の場所を数秒示す（描くのは scene.js）。
	// 行は描き直しで入れ替わるので、1つずつではなく一覧の側でまとめて受ける。
	const list = document.getElementById("people-list");
	if (list) list.addEventListener("click", (e) => {
		const row = e.target.closest ? e.target.closest(".person-row.other") : null;
		if (!row || !store.others.has(row.dataset.id)) return;
		store.locate = { id: row.dataset.id, until: Date.now() + LOCATE_MS };
		if (modal) modal.classList.remove("open");
	});
}

const LOCATE_MS = 6000;   // 場所を示し続ける時間
// 一覧を開いている間だけ、最新の接続者に更新する
export function updatePeople() {
	const modal = document.getElementById("people-modal");
	if (modal && modal.classList.contains("open")) renderPeople();
}
function renderPeople() {
	const el = document.getElementById("people-list");
	if (!el) return;
	// いる場所。会話エリアの中ならその名前、外なら空（何も出さない）
	const whereOf = (x, y) => {
		const id = zoneIdAt(x, y);
		const z = id ? store.zones.find((z) => z.id === id) : null;
		return z ? z.name : "";
	};
	const people = [{ name: store.me.name, self: true, away: store.me.away, awayMsg: store.me.awayMsg, where: whereOf(store.me.x, store.me.y) }];
	for (const [id, o] of store.others) {
		const p = o.buf[o.buf.length - 1];
		people.push({ id, name: o.name, self: false, away: o.away, awayMsg: o.awayMsg, where: p ? whereOf(p.x, p.y) : "" });
	}
	let html = `<div class="people-count"><span>${people.length}人が接続中</span><span>名前を押すと場所を表示</span></div>`;
	for (const p of people) {
		html += `<div class="person-row${p.self ? " self" : " other"}"${p.self ? "" : ` data-id="${esc(p.id)}"`}><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.self ? "（自分）" : ""}`
			+ `<span class="where">${esc(p.where)}</span>${p.away ? `<span class="away-tag">離席中${p.awayMsg ? "：" + esc(p.awayMsg) : ""}</span>` : ""}</div>`;
	}
	// 変わったときだけ書き換える。500msごとに作り直すと、押している最中に行が
	// 入れ替わってクリックを取りこぼす。
	if (html === peopleHtml) return;
	peopleHtml = html;
	el.innerHTML = html;
}
let peopleHtml = "";

// ── 退出・離席 ──
export function initAwayUI() {
	const awayBtn = document.getElementById("away-btn");
	const leaveBtn = document.getElementById("leave-btn");
	const modal = document.getElementById("away-modal");
	const saveBtn = document.getElementById("away-save");
	const text = document.getElementById("away-text");

	if (leaveBtn) leaveBtn.addEventListener("click", () => { window.location.href = "index.html"; });

	// いまの文字数を入力欄の下に出す。上限は textarea の maxlength（office.html）から読む。
	// 上限に達すると、それ以上は入力できない（ブラウザが止める）ので、数字を赤くして知らせる。
	const count = document.getElementById("away-count");
	const syncCount = () => {
		if (!text || !count) return;
		const max = text.maxLength > 0 ? text.maxLength : 100;
		count.textContent = `${text.value.length} / ${max}`;
		count.classList.toggle("full", text.value.length >= max);
	};
	if (text) text.addEventListener("input", syncCount);

	if (awayBtn) awayBtn.addEventListener("click", () => {
		if (!store.me.away) {
			store.me.away = true;
			setAwayBtn(true);
			sendAway(true, store.me.awayMsg || "");
			updateVoice();   // マイクと画面共有をすぐ止め、ボタンの表示も合わせる（次の周期を待たない）
			if (text) text.value = store.me.awayMsg || "";
			syncCount();   // 値をこちらで入れたときは input が発火しないので、数字も合わせる
			if (modal) modal.classList.add("open");
			if (text) text.focus();
		} else {
			// 着席：離席解除し、モーダルも閉じる
			store.me.away = false;
			store.me.awayMsg = "";
			setAwayBtn(false);
			sendAway(false, "");
			updateVoice();
			if (modal) modal.classList.remove("open");
		}
	});

	// 「更新」は理由を書き換えるだけで、離席は解除しない。
	// モーダルも開いたままにする（閉じる導線は「着席」ボタンのほう）。
	if (saveBtn) saveBtn.addEventListener("click", () => {
		store.me.awayMsg = text ? text.value.trim() : "";
		sendAway(true, store.me.awayMsg);
	});
}
function setAwayBtn(away) {
	const b = document.getElementById("away-btn");
	if (!b) return;
	// 文字は .bl の中だけを書き換える（ボタン全体を書き換えると、畳んだとき用の絵が消える）
	const label = away ? "着席" : "離席";
	const bl = b.querySelector(".bl");
	if (bl) bl.textContent = label; else b.textContent = label;
	b.title = label;
	b.classList.toggle("on", away);
}

// ── 左メニューを畳む ──
// 畳むと幅 56px の帯になり、マップが広く映る。マイク・画面共有・離席などは絵だけの
// ボタンとして残す（すぐ押せないと困るため、完全には閉じない）。
// 見た目の切り替えは style.css の .rail-collapsed が受け持ち、ここはクラスの付け外しと
// 状態の保存、畳んでいる間に届いたチャットの数え上げをする。
let railCollapsed = false;
let unreadChat = 0;

export function initRailToggle() {
	const root = document.getElementById("admin");
	const toggle = document.getElementById("rail-toggle");
	if (!root || !toggle) return;
	const apply = (collapsed, save) => {
		railCollapsed = collapsed;
		root.classList.toggle("rail-collapsed", collapsed);
		toggle.textContent = collapsed ? "»" : "«";
		toggle.title = collapsed ? "メニューを開く" : "メニューを畳む";
		toggle.setAttribute("aria-label", toggle.title);
		if (!collapsed) setUnread(0);
		if (save) write(KEY.rail, collapsed ? "1" : "0");
		// マップ部分の幅が変わるので描き直させる（scene.js が resize を聞いている）
		window.dispatchEvent(new Event("resize"));
		if (!collapsed) {
			// 開いた直後はチャット欄の高さが変わっているので、最新のメッセージまで送る
			const log = document.getElementById("chat-log");
			if (log) log.scrollTop = log.scrollHeight;
		}
	};
	toggle.addEventListener("click", () => apply(!railCollapsed, true));
	const chatBtn = document.getElementById("chat-open-btn");
	if (chatBtn) chatBtn.addEventListener("click", () => {
		apply(false, true);
		const input = document.getElementById("chat-input");
		if (input) input.focus();
	});
	// 前回の状態を引き継ぐ。初めての人（保存された値が無い人）は、開いた状態から始める。
	apply(read(KEY.rail, "") === "1", false);
}

// 畳んでいる間に届いたチャットの数。チャットを開くボタンの右上に出す。
function setUnread(n) {
	unreadChat = n;
	const badge = document.querySelector("#chat-open-btn .badge");
	if (!badge) return;
	badge.hidden = n === 0;
	badge.textContent = n > 9 ? "9+" : String(n);
}

// ── 転送量の表示（使用量 / 1000GB） ──
// 直前に表示した値。同じなら DOM を触らない（毎フレーム呼ばれるため）。
let lastUsage = -1;
export function updateUsage() {
	const el = document.getElementById("usage");
	if (!el) return;
	const used = store.usedGb || 0, limit = store.limitGb || 1000;
	if (used === lastUsage) return;
	lastUsage = used;
	const pct = Math.min(100, (used / limit) * 100);
	const color = pct >= 90 ? "#b23a2a" : pct >= 70 ? "#e0a83f" : "#2a7d3f";
	el.innerHTML =
		`<div class="usage-label">推定通信量 ${used} / ${limit} GB</div>` +
		`<div class="usage-bar"><span style="width:${pct}%;background:${color}"></span></div>`;
}

// ── チャットの表示 ──
// store.chatSeq は net.js が1件受け取るたびに増やす通し番号。
// 中身を比べる代わりにこれを見て、変わったときだけ組み直す。
let lastChatSeq = -1;
export function updateChat() {
	const el = document.getElementById("chat-log");
	if (!el || store.chatSeq === lastChatSeq) return;   // 変化がなければ何もしない
	const added = lastChatSeq < 0 ? 0 : store.chatSeq - lastChatSeq;   // 前回の描画から増えた件数
	lastChatSeq = store.chatSeq;
	let html = "";
	for (const m of store.messages) {   // 古い順＝上から古い順、新着が一番下
		if (m.kind === "call") {        // 呼び出しの記録は発言者名を出さず、見た目を分ける（時刻は本文に入っている）
			html += `<div class="chat-msg call">${esc(m.text)}</div>`;
			continue;
		}
		html += `<div class="chat-msg${m.self ? " self" : ""}"><span class="chat-name"><span>${esc(m.name)}</span><span class="chat-time">${hhmm(m.at)}</span></span>${esc(m.text)}</div>`;
	}
	// 一番下を見ているときだけ新着に追従する。さかのぼって読んでいる最中に
	// 下へ引き戻されないようにするため。自分が送ったときは、どこを見ていても下へ送る。
	const last = store.messages[store.messages.length - 1];
	if (last && last.self) chatStick = true;
	// メニューを畳んでいる間に届いたぶんを数える（自分の発言は数えない）。
	// 1回の描画のあいだに複数届くことがあるので、増えた件数ぶんを末尾から見る。
	if (railCollapsed && added > 0) {
		const fresh = store.messages.slice(-added).filter((m) => !m.self).length;
		if (fresh) setUnread(unreadChat + fresh);
	}
	el.innerHTML = html;
	if (chatStick) el.scrollTop = el.scrollHeight;
}

// チャット欄の一番下を見ているか（initChatUI のスクロール監視が更新する）。最初は一番下。
let chatStick = true;

// スクロール位置がほぼ一番下か。ぴったりでなくても、1行ぶん程度のずれは一番下とみなす。
function atBottom(el) {
	return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

function hhmm(at) {
	const d = new Date(Number.isFinite(+at) ? +at : Date.now());
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 在室者リストの1グループ分の HTML。isFree は「会話エリアではなく近くの人」の意味で、
// 見た目を変えるために CSS のクラスへ渡している。
function renderGroup(title, members, isFree) {
	let h = `<div class="rgroup${isFree ? " free" : ""}">`;
	h += `<div class="rh">${esc(title)}（${members.length}）</div>`;
	// members は必ず自分から始まるので0件にはならない
	for (const p of members) {
		h += `<div class="rperson${p.self ? " self" : ""}"><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.self ? '<span class="you">あなた</span>' : ""}</div>`;
	}
	return h + "</div>";
}

// HTML に差し込む前に記号を実体参照へ変える。
// このファイルは innerHTML で組み立てるので、名前や本文は必ずこれを通す。
function esc(s) {
	return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
