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
// enabled = false ではデバイスが開いたままになり、Bluetooth が低音質のまま戻らない。
let localStream = null;       // 開いているマイク。null なら閉じている
let micOn = false;            // ミュートを解除しているか（ボタンの状態）
let micFailed = false;        // マイクが使えないとき true（再試行を止める）
let micSender = null;         // 自分の声を送る口。トラックを差し替えるために持っておく
let micReleaseTimer = null;   // ミュート後、マイクを閉じるまでの猶予
// ── SFU（マイク送信＋受信） ──
let sfuPc = null;             // SFU用の RTCPeerConnection
let sfuSessionId = null;
let sfuPublished = false;     // マイクを送り始めたか（publish は一度だけ）
const sfuSubs = new Map();    // "sessionId/trackName" -> { mid, kind, audioEl, videoEl }
let voiceBusy = false;        // updateVoice の多重実行を防ぐ
let sfuBroken = false;        // 接続が壊れたことの記録。次の updateVoice が畳んで張り直す

// ── 画面共有（送信専用） ──
let screenStream = null;      // 自分の画面共有
let screenPc = null;          // 画面送信専用の RTCPeerConnection（購読用と分離）
let screenSessionId = null;   // 画面送信専用の SFU セッション
let selfTile = null;          // 自分の共有プレビュー（自分の画面にも小さく表示）

