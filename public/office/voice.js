// 音声と画面共有。相手と直接つながるのではなく、すべて SFU（Cloudflare Realtime）を経由する。
//
// 会話できる相手は位置で決まる。エリア内にいれば同じエリアの全員、
// エリア外なら半径 NEAR 以内の人。判定は currentTargets が一手に引き受ける。
//
// RTCPeerConnection を2本持っているのがこのファイルの肝。
//   sfuPc    … 自分のマイクを送り、相手の音声と画面を受け取る
//   screenPc … 自分の画面を送るためだけの専用
// 1本にまとめると、送信と受信の SDP のやりとりが重なったときに衝突する。
//
// 転送量が増えると、まず画面共有、次に音声の順に止まる（applyBudget）。
import { store, zoneIdAt } from "./store.js";
import { GRID } from "../map.js";
import { openMic, micIdOf, startLevelMeter, startTalkDetector, playTestTone, getSilentTrack } from "../devices.js";
import { KEY, write } from "../storage.js";

// エリア外での会話範囲。panel.js と src/config.js にも同じ値がある（変えるときは3か所）。
const NEAR = GRID * 2;

// マイクを閉じるまでの猶予。
// Bluetooth はマイクの開閉のたびにプロファイルが切り替わり、1〜2秒ほど双方向で
// 音が途切れる（相手の声も聞こえなくなる）。会話中は切り替えたくないので、
// 近くに人がいるときは長く待つ。
const MIC_RELEASE_ALONE_MS = 3_000;    // 近くに誰もいない＝会話していない
const MIC_RELEASE_NEAR_MS = 30_000;    // 近くに人がいる＝また話す可能性が高い

// ── マイク ──
// micOn は「利用者の意思」、localStream は「デバイスの実体」で、別物として扱う。
//
// ミュートは2段階。片方だけでは足りない。
//   1. track.enabled = false … 押した瞬間に送信が止まる（相手に届かなくなる）
//   2. track.stop()          … 猶予のあとデバイスを閉じる（Bluetooth が高音質に戻る）
// 1 だけではデバイスが開いたままで、Bluetooth が低音質のまま戻らない。
// 2 をすぐ行うと、開け直すたびにプロファイルの切り替えが起きて話し出しが欠ける。
let localStream = null;       // 開いているマイク。null なら閉じている
let micOn = false;            // ミュートを解除しているか（ボタンの状態）
let micFailed = false;        // マイクが使えないとき true（再試行を止める）
let micSender = null;         // 自分の声を送る口。トラックを差し替えるために持っておく
let mutedAt = 0;              // ミュートにした時刻。0 ならミュートしていない
let stopMeter = null;         // 音量メーターの停止関数。マイクを閉じるときに呼ぶ
// ── SFU（マイク送信＋受信） ──
let sfuPc = null;             // SFU用の RTCPeerConnection
let sfuSessionId = null;
let sfuPublished = false;     // マイクを送り始めたか（publish は一度だけ）
const sfuSubs = new Map();    // "sessionId/trackName" -> { mid, kind, audioEl, videoEl }
const pendingClose = new Set();   // 閉じ損ねた受信口の mid。次の周期で閉じ直す
let voiceBusy = false;        // updateVoice の多重実行を防ぐ
let sfuBroken = false;        // 接続が壊れたことの記録。次の updateVoice が畳んで張り直す

// ── 画面共有（送信専用） ──
let screenStream = null;      // 自分の画面共有
let screenPc = null;          // 画面送信専用の RTCPeerConnection（購読用と分離）
let screenSessionId = null;   // 画面送信専用の SFU セッション
let selfTile = null;          // 自分の共有プレビュー（自分の画面にも小さく表示）
let screenStarting = false;   // 画面共有の開始処理中か（二重開始を防ぎ、ボタンに「準備中」を出す）
let screenGen = 0;            // 画面共有の世代。止めるたびに進め、開始処理の途中で止められたことを検知する

// ── 直列化 ──
// SFU 用の接続（sfuPc）に触る処理は必ずここを通して1つずつ実行する。
// 周期処理（updateVoice）とボタン操作（ミュート解除）が同じ接続の上で同時に
// SDP をやりとりすると衝突するため。
let voiceChain = Promise.resolve();
function locked(fn) {
	const p = voiceChain.then(fn);
	voiceChain = p.catch(() => { });
	return p;
}

// ボタンに最後に出した内容。同じなら DOM を触らない。
let micBtnKey = "";

// ── 発話の表示（アバターの吹き出し） ──
// talkRaw は「マイクが声を拾っている」、talkSent は「全員に知らせてある状態」。
// 知らせるのは声が実際に流れているとき（micLive）だけ。ミュート中や接続中に
// 吹き出しが出ると、届いていない声が届いているように見えてしまう。
let stopTalk = null;          // 検出の停止関数。マイクを閉じるときに呼ぶ
let talkRaw = false;
let talkSent = false;
let screenBtnKey = "";
let noticeTimer = null;       // 一時的なお知らせ（バナー）を消すタイマー

