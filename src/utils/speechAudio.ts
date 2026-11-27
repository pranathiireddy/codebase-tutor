import { apiFetch, safeJson } from './api';

export type VoiceEngineMode = 'lite' | 'browser';

const audioBlobUrlCache = new Map<string, string>();

export function prepareSpokenDigest(markdown: string, maxChars = 600): string {
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/:L?\d+(?:-\d+)?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return 'Here is the explanation from Plupus.';
  }
  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  const slice = cleaned.slice(0, maxChars);
  const lastPeriod = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  const cut = lastPeriod > Math.floor(maxChars * 0.45) ? slice.slice(0, lastPeriod + 1) : `${slice.trim()}...`;
  return `${cut} See the chat panel for full code references.`;
}

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
  return URL.createObjectURL(blob);
}

const PREFERRED_SWEET_VOICES = [
  'google uk english female',
  'microsoft aria',
  'microsoft jenny',
  'samantha',
  'victoria',
  'karen',
  'moira',
  'microsoft zira',
  'google us english',
  'female',
];

function pickSweetEnglishVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null;
  }
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const englishVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const pool = englishVoices.length > 0 ? englishVoices : voices;

  for (const preferred of PREFERRED_SWEET_VOICES) {
    const found = pool.find((v) => v.name.toLowerCase().includes(preferred));
    if (found) return found;
  }
  return pool[0] ?? null;
}

export interface PlaybackHandle {
  stop: () => void;
}

export function stopAllSpeech(activeAudio: HTMLAudioElement | null): void {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

export function playBrowserSweetVoice(
  text: string,
  callbacks: { onStart: () => void; onEnd: () => void; onError: (msg: string) => void }
): PlaybackHandle {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    callbacks.onError('Audio playback is unavailable in this browser.');
    return { stop: () => {} };
  }

  window.speechSynthesis.cancel();
  const spokenText = prepareSpokenDigest(text, 750);
  const utterance = new SpeechSynthesisUtterance(spokenText);
  const voice = pickSweetEnglishVoice();
  if (voice) {
    utterance.voice = voice;
  }
  utterance.lang = 'en-US';
  utterance.pitch = 1.08;
  utterance.rate = 0.96;
  utterance.volume = 0.95;

  let cancelled = false;
  utterance.onstart = () => {
    if (!cancelled) callbacks.onStart();
  };
  utterance.onend = () => {
    if (!cancelled) callbacks.onEnd();
  };
  utterance.onerror = () => {
    if (!cancelled) callbacks.onEnd();
  };

  callbacks.onStart();
  window.speechSynthesis.speak(utterance);

  return {
    stop: () => {
      cancelled = true;
      window.speechSynthesis.cancel();
    },
  };
}

export async function synthesizeAndPlayAnswer(options: {
  messageId: string;
  markdown: string;
  mode: VoiceEngineMode;
  audioRef: { current: HTMLAudioElement | null };
  signal?: AbortSignal;
  onLoading: () => void;
  onPlaying: (engineLabel: string) => void;
  onEnded: () => void;
  onError: (msg: string) => void;
}): Promise<PlaybackHandle> {
  const { messageId, markdown, mode, audioRef, signal, onLoading, onPlaying, onEnded, onError } = options;

  stopAllSpeech(audioRef.current);

  const spokenDigest = prepareSpokenDigest(markdown, 600);

  if (signal?.aborted) {
    return { stop: () => {} };
  }

  if (mode === 'browser') {
    return playBrowserSweetVoice(spokenDigest, {
      onStart: () => onPlaying('0-token sweet voice'),
      onEnd: onEnded,
      onError,
    });
  }

  const cacheKey = `${messageId}:${spokenDigest.length}`;
  let cachedUrl = audioBlobUrlCache.get(cacheKey);
  let stopped = false;

  const isAborted = () => stopped || Boolean(signal?.aborted);

  const playBlobUrl = (blobUrl: string, label: string): PlaybackHandle => {
    if (isAborted()) return { stop: () => {} };
    const audio = new Audio(blobUrl);
    audioRef.current = audio;
    audio.onended = () => {
      if (audioRef.current === audio) audioRef.current = null;
      if (!isAborted()) onEnded();
    };
    audio.onerror = () => {
      if (audioRef.current === audio) audioRef.current = null;
      if (!isAborted()) onError('Failed to play audio clip.');
    };
    onPlaying(label);
    void audio.play().catch(() => {
      if (!isAborted()) onEnded();
    });
    return {
      stop: () => {
        stopped = true;
        audio.pause();
        audio.currentTime = 0;
        if (audioRef.current === audio) audioRef.current = null;
      },
    };
  };

  if (cachedUrl) {
    return playBlobUrl(cachedUrl, 'Cached sweet voice (0 extra tokens)');
  }

  onLoading();

  try {
    const res = await apiFetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: spokenDigest }),
      signal,
    });
    const json = await safeJson<{
      audioBase64?: string;
      mimeType?: string;
      modelUsed?: string;
      error?: string;
    }>(res);

    if (isAborted()) {
      return { stop: () => {} };
    }

    if (!res.ok || !json.audioBase64) {
      throw new Error(json.error || 'Gemini TTS unavailable.');
    }

    cachedUrl = base64ToBlobUrl(json.audioBase64, json.mimeType || 'audio/wav');
    audioBlobUrlCache.set(cacheKey, cachedUrl);
    return playBlobUrl(cachedUrl, `Sweet voice (${json.modelUsed || 'lite TTS'})`);
  } catch (err) {
    if (isAborted() || (err instanceof DOMException && err.name === 'AbortError')) {
      return { stop: () => {} };
    }
    // Seamless 0-token sweet browser voice fallback when Gemini TTS key isn't active or unavailable
    return playBrowserSweetVoice(spokenDigest, {
      onStart: () => onPlaying('0-token sweet voice fallback'),
      onEnd: onEnded,
      onError,
    });
  }
}

export function clearAudioCache(): void {
  for (const url of audioBlobUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  audioBlobUrlCache.clear();
}
