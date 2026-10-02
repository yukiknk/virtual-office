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

// エリア外にいる人どうしが会話できる範囲。voice.js が音声をつなぐ距離と、
// サーバーがチャットを配る距離と、同じ値を別々に持っている。変えるときは3か所。
const NEAR = GRID * 2;

// ── コメント作成モーダル（オフィス側） ──
let editingComment = null;   // 再編集中の看板（null＝新規作成）

export function initCommentUI() {
	const addBtn = document.getElementById("comment-add-btn");
	const cancel = document.getElementById("c-cancel");
	const save = document.getElementById("c-save");
	const modal = document.getElementById("comment-modal");
	if (addBtn) addBtn.addEventListener("click", () => openCommentModal());
	if (cancel) cancel.addEventListener("click", closeCommentModal);
	if (save) save.addEventListener("click", saveCommentModal);
	if (modal) modal.addEventListener("click", (e) => { if (e.target.id === "comment-modal") closeCommentModal(); });
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
	document.getElementById("c-text").value = src.text || "";
	document.getElementById("c-size").value = String(src.size || 16);
	document.getElementById("c-color").value = src.color || "#141815";
	document.getElementById("c-bg").value = src.bg || "#ffffff";
	document.getElementById("c-bold").checked = !!src.bold;
	document.getElementById("c-italic").checked = !!src.italic;
	// 期限日時：既存はその値、新規は「今から1時間後」を初期値に
	const base = src.expireAt ? new Date(src.expireAt) : new Date(Date.now() + 60 * 60 * 1000);
	base.setSeconds(0, 0);
	setExpirySelects(base);
	const err = document.getElementById("c-err");
	if (err) err.textContent = "";
	document.getElementById("comment-modal").classList.add("open");
	document.getElementById("c-text").focus();
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
	const fields = {
		text: document.getElementById("c-text").value.trim(),
		size: Number(document.getElementById("c-size").value) || 16,
		color: document.getElementById("c-color").value,
		bg: document.getElementById("c-bg").value,
		bold: document.getElementById("c-bold").checked,
		italic: document.getElementById("c-italic").checked,
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
		document.getElementById("link-label").textContent = `「${best.label || best.url}」を開きますか？`;
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
	return list.sort((a, b) => a.d - b.d).slice(0, 3);   // 多すぎても押せないので近い順に3人まで
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

	el.replaceChildren(...targets.map((t) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "call-btn";
		btn.textContent = `${t.name}さんを呼び出す`;
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

	const myZone = zoneIdAt(store.me.x, store.me.y);

	// 他人を最新位置つきで集める
	const others = [];
	for (const o of store.others.values()) {
		const p = o.buf[o.buf.length - 1];
		if (!p) continue;
		others.push({ name: o.name, x: p.x, y: p.y });
	}

	// 自分が今いるグループだけを表示する
	const members = [{ name: store.me.name, self: true }];
	let title;
	if (myZone) {
		const z = store.zones.find((z) => z.id === myZone);
		title = z ? z.name : "会話エリア";
		for (const p of others) if (zoneIdAt(p.x, p.y) === myZone) members.push({ name: p.name, self: false });
		el.innerHTML = renderGroup(title, members, false);
	} else {
		title = "近くの人";
		for (const p of others) {
			if (zoneIdAt(p.x, p.y) !== null) continue;   // エリア内の人は対象外
			if (Math.hypot(p.x - store.me.x, p.y - store.me.y) <= NEAR) members.push({ name: p.name, self: false });
		}
		el.innerHTML = renderGroup(title, members, true);
	}
}

// ── チャット（左メニュー） ──
export function initChatUI() {
	const form = document.getElementById("chat-form");
	if (!form) return;
	const input = document.getElementById("chat-input");
	const submit = () => {
		const text = input.value.trim();
		if (!text) return;
		sendChat(text);
		input.value = "";
	};
	form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
	// Enterで送信、Shift+Enterで改行
	if (input) input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
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
}
// 一覧を開いている間だけ、最新の接続者に更新する
export function updatePeople() {
	const modal = document.getElementById("people-modal");
	if (modal && modal.classList.contains("open")) renderPeople();
}
function renderPeople() {
	const el = document.getElementById("people-list");
	if (!el) return;
	const people = [{ name: store.me.name, self: true, away: store.me.away }];
	for (const o of store.others.values()) people.push({ name: o.name, self: false, away: o.away });
	let html = `<div class="people-count">${people.length}人が接続中</div>`;
	for (const p of people) {
		html += `<div class="person-row${p.self ? " self" : ""}"><span class="dot"></span><span class="nm">${esc(p.name)}</span>${p.self ? "（自分）" : ""}${p.away ? '<span class="away-tag">離席中</span>' : ""}</div>`;
	}
	el.innerHTML = html;
}

// ── 退出・離席 ──
export function initAwayUI() {
	const awayBtn = document.getElementById("away-btn");
	const leaveBtn = document.getElementById("leave-btn");
	const modal = document.getElementById("away-modal");
	const saveBtn = document.getElementById("away-save");
	const text = document.getElementById("away-text");

	if (leaveBtn) leaveBtn.addEventListener("click", () => { window.location.href = "index.html"; });

	if (awayBtn) awayBtn.addEventListener("click", () => {
		if (!store.me.away) {
			store.me.away = true;
			setAwayBtn(true);
			sendAway(true, store.me.awayMsg || "");
			updateVoice();   // マイクと画面共有をすぐ止め、ボタンの表示も合わせる（次の周期を待たない）
			if (text) text.value = store.me.awayMsg || "";
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
	b.textContent = away ? "着席" : "離席";
	b.classList.toggle("on", away);
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
	lastChatSeq = store.chatSeq;
	let html = "";
	for (const m of store.messages) {   // 新着が先頭＝上から新しい順
		if (m.kind === "call") {        // 呼び出しの記録は発言者名を出さず、見た目を分ける
			html += `<div class="chat-msg call">${esc(m.text)}</div>`;
			continue;
		}
		html += `<div class="chat-msg${m.self ? " self" : ""}"><span class="chat-name">${esc(m.name)}</span>${esc(m.text)}</div>`;
	}
	el.innerHTML = html;
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