// ── メイン更新 ──
// main.js から400msごとに呼ばれ、「今つながっているべき相手」と実際の購読の差を埋める。
//
// voiceBusy が多重実行ガード。await を挟むので、前回が終わる前に次が入ると
// SFU とのやりとりが交錯する。main.js が重複呼び出しを気にしなくていいのはこれのおかげ。
// 実際の処理は locked を通すので、ボタン操作（ミュート解除）とも重ならない。
export async function updateVoice() {
	// 離席したらマイクはミュートに戻す。着席しても自動では ON に戻さない
	// （席に戻った瞬間に、気づかないまま声が届くのを防ぐ）。
	if (store.me.away && micOn) { micOn = false; mutedAt = Date.now(); }
	applyMicGate();
	syncMicBtn();
	if (voiceBusy) return;
	if (!isConnected()) return;  // 接続待ち
	voiceBusy = true;
	try {
		await locked(voiceStep);
	} catch (e) {
		console.warn("[voice]", e);
		// publish や購読の途中で失敗すると、送信口や購読が半端に残る。
		// 次の周期で畳んで張り直させる（そのまま続けると二重に publish される）。
		sfuBroken = true;
	} finally {
		voiceBusy = false;
		applyMicGate();
		syncMicBtn();
	}
}

function isConnected() {
	return !!store.myId && !!store.ws && store.ws.readyState === WebSocket.OPEN;
}

// 音声を使ってよい状態か。離席中と、転送量の上限（voice_off）では使わない。
function voiceAllowed() {
	return !store.me.away && store.budgetLevel !== "voice_off";
}

// マイクそのものが原因の失敗か（許可されていない・見つからない・他のアプリが使用中など）。
// これらは接続を張り直しても直らないので、SFU 側の失敗とは分けて扱う。
function isDeviceError(e) {
	return !!e && ["NotAllowedError", "NotReadableError", "NotFoundError", "OverconstrainedError", "AbortError", "SecurityError"].includes(e.name);
}

async function voiceStep() {
	// 接続が壊れていたら、まず畳む。この下の ensureSession が最初から張り直す。
	// 畳むのをここでやるのは、通知が来た瞬間に畳むと、実行中の購読処理の足元で
	// sfuPc が消えてしまうため。
	if (sfuBroken) { sfuBroken = false; await teardownNow(); }
	if (!voiceAllowed()) { await teardownNow(); return; }   // 離席中は接続しない
	await ensureSession();
	// micOn のまま接続が張り直された場合はここで付け直す。
	if (micOn && !micFailed) {
		try {
			await attachMic();
		} catch (e) {
			if (!isDeviceError(e)) throw e;
			// マイクが使えないときは送るのを諦め、ボタンも「マイク不可」にする。
			// 放っておくと400msごとに開こうとし続ける。相手の声を受け取るほうは続ける。
			console.warn("[voice] mic", e);
			micFailed = true;
			micOn = false;
			applyMicGate();
		}
	}
	const targets = currentTargets();
	await maybeReleaseMic(targets);
	await updateSubscriptions(targets);
	await closePending();
}

// いま会話すべき相手（エリア内=同エリア / エリア外=近接）。
// この条件は src/room.js がチャットを配る条件と同じ式。声とチャットが同じ範囲に
// 届くようにするためだが、コードは別々に書かれているので片方だけ変えないこと。
function currentTargets() {
	const myZone = zoneIdAt(store.me.x, store.me.y);
	const ids = new Set();
	for (const [id, o] of store.others) {
		const last = o.buf[o.buf.length - 1];
		if (!last) continue;
		if (o.away) continue;   // 離席中の人とは接触しない
		const oz = zoneIdAt(last.x, last.y);
		if (myZone) {
			if (oz === myZone) ids.add(id);
		} else if (oz === null && Math.hypot(last.x - store.me.x, last.y - store.me.y) <= NEAR) {
			ids.add(id);
		}
	}
	return ids;
}

