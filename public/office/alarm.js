// 呼び出しを受けたときの注意喚起：アラーム音とブラウザ通知。
//
// 音は Web Audio で合成する。音声ファイルを持たないので、リポジトリが太らず
// 素材ライセンスの管理対象も増えない。

let audioCtx = null;

function ctx() {
	if (!audioCtx) {
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		audioCtx = new AC();
	}
	// 自動再生制限で止まっていることがあるので、鳴らす直前に起こす
	if (audioCtx.state === "suspended") audioCtx.resume().catch(() => { });
	return audioCtx;
}

// 「ピッ・ピッ」を2回。矩形波だと耳に刺さるので三角波にし、
// 音の切れ目でプツッと鳴らないよう音量に傾斜をつける。
export function playAlarm() {
	const ac = ctx();
	if (!ac) return;
	const start = ac.currentTime;
	const beeps = [
		{ at: 0.00, hz: 880 },
		{ at: 0.18, hz: 1175 },
		{ at: 0.50, hz: 880 },
		{ at: 0.68, hz: 1175 },
	];
	for (const b of beeps) {
		try {
			const osc = ac.createOscillator();
			const gain = ac.createGain();
			osc.type = "triangle";
			osc.frequency.value = b.hz;
			const t0 = start + b.at;
			gain.gain.setValueAtTime(0, t0);
			gain.gain.linearRampToValueAtTime(0.18, t0 + 0.01);
			gain.gain.setValueAtTime(0.18, t0 + 0.11);
			gain.gain.linearRampToValueAtTime(0, t0 + 0.15);
			osc.connect(gain).connect(ac.destination);
			osc.start(t0);
			osc.stop(t0 + 0.16);
		} catch { }
	}
}

// タブが裏にあるときだけ OS の通知を出す。画面を見ているならバナーと音で足りる。
export function showCallNotification(name) {
	try {
		if (!("Notification" in window)) return;
		if (Notification.permission !== "granted") return;
		if (!document.hidden) return;
		const n = new Notification("呼び出し", {
			body: `${name}さんから呼び出しがありました`,
			tag: "office-call",       // 連続で呼ばれても通知は積み上がらず置き換わる
			renotify: true,
		});
		n.onclick = () => { window.focus(); n.close(); };
	} catch { }
}

// 音声の再生許可と通知の許可は、どちらも利用者の操作を起点にしないと
// ブラウザに拒否されることがある。最初のクリック／キー入力で一度だけ済ませる。
export function initAlarm() {
	const once = () => {
		document.removeEventListener("pointerdown", once);
		document.removeEventListener("keydown", once);
		ctx();   // AudioContext を先に起こしておく
		try {
			if ("Notification" in window && Notification.permission === "default") {
				Notification.requestPermission().catch(() => { });
			}
		} catch { }
	};
	document.addEventListener("pointerdown", once);
	document.addEventListener("keydown", once);
}
