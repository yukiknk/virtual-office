// サーバー側で共有する定数（転送量ガードの設定など）

export const GB = 1_000_000_000;
export const AUDIO_BPS = 32_000;      // 音声1本の想定ビットレート
export const SCREEN_BPS = 800_000;    // 画面共有1本の想定ビットレート
export const SCREEN_OFF_GB = 700;     // これを超えたら画面共有を停止
export const VOICE_OFF_GB = 900;      // これを超えたら音声も停止
export const LIMIT_GB = 1000;         // 無料枠（表示用）
export const NEAR = 64;               // 近接の半径（2マス＝64px）。office と一致させる

// ── Slack 通知（入室・離席・着席・退出） ──
// 登録を許す Webhook URL の接頭辞。ここを狭めておくことで、
// 管理APIが無認証のあいだも Worker を踏み台にした任意ホストへの POST を防ぐ。
export const SLACK_WEBHOOK_PREFIX = "https://hooks.slack.com/services/";