// ── SFU 通信 ──
// SFU の API を叩く共通処理。x-office-token が無いと、他人になりすまして
// SFU のセッションを操作できてしまうので必ず付ける。
async function rtcFetch(path, method, body) {
	const res = await fetch(path, {
		method,
		headers: { "Content-Type": "application/json", "x-office-token": store.myToken },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();   // エラーでも本文を読み切って接続を解放する
	let data = null;
	try { data = text ? JSON.parse(text) : null; } catch { }
	if (!res.ok) throw new Error(`rtc ${method} ${path} -> ${res.status}`);
	return data;
}

// マイクを開いて送信口につなぐ。必ず locked の中から呼ぶ。
//
// 初回は送信口ごと作って全員へ知らせる（publishMic）。2回目以降は replaceTrack で
// 差し替えるだけなので、SFU との再ネゴは起きない。
async function attachMic() {
	mutedAt = 0;
	if (!localStream) {
		const stream = await openMic(store.micId);
		localStream = stream;
		// 代替のマイクで開けた場合は選択を書き直す。
		// そのままだと、次にミュートを解除したときも同じ exact で失敗し続ける。
		const got = micIdOf(stream);
		if (got && got !== store.micId) { store.micId = got; write(KEY.micId, got); }
		// マイクが抜かれた・Bluetooth が切れたとき。閉じた扱いにして、次の周期で開き直す。
		// 放っておくと、ボタンは ON のまま何も送られない状態になる。
		const t0 = stream.getAudioTracks()[0];
		if (t0) t0.onended = () => {
			if (localStream !== stream) return;
			if (stopMeter) { stopMeter(); stopMeter = null; }
			if (stopTalk) { stopTalk(); stopTalk = null; }
			setMeter(null);
			localStream = null;
			syncMicBtn();
		};
		startMeter();
		if (stopTalk) stopTalk();
		stopTalk = startTalkDetector(stream, (on) => { talkRaw = on; syncTalk(); });
	}
	// マイクを開いている間（1〜2秒かかることがある）にミュートされていたら、
	// ここで送信を止めたままにする。無条件に有効化すると「ボタンはミュートなのに
	// 声が届く」状態になる。
	applyMicGate();
	const track = localStream.getAudioTracks()[0];
	if (!track || !sfuPc) return;
	if (!sfuPublished) await publishMic(track);
	else if (micSender && micSender.track !== track) await micSender.replaceTrack(track);
	applyMicGate();
}

// 送信してよいかを、ボタンの状態（micOn）と離席・転送量の状態から決めてトラックへ反映する。
// デバイスの開閉とは別物。enabled = false はデバイスを閉じないので、Bluetooth の
// 切り替えを起こさずに相手へ一切届かなくできる。
//
// 「ボタンがミュートなら必ず送らない」をここ1か所で保証する。micOn や離席の状態を
// 変えたあと、および await のあとには必ず呼ぶこと。
function applyMicGate() {
	if (!localStream) return;
	const on = micOn && voiceAllowed();
	for (const t of localStream.getAudioTracks()) t.enabled = on;
}

// 自分の声が実際に SFU へ流れているか。ボタンの「ON」はこれが true のときだけ出す。
function micLive() {
	if (!micOn || !localStream || !sfuPc || !sfuPublished || !micSender) return false;
	const t = localStream.getAudioTracks()[0];
	if (!t || t.readyState !== "live" || !t.enabled || micSender.track !== t) return false;
	const st = sfuPc.connectionState;   // 未対応のブラウザでは undefined
	return st === undefined || st === "connected";
}

// マイクを本当に閉じる。Bluetooth はここで高音質モードへ戻る。
async function releaseMic() {
	mutedAt = 0;
	if (!localStream) return;
	if (stopMeter) { stopMeter(); stopMeter = null; }
	if (stopTalk) { stopTalk(); stopTalk = null; }
	setMeter(null);
	// null ではなく無音に差し替える。null にすると送信そのものが止まり、
	// SFU が相手への転送をやめてしまう（devices.js の getSilentTrack に経緯）。
	if (micSender) {
		const silent = getSilentTrack();
		try { await micSender.replaceTrack(silent); } catch { }
	}
	for (const t of localStream.getAudioTracks()) t.stop();
	localStream = null;
}

// ミュートが続いていればマイクを閉じる。updateVoice から毎回呼ばれる。
//
// 猶予はそのつど計算し直す。ミュートした時点の状況で決め打ちにすると、
// 相手が離れて誰もいなくなったあとも、長いほうの猶予を待ち続けてしまう。
// 逆に、誰もいないときにミュートしてから人が近づいてきた場合は、長いほうへ切り替わる。
async function maybeReleaseMic(targets) {
	if (micOn || !localStream) return;
	// ミュート解除に失敗すると、マイクは開いたのに mutedAt が 0 のまま残る。
	// そのままでは永久に閉じられないので、ここで押し直す。
	if (!mutedAt) mutedAt = Date.now();
	const ms = targets.size === 0 ? MIC_RELEASE_ALONE_MS : MIC_RELEASE_NEAR_MS;
	if (Date.now() - mutedAt >= ms) await releaseMic();
}

// 自分のマイクをSFUへ publish（一度だけ）
// SFU のセッションと接続だけ用意する。マイクは開かない。
// 相手の声を受け取るのに必要なのはここまでで、自分の声を送るのは別（publishMic）。
async function ensureSession() {
	if (sfuPc) return;
	const data = await rtcFetch("/rtc/sessions/new", "POST");
	sfuSessionId = data.sessionId;
	sfuPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
	sfuPc.ontrack = onTrack;
	watchConnection(sfuPc);
}

// 自分の声を送り始める。初めてミュートを解除したときに一度だけ走る。
// 一度も喋らない人は publish しないので、その人ぶんの通信は誰にも発生しない。
async function publishMic(track) {
	const tr = sfuPc.addTransceiver(track, { direction: "sendonly" });
	micSender = tr.sender;
	const offer = await sfuPc.createOffer();
	await sfuPc.setLocalDescription(offer);
	const answer = await rtcFetch(`/rtc/sessions/${sfuSessionId}/tracks/new`, "POST", {
		sessionDescription: { type: "offer", sdp: offer.sdp },
		tracks: [{ location: "local", mid: tr.mid, trackName: `mic-${store.myId}` }],
	});
	await sfuPc.setRemoteDescription(answer.sessionDescription);
	sfuPublished = true;
	store.ws.send(JSON.stringify({ t: "publish", sessionId: sfuSessionId, audio: `mic-${store.myId}` }));
}

// 接続が壊れたことを記録する。実際に畳むのは updateVoice。
//
// これが無いと、Wi-Fi の切り替えやスリープ復帰で PeerConnection が死んでも
// sfuPublished と sfuSubs が残ったままになり、声を送り直すことも
// 受け直すこともないまま無音になる（退出して入り直すまで直らない）。
//
// pc を引数で受け取るのは、畳んだあと新しい PeerConnection に差し替わるため。
// 古いほうから遅れて届いた通知で、新しい接続を巻き添えにしない。
function watchConnection(pc) {
	pc.onconnectionstatechange = () => {
		if (pc !== sfuPc) return;   // すでに差し替わっている
		syncMicBtn();               // つながった／切れたをすぐボタンに出す
		const st = pc.connectionState;
		if (st === "failed") { sfuBroken = true; return; }
		// disconnected は一時的に出ることがあるので、続いていたときだけ壊れたとみなす
		if (st === "disconnected") setTimeout(() => {
			if (pc === sfuPc && pc.connectionState === "disconnected") sfuBroken = true;
		}, 5000);
	};
}

// 画面共有用の接続の監視。壊れたら共有を止めてボタンを戻す。
// これが無いと、ネットワークが切り替わったあとも「共有中」のまま映像が止まる。
function watchScreen(pc) {
	const fail = () => {
		if (pc !== screenPc) return;
		stopScreen();
		notice("接続が切れたため、画面共有を停止しました。もう一度共有するにはボタンを押してください。");
	};
	pc.onconnectionstatechange = () => {
		if (pc !== screenPc) return;
		const st = pc.connectionState;
		if (st === "failed") { fail(); return; }
		if (st === "disconnected") setTimeout(() => {
			if (pc === screenPc && pc.connectionState === "disconnected") fail();
		}, 5000);
	};
}

// 受信トラックの再生（音声＝audio要素／画面＝オーバーレイ）。
//
// 再生の経路は2本ある。
//   subscribe の直後   … attachSub（購読した時点で既に届いているトラック）
//   後から届いたとき   … この ontrack
// 片方だけでは、同時に複数の共有が始まったときに取りこぼす。
function onTrack(ev) {
	const mid = ev.transceiver && ev.transceiver.mid;
	for (const sub of sfuSubs.values()) {
		if (sub.mid !== mid) continue;
		attachStream(sub, ev.streams[0] || new MediaStream([ev.track]));
		return;
	}
}

// sub に stream を結びつけて再生する。画面は小さいタイルへ、音声は audio 要素へ。
// 要素は最初の1回だけ作り、以後は srcObject の差し替えで使い回す。
function attachStream(sub, stream) {
	if (sub.kind === "screen") {
		if (!sub.videoEl) sub.videoEl = addScreenTile();   // 共有ごとに小さいタイルを用意
		sub.videoEl.srcObject = stream;
		sub.videoEl.play?.().catch(() => { });
		return;
	}
	if (!sub.audioEl) {
		sub.audioEl = document.createElement("audio");
		sub.audioEl.autoplay = true;
		document.body.appendChild(sub.audioEl);
		// 入室画面で選んだスピーカーへ出す（対応していないブラウザでは無視される）。
		// 失敗したら選択を捨てる。deviceId はマイクと同じく古くなるので、抱え続けると
		// 以後ずっと黙って既定のスピーカーへ落ちたままになる。
		if (store.speakerId && sub.audioEl.setSinkId) {
			sub.audioEl.setSinkId(store.speakerId).catch(() => {
				store.speakerId = null;
				write(KEY.speakerId, "");
			});
		}
	}
	sub.audioEl.srcObject = stream;
	sub.audioEl.play?.().catch(() => { });
}

// 相手のトラックを購読／解除（対象と現状の差分）
async function updateSubscriptions(targetIds) {
	const want = new Map();
	const allowScreen = store.budgetLevel === "ok";
	for (const id of targetIds) {
		const o = store.others.get(id);
		if (!o || !o.sfu) continue;
		if (o.sfu.audio) want.set(`${o.sfu.sessionId}/${o.sfu.audio}`, { sessionId: o.sfu.sessionId, trackName: o.sfu.audio, kind: "audio" });
		if (allowScreen && o.sfu.screen) {
			const ssid = o.sfu.screenSessionId || o.sfu.sessionId;   // 画面は別セッション
			want.set(`${ssid}/${o.sfu.screen}`, { sessionId: ssid, trackName: o.sfu.screen, kind: "screen" });
		}
	}
	for (const [key, t] of want) if (!sfuSubs.has(key)) await subscribe(key, t);
	for (const key of [...sfuSubs.keys()]) if (!want.has(key)) await unsubscribe(key);
}

// 1人ぶんの受信を開始する。
//
// sfuSubs への登録は「最後まで成功したとき」だけにしている。途中で失敗したものを
// 登録してしまうと、updateSubscriptions が「購読済み」と判断して二度と張り直さず、
// その相手の声だけが永久に届かなくなる（退出するまで直らない）。
// 登録しなければ、次の周期（400ms後）に自動で再試行される。
async function subscribe(key, t) {
	const resp = await rtcFetch(`/rtc/sessions/${sfuSessionId}/tracks/new`, "POST", {
		tracks: [{ location: "remote", sessionId: t.sessionId, trackName: t.trackName }],
	});
	const mid = resp && resp.tracks && resp.tracks[0] && resp.tracks[0].mid;
	if (mid == null) return;   // 受信口が取れていない。登録せず次の周期へ譲る
	// SFU が「今すぐ再ネゴせよ」と言ってきたら応じる（新しい受信口が増えたとき）。
	// ここで失敗しても登録前なので、やはり次の周期で再試行される。
	if (resp.requiresImmediateRenegotiation) await renegotiate(resp.sessionDescription);
	const sub = { mid, kind: t.kind, audioEl: null, videoEl: null };
	sfuSubs.set(key, sub);
	attachSub(sub);   // mid から受信トラックを取り出して確実に表示/再生（複数共有でも取りこぼさない）
}

// mid に対応する受信トラックを取り出して結びつける（購読した時点で既に届いている分）
function attachSub(sub) {
	if (!sfuPc || sub.mid == null) return;
	const tr = sfuPc.getTransceivers().find((x) => x.mid === sub.mid);
	const track = tr && tr.receiver && tr.receiver.track;
	if (!track) return;
	attachStream(sub, new MediaStream([track]));
}

async function unsubscribe(key) {
	const sub = sfuSubs.get(key);
	if (!sub) return;
	sfuSubs.delete(key);
	if (sub.audioEl) sub.audioEl.remove();
	if (sub.videoEl) { closeBigIfShowing(sub.videoEl.srcObject); sub.videoEl.remove(); }
	if (sub.mid != null) pendingClose.add(sub.mid);
	await closePending();
}

// 閉じ損ねた受信口をまとめて閉じる。失敗したぶんは次の周期へ持ち越す。
//
// 以前はここの失敗を握り潰していた。sfuSubs からは消えているので閉じ直す機会が
// 二度と来ず、SFU 側に死んだ受信口が溜まり続けていた（つけっぱなしで効いてくる）。
//
// force:true は即時クローズ。クライアント側の再ネゴを挟まないので接続状態が崩れず、
// 離れて再度近づいたときの再購読が確実に成功する。
async function closePending() {
	if (!pendingClose.size || !sfuSessionId) return;
	const mids = [...pendingClose];
	try {
		await rtcFetch(`/rtc/sessions/${sfuSessionId}/tracks/close`, "PUT", {
			tracks: mids.map((mid) => ({ mid })),
			force: true,
		});
		for (const mid of mids) pendingClose.delete(mid);
	} catch { }   // 消さずに残し、次の周期で試し直す
}

// SFU から再ネゴを求められたときの応答
async function renegotiate(remoteDesc) {
	await sfuPc.setRemoteDescription(remoteDesc);
	const answer = await sfuPc.createAnswer();
	await sfuPc.setLocalDescription(answer);
	await rtcFetch(`/rtc/sessions/${sfuSessionId}/renegotiate`, "PUT", {
		sessionDescription: { type: "answer", sdp: answer.sdp },
	});
}

// 接続断・離席・転送量上限でSFUを畳む。
// 外（net.js）から呼ぶときは locked を通し、実行中の周期処理と重ならないようにする。
export function teardownSfu() {
	return locked(teardownNow);
}

// 畳む本体。locked の中から呼ぶ。何も張っていなくてもマイクだけは必ず閉じる
// （離席中にマイクが開いたまま残らないようにするため）。
async function teardownNow() {
	const hadScreen = stopScreenLocal();
	for (const sub of sfuSubs.values()) {
		if (sub.audioEl) sub.audioEl.remove();
		if (sub.videoEl) sub.videoEl.remove();
	}
	if (sfuSubs.size) closeBig();
	sfuSubs.clear();
	// セッションごと消えるので、閉じ損ねの持ち越しも無意味になる（mid は次で振り直し）
	pendingClose.clear();
	// 音声と画面のどちらかでも送っていたら取り下げを知らせる。
	// 画面だけ共有していた場合にも送らないと、他の人に止まった画面が残り続ける。
	if (sfuPublished || hadScreen) { try { store.ws.send(JSON.stringify({ t: "unpublish" })); } catch { } }
	sfuPublished = false;
	if (sfuPc) { try { sfuPc.close(); } catch { } sfuPc = null; }
	sfuSessionId = null;
	// 離席・転送量の上限・接続の張り直しでここへ来る。いずれもマイクは即座に閉じる。
	micSender = null;
	await releaseMic();
	talkSent = false;   // 再接続後はサーバーが覚えていないので、次に話したとき送り直す
	syncMicBtn();
}

// ── 画面共有（エリア内外どこでも・SFU） ──

// いま画面共有してよい状態か
function canShare() {
	return !store.me.away && store.budgetLevel === "ok" && !!sfuSessionId && isConnected();
}

async function startScreen() {
	if (screenStarting || screenStream) return;   // 開始処理中の押し直しで二重に共有しない
	if (store.me.away) { alert("離席中は画面共有できません"); return; }
	// 画面共有の publish は音声のセッションIDを一緒に送るので、それが無いと成立しない
	if (!sfuSessionId) { alert("音声の準備中です。少し待ってから再度お試しください。"); return; }
	if (store.budgetLevel !== "ok") { alert("転送量の上限に近づいているため、画面共有は停止中です"); return; }
	if (!store.myId) return;

	// 開始処理の途中で止められた（離席・切断・転送量の上限）ことを検知するための世代。
	// 途中で進んでいたら、何も送らずに片づけて終わる。
	const gen = ++screenGen;
	screenStarting = true;
	syncScreenBtn();
	let stream = null, pc = null;
	try {
		// 画面選択のダイアログはユーザー操作の直後にしか出せないので、
		// await を挟む前に呼ぶ（先に SFU を用意すると出せなくなる）
		try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false }); } catch { return; }
		if (gen !== screenGen || !canShare()) throw new Error("cancelled");
		// 画面送信は専用のセッション/PCで行う（購読用の sfuPc と分離＝SDP衝突を防ぐ）
		const data = await rtcFetch("/rtc/sessions/new", "POST");
		pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
		const track = stream.getVideoTracks()[0];
		const tr = pc.addTransceiver(track, { direction: "sendonly" });
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		const answer = await rtcFetch(`/rtc/sessions/${data.sessionId}/tracks/new`, "POST", {
			sessionDescription: { type: "offer", sdp: offer.sdp },
			tracks: [{ location: "local", mid: tr.mid, trackName: `screen-${store.myId}` }],
		});
		await pc.setRemoteDescription(answer.sessionDescription);
		if (gen !== screenGen || !canShare()) throw new Error("cancelled");

		// ここから先は await を挟まない。状態の確定・全員への通知・ボタンの更新を一息に行う。
		screenStream = stream; screenPc = pc; screenSessionId = data.sessionId;
		watchScreen(pc);
		// 音声トラック名は付けない。マイクを publish していない人が付けると、
		// 存在しない音声を全員が購読しようとし続ける（音声は publishMic が別に知らせる）。
		store.ws.send(JSON.stringify({ t: "publish", sessionId: sfuSessionId, screenSessionId, screen: `screen-${store.myId}` }));
		track.onended = () => { if (screenStream === stream) stopScreen(); };   // ブラウザの「共有を停止」に追従
		// 自分の共有プレビューを自分の画面にも出す（共有できているか確認用）
		selfTile = addScreenTile();
		selfTile.classList.add("self");
		selfTile.title = "自分の共有（クリックで拡大）";
		selfTile.srcObject = screenStream;
		selfTile.play?.().catch(() => { });
	} catch (e) {
		if (!e || e.message !== "cancelled") console.warn("[screen]", e);
		if (screenStream === stream) {
			stopScreen();   // 確定後に失敗した場合は、通常の停止と同じ後始末をする
		} else {
			if (stream) for (const t of stream.getTracks()) t.stop();
			if (pc) { try { pc.close(); } catch { } }
		}
	} finally {
		screenStarting = false;
		syncScreenBtn();
	}
}

