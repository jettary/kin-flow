import { AI_AUDIO_RATE, AI_MAX_AUDIO_SECONDS } from './ai';

// Browser-side downmix/resampling keeps recordings small and sends the same PCM
// format from Safari, Chromium and Firefox. Nothing is written to local storage.
export function encodeVoiceWav(channels: Float32Array[], sampleRate: number) {
  if (!channels.length || sampleRate <= 0 || !channels[0].length)
    throw new Error('The recording was empty.');
  const samples = Math.min(
    Math.floor((channels[0].length * AI_AUDIO_RATE) / sampleRate),
    AI_AUDIO_RATE * AI_MAX_AUDIO_SECONDS,
  );
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, AI_AUDIO_RATE, true);
  view.setUint32(28, AI_AUDIO_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const position = (i * sampleRate) / AI_AUDIO_RATE;
    const a = Math.floor(position),
      mix = position - a;
    const sample =
      channels.reduce(
        (sum, c) => sum + c[a] * (1 - mix) + c[Math.min(a + 1, c.length - 1)] * mix,
        0,
      ) / channels.length;
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export async function voiceWav(blob: Blob) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    return encodeVoiceWav(
      Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)),
      decoded.sampleRate,
    );
  } finally {
    await context.close();
  }
}

export function audioBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
