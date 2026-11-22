import { useRef, useState } from 'react';
import { api, ctx, type Heard } from './api';
import { asBase64 } from './photo';

/** Set once /health has answered: true when the server has Sarvam (speech, voice, translation). */
let serverVoice = false;
export const setServerVoice = (on: boolean): void => { serverVoice = on; };
export const hasServerVoice = (): boolean => serverVoice;

type SR = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: () => void };
const BrowserSR = (): (new () => SR) | undefined => {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export type VoiceState = 'idle' | 'listening' | 'thinking';

/**
 * Tap to talk, tap again to stop.
 *  - With Sarvam on the server: records the audio and sends it to Saaras, which detects the language (22 Indian
 *    languages), then the server adds an English version and a guess of the problem type.
 *  - Without it, or if Sarvam fails: the browser's own speech recognition (Chrome, Edge, Android), Hindi or English.
 */
export function useVoiceInput(opts: { who: 'citizen' | 'officer'; browserLang: string; onResult: (h: Heard, via: 'sarvam' | 'browser') => void; onError: (msg: string) => void }) {
  const [state, setState] = useState<VoiceState>('idle');
  const rec = useRef<{ stop: () => void }>();

  function browser(): boolean {
    const Ctor = BrowserSR();
    if (!Ctor) return false;
    const r = new Ctor();
    r.lang = opts.browserLang; r.interimResults = true; r.continuous = true;
    let last = '';
    r.onresult = (e) => { last = Array.from(e.results).map((x) => x[0].transcript).join(' '); opts.onResult({ text: last, language: opts.browserLang }, 'browser'); };
    r.onend = () => setState('idle');
    r.onerror = () => { setState('idle'); if (!last) opts.onError('mic'); };
    r.start(); rec.current = r; setState('listening');
    return true;
  }

  async function toggle() {
    if (state === 'listening') return rec.current?.stop();
    if (state === 'thinking') return;
    const signedIn = opts.who === 'officer' ? !!ctx.officerToken : !!ctx.token;
    if (serverVoice && signedIn && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const m = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        m.ondataavailable = (e) => chunks.push(e.data);
        m.onstop = async () => {
          stream.getTracks().forEach((x) => x.stop());
          setState('thinking');
          try {
            const heard = await api.transcribe(await asBase64(new Blob(chunks, { type: m.mimeType })), m.mimeType || 'audio/webm', opts.who);
            opts.onResult(heard, 'sarvam');
          } catch (e) {
            // Sarvam failed: fall back to the browser so the person is not stuck.
            if (!browser()) opts.onError((e as Error).message);
            return;
          } finally {
            setState((s) => (s === 'thinking' ? 'idle' : s));
          }
        };
        m.start(); rec.current = m; setState('listening');
        setTimeout(() => m.state === 'recording' && m.stop(), 28_000); // Sarvam's quick endpoint takes up to ~30 s
        return;
      } catch {
        /* no microphone permission: try the browser recogniser, which asks again */
      }
    }
    if (!browser()) opts.onError('unsupported');
  }
  return { state, toggle };
}

let playing: HTMLAudioElement | undefined;
export const stopVoice = (): void => { playing?.pause(); playing = undefined; if ('speechSynthesis' in window) window.speechSynthesis.cancel(); };

/**
 * Reads text aloud. Sarvam's Bulbul voice when the server has it (natural voices in 11 languages, also on phones
 * without a Hindi voice installed); otherwise the browser's own voice. Resolves when playback starts.
 */
export async function speakText(text: string, bcp: string, who: 'citizen' | 'officer' = 'citizen'): Promise<'sarvam' | 'browser' | 'none'> {
  stopVoice();
  const signedIn = who === 'officer' ? !!ctx.officerToken : !!ctx.token;
  if (serverVoice && signedIn) {
    try {
      const { audio, mime } = await api.speak(text.slice(0, 1200), bcp, who);
      playing = new Audio(`data:${mime};base64,${audio}`);
      await playing.play();
      return 'sarvam';
    } catch { /* fall back below */ }
  }
  if (!('speechSynthesis' in window)) return 'none';
  const u = new SpeechSynthesisUtterance(text);
  u.lang = bcp;
  window.speechSynthesis.speak(u);
  return 'browser';
}