// 画面共有を手元で止める（サーバーへは知らせない）。止めたものがあれば true。
function stopScreenLocal() {
	screenGen++;   // 開始処理の途中なら、そちらに「止められた」と伝える
	const had = !!(screenStream || screenPc);
	if (selfTile) { closeBigIfShowing(selfTile.srcObject); selfTile.remove(); selfTile = null; }
	if (screenStream) { for (const t of screenStream.getTracks()) t.stop(); screenStream = null; }
	if (screenPc) { try { screenPc.close(); } catch { } screenPc = null; }   // 専用PCごと閉じる
	screenSessionId = null;
	syncScreenBtn();
	return had;
}

function stopScreen() {
	stopScreenLocal();
	try { store.ws.send(JSON.stringify({ t: "unpublish", kind: "screen" })); } catch { }
}

// 数秒で消えるお知らせ。転送量の警告が出ているあいだは、そちらを優先して出さない。
function notice(text) {
	const el = document.getElementById("banner");
	if (!el || store.budgetLevel !== "ok") return;
	el.textContent = text;
	el.style.display = "block";
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		noticeTimer = null;
		if (store.budgetLevel === "ok") { el.style.display = "none"; el.textContent = ""; }
	}, 8000);
}

// ── 音量メーター ──
// 送っている音声そのものを見せる。「声が届かない」と相談を受けたときに、
// マイクが拾えていないのか、送信側の問題なのかを本人が切り分けられる。
function startMeter() {
	if (stopMeter) stopMeter();
	stopMeter = startLevelMeter(localStream, setMeter);
}

