// マイクとスピーカーを扱う共通処理。入室画面（login.js）とオフィス画面
// （office/voice.js）の両方から使う。DOM には触らない。
//
// deviceId は環境で変わる。Bluetooth を繋ぎ直す、USB を抜き差しする、
// スリープから復帰する、いずれでも別の文字列になることがある。
// 保存した deviceId をそのまま exact で要求すると、そのとき
// 「マイクが使えない」扱いになってしまうため、代替へ落とす役目を openMic が持つ。

// 音を拾えているとみなす下限。下げすぎると暗騒音で「正常」に見えてしまう。
export const LEVEL_OK = 0.06;

// マイクを開く。
//
// exact を付けるのは、選んだのと違うマイクが黙って使われると原因が追えなくなるため。
// そのうえで、失敗したときだけ既定のマイクへ落とす。
export async function openMic(micId) {
	if (micId) {
		try {
			return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } });
		} catch (err) {
			// 許可されていない場合は代替でも直らないので、そのまま返す
			if (err && err.name === "NotAllowedError") throw err;
		}
	}
	try {
		return await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (err) {
		// Bluetooth の切り替え中や、他のアプリが掴んでいる一瞬に当たっただけのことが
		// ある。1回だけ待って試し直す。
		if (!err || err.name !== "NotReadableError") throw err;
		await new Promise((r) => setTimeout(r, 300));
		return await navigator.mediaDevices.getUserMedia({ audio: true });
	}
}

// 実際に開けたマイクの deviceId。代替で開いたときに保存し直すために使う。
export function micIdOf(stream) {
	const t = stream && stream.getAudioTracks()[0];
	const s = t && t.getSettings ? t.getSettings() : null;
	return (s && s.deviceId) || "";
}

// 音量を 0〜1 で onLevel に渡し続ける。戻り値を呼ぶと止まる。
//
// analyser を destination へは繋がない。繋ぐと自分の声がスピーカーから出て、
// イヤホンを使っていない人でハウリングする。
export function startLevelMeter(stream, onLevel) {
	const AC = window.AudioContext || window.webkitAudioContext;
	if (!AC) return () => { };
	const ac = new AC();
	const analyser = ac.createAnalyser();
	analyser.fftSize = 512;   // 約10ms分。短くすると数値が暴れ、長くすると反応が鈍る
	ac.createMediaStreamSource(stream).connect(analyser);
	const buf = new Float32Array(analyser.fftSize);
	let live = true;
	const tick = () => {
		if (!live) return;
		analyser.getFloatTimeDomainData(buf);
		let sum = 0;
		for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
		// 実効値（RMS）。話し声が 0.05〜0.15 くらいなので、8倍してバーを振らせる
		onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 8));
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return () => { live = false; try { ac.close(); } catch { } };
}

// 話しているかどうかを検出し、変わったときだけ onTalk(true/false) を呼ぶ。戻り値を呼ぶと止まる。
//
// startLevelMeter とは別にしてあるのは、あちらが requestAnimationFrame で動くため。
// タブが裏に回ると止まってしまうが、オフィスを裏に置いたまま話すのが普通の使い方なので、
// こちらはタイマーで動かす。裏のタブではタイマーが1秒に1回まで遅くなるため、
// 直近約0.7秒ぶんをまとめて調べ、その中に声があれば「話している」とする。
const TALK_LEVEL = 0.1;      // startLevelMeter と同じ目盛り（RMS×8）。暗騒音で点かない程度に
const TALK_HOLD_MS = 1500;   // 声が途切れてから消すまで。言葉の切れ目でちらつかせない
export function startTalkDetector(stream, onTalk) {
	const AC = window.AudioContext || window.webkitAudioContext;
	if (!AC) return () => { };
	const ac = new AC();
	const analyser = ac.createAnalyser();
	analyser.fftSize = 32768;   // 48kHz で約0.68秒ぶん
	ac.createMediaStreamSource(stream).connect(analyser);
	const buf = new Float32Array(analyser.fftSize);
	const CHUNK = 1024;
	let talking = false, lastLoud = 0;
	const timer = setInterval(() => {
		if (ac.state === "suspended") ac.resume().catch(() => { });
		analyser.getFloatTimeDomainData(buf);
		// 区切りごとの実効値のうち最大を見る。全体を均すと短い発話が埋もれる。
		let peak = 0;
		for (let i = 0; i + CHUNK <= buf.length; i += CHUNK) {
			let sum = 0;
			for (let j = i; j < i + CHUNK; j++) sum += buf[j] * buf[j];
			peak = Math.max(peak, Math.sqrt(sum / CHUNK));
		}
		const now = Date.now();
		if (peak * 8 >= TALK_LEVEL) lastLoud = now;
		const on = lastLoud > 0 && now - lastLoud < TALK_HOLD_MS;
		if (on !== talking) { talking = on; onTalk(on); }
	}, 250);
	return () => {
		clearInterval(timer);
		try { ac.close(); } catch { }
		if (talking) { talking = false; onTalk(false); }
	};
}

