/**
 * 落子音效与触感（沿用 YiRenju 的 Web Audio 方案）：
 * 碰撞瞬态（7ms 带通噪声）+ 微弱实心共鸣（32ms 正弦），黑白不同音高；
 * 终局为 C5→E5→G5→C6 大三和弦轻快连音。
 */

let audioCtx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;
    if (!audioCtx) audioCtx = new AudioCtor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

export function playStoneSound(isWhite: boolean, enabled: boolean): void {
  if (!enabled) return;
  const ctx = ensureCtx();
  if (!ctx) return;
  try {
    const t = ctx.currentTime;
    const bufLen = Math.max(1, Math.floor(ctx.sampleRate * 0.007));
    const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const out = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) out[i] = Math.random() * 2 - 1;
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(isWhite ? 3200 : 2700, t);
    filter.Q.setValueAtTime(3.0, t);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.42, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.007);
    noiseSrc.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noiseSrc.start(t);
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isWhite ? 580 : 510, t);
    oscGain.gain.setValueAtTime(0.25, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.032);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.033);
  } catch { /* ignore */ }
}

export function playWinSound(enabled: boolean): void {
  if (!enabled) return;
  const ctx = ensureCtx();
  if (!ctx) return;
  try {
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const st = t + idx * 0.08;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, st);
      gain.gain.setValueAtTime(0.28, st);
      gain.gain.exponentialRampToValueAtTime(0.001, st + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(st);
      osc.stop(st + 0.22);
    });
  } catch { /* ignore */ }
}

export function triggerHaptic(type: 'move' | 'win'): void {
  try {
    if (!navigator.vibrate) return;
    navigator.vibrate(type === 'win' ? [40, 60, 40, 60, 60, 80, 80] : 18);
  } catch { /* ignore */ }
}