// v が null なら非表示（ミュート中）。
function setMeter(v) {
	const el = document.getElementById("mic-level");
	if (!el) return;
	el.hidden = v === null;
	if (v !== null) el.firstElementChild.style.width = Math.round(v * 100) + "%";
}

// 失敗の理由ごとに、次にやることを書く。
// エラー名も併記する。報告を受けたときに原因を絞れるようにするため。
function micErrorText(err) {
	const name = (err && err.name) || "Error";
	if (name === "NotAllowedError") return "マイクの使用が許可されていません。アドレスバーの鍵アイコンからマイクを「許可」にしてください。";
	if (name === "NotReadableError") return "マイクを他のアプリが使っています。Teams や Zoom を閉じてから、もう一度お試しください。";
	if (name === "NotFoundError" || name === "OverconstrainedError") return "選んだマイクが見つかりません。一度退出して、入室画面でマイクを選び直してください。";
	return `マイクを使えませんでした（${name}）。もう一度お試しください。`;
}

// マイクボタンを実際の状態に合わせる。
//
// 「ON」と出すのは、声が本当に SFU へ流れているとき（micLive）だけ。
// 利用者は ON にしたつもりでも、接続中・離席中・停止中は別の表示にして、
// ボタンと実際の送信状況が食い違わないようにする。
function syncMicBtn() {
	syncTalk();   // マイクの状態が変わる場所は必ずここを通るので、吹き出しも一緒に合わせる
	let v;
	if (!micOn) v = micFailed ? { on: false, icon: "🚫", label: "マイク不可" } : { on: false, icon: "🔇", label: "ミュート中" };
	else if (micLive()) v = { on: true, icon: "🎤", label: "ON" };
	else if (store.me.away) v = { on: false, icon: "🔇", label: "離席中" };
	else if (store.budgetLevel === "voice_off") v = { on: false, icon: "🔇", label: "停止中" };
	else v = { on: false, icon: "⏳", label: "接続中…" };
	const key = `${v.on}|${v.icon}|${v.label}`;
	if (key === micBtnKey) return;
	micBtnKey = key;
	setToolBtn("mic-btn", v);
}

