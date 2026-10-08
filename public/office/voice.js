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
import { openMic, micIdOf, startLevelMeter, startTalkDetector, getSilentTrack } from "../devices.js";
import { KEY, write } from "../storage.js";

// エリア外での会話範囲。panel.js と src/config.js にも同じ値がある（変えるときは3か所）。
const NEAR = GRID * 2;

// マイクを閉じるまでの猶予。
// Bluetooth はマイクの開閉のたびにプロファイルが切り替わり、1〜2秒ほど双方向で
// 音が途切れる（相手の声も聞こえなくなる）。会話中は切り替えたくないので、
// 近くに人がいるときは長く待つ。
const MIC_RELEASE_ALONE_MS = 3_000;    // 近くに誰もいない＝会話していない
const MIC_RELEASE_NEAR_MS = 30_000;    // 近くに人がいる＝また話す可能性が高い

// ── サーバーとのつなぎ直し ──
// 部屋（サーバー）は数時間おきに作り直され、そのたびに WebSocket が切れる。音声と画面共有は
// Cloudflare Realtime と直接つながっているので、ここで畳まなければ流れ続ける。
// つなぎ直したら hello に resumeInfo() を添え、サーバーに同じ接続を引き継がせる
// （src/room.js の checkResume）。引き継げなかったときだけ、これまでどおり張り直す。
//
// RESUME_MS … サーバーにつながらないまま、音声を保っておく時間。裏のタブはつなぎ直しに
//             最長1分ほどかかるので、それより長くする。過ぎたら畳む。
// GONE_GRACE_MS … 部屋が作り直された直後に、まだ戻ってきていない相手の受信を切らずに待つ時間。
//             作り直しでは全員が一斉に消え、つなぎ直した順に戻ってくる。すぐ切ると、戻ってくるまで
//             声が途切れる。待つのは「自分もサーバーとの接続が切れてから GONE_GRACE_MS 以内」で、
//             かつ相手がオフィスにいないときだけ。共有を止めた・離れた・退出した、など
//             自分がつながったままの場面では、これまでどおりすぐ切る（止めた画面が残らないように）。
const RESUME_MS = 90_000;
const GONE_GRACE_MS = 90_000;
let dropTimer = null;         // サーバーにつながらないまま RESUME_MS が過ぎたら畳むタイマー
const tickets = new Map();    // 自分が作ったセッション ID -> 合札（引き継ぎで本人と示すためのもの）
let lostAt = 0;               // 自分のサーバーとの接続が最後に切れた時刻

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
let micTesting = false;       // 音声の設定でマイクを確認中か。その間はオフィスへ送らない（setMicTest）
let micFailed = false;        // マイクが使えないとき true（再試行を止める）
let micSender = null;         // 自分の声を送る口。トラックを差し替えるために持っておく
let mutedAt = 0;              // ミュートにした時刻。0 ならミュートしていない
let stopMeter = null;         // 音量メーターの停止関数。マイクを閉じるときに呼ぶ
// ── SFU（マイク送信＋受信） ──
let sfuPc = null;             // SFU用の RTCPeerConnection
let sfuSessionId = null;
let sfuPublished = false;     // マイクを送り始めたか（publish は一度だけ）
let micTrackName = null;      // 送っているマイクのトラック名（引き継ぎでサーバーに伝え直す）
const sfuSubs = new Map();    // "sessionId/trackName" -> { mid, kind, audioEl, videoEl }
const pendingClose = new Set();   // 閉じ損ねた受信口の mid。次の周期で閉じ直す
let voiceBusy = false;        // updateVoice の多重実行を防ぐ
let sfuBroken = false;        // 接続が壊れたことの記録。次の updateVoice が畳んで張り直す

// ── 画面共有（送信専用） ──
let screenStream = null;      // 自分の画面共有
let screenPc = null;          // 画面送信専用の RTCPeerConnection（購読用と分離）
let screenSessionId = null;   // 画面送信専用の SFU セッション
let screenTrackName = null;   // 送っている画面のトラック名
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

