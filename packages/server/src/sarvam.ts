import { AppError } from './errors.js';

/**
 * Sarvam AI, used for everything language-related:
 *  - Saaras (speech to text): a complaint spoken in any of 22 Indian languages, language detected automatically
 *  - Sarvam-Translate: the officer reads every complaint in English; the citizen reads officer updates, notices and
 *    the whole app in their own language
 *  - text-lid: which language a typed complaint is in
 *  - Bulbul (text to speech): updates and answers read aloud, for people who find reading hard
 *  - Sarvam-105B (chat): "Ask BharatPulse" picks the right graph question and words the answer
 * Request shapes follow docs.sarvam.ai (Nov 2026). NOT verified against the live API from this machine:
 * run `npm run sarvam:smoke` once with a real key.
 */

export const LANGUAGES: Record<string, string> = {
  'en-IN': 'English', 'hi-IN': 'हिन्दी', 'bn-IN': 'বাংলা', 'ta-IN': 'தமிழ்', 'te-IN': 'తెలుగు', 'mr-IN': 'मराठी',
  'gu-IN': 'ગુજરાતી', 'kn-IN': 'ಕನ್ನಡ', 'ml-IN': 'മലയാളം', 'pa-IN': 'ਪੰਜਾਬੀ', 'od-IN': 'ଓଡ଼ିଆ',
};
/** Bulbul v3 speaks these 11. */
export const TTS_LANGUAGES = Object.keys(LANGUAGES);

const BASE = 'https://api.sarvam.ai';
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac' };
export const isEnglish = (lang?: string): boolean => !lang || lang.startsWith('en');
/** Non-Latin letters (Devanagari, Tamil, Bengali ...) mean the text is not plain English. */
export const hasIndicScript = (s: string): boolean => /[ऀ-෿]/.test(s);

export interface SarvamOptions {
  fetchFn?: typeof fetch;
  sttModel?: string;
  translateModel?: string;
  ttsModel?: string;
  ttsSpeaker?: string;
  chatModel?: string;
  timeoutMs?: number;
  /** Only for local testing against a mock; production always uses api.sarvam.ai. */
  baseUrl?: string;
}

class Lru<V> {
  private m = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V): void { this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
}

export class Sarvam {
  private readonly f: typeof fetch;
  private readonly translations = new Lru<string>(2000);
  private readonly voices = new Lru<string>(200);
  /** Counts calls by kind, shown on /health so a demo can prove Sarvam is really being used. */
  readonly calls: Record<string, number> = { stt: 0, translate: 0, lid: 0, tts: 0, chat: 0, failed: 0 };

  constructor(private readonly key: string, private readonly o: SarvamOptions = {}) {
    this.f = o.fetchFn ?? fetch;
  }

  get models() {
    return { stt: this.o.sttModel ?? 'saaras:v3', translate: this.o.translateModel ?? 'sarvam-translate:v1', tts: this.o.ttsModel ?? 'bulbul:v3', chat: this.o.chatModel ?? 'sarvam-105b' };
  }

  private async call<T>(kind: string, path: string, init: RequestInit): Promise<T> {
    this.calls[kind] = (this.calls[kind] ?? 0) + 1;
    let res: Response;
    try {
      res = await this.f((this.o.baseUrl ?? BASE) + path, { ...init, headers: { 'api-subscription-key': this.key, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000) });
    } catch {
      this.calls.failed++;
      throw new AppError(502, 'sarvam_unreachable', 'The language service did not answer. Please try again or type instead.');
    }
    if (!res.ok) {
      this.calls.failed++;
      const detail = await res.text().catch(() => '');
      throw new AppError(502, 'sarvam_failed', `Language service answered ${res.status}`, { status: res.status, detail: detail.slice(0, 300) });
    }
    return (await res.json()) as T;
  }

  private json<T>(kind: string, path: string, body: unknown): Promise<T> {
    return this.call<T>(kind, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  /** Speech to text in the spoken language (Saaras, mode "transcribe"). Up to ~30 s of audio. */
  async transcribe(audio: Buffer, mime: string): Promise<{ text: string; language?: string }> {
    const type = mime.split(';')[0].trim() || 'audio/wav';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type }), `complaint.${EXT[type] ?? 'webm'}`);
    form.append('model', this.models.stt);
    form.append('mode', 'transcribe');
    const j = await this.call<{ transcript?: string; language_code?: string | null }>('stt', '/speech-to-text', { method: 'POST', body: form });
    return { text: (j.transcript ?? '').trim(), language: j.language_code ?? undefined };
  }

  /** Which language a piece of text is in (BCP-47, e.g. "ta-IN"). */
  async detect(text: string): Promise<string | undefined> {
    const j = await this.json<{ language_code?: string | null }>('lid', '/text-lid', { input: text.slice(0, 1000) });
    return j.language_code ?? undefined;
  }

  /** Translate between English and an Indian language (or between two Indian languages). Cached. */
  async translate(text: string, from: string, to: string): Promise<string> {
    if (!text.trim() || from === to) return text;
    const k = `${from}>${to}:${text}`;
    const hit = this.translations.get(k);
    if (hit !== undefined) return hit;
    const j = await this.json<{ translated_text?: string }>('translate', '/translate', { input: text.slice(0, 2000), source_language_code: from, target_language_code: to, model: this.models.translate, mode: 'formal' });
    const out = (j.translated_text ?? '').trim() || text;
    this.translations.set(k, out);
    return out;
  }

  /** Any text to English: detects the language first unless it is given. */
  async toEnglish(text: string, language?: string): Promise<{ text: string; language: string }> {
    const lang = language && language !== 'unknown' ? language : await this.detect(text).catch(() => undefined);
    if (!lang || isEnglish(lang)) return { text, language: lang ?? 'en-IN' };
    return { text: await this.translate(text, lang, 'en-IN'), language: lang };
  }

  /** Text to speech (Bulbul). Returns base64 audio (mp3). Cached. */
  async speak(text: string, language: string): Promise<{ audio: string; mime: string }> {
    const lang = TTS_LANGUAGES.includes(language) ? language : 'hi-IN';
    const k = `${lang}:${text}`;
    const hit = this.voices.get(k);
    if (hit) return { audio: hit, mime: 'audio/mpeg' };
    const j = await this.json<{ audios?: string[] }>('tts', '/text-to-speech', { text: text.slice(0, 2400), language_code: lang, model: this.models.tts, speaker: this.o.ttsSpeaker ?? 'shubh', output_audio_codec: 'mp3', speech_sample_rate: 24000 });
    const audio = j.audios?.[0];
    if (!audio) throw new AppError(502, 'sarvam_failed', 'The voice service returned no audio');
    this.voices.set(k, audio);
    return { audio, mime: 'audio/mpeg' };
  }

  /** Chat completion (Sarvam-105B), reasoning off so it answers fast. `json` asks for a JSON object back. */
  async chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], json = false, maxTokens = 500): Promise<string> {
    const j = await this.json<{ choices?: { message?: { content?: string | null } }[] }>('chat', '/v1/chat/completions', {
      model: this.models.chat, messages, temperature: 0.2, max_tokens: maxTokens, reasoning_effort: null,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    });
    return (j.choices?.[0]?.message?.content ?? '').trim();
  }
}

/** Pulls the first {...} block out of a model reply (models sometimes wrap JSON in prose or code fences). */
export function firstJson<T>(s: string): T | undefined {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(s.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