// 「話している」を全員へ知らせる。変わったときだけ送る。
function syncTalk() {
	if (!localStream) talkRaw = false;
	const on = talkRaw && micLive();
	store.me.talking = on;   // 自分の吹き出しは送信を待たずに出す
	if (on === talkSent) return;
	talkSent = on;
	const ws = store.ws;
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "talk", on }));
}

// 画面共有ボタンを実際の状態に合わせる。「共有中」は送信用の接続と映像が生きているときだけ。
function syncScreenBtn() {
	const t = screenStream && screenStream.getVideoTracks()[0];
	const live = !!(screenPc && t && t.readyState === "live");
	const v = screenStarting ? { on: false, label: "準備中…" } : { on: live, label: live ? "共有中" : "画面共有" };
	const key = `${v.on}|${v.label}`;
	if (key === screenBtnKey) return;
	screenBtnKey = key;
	setToolBtn("screen-btn", { on: v.on, icon: "🖥️", label: v.label });
}

// ツールバーのボタン状態を更新。office.html の .ic（アイコン）と .lb（ラベル）に対応。
function setToolBtn(id, { on, icon, label } = {}) {
	const b = document.getElementById(id);
	if (!b) return;
	if (icon !== undefined) b.querySelector(".ic").textContent = icon;
	if (label !== undefined) b.querySelector(".lb").textContent = label;
	if (on !== undefined) b.classList.toggle("on", on);
}
// 受信した画面共有ごとの小さいタイルを作る（クリックで拡大）
function addScreenTile() {
	const wrap = document.getElementById("shares");
	const v = document.createElement("video");
	v.autoplay = true; v.playsInline = true; v.muted = true;
	v.className = "screen-tile";
	v.title = "クリックで拡大";
	v.addEventListener("click", () => enlargeBig(v.srcObject));
	wrap.appendChild(v);
	return v;
}
// 拡大表示（中央の大きいオーバーレイ）
function enlargeBig(stream) {
	const big = document.getElementById("share-big");
	const bv = big.querySelector("video");
	bv.srcObject = stream;
	big.classList.add("on");
	bv.play?.().catch(() => { });
}
function closeBig() {
	const big = document.getElementById("share-big");
	if (!big) return;
	big.classList.remove("on");
	big.querySelector("video").srcObject = null;
}
// 拡大中のものが消えたら閉じる
function closeBigIfShowing(stream) {
	const big = document.getElementById("share-big");
	if (big && big.querySelector("video").srcObject === stream) closeBig();
}