// ── エラーの記録 ──
// マイクまわりの失敗は利用者の環境（ブラウザ・許可の設定・デバイス）に左右され、
// 手元では再現しないことが多い。どの段階で何が起きたかをサーバーへ送って残す
// （src/room.js の onClientErr。/api/client-errors で直近の記録を見られる）。
let micStage = "";            // いま実行中の段階。"session" | "open" | "publish" | ""
const STAGE_LABEL = { session: "接続の準備", open: "マイクを開く", publish: "送信の開始" };
const reported = new Map();   // 同じ内容を続けて送らないための記録。キー -> 最後に送った時刻

async function reportVoiceError(where, err, stage = micStage) {
	try {
		const name = (err && err.name) || "Error";
		const message = String((err && err.message) || err || "").slice(0, 200);
		// 周期処理の失敗は400msごとに繰り返すことがあるので、同じ内容は1分に1回まで
		const key = `${where}|${stage}|${name}|${message}`;
		const now = Date.now();
		if (now - (reported.get(key) || 0) < 60_000) return;
		reported.set(key, now);
		// マイクの許可の状態（granted / prompt / denied）。「許可されていません」の切り分けに使う。
		// 対応していないブラウザでは unknown のまま。
		let perm = "unknown";
		try { perm = (await navigator.permissions.query({ name: "microphone" })).state; } catch { }
		const ws = store.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({
			t: "clienterr", where, stage, name, message, perm,
			savedMic: !!store.micId,            // 入室画面で特定のマイクを選んでいたか
			visible: !document.hidden,          // タブが前面にあったか
			ua: navigator.userAgent.slice(0, 200),
		}));
	} catch { }
}

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
	const token = store.myToken;
	try {
		await locked(voiceStep);
	} catch (e) {
		console.warn("[voice]", e);
		// サーバーとの接続が途中で入れ替わり、古い合言葉で断られただけ（403）なら、
		// 張り直さずに次の周期でやり直す。送信の開始（publish）の途中だけは送信口が半端に
		// 残るので、これまでどおり張り直す。
		const swapped = e && e.status === 403 && (!isConnected() || store.myToken !== token);
		if (swapped && micStage !== "publish") { micStage = ""; return; }
		reportVoiceError("cycle", e);
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
	// sfuPc が消えてしまうため。画面共有は別の接続なので巻き込まない。
	if (sfuBroken) { sfuBroken = false; await teardownNow(true); }
	if (!voiceAllowed()) { await teardownNow(); return; }   // 離席中は接続しない

	// セッションは必要になるまで作らない。
	// 作っただけで何も流さないセッションは、しばらくすると SFU 側で破棄される（以後は
	// 410 が返る）。入室時に作っておくと、ひとりで作業していた人が初めてミュートを
	// 解除したときに、その破棄済みのセッションへ送ろうとして失敗する。
	const targets = currentTargets();
	const wantMic = micOn && !micFailed;
	if (!sfuPc && !wantMic && !wantsAny(targets)) { await maybeReleaseMic(targets); return; }

	await ensureSession();
	// micOn のまま接続が張り直された場合はここで付け直す。
	if (wantMic) {
		try {
			await attachMic();
		} catch (e) {
			if (!isDeviceError(e)) throw e;
			// マイクが使えないときは送るのを諦め、ボタンも「マイク不可」にする。
			// 放っておくと400msごとに開こうとし続ける。相手の声を受け取るほうは続ける。
			console.warn("[voice] mic", e);
			reportVoiceError("auto", e);
			micFailed = true;
			micOn = false;
			applyMicGate();
			notice(micLostText(e));
		}
	}
	await maybeReleaseMic(targets);
	await updateSubscriptions(targets);
	await closePending();
}