// 無音を送り続けるためのトラック。
//
// マイクを閉じたあとも「SFU から見ると送信が続いている」状態を保つためのもの。
// 送信そのものを止める（replaceTrack(null)）と、止まったままの時間が続いたときに
// SFU が相手への転送をやめてしまい、ミュートを解除しても相手に届かなくなる。
// リロードするまで直らないので、止めずに無音を流しておく。
//
// 0 をかけた発振器を繋いでいるのは、音を出さずにグラフを動かし続けるため。
// 何も繋がない出力先でも無音にはなるが、処理ごと止まってしまうブラウザがある。
let silentCtx = null;
let silentTrack = null;

export function getSilentTrack() {
	const AC = window.AudioContext || window.webkitAudioContext;
	if (!AC) return null;
	if (silentTrack && silentTrack.readyState === "live") {
		// 自動再生制限で止まっていると無音すら流れないので、そのつど起こす
		if (silentCtx.state === "suspended") silentCtx.resume().catch(() => { });
		return silentTrack;
	}
	silentCtx = new AC();
	const osc = silentCtx.createOscillator();
	const gain = silentCtx.createGain();
	gain.gain.value = 0;
	const dest = silentCtx.createMediaStreamDestination();
	osc.connect(gain).connect(dest);
	osc.start();
	silentTrack = dest.stream.getAudioTracks()[0];
	return silentTrack;
}

// スピーカーの確認音。短い2音を鳴らす。
//
// 戻り値は「選んだスピーカーへ出せたか」。出力先の指定（setSinkId）は
// Chrome / Edge にしか無く、それ以外では既定のスピーカーから鳴るため、
// 呼び出し元が案内を変えられるようにしている。
export async function playTestTone(speakerId) {
	const AC = window.AudioContext || window.webkitAudioContext;
	if (!AC) return false;
	const ac = new AC();
	let routed = !speakerId;   // 指定が無いなら既定で鳴るのが正しい
	if (speakerId && ac.setSinkId) {
		try { await ac.setSinkId(speakerId); routed = true; } catch { routed = false; }
	}
	if (ac.state === "suspended") { try { await ac.resume(); } catch { } }
	const t0 = ac.currentTime + 0.02;
	beep(ac, 880.00, t0);            // A5
	beep(ac, 1174.66, t0 + 0.22);    // D6
	setTimeout(() => { try { ac.close(); } catch { } }, 1500);
	return routed;
}

// 1音。立ち上がりと減衰に傾斜をつけて、耳に刺さらないようにする。
// 音の作り方は office/alarm.js の tone() と同じ考え方。
function beep(ac, hz, at) {
	const g = ac.createGain();
	g.gain.setValueAtTime(0.0001, at);
	g.gain.linearRampToValueAtTime(0.2, at + 0.02);
	g.gain.exponentialRampToValueAtTime(0.0001, at + 0.30);
	g.connect(ac.destination);
	const osc = ac.createOscillator();
	osc.type = "sine";
	osc.frequency.value = hz;
	osc.connect(g);
	osc.start(at);
	osc.stop(at + 0.34);
}
