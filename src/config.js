// サーバー側で共有する定数（転送量ガードの設定など）

export const GB = 1_000_000_000;

// 単位はビット毎秒。バイトに直すのは使う側（helpers.js の bytesPerSec）。
export const AUDIO_BPS = 32_000;      // 音声1本の想定ビットレート
export const SCREEN_BPS = 800_000;    // 画面共有1本の想定ビットレート
export const SCREEN_OFF_GB = 700;     // これを超えたら画面共有を停止
export const VOICE_OFF_GB = 900;      // これを超えたら音声も停止
export const LIMIT_GB = 1000;         // 無料枠（表示用）
// エリア外で会話できる半径（2マス＝64px）。
// 同じ値が public/office/panel.js と public/office/voice.js にもある（計3か所）。
// ここだけ変えると、画面では呼び出しボタンが出るのにチャットが届かない、といったずれ方をする。
export const NEAR = 64;

// ── Slack 通知（入室・離席・着席・退出） ──
// 登録を許す Webhook URL の接頭辞。ここを狭めておくことで、
// 管理APIが無認証のあいだも Worker を踏み台にした任意ホストへの POST を防ぐ。
export const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/services/";

// ── 呼び出し ──
// 同じ相手を続けて呼べない時間。アラームが鳴る機能なので、連打による
// 嫌がらせを防ぐためにサーバー側で間隔を強制する。
export const CALL_COOLDOWN_MS = 10_000;
