// 入室画面の入力フォーム。氏名とマイク／スピーカーを決めて office.html へ送り出す。
//
// アバターの選択UIは avatar-ui.js が担当する。ここは入室時に getAvatar() で受け取るだけ。
//
// オフィス画面へは localStorage 経由で引き継ぐ。キーと読み書きは storage.js にまとめてある。

import { getAvatar, initAvatarUI } from "./avatar-ui.js";
import { KEY, read, write, writeJson } from "./storage.js";

const form = document.getElementById("gateform");
const nm = document.getElementById("nm");
const micSel = document.getElementById("mic-select");
const spkSel = document.getElementById("spk-select");
const note = document.getElementById("dev-note");

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

	write(KEY.name, name);
	write(KEY.micId, micSel.value || "");
	write(KEY.speakerId, spkSel.value || "");
	writeJson(KEY.avatar, getAvatar());
	location.href = "office.html";
});

initDevices();
initAvatarUI();
