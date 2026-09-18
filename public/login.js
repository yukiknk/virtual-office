// 入室画面の入力フォーム。氏名とマイク／スピーカーを決めて office.html へ送り出す。
//
// アバターの選択UIは avatar-ui.js が担当する。ここは入室時に getAvatar() で受け取るだけ。
//
// オフィス画面へは localStorage 経由で引き継ぐ。キー名は office/store.js と一致させること。
// 型の検査は無いので、片方だけ変えるとエラーも出ずに既定値へ落ちる。
//   office.name      … 氏名
//   office.micId     … マイクの deviceId
//   office.speakerId … スピーカーの deviceId
//   office.avatar    … アバターの選択（JSON）

import { getAvatar, initAvatarUI } from "./avatar-ui.js";

const form = document.getElementById("gateform");
const nm = document.getElementById("nm");
const micSel = document.getElementById("mic-select");
const spkSel = document.getElementById("spk-select");
const note = document.getElementById("dev-note");

// localStorage はプライベートモードや設定によっては例外を投げる。
// 読めなくても入室はできるので、この先も try で囲んで黙って諦める。
try {
	nm.value = localStorage.getItem("office.name") || "";
} catch { }

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
	let savedMic = "", savedSpk = "";
	try {
		savedMic = localStorage.getItem("office.micId") || "";
		savedSpk = localStorage.getItem("office.speakerId") || "";
	} catch { }
	for (const d of devices) {
		if (d.kind === "audioinput") addOption(micSel, d, savedMic);
		else if (d.kind === "audiooutput") addOption(spkSel, d, savedSpk);
	}
	// enumerateDevices() が audiooutput を返さないブラウザでは候補が空になる。
	// その場合はスピーカーを選べないので、欄ごと無効にする。
	if (!spkSel.options.length) spkSel.disabled = true;
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

	// 氏名に "admin" と入れると管理者ページへ移動する隠し動作。
	// 副作用として "admin" という氏名では入室できない。
	if (name === "admin") {
		location.href = "admin.html";
		return;
	}

	try {
		localStorage.setItem("office.name", name);
		localStorage.setItem("office.micId", micSel.value || "");
		localStorage.setItem("office.speakerId", spkSel.value || "");
		localStorage.setItem("office.avatar", JSON.stringify(getAvatar()));
	} catch { }
	location.href = "office.html";
});

initDevices();
initAvatarUI();
