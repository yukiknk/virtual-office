// 入室画面の入力フォーム。氏名とマイク／スピーカーを決めて office.html へ送り出す。
//
// アバターの選択UIは avatar-ui.js が担当する。ここは入室時に getAvatar() で受け取るだけ。
//
// オフィス画面へは localStorage 経由で引き継ぐ。キーと読み書きは storage.js にまとめてある。

import { getAvatar, initAvatarUI } from "./avatar-ui.js";
import { KEY, read, write, writeJson } from "./storage.js";
import { micIdOf, playTestTone, startMicLoopTest, micTestText } from "./devices.js";

const form = document.getElementById("gateform");
const nm = document.getElementById("nm");
const micSel = document.getElementById("mic-select");
const spkSel = document.getElementById("spk-select");
const note = document.getElementById("dev-note");
const micTestBtn = document.getElementById("mic-test-btn");
const micLevel = document.getElementById("mic-level");
const micNote = document.getElementById("mic-test-note");
const spkTestBtn = document.getElementById("spk-test-btn");
const spkNote = document.getElementById("spk-test-note");

nm.value = read(KEY.name);

// 氏名が空のあいだは入室ボタンを押せなくする
const submitBtn = form.querySelector('button[type="submit"]');
function syncSubmit() { if (submitBtn) submitBtn.disabled = !nm.value.trim(); }
nm.addEventListener("input", syncSubmit);
syncSubmit();

// ── デバイス一覧 ──
// 先にマイクの許可を取る必要がある。許可前の enumerateDevices() は
// デバイス名を空文字で返すため、一覧に「マイク」としか出せなくなる。
// 取得したストリームは名前を読むためだけのものなので、すぐ止める。
async function initDevices() {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		stream.getTracks().forEach((t) => t.stop());
	} catch {
		note.textContent = "マイクが許可されていません。音声なしでも入室できます。";
		return;
	}
	const devices = await navigator.mediaDevices.enumerateDevices();
	const savedMic = read(KEY.micId);
	const savedSpk = read(KEY.speakerId);
	// 先頭は「既定」。deviceId は Bluetooth の再接続などで変わるので、
	// 特定のデバイスを名指ししない選択肢を用意しておく（既定はブラウザが追従する）。
	addDefaultOption(micSel, "既定のマイク", savedMic);
	addDefaultOption(spkSel, "既定のスピーカー", savedSpk);
	for (const d of devices) {
		// Chrome は deviceId が "default" / "communications" の項目も返す。
		// 上で足した「既定」と二重になるので除く。
		if (d.deviceId === "default" || d.deviceId === "communications") continue;
		if (d.kind === "audioinput") addOption(micSel, d, savedMic);
		else if (d.kind === "audiooutput") addOption(spkSel, d, savedSpk);
	}
	// enumerateDevices() が audiooutput を返さないブラウザでは「既定」しか残らない。
	// 選ぶ意味がないので欄ごと無効にする（テスト音は既定へ鳴らせるので有効のまま）。
	if (spkSel.options.length <= 1) spkSel.disabled = true;
}

// 「指定しない」を表す選択肢。value を空にしておくと、保存値も空になり、
// devices.js の openMic が getUserMedia({ audio: true }) で開く。
function addDefaultOption(sel, label, selectedId) {
	const o = document.createElement("option");
	o.value = "";
	o.textContent = label;
	if (!selectedId) o.selected = true;
	sel.appendChild(o);
}

function addOption(sel, device, selectedId) {
	const o = document.createElement("option");
	o.value = device.deviceId;
	o.textContent = device.label || (sel === micSel ? "マイク" : "スピーカー");
	if (device.deviceId === selectedId) o.selected = true;
	sel.appendChild(o);
}

// ── 入室 ──
form.addEventListener("submit", (e) => {
	e.preventDefault();
	const name = nm.value.trim();
	if (!name) return;
	stopMicTest();   // マイクを掴んだまま遷移しない

	// 氏名に "admin" と入れると管理者ページへ移動する隠し動作。
	// 副作用として "admin" という氏名では入室できない。
	if (name === "admin") {
		location.href = "admin.html";
		return;
	}

	write(KEY.name, name);
	write(KEY.micId, micSel.value || "");
	write(KEY.speakerId, spkSel.value || "");
	writeJson(KEY.avatar, getAvatar());
	location.href = "office.html";
});

// ── マイクテスト ──
// 4秒間録音して、そのあと自分の声を再生する。話している最中の声をそのまま返すと、
// イヤホンを使っていない人でハウリングするため、録り終えてから鳴らす。
// 本体は devices.js の startMicLoopTest（オフィスの音声の設定と共通）。
let stopTest = null;   // 実行中のテストを止める関数。null ならテストしていない

function startMicTest() {
	stopMicTest();
	micTestBtn.textContent = "テストを終了";
	stopTest = startMicLoopTest({
		micId: micSel.value,
		speakerId: spkSel.value,
		onLevel: (v) => { micLevel.firstElementChild.style.width = Math.round(v * 100) + "%"; },
		onPhase: (phase, detail) => {
			if (phase === "opened") {
				// 代替で開けた場合は、実際に開いたデバイスへ選択を合わせる
				const got = micIdOf(detail);
				if (got && [...micSel.options].some((o) => o.value === got)) micSel.value = got;
				micLevel.hidden = false;
			}
			if (phase === "playing") micLevel.hidden = true;
			if (["ok", "silent", "playfail", "error"].includes(phase)) stopMicTest();   // 片づけてから結果を出す
			const t = micTestText(phase, detail);
			if (t) setMicNote(t.text, t.cls);
		},
	});
}

// マイクを確実に閉じる。開いたままにすると Bluetooth が低音質のままになる。
function stopMicTest() {
	if (stopTest) { stopTest(); stopTest = null; }
	if (micTestBtn) micTestBtn.textContent = "マイクをテスト";
	if (micLevel) micLevel.hidden = true;
	setMicNote("", "");
}

function setMicNote(text, cls) {
	if (!micNote) return;
	micNote.textContent = text;
	micNote.className = cls ? `test-note ${cls}` : "test-note";
}

if (micTestBtn) micTestBtn.addEventListener("click", () => { if (stopTest) stopMicTest(); else startMicTest(); });
if (micSel) micSel.addEventListener("change", stopMicTest);   // 選び直したら仕切り直し

// ── スピーカーテスト ──
// 出力先を選べないブラウザ（Firefox など）では既定のスピーカーから鳴るので、
// そのことを文言で伝える。
if (spkTestBtn) {
	spkTestBtn.addEventListener("click", async () => {
		spkTestBtn.disabled = true;
		spkNote.className = "test-note";
		spkNote.textContent = "鳴らしています…";
		const routed = await playTestTone(spkSel.value);
		spkNote.textContent = routed
			? "音が聞こえましたか？聞こえない場合は別のスピーカーを選んでください"
			: "このブラウザでは出力先を選べないため、既定のスピーカーで鳴らしました";
		setTimeout(() => { spkTestBtn.disabled = false; }, 800);
	});
}

initDevices();
initAvatarUI();
