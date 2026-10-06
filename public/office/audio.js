// 音声の設定：オフィスにいるまま、マイクとスピーカーを選び直し、確認する画面。
// 入室画面（login.js）でも選べるが、途中でヘッドセットをつなぎ替えたときなどに、
// 退出せずに変えられるようにするためのもの。
//
// 実際の切り替え（送信中のマイクの差し替え、受信音声の出力先の変更）は voice.js が行う。
// このファイルは画面と、確認用の録音・再生だけを受け持つ。
import { store } from "./store.js";
import { playTestTone, startMicLoopTest, micTestText } from "../devices.js";
import { changeMic, changeSpeaker, setMicTest } from "./voice.js";
import { stopMoving } from "./move.js";

let modal, micSel, spkSel, micBtn, spkBtn, micNote, spkNote, level;

export function initAudioSettings() {
	modal = document.getElementById("audio-modal");
	const open = document.getElementById("audio-settings-btn");
	if (!modal || !open) return;
	micSel = document.getElementById("au-mic");
	spkSel = document.getElementById("au-spk");
	micBtn = document.getElementById("au-mic-test");
	spkBtn = document.getElementById("au-spk-test");
	micNote = document.getElementById("au-mic-note");
	spkNote = document.getElementById("au-spk-note");
	level = document.getElementById("au-level");

	open.addEventListener("click", async () => {
		stopMoving();   // 開いている間にアバターが歩き続けないようにする
		modal.classList.add("open");
		await fillDevices();
	});
	const close = () => { stopMicTest(); modal.classList.remove("open"); };
	document.getElementById("au-close").addEventListener("click", close);
	modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

	// 選び直したら、その場で切り替える（保存ボタンは置かない。選んだ結果をすぐ試せるように）
	micSel.addEventListener("change", () => { stopMicTest(); changeMic(micSel.value); });
	spkSel.addEventListener("change", () => changeSpeaker(spkSel.value));

	micBtn.addEventListener("click", () => { if (testing) stopMicTest(); else startMicTest(); });
	spkBtn.addEventListener("click", async () => {
		spkBtn.disabled = true;
		setNote(spkNote, "鳴らしています…");
		const routed = await playTestTone(spkSel.value);
		setNote(spkNote, routed
			? "音が聞こえましたか？聞こえない場合は別のスピーカーを選んでください"
			: "このブラウザでは出力先を選べないため、既定のスピーカーで鳴らしました");
		setTimeout(() => { spkBtn.disabled = false; }, 800);
	});

	// 開いている間にヘッドセットをつなぎ替えたら、一覧を作り直す
	try {
		navigator.mediaDevices.addEventListener("devicechange", () => { if (modal.classList.contains("open")) fillDevices(); });
	} catch { }
}

// ── デバイスの一覧 ──
// デバイス名は、マイクを一度でも許可していないと空で返ってくる。空だったら
// 許可を求めてから取り直す（取ったストリームは名前を読むためだけなので、すぐ止める）。
async function fillDevices() {
	let devices = [];
	try {
		devices = await navigator.mediaDevices.enumerateDevices();
		const inputs = devices.filter((d) => d.kind === "audioinput");
		if (inputs.length && !inputs.some((d) => d.label)) {
			const s = await navigator.mediaDevices.getUserMedia({ audio: true });
			s.getTracks().forEach((t) => t.stop());
			devices = await navigator.mediaDevices.enumerateDevices();
		}
		setNote(micNote, "");
	} catch {
		setNote(micNote, "マイクが許可されていないため、一覧を表示できません", "ng");
	}
	fillSelect(micSel, devices, "audioinput", "既定のマイク", store.micId);
	fillSelect(spkSel, devices, "audiooutput", "既定のスピーカー", store.speakerId);
	// 出力先を選べないブラウザ（Firefox など）は「既定」しか出ない。選ぶ意味がないので無効にする
	spkSel.disabled = spkSel.options.length <= 1;
}

// 先頭は「既定」（値は空）。特定のデバイスを名指ししない選択肢で、ブラウザが既定の変更に追従する。
function fillSelect(sel, devices, kind, defaultLabel, selectedId) {
	sel.replaceChildren();
	const add = (value, label) => {
		const o = document.createElement("option");
		o.value = value;
		o.textContent = label;
		sel.appendChild(o);
	};
	add("", defaultLabel);
	for (const d of devices) {
		// Chrome は "default" / "communications" という項目も返す。上の「既定」と重なるので除く
		if (d.kind !== kind || d.deviceId === "default" || d.deviceId === "communications") continue;
		add(d.deviceId, d.label || (kind === "audioinput" ? "マイク" : "スピーカー"));
	}
	// 保存してあるデバイスが今は無い場合は「既定」になる
	sel.value = [...sel.options].some((o) => o.value === selectedId) ? selectedId : "";
}

// ── マイクの確認（録音して、自分の声を聞く） ──
// 録音と再生の本体は devices.js の startMicLoopTest（入室画面と共通）。
//
// 確認中は、オフィスへの送信を止める（setMicTest）。マイクが ON のままだと、
// 再生した自分の声をマイクが拾い、周りの人に流れてしまうため。
let testing = false;
let stopTest = null;   // 実行中の確認を止める関数

function startMicTest() {
	testing = true;
	setMicTest(true);
	micBtn.textContent = "中止";
	stopTest = startMicLoopTest({
		micId: micSel.value,
		speakerId: spkSel.value,
		onLevel: (v) => { level.firstElementChild.style.width = Math.round(v * 100) + "%"; },
		onPhase: (phase, detail) => {
			if (phase === "opened") level.hidden = false;
			if (phase === "playing") level.hidden = true;
			const done = ["ok", "silent", "playfail", "error"].includes(phase);
			if (done) stopMicTest();   // 片づけてから結果を出す（stopMicTest が案内を消すため）
			const t = micTestText(phase, detail);
			if (t) setNote(micNote, t.text, t.cls);
		},
	});
}

// 確認をやめて、すべて片づける。画面を閉じたとき・デバイスを選び直したときにも呼ぶ。
function stopMicTest() {
	if (stopTest) { stopTest(); stopTest = null; }
	if (level) level.hidden = true;
	if (micBtn) micBtn.textContent = "マイクをテスト";
	if (testing) { testing = false; setMicTest(false); setNote(micNote, ""); }
}

function setNote(el, text, cls) {
	if (!el) return;
	el.textContent = text;
	el.className = cls ? `au-note ${cls}` : "au-note";
}
