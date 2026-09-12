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

// ── 呼び鈴メロディ ──
// 作業に集中していても気づけるよう、短い電子音ではなく音程の動くメロディにしている。
// 同じ音が続くと背景音として聞き流されるため、上がって下りる音列にした。
// 最後が低い音で終わるので、気づかせつつ急かさない。

// ベルらしい響き。倍音を整数倍からわずかにずらすと金属的になりすぎない。
const BELL = [[2.01, 0.11], [3.02, 0.05]];

// G5 → C6 → D6 → C6 → G5（平均律）
const MELODY = [
	{ at: 0.00, hz: 783.99, dur: 0.8, attack: 0.030, peak: 0.14 },
	{ at: 0.38, hz: 1046.50, dur: 0.8, attack: 0.030, peak: 0.14 },
	{ at: 0.76, hz: 1174.66, dur: 0.9, attack: 0.030, peak: 0.14 },
	{ at: 1.14, hz: 1046.50, dur: 0.9, attack: 0.030, peak: 0.14 },
	{ at: 1.52, hz: 783.99, dur: 1.5, attack: 0.035, peak: 0.15 },
];
const MELODY_SPAN = 1.85;   // メロディ本体の長さ（余韻は含めない）
const REPEAT_GAP = 0.8;     // 1回目と2回目のあいだ
const REPEAT = 2;           // 1回目を聞き逃しても2回目で気づけるように

// 全体の音量。試聴ページの既定（60%）と同じ大きさに揃えている。
const VOLUME = 0.6;

// 1音を鳴らす。立ち上がりに傾斜をつけて出だしの角を取り、
// 減衰は指数的にして自然に消えるようにする。
function tone(ac, n, startAt) {
	const t0 = startAt + n.at;
	const peak = n.peak * VOLUME;
	const master = ac.createGain();
	master.gain.setValueAtTime(0.0001, t0);
	master.gain.linearRampToValueAtTime(peak, t0 + n.attack);
	master.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
	master.connect(ac.destination);

	const add = (hz, g) => {
		const osc = ac.createOscillator();
		const gain = ac.createGain();
		osc.type = "sine";
		osc.frequency.value = hz;
		gain.gain.value = g;
		osc.connect(gain).connect(master);
		osc.start(t0);
		osc.stop(t0 + n.dur + 0.08);
	};
	add(n.hz, 1);
	for (const [mult, g] of BELL) add(n.hz * mult, g);
}

export function playAlarm() {
	const ac = ctx();
	if (!ac) return;
	try {
		const base = ac.currentTime;
		const step = MELODY_SPAN + REPEAT_GAP;
		for (let i = 0; i < REPEAT; i++) {
			for (const n of MELODY) tone(ac, n, base + i * step);
		}
	} catch { }
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