// 相手の中に、受け取るべき音声か画面を出している人がいるか
function wantsAny(targets) {
	for (const id of targets) {
		const o = store.others.get(id);
		if (o && o.sfu && (o.sfu.audio || o.sfu.screen)) return true;
	}
	return false;
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
	if (!res.ok) {
		const err = new Error(`rtc ${method} ${path} -> ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return data;
}

// マイクを開いて送信口につなぐ。必ず locked の中から呼ぶ。
//
// 初回は送信口ごと作って全員へ知らせる（publishMic）。2回目以降は replaceTrack で
// 差し替えるだけなので、SFU との再ネゴは起きない。
async function attachMic() {
	mutedAt = 0;
	if (!localStream) {
		micStage = "open";
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
	if (!track || !sfuPc) { micStage = ""; return; }
	micStage = "publish";
	if (!sfuPublished) await publishMic(track);
	else if (micSender && micSender.track !== track) await micSender.replaceTrack(track);
	micStage = "";
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
	const on = micOn && voiceAllowed() && !micTesting;
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
	micStage = "session";
	const data = await rtcFetch("/rtc/sessions/new", "POST");
	sfuSessionId = data.sessionId;
	if (data.ticket) tickets.set(data.sessionId, data.ticket);
	sfuPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
	sfuPc.ontrack = onTrack;
	watchConnection(sfuPc);
	micStage = "";
}

// 自分の声を送り始める。初めてミュートを解除したときに一度だけ走る。
// 一度も喋らない人は publish しないので、その人ぶんの通信は誰にも発生しない。
async function publishMic(track) {
	const tr = sfuPc.addTransceiver(track, { direction: "sendonly" });
	micSender = tr.sender;
	const offer = await sfuPc.createOffer();
	await sfuPc.setLocalDescription(offer);
	const name = `mic-${store.myId}`;
	const answer = await rtcFetch(`/rtc/sessions/${sfuSessionId}/tracks/new`, "POST", {
		sessionDescription: { type: "offer", sdp: offer.sdp },
		tracks: [{ location: "local", mid: tr.mid, trackName: name }],
	});
	await sfuPc.setRemoteDescription(answer.sessionDescription);
	sfuPublished = true;
	micTrackName = name;
	store.ws.send(JSON.stringify({ t: "publish", sessionId: sfuSessionId, audio: name }));
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
		if (!sub.videoEl) sub.videoEl = addScreenTile(sub.name);   // 共有ごとに小さいタイルを用意
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
		if (o.sfu.audio) want.set(`${o.sfu.sessionId}/${o.sfu.audio}`, { sessionId: o.sfu.sessionId, trackName: o.sfu.audio, kind: "audio", owner: o.sfu.sessionId });
		if (allowScreen && o.sfu.screen) {
			const ssid = o.sfu.screenSessionId || o.sfu.sessionId;   // 画面は別セッション
			want.set(`${ssid}/${o.sfu.screen}`, { sessionId: ssid, trackName: o.sfu.screen, kind: "screen", name: o.name, owner: o.sfu.sessionId });
		}
	}
	for (const [key, t] of want) if (!sfuSubs.has(key)) await subscribe(key, t);
	// オフィスにいる人の音声用セッション。持ち主がここにいれば、相手は残っている
	const present = new Set();
	for (const o of store.others.values()) if (o.sfu) present.add(o.sfu.sessionId);
	const afterRestart = lostAt && Date.now() - lostAt < GONE_GRACE_MS;
	for (const [key, sub] of [...sfuSubs]) {
		if (want.has(key)) continue;
		if (afterRestart && !present.has(sub.owner)) continue;   // 作り直しのあと、まだ戻ってきていない（GONE_GRACE_MS）
		await unsubscribe(key);
	}
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
	const sub = { mid, kind: t.kind, name: t.name || "", owner: t.owner, audioEl: null, videoEl: null };
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
	if (sub.videoEl) { closeBigIfShowing(sub.videoEl.srcObject); removeTile(sub.videoEl); }
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

// ── サーバーとのつなぎ直し（net.js から呼ばれる） ──

// hello に添える、引き継いでほしい接続。何も張っていなければ null。
export function resumeInfo() {
	if (!sfuPc || !sfuSessionId || !tickets.has(sfuSessionId)) return null;
	const ids = [sfuSessionId];
	if (screenSessionId) ids.push(screenSessionId);
	return {
		sessions: ids.filter((id) => tickets.has(id)).map((id) => ({ id, ticket: tickets.get(id) })),
		sessionId: sfuSessionId,
		audio: sfuPublished ? micTrackName : undefined,
		screenSessionId: screenSessionId || undefined,
		screen: screenSessionId ? screenTrackName : undefined,
	};
}

// サーバーとの接続が切れた。音声はすぐには畳まず、RESUME_MS だけ待つ。
export function onServerLost() {
	lostAt = Date.now();
	clearTimeout(dropTimer);
	dropTimer = setTimeout(() => {
		dropTimer = null;
		if (!isConnected()) teardownSfu();
	}, RESUME_MS);
}

// サーバーにつながった（welcome を受け取った）。resumed は、音声の接続を引き継げたか。
export function onServerJoined(resumed) {
	clearTimeout(dropTimer);
	dropTimer = null;
	talkSent = false;   // サーバーは「話している」を覚えていないので、次に話したとき送り直す
	// 引き継げなかった（合札が通らなかった、など）。サーバーは古い接続を知らないので、
	// これまでどおり畳んで張り直す。何も張っていなかったなら何もしない。
	if (!resumed && (sfuPc || screenPc)) teardownSfu();
}

// 接続断・離席・転送量上限でSFUを畳む。
// 外（net.js）から呼ぶときは locked を通し、実行中の周期処理と重ならないようにする。
export function teardownSfu() {
	return locked(teardownNow);
}

// 畳む本体。locked の中から呼ぶ。何も張っていなくてもマイクだけは必ず閉じる
// （離席中にマイクが開いたまま残らないようにするため）。
//
// keepScreen = true は「音声側の接続が壊れたので張り直す」とき。画面共有は別の接続で
// 生きているので止めない（止めると、他人の声を受け取り損ねただけで共有が切れる）。
async function teardownNow(keepScreen = false) {
	const hadScreen = keepScreen ? false : stopScreenLocal();
	for (const sub of sfuSubs.values()) {
		if (sub.audioEl) sub.audioEl.remove();
		if (sub.videoEl) removeTile(sub.videoEl);
	}
	if (sfuSubs.size) closeBig();
	sfuSubs.clear();
	// セッションごと消えるので、閉じ損ねの持ち越しも無意味になる（mid は次で振り直し）
	pendingClose.clear();
	// 音声と画面のどちらかでも送っていたら取り下げを知らせる。
	// 画面だけ共有していた場合にも送らないと、他の人に止まった画面が残り続ける。
	if (sfuPublished || hadScreen) {
		const msg = keepScreen ? { t: "unpublish", kind: "audio" } : { t: "unpublish" };
		try { store.ws.send(JSON.stringify(msg)); } catch { }
	}
	sfuPublished = false;
	micTrackName = null;
	if (sfuPc) { try { sfuPc.close(); } catch { } sfuPc = null; }
	if (sfuSessionId) tickets.delete(sfuSessionId);
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
		// 画面共有の publish は音声側のセッションIDを一緒に送る。セッションは必要になるまで
		// 作らないので、まだ無ければここで用意する。
		await locked(async () => { if (voiceAllowed() && isConnected()) await ensureSession(); });
		if (gen !== screenGen || !canShare()) throw new Error("cancelled");
		// 画面送信は専用のセッション/PCで行う（購読用の sfuPc と分離＝SDP衝突を防ぐ）
		const data = await rtcFetch("/rtc/sessions/new", "POST");
		if (data.ticket) tickets.set(data.sessionId, data.ticket);
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
		screenStream = stream; screenPc = pc; screenSessionId = data.sessionId; screenTrackName = `screen-${store.myId}`;
		watchScreen(pc);
		// 音声トラック名は付けない。マイクを publish していない人が付けると、
		// 存在しない音声を全員が購読しようとし続ける（音声は publishMic が別に知らせる）。
		store.ws.send(JSON.stringify({ t: "publish", sessionId: sfuSessionId, screenSessionId, screen: screenTrackName }));
		track.onended = () => { if (screenStream === stream) stopScreen(); };   // ブラウザの「共有を停止」に追従
		// 自分の共有プレビューを自分の画面にも出す（共有できているか確認用）
		selfTile = addScreenTile("自分");
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
	if (selfTile) { closeBigIfShowing(selfTile.srcObject); removeTile(selfTile); selfTile = null; }
	if (screenStream) { for (const t of screenStream.getTracks()) t.stop(); screenStream = null; }
	if (screenPc) { try { screenPc.close(); } catch { } screenPc = null; }   // 専用PCごと閉じる
	if (screenSessionId) tickets.delete(screenSessionId);
	screenSessionId = null;
	screenTrackName = null;
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
function micErrorText(err, stage = "") {
	const name = (err && err.name) || "Error";
	// マイクを開く段階以外の失敗は、マイクの問題ではなく接続側の問題。
	// マイク向けの案内（許可してください等）を出すと、利用者が見当違いの対処をしてしまう。
	if (stage && stage !== "open") return `音声の接続に失敗しました（${STAGE_LABEL[stage] || stage}：${name}）。少し待ってから、もう一度お試しください。`;
	if (name === "NotAllowedError") return blockedText();
	if (name === "NotReadableError") return "マイクを他のアプリが使っています。Teams や Zoom を閉じてから、もう一度お試しください。";
	// 保存してあるマイクが無ければ既定のマイクで開き直している（devices.js の openMic）。
	// それでもこのエラーになるのは、使えるマイクが1つも見つからないとき。
	if (name === "NotFoundError" || name === "OverconstrainedError") return "マイクが見つかりません。ヘッドセットやイヤホンの接続を確認してから、もう一度マイクボタンを押してください。";
	return `マイクを使えませんでした（${name}）。もう一度お試しください。`;
}

// マイクがブロックされているときの案内。
// いちど「ブロック」にすると、ブラウザはもう許可を聞いてこない。ボタンを押し直しても
// 直らないので、設定を変える手順を具体的に書く。Mac は OS 側にも許可の設定があり、
// そこが切れていると同じエラーになるので、あわせて案内する。
function blockedText() {
	const mac = /Mac/i.test(navigator.userAgent);
	return "マイクがブロックされています。次の手順で許可してください。\n\n"
		+ "1. アドレスバーの左端にあるアイコン（サイト情報）を押す\n"
		+ "2. 「マイク」を「許可」にする\n"
		+ "3. ページを再読み込みする"
		+ (mac ? "\n\nそれでも使えない場合は、Mac の「システム設定」→「プライバシーとセキュリティ」→「マイク」で、このブラウザがオンになっているか確認してください。" : "");
}

// 自動の付け直しでマイクが使えなかったときに、画面上部へ出す短い案内。
// ボタンを押した結果ではないのでアラートは出さないが、黙って「マイク不可」にすると
// 本人が理由に気づけない（話しているつもりで、声が届いていない状態になる）。
function micLostText(err) {
	const name = (err && err.name) || "Error";
	if (name === "NotFoundError" || name === "OverconstrainedError") return "マイクが見つからなくなったため、ミュートにしました。ヘッドセットの接続を確認して、マイクボタンを押し直してください。";
	if (name === "NotAllowedError") return "マイクがブロックされているため、ミュートにしました。マイクボタンを押すと、許可の手順を表示します。";
	if (name === "NotReadableError") return "マイクをほかのアプリが使っているため、ミュートにしました。マイクボタンを押し直してください。";
	return `マイクを使えなくなったため、ミュートにしました（${name}）。マイクボタンを押し直してください。`;
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
	else if (micTesting) v = { on: false, icon: "🎤", label: "テスト中" };
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
function addScreenTile(name) {
	const host = document.getElementById("shares");
	// 映像の上に名前を重ねるための枠。複数人が同時に共有したとき、どれが誰の画面か分かるようにする。
	const wrap = document.createElement("div");
	wrap.className = "screen-wrap";
	const v = document.createElement("video");
	v.autoplay = true; v.playsInline = true; v.muted = true;
	v.className = "screen-tile";
	v.title = "クリックで拡大";
	v.addEventListener("click", () => enlargeBig(v.srcObject, name));
	const label = document.createElement("span");
	label.className = "screen-name";
	label.textContent = name || "";
	label.hidden = !name;
	wrap.append(v, label);
	host.appendChild(wrap);
	v._wrap = wrap;   // 片づけるときは枠ごと消す（removeTile）
	return v;
}
// タイルを片づける。addScreenTile が作った枠ごと消す。
function removeTile(v) {
	(v._wrap || v).remove();
}
// 拡大表示（中央の大きいオーバーレイ）。誰の画面かも一緒に出す。
function enlargeBig(stream, name) {
	const big = document.getElementById("share-big");
	const bv = big.querySelector("video");
	bv.srcObject = stream;
	const label = document.getElementById("share-big-name");
	if (label) { label.textContent = name ? `${name}の画面` : ""; label.hidden = !name; }
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
// ── 音声の設定（office/audio.js から呼ばれる） ──

// 使うマイクを切り替える。送信中なら、その場で新しいマイクに差し替える。
// いったん閉じて開き直すので、Bluetooth では1〜2秒ほど音が途切れることがある。
export async function changeMic(id) {
	store.micId = id || null;
	write(KEY.micId, id || "");
	micFailed = false;   // 選び直したので、もう一度試せるようにする
	try {
		await locked(async () => {
			if (!localStream) return;   // 開いていなければ、次に開くときに新しい指定が使われる
			await releaseMic();
			if (micOn && voiceAllowed() && sfuPc) await attachMic();
		});
	} catch (e) {
		console.warn("[voice] change mic", e);
		reportVoiceError("change", e);
		if (isDeviceError(e)) { micFailed = true; micOn = false; notice(micLostText(e)); }
		else sfuBroken = true;
	}
	applyMicGate();
	syncMicBtn();
}

// 相手の声を出すスピーカーを切り替える。いま再生中の音声にもすぐ反映する。
// 空文字は「既定のスピーカー」。出力先を選べないブラウザでは何も起きない。
export function changeSpeaker(id) {
	store.speakerId = id || null;
	write(KEY.speakerId, id || "");
	for (const sub of sfuSubs.values()) {
		if (sub.audioEl && sub.audioEl.setSinkId) sub.audioEl.setSinkId(id || "").catch(() => { });
	}
}

// マイクの確認中は、オフィスへの送信を止める。確認では録音した声をスピーカーから
// 再生するので、マイクが ON のままだとそれを拾って周りの人へ流してしまう。
export function setMicTest(on) {
	micTesting = !!on;
	applyMicGate();
	syncMicBtn();
}

// マイクの状態が外から変わったときに、「マイク不可」の表示を実態に合わせる。
//   ・デバイスが増減した（ヘッドセットをつなぎ直した等）→ 不可の印を外し、押し直せることを示す
//   ・ブラウザの許可が変わった → ブロック中は最初から「マイク不可」、許可されたら外す
// どちらも印を外すだけで、自動でマイクを ON にはしない（本人の操作なしに声を送らない）。
function watchMicAvailability() {
	const clear = () => { if (micFailed && !micOn) { micFailed = false; syncMicBtn(); } };
	try { navigator.mediaDevices.addEventListener("devicechange", clear); } catch { }
	try {
		navigator.permissions.query({ name: "microphone" }).then((st) => {
			const apply = () => {
				if (st.state === "denied") { if (!micOn) { micFailed = true; syncMicBtn(); } }
				else clear();
			};
			apply();
			st.onchange = apply;
		}).catch(() => { });   // 対応していないブラウザでは何もしない（押したときのエラーで分かる）
	} catch { }
}

export function initVoiceUI() {
	watchMicAvailability();
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
					// 壊れていると分かっている接続には送らない（周期処理を待たずにここで畳む）
					if (sfuBroken) { sfuBroken = false; await teardownNow(true); }
					try {
						await ensureSession();
						await attachMic();
					} catch (e) {
						if (isDeviceError(e)) throw e;   // マイク自体の問題は張り直しても直らない
						// SFU 側の失敗（破棄済みのセッションに送って 410 が返る、など）。
						// 利用者に押し直させず、張り直して1回だけやり直す。
						console.warn("[voice] unmute retry", e);
						reportVoiceError("unmute-retry", e);
						await teardownNow(true);
						if (!micOn || !voiceAllowed() || !isConnected()) return;
						await ensureSession();
						await attachMic();
					}
				});
			} catch (err) {
				console.warn("[voice] unmute", err);
				const stage = micStage;   // 記録と案内で同じ段階を使う（このあと書き換わるため控える）
				reportVoiceError("unmute", err, stage);
				micOn = false;
				applyMicGate();
				mutedAt = Date.now();   // 開いたまま失敗した場合に閉じられるようにする
				if (isDeviceError(err)) micFailed = true;
				else sfuBroken = true;   // 送信口が半端に残るので、次の周期で畳んで張り直す
				alert(micErrorText(err, stage));
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
	const screenBtn = document.getElementById("screen-btn");
	if (screenBtn) {
		screenBtn.addEventListener("click", () => { if (screenStarting) return; if (screenStream) stopScreen(); else startScreen(); });
	}
	const big = document.getElementById("share-big");
	if (big) big.addEventListener("click", closeBig);   // 拡大表示はクリックで閉じる
}
