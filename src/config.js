// サーバー側で共有する定数（転送量ガードの設定など）

export const GB = 1_000_000_000;
export const AUDIO_BPS = 32_000;      // 音声1本の想定ビットレート
export const SCREEN_BPS = 800_000;    // 画面共有1本の想定ビットレート
export const SCREEN_OFF_GB = 700;     // これを超えたら画面共有を停止
export const VOICE_OFF_GB = 900;      // これを超えたら音声も停止
export const LIMIT_GB = 1000;         // 無料枠（表示用）
export const NEAR = 64;               // 近接の半径（2マス＝64px）。office と一致させる

// ── 呼び出し ──
// 同じ相手を続けて呼べない時間。アラームが鳴る機能なので、連打による
// 嫌がらせを防ぐためにサーバー側で間隔を強制する。
export const CALL_COOLDOWN_MS = 10_000;