// ── メイン更新 ──
// main.js から400msごとに呼ばれ、「今つながっているべき相手」と実際の購読の差を埋める。
//
// voiceBusy が多重実行ガード。await を挟むので、前回が終わる前に次が入ると
// SFU とのやりとりが交錯する。main.js が重複呼び出しを気にしなくていいのはこれのおかげ。
export async function updateVoice() {
	if (voiceBusy || micFailed) return;
	if (!store.myId || !store.ws || store.ws.readyState !== WebSocket.OPEN) return;  // 接続待ち
	voiceBusy = true;
	try {
		// 接続が壊れていたら、まず畳む。この下の ensureSession が最初から張り直す。
		// 畳むのをここでやるのは、通知が来た瞬間に畳むと、実行中の購読処理の足元で
		// sfuPc が消えてしまうため。
		if (sfuBroken) { sfuBroken = false; await teardownSfu(); }
		if (store.me.away || store.budgetLevel === "voice_off") { await teardownSfu(); return; }   // 離席中は接続しない
		await ensureSession();
		if (micOn) await attachMic();   // micOn のまま接続が張り直された場合はここで付け直す
		await updateSubscriptions(currentTargets());
	} catch (e) {
		console.warn("[voice]", e);
		// マイクを拒否されたら二度と試さない。放っておくと400msごとに許可を求め続ける。
		if (e && e.name === "NotAllowedError") {
			micFailed = true;
			setToolBtn("mic-btn", { on: false, icon: "🚫", label: "マイク不可" });
		}
	} finally {
		voiceBusy = false;
	}
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

// マイクを開いて送信口につなぐ。ミュートを解除したときだけ呼ぶ。
//
// 初回は送信口ごと作って全員へ知らせる（publishMic）。2回目以降は replaceTrack で
// 差し替えるだけなので、SFU との再ネゴは起きない。
async function attachMic() {
	clearTimeout(micReleaseTimer);
	micReleaseTimer = null;
	if (!localStream) {
		const micId = store.micId;
		localStream = await navigator.mediaDevices.getUserMedia({
			audio: micId ? { deviceId: { exact: micId } } : true,
		});
	}
	const track = localStream.getAudioTracks()[0];
	if (!track) return;
	if (!sfuPublished) await publishMic(track);
	else if (micSender) await micSender.replaceTrack(track);
}

// マイクを本当に閉じる。Bluetooth はここで高音質モードへ戻る。
async function releaseMic() {
	clearTimeout(micReleaseTimer);
	micReleaseTimer = null;
	if (!localStream) return;
	if (micSender) { try { await micSender.replaceTrack(null); } catch { } }
	for (const t of localStream.getAudioTracks()) t.stop();
	localStream = null;
}

// ミュートされたら猶予つきで閉じる。猶予の途中で解除されれば attachMic が取り消す。
function scheduleMicRelease() {
	clearTimeout(micReleaseTimer);
	const ms = currentTargets().size === 0 ? MIC_RELEASE_ALONE_MS : MIC_RELEASE_NEAR_MS;
	micReleaseTimer = setTimeout(releaseMic, ms);
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
		const st = pc.connectionState;
		if (st === "failed") { sfuBroken = true; return; }
		// disconnected は一時的に出ることがあるので、続いていたときだけ壊れたとみなす
		if (st === "disconnected") setTimeout(() => {
			if (pc === sfuPc && pc.connectionState === "disconnected") sfuBroken = true;
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
		// 入室画面で選んだスピーカーへ出す（対応していないブラウザでは無視される）
		if (store.speakerId && sub.audioEl.setSinkId) sub.audioEl.setSinkId(store.speakerId).catch(() => { });
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
	// force:true で即時クローズ。クライアント側の再ネゴを挟まないので接続状態が崩れず、
	// 離れて再度近づいたときの再購読が確実に成功する。
	try {
		await rtcFetch(`/rtc/sessions/${sfuSessionId}/tracks/close`, "PUT", {
			tracks: [{ mid: sub.mid }],
			force: true,
		});
	} catch { }
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
// localStream（マイク）はあえて止めない。止めると再開のたびに
// ブラウザの許可ダイアログが出て、離席のたびに煩わしくなる。
export async function teardownSfu() {
	if (!sfuPc && !sfuPublished) return;
	if (selfTile) { selfTile.remove(); selfTile = null; }
	if (screenStream) { for (const t of screenStream.getTracks()) t.stop(); screenStream = null; }
	if (screenPc) { try { screenPc.close(); } catch { } screenPc = null; }
	screenSessionId = null;
	setScreenBtn(false);
	for (const sub of sfuSubs.values()) {
		if (sub.audioEl) sub.audioEl.remove();
		if (sub.videoEl) sub.videoEl.remove();
	}
	closeBig();
	sfuSubs.clear();
	if (sfuPublished) { try { store.ws.send(JSON.stringify({ t: "unpublish" })); } catch { } sfuPublished = false; }
	if (sfuPc) { try { sfuPc.close(); } catch { } sfuPc = null; }
	sfuSessionId = null;
	// 離席・転送量の上限・接続の張り直しでここへ来る。いずれもマイクは即座に閉じる。
	micSender = null;
	await releaseMic();
}

// ── 画面共有（エリア内外どこでも・SFU） ──
async function startScreen() {
	if (store.me.away) { alert("離席中は画面共有できません"); return; }
	// 画面共有の publish は音声のセッションIDを一緒に送るので、それが無いと成立しない
	if (!sfuSessionId) { alert("音声の準備中です。少し待ってから再度お試しください。"); return; }
	if (store.budgetLevel !== "ok") { alert("転送量の上限に近づいているため、画面共有は停止中です"); return; }
	if (!store.myId) return;
	// 画面選択のダイアログはユーザー操作の直後にしか出せないので、
	// await を挟む前に呼ぶ（先に SFU を用意すると出せなくなる）
	let stream;
	try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false }); } catch { return; }
	try {
		// 画面送信は専用のセッション/PCで行う（購読用の sfuPc と分離＝SDP衝突を防ぐ）
		const data = await rtcFetch("/rtc/sessions/new", "POST");
		screenSessionId = data.sessionId;
		screenPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
		screenStream = stream;
		const track = screenStream.getVideoTracks()[0];
		const tr = screenPc.addTransceiver(track, { direction: "sendonly" });
		const offer = await screenPc.createOffer();
		await screenPc.setLocalDescription(offer);
		const answer = await rtcFetch(`/rtc/sessions/${screenSessionId}/tracks/new`, "POST", {
			sessionDescription: { type: "offer", sdp: offer.sdp },
			tracks: [{ location: "local", mid: tr.mid, trackName: `screen-${store.myId}` }],
		});
		await screenPc.setRemoteDescription(answer.sessionDescription);
		store.ws.send(JSON.stringify({ t: "publish", sessionId: sfuSessionId, audio: `mic-${store.myId}`, screenSessionId, screen: `screen-${store.myId}` }));
		track.onended = () => stopScreen();   // ブラウザの「共有を停止」に追従
		// 自分の共有プレビューを自分の画面にも出す（共有できているか確認用）
		selfTile = addScreenTile();
		selfTile.classList.add("self");
		selfTile.title = "自分の共有（クリックで拡大）";
		selfTile.srcObject = screenStream;
		selfTile.play?.().catch(() => { });
		setScreenBtn(true);
	} catch (e) {
		console.warn("[screen]", e);
		if (stream) for (const t of stream.getTracks()) t.stop();
		if (screenPc) { try { screenPc.close(); } catch { } }
		screenStream = null; screenPc = null; screenSessionId = null;
		setScreenBtn(false);
	}
}

async function stopScreen() {
	if (selfTile) { closeBigIfShowing(selfTile.srcObject); selfTile.remove(); selfTile = null; }
	if (screenStream) { for (const t of screenStream.getTracks()) t.stop(); screenStream = null; }
	if (screenPc) { try { screenPc.close(); } catch { } screenPc = null; }   // 専用PCごと閉じる
	screenSessionId = null;
	try { store.ws.send(JSON.stringify({ t: "unpublish", kind: "screen" })); } catch { }
	setScreenBtn(false);
}

function setMicBtn() {
	setToolBtn("mic-btn", { on: micOn, icon: micOn ? "🎤" : "🔇", label: micOn ? "ON" : "ミュート中" });
}

function setScreenBtn(active) {
	setToolBtn("screen-btn", { on: active, icon: "🖥️", label: active ? "共有中" : "画面共有" });
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
	if (store.budgetLevel !== "ok" && screenStream) stopScreen();

	const el = document.getElementById("banner");
	if (!el) return;
	if (store.budgetLevel === "ok") {
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
				setMicBtn();
				scheduleMicRelease();   // すぐには閉じない（猶予は近くに人がいるかで変わる）
				return;
			}
			// Bluetooth だと開くのに1〜2秒かかることがあるので、待っていることを見せる
			setToolBtn("mic-btn", { label: "準備中…" });
			try {
				await attachMic();
				micOn = true;
			} catch {
				micOn = false;
				alert("マイクを使えませんでした。ブラウザの許可を確認してください。");
			}
			setMicBtn();
		});
	}

	// ブラウザは操作前の自動再生を止めるので、最初の操作で受信音声を鳴らし始める。
	// alarm.js の initAlarm も同じ理由で同じことをしている。
	const resume = () => document.querySelectorAll("audio").forEach((a) => a.play?.().catch(() => { }));
	window.addEventListener("pointerdown", resume, { once: true });
	window.addEventListener("keydown", resume, { once: true });
	const screenBtn = document.getElementById("screen-btn");
	if (screenBtn) {
		screenBtn.addEventListener("click", () => { if (screenStream) stopScreen(); else startScreen(); });
	}
	const big = document.getElementById("share-big");
	if (big) big.addEventListener("click", closeBig);   // 拡大表示はクリックで閉じる
}