// ── 転送量ガードの反映 ──
// レベルは2段階。screen_off で画面共有だけ止め、voice_off で音声も止める。
// 判断はサーバー側が行い、ここは受け取った結果を画面に反映するだけ。
export function applyBudget() {
	const b = document.getElementById("screen-btn");
	if (b) b.disabled = store.budgetLevel !== "ok";
	if (store.budgetLevel !== "ok" && (screenStream || screenStarting)) stopScreen();
	applyMicGate();   // voice_off になった瞬間に送信を止める（畳むのは次の updateVoice）
	syncMicBtn();

	const el = document.getElementById("banner");
	if (!el) return;
	if (store.budgetLevel === "ok") {
		if (noticeTimer) return;   // 一時的なお知らせを表示中なら消さない
		el.style.display = "none";
		el.textContent = "";
	} else {
		el.style.display = "block";
		el.textContent = store.budgetLevel === "screen_off"
			? "転送量が上限に近づいたため、画面共有を停止しました（音声は利用できます）。"
			: "転送量が上限に達したため、音声・画面共有を停止しました（マップは利用できます）。";
	}
}

// ── ボタンの初期化 ──
export function initVoiceUI() {
	const micBtn = document.getElementById("mic-btn");
	if (micBtn) {
		micBtn.addEventListener("click", async () => {
			if (micOn) {
				micOn = false;
				// 送信はこの場で止める。デバイスを閉じるまで待つと、その間ずっと
				// 相手に声が届いてしまう（近くに人がいると猶予は30秒）。
				applyMicGate();
				mutedAt = Date.now();   // デバイスを閉じるのは updateVoice（猶予を毎回見直す）
				syncMicBtn();
				return;
			}
			if (store.me.away) { alert("離席中はマイクを使えません。着席してからお試しください。"); return; }
			if (store.budgetLevel === "voice_off") { alert("転送量の上限に達したため、音声は停止中です。"); return; }
			// 先に意思（micOn）だけ立てる。ボタンは実際に流れ始めるまで「接続中…」になる。
			// Bluetooth だと開くのに1〜2秒かかることがある。
			micFailed = false;   // 手で押し直したときは、もう一度試す
			micOn = true;
			syncMicBtn();
			try {
				await locked(async () => {
					// 待っているあいだにミュートへ戻された・離席した場合は何もしない。
					// サーバーとまだつながっていない場合も、ここでは開かない
					// （つながり次第 updateVoice が micOn を見て付ける）。
					if (!micOn || !voiceAllowed() || !isConnected()) return;
					await ensureSession();
					await attachMic();
				});
			} catch (err) {
				console.warn("[voice] unmute", err);
				micOn = false;
				applyMicGate();
				mutedAt = Date.now();   // 開いたまま失敗した場合に閉じられるようにする
				if (isDeviceError(err)) micFailed = true;
				else sfuBroken = true;   // 送信口が半端に残るので、次の周期で畳んで張り直す
				alert(micErrorText(err));
			}
			applyMicGate();
			syncMicBtn();
		});
	}

	// ブラウザは操作前の自動再生を止めるので、最初の操作で受信音声を鳴らし始める。
	// alarm.js の initAlarm も同じ理由で同じことをしている。
	const resume = () => document.querySelectorAll("audio").forEach((a) => a.play?.().catch(() => { }));
	window.addEventListener("pointerdown", resume, { once: true });
	window.addEventListener("keydown", resume, { once: true });
	// スピーカーの確認音。マイク側の処理には触らないので、会話中に押しても
	// 接続には影響しない。「相手の声が聞こえない」ときの切り分けに使う。
	const spkBtn = document.getElementById("spk-test-btn");
	if (spkBtn) {
		spkBtn.addEventListener("click", async () => {
			spkBtn.disabled = true;
			const routed = await playTestTone(store.speakerId);
			spkBtn.textContent = routed ? "🔊 鳴らしました" : "🔊 既定のスピーカーで鳴らしました";
			setTimeout(() => {
				spkBtn.disabled = false;
				spkBtn.textContent = "🔊 スピーカーをテスト";
			}, 2500);
		});
	}

	const screenBtn = document.getElementById("screen-btn");
	if (screenBtn) {
		screenBtn.addEventListener("click", () => { if (screenStarting) return; if (screenStream) stopScreen(); else startScreen(); });
	}
	const big = document.getElementById("share-big");
	if (big) big.addEventListener("click", closeBig);   // 拡大表示はクリックで閉じる
}
