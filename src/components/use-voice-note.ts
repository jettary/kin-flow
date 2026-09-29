'use client';
import { useEffect, useRef, useState } from 'react';
import { AI_MAX_AUDIO_SECONDS } from '@/lib/ai';
import { audioBase64, voiceWav } from '@/lib/ai-audio';

export function useVoiceNote() {
  const [audio, setAudio] = useState<{ data: string; url: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  const starting = useRef(false);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    if (recorder.current?.state === 'recording') {
      setProcessing(true);
      recorder.current.stop();
    }
    stream.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearInterval(timer.current);
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(
    () => () => {
      if (audio) URL.revokeObjectURL(audio.url);
    },
    [audio],
  );
  useEffect(() => {
    const hide = () => {
      if (document.hidden && recorder.current?.state === 'recording') stop();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);

  async function start() {
    if (starting.current || recorder.current?.state === 'recording') return;
    setError('');
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined' ||
      typeof AudioContext === 'undefined'
    ) {
      setError('Voice recording is unavailable in this browser. Type or use keyboard dictation.');
      return;
    }
    starting.current = true;
    setProcessing(true);
    try {
      const source = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
        video: false,
      });
      if (!alive.current) {
        source.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = source;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const current = new MediaRecorder(source, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32000,
      });
      recorder.current = current;
      const chunks: Blob[] = [];
      let size = 0,
        failed = false;
      current.ondataavailable = (event) => {
        size += event.data.size;
        if (size > 8 * 1024 * 1024) {
          failed = true;
          stop();
        } else chunks.push(event.data);
      };
      current.onerror = () => {
        failed = true;
        stop();
      };
      current.onstop = async () => {
        if (!alive.current) return;
        stop();
        setProcessing(true);
        try {
          if (failed) throw new Error('Recording failed');
          const bytes = await voiceWav(new Blob(chunks, { type: current.mimeType }));
          if (alive.current)
            setAudio({
              data: audioBase64(bytes),
              url: URL.createObjectURL(
                new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
              ),
            });
        } catch {
          if (alive.current)
            setError(
              'Could not read this recording. Try recording again or use keyboard dictation.',
            );
        } finally {
          chunks.length = 0;
          if (alive.current) setProcessing(false);
        }
      };
      setAudio(null);
      setSeconds(0);
      current.start(1000);
      setRecording(true);
      const began = performance.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((performance.now() - began) / 1000);
        setSeconds(Math.min(elapsed, AI_MAX_AUDIO_SECONDS));
        if (elapsed >= AI_MAX_AUDIO_SECONDS) stop();
      }, 200);
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop());
      if (alive.current)
        setError('Microphone access was not available. Allow it in browser settings or use text.');
    } finally {
      starting.current = false;
      if (alive.current) setProcessing(false);
    }
  }
  return { audio, recording, processing, seconds, error, start, stop, clear: () => setAudio(null) };
}
