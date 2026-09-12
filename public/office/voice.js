// 音声と画面共有（すべてSFU）。エリア内は同エリア全員、エリア外は近接の人と会話。
// 転送量ガードのレベルに応じて画面共有→音声の順に停止する。
import { store, zoneIdAt } from "./store.js";
import { GRID } from "../map.js";

const NEAR = GRID * 2;        // エリア外での会話範囲（半径2マス）

let localStream = null;       // 自分のマイク
let micOn = false;            // 送話ON/OFF
let voiceReady = true;        // 入室時に会話モードへ自動参加（ミュートで publish）
let micFailed = false;        // マイクが使えないとき true（再試行を止める）
let sfuPc = null;             // SFU用の RTCPeerConnection
let sfuSessionId = null;
let sfuPublished = false;
const sfuSubs = new Map();    // "sessionId/trackName" -> { mid, kind, audioEl }
let voiceBusy = false;        // updateVoice の多重実行を防ぐ
let screenStream = null;      // 自分の画面共有
let screenPc = null;          // 画面送信専用の RTCPeerConnection（購読用と分離）
let screenSessionId = null;   // 画面送信専用の SFU セッション
let selfTile = null;          // 自分の共有プレビュー（自分の画面にも小さく表示）

// ── メイン更新（毎フレーム間引いて呼ばれる） ──
export async function updateVoice() {
	if (!voiceReady || voiceBusy || micFailed) return;
	if (!store.myId || !store.ws || store.ws.readyState !== WebSocket.OPEN) return;  // 接続待ち
	voiceBusy = true;
	try {
		if (store.me.away || store.budgetLevel === "voice_off") { await teardownSfu(); return; }   // 離席中は接続しない
		await ensureSfuAndPublish();
		await updateSubscriptions(currentTargets());
	} catch (e) {
		console.warn("[voice]", e);
		if (e && e.name === "NotAllowedError") {   // マイク拒否
			micFailed = true;
			setToolBtn("mic-btn", { on: false, icon: "🚫", label: "マイク不可" });
		}
	} finally {
		voiceBusy = false;
	}
}

