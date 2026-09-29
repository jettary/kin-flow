import { describe, expect, it } from 'vitest';
import { encodeVoiceWav, audioBase64 } from '../src/lib/ai-audio';
import { AI_MAX_AUDIO_BYTES } from '../src/lib/ai';
import { validateAiAudio } from '../src/server/ai';

describe('voice note encoding', () => {
  it('downmixes and resamples browser audio to a server-validated 16kHz mono WAV', () => {
    const left = new Float32Array(48000).fill(1);
    const right = new Float32Array(48000).fill(-0.5);
    const wav = encodeVoiceWav([left, right], 48000);
    expect(wav.byteLength).toBe(44 + 32000);
    expect(new DataView(wav.buffer).getInt16(44, true)).toBe(8192);
    expect(() => validateAiAudio(audioBase64(wav))).not.toThrow();
  });
  it('caps late recorder stops at exactly a minute and clips out-of-range samples', () => {
    const wav = encodeVoiceWav([new Float32Array(16000 * 62).fill(-2)], 16000);
    expect(wav.byteLength).toBe(AI_MAX_AUDIO_BYTES);
    expect(new DataView(wav.buffer).getInt16(44, true)).toBe(-32768);
    expect(() => validateAiAudio(audioBase64(wav))).not.toThrow();
  });
  it('rejects empty recordings', () => {
    expect(() => encodeVoiceWav([new Float32Array()], 48000)).toThrow('empty');
  });
});