// いま会話すべき相手（エリア内=同エリア / エリア外=近接）
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
async function rtcFetch(path, method, body) {
	const res = await fetch(path, {
		method,
		headers: { "Content-Type": "application/json", "x-office-token": store.myToken },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let data = null;
	try { data = text ? JSON.parse(text) : null; } catch { }
	if (!res.ok) throw new Error(`rtc ${method} ${path} -> ${res.status}`);
	return data;
}

async function ensureMic() {
	if (localStream) return localStream;
	const micId = store.micId;
	localStream = await navigator.mediaDevices.getUserMedia({
		audio: micId ? { deviceId: { exact: micId } } : true,
	});
	for (const t of localStream.getAudioTracks()) t.enabled = micOn;   // 起動時はミュート
	return localStream;
}

// 自分のマイクをSFUへ publish（一度だけ）
async function ensureSfuAndPublish() {
	if (sfuPublished) return;
	await ensureMic();
	if (!sfuPc) {
		const data = await rtcFetch("/rtc/sessions/new", "POST");
		sfuSessionId = data.sessionId;
		sfuPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
		sfuPc.ontrack = onTrack;
	}
	const track = localStream.getAudioTracks()[0];
	if (!track) return;
	const tr = sfuPc.addTransceiver(track, { direction: "sendonly" });
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

// 受信トラックの再生（音声＝audio要素／画面＝オーバーレイ）
function onTrack(ev) {
	const mid = ev.transceiver && ev.transceiver.mid;
	for (const sub of sfuSubs.values()) {
		if (sub.mid !== mid) continue;
		const stream = ev.streams[0] || new MediaStream([ev.track]);
		if (sub.kind === "screen") {
			if (!sub.videoEl) sub.videoEl = addScreenTile();   // 共有ごとに小さいタイルを用意
			sub.videoEl.srcObject = stream;
			sub.videoEl.play?.().catch(() => { });
		} else {
			if (!sub.audioEl) {
				sub.audioEl = document.createElement("audio");
				sub.audioEl.autoplay = true;
				document.body.appendChild(sub.audioEl);
				if (store.speakerId && sub.audioEl.setSinkId) sub.audioEl.setSinkId(store.speakerId).catch(() => { });
			}
			sub.audioEl.srcObject = stream;
			sub.audioEl.play?.().catch(() => { });
		}
		return;
	}
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

async function subscribe(key, t) {
	const resp = await rtcFetch(`/rtc/sessions/${sfuSessionId}/tracks/new`, "POST", {
		tracks: [{ location: "remote", sessionId: t.sessionId, trackName: t.trackName }],
	});
	const mid = resp.tracks && resp.tracks[0] && resp.tracks[0].mid;
	const sub = { mid, kind: t.kind, audioEl: null, videoEl: null };
	sfuSubs.set(key, sub);
	if (resp.requiresImmediateRenegotiation) await renegotiate(resp.sessionDescription);
	attachSub(sub);   // mid から受信トラックを取り出して確実に表示/再生（複数共有でも取りこぼさない）
}

// mid に対応する受信トラックを、画面はタイルへ・音声はaudio要素へ結びつける
function attachSub(sub) {
	if (!sfuPc || sub.mid == null) return;
	const tr = sfuPc.getTransceivers().find((x) => x.mid === sub.mid);
	const track = tr && tr.receiver && tr.receiver.track;
	if (!track) return;
	const stream = new MediaStream([track]);
	if (sub.kind === "screen") {
		if (!sub.videoEl) sub.videoEl = addScreenTile();
		sub.videoEl.srcObject = stream;
		sub.videoEl.play?.().catch(() => { });
	} else {
		if (!sub.audioEl) {
			sub.audioEl = document.createElement("audio");
			sub.audioEl.autoplay = true;
			document.body.appendChild(sub.audioEl);
			if (store.speakerId && sub.audioEl.setSinkId) sub.audioEl.setSinkId(store.speakerId).catch(() => { });
		}
		sub.audioEl.srcObject = stream;
		sub.audioEl.play?.().catch(() => { });
	}
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

// 接続断・音声停止時にSFUを畳む
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
}

// ── 画面共有（エリア内外どこでも・SFU） ──
async function startScreen() {
	if (store.me.away) { alert("離席中は画面共有できません"); return; }
	if (!voiceReady) { alert("先に「音声ON」を押してください"); return; }
	if (store.budgetLevel !== "ok") { alert("転送量の上限に近づいているため、画面共有は停止中です"); return; }
	if (!store.myId) return;
	// 画面選択はユーザー操作直後に呼ぶ
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

function setScreenBtn(active) {
	setToolBtn("screen-btn", { on: active, icon: "🖥️", label: active ? "共有中" : "画面共有" });
}

// ツールバーのボタン状態を更新（アイコン・ラベル・ON色・無効化）
function setToolBtn(id, { on, icon, label, disabled } = {}) {
	const b = document.getElementById(id);
	if (!b) return;
	if (icon !== undefined) b.querySelector(".ic").textContent = icon;
	if (label !== undefined) b.querySelector(".lb").textContent = label;
	if (on !== undefined) b.classList.toggle("on", on);
	if (disabled !== undefined) b.disabled = disabled;
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

// ── 転送量ガードの反映（バナー表示・画面共有停止） ──
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
			try {
				await ensureMic();
				micOn = !micOn;
				for (const t of localStream.getAudioTracks()) t.enabled = micOn;
				setToolBtn("mic-btn", { on: micOn, icon: micOn ? "🎤" : "🔇", label: micOn ? "ON" : "ミュート中" });
			} catch {
				alert("マイクを使えませんでした。ブラウザの許可を確認してください。");
			}
		});
	}

	// 自動再生がブロックされている場合に備え、最初の操作で受信音声を鳴らし始める
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
