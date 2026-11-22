import { describe, expect, it } from 'vitest';
import { ask, route } from '../src/ask.js';
import { CITY } from '../src/data.js';
import { understand } from '../src/intake.js';
import { buildPack } from '../src/langpack.js';
import { MemoryStore } from '../src/memoryStore.js';
import { firstJson, Sarvam } from '../src/sarvam.js';
import { IncidentService } from '../src/service.js';
import { failure, fakeSarvamFetch } from './helpers.js';

describe('Sarvam client', () => {
  it('sends speech with the model, mode, key and a file name that matches the audio type', async () => {
    let seen: Record<string, unknown> = {};
    const f = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen = { url, key: (init.headers as Record<string, string>)['api-subscription-key'], model: form.get('model'), mode: form.get('mode'), name: (form.get('file') as File).name };
      return new Response(JSON.stringify({ transcript: ' पानी नहीं आ रहा ', language_code: 'hi-IN' }));
    }) as unknown as typeof fetch;
    expect(await new Sarvam('k', { fetchFn: f }).transcribe(Buffer.from('x'), 'audio/webm;codecs=opus')).toEqual({ text: 'पानी नहीं आ रहा', language: 'hi-IN' });
    expect(seen).toEqual({ url: 'https://api.sarvam.ai/speech-to-text', key: 'k', model: 'saaras:v3', mode: 'transcribe', name: 'complaint.webm' });
  });

  it('turns an upstream failure into a clear 502 and counts it', async () => {
    const s = new Sarvam('k', { fetchFn: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch });
    expect((await failure(s.translate('x', 'en-IN', 'hi-IN'))).statusCode).toBe(502);
    expect(s.calls.failed).toBe(1);
  });

  it('translates with the documented fields, and caches', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const s = new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/translate': { translated_text: 'पानी शाम तक आएगा' } }, seen) });
    expect(await s.translate('Water returns by evening', 'en-IN', 'hi-IN')).toBe('पानी शाम तक आएगा');
    await s.translate('Water returns by evening', 'en-IN', 'hi-IN');
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ input: 'Water returns by evening', source_language_code: 'en-IN', target_language_code: 'hi-IN', model: 'sarvam-translate:v1', mode: 'formal' });
  });

  it('speaks with Bulbul and asks the chat model with reasoning off', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const s = new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/text-to-speech': { audios: ['QUJD'] }, '/v1/chat/completions': { choices: [{ message: { content: '```json\n{"tool":"root_cause"}\n```' } }] } }, seen) });
    expect(await s.speak('नमस्ते', 'hi-IN')).toEqual({ audio: 'QUJD', mime: 'audio/mpeg' });
    expect(seen[0].body).toMatchObject({ text: 'नमस्ते', language_code: 'hi-IN', model: 'bulbul:v3', speaker: 'shubh', output_audio_codec: 'mp3' });
    expect(firstJson(await s.chat([{ role: 'user', content: 'q' }], true))).toEqual({ tool: 'root_cause' });
    expect(seen[1].body).toMatchObject({ model: 'sarvam-105b', reasoning_effort: null, response_format: { type: 'json_object' } });
  });
});

describe('understanding a complaint in any language', () => {
  it('Tamil text gets English for the officer and is classified from the English', async () => {
    const s = new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/text-lid': { language_code: 'ta-IN' }, '/translate': { translated_text: 'The pipe has burst near the temple' } }) });
    expect(await understand('கோவில் அருகே குழாய் உடைந்துவிட்டது', s)).toEqual({ text: 'கோவில் அருகே குழாய் உடைந்துவிட்டது', textEn: 'The pipe has burst near the temple', language: 'ta-IN', issueType: 'LEAK', translated: true });
  });
  it('plain English and Hinglish need no Sarvam call', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const s = new Sarvam('k', { fetchFn: fakeSarvamFetch({}, seen) });
    expect(await understand('paani nahi aa raha', s)).toMatchObject({ language: 'en-IN', issueType: 'NO_WATER', translated: false });
    expect(seen).toHaveLength(0);
  });
  it('if Sarvam fails, keeps the original and still classifies Hindi', async () => {
    const s = new Sarvam('k', { fetchFn: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch });
    expect(await understand('पानी नहीं आ रहा', s)).toMatchObject({ text: 'पानी नहीं आ रहा', issueType: 'NO_WATER', translated: false });
  });
});

describe('Ask BharatPulse with Sarvam', () => {
  it('Hindi question -> English -> the model picks a whitelisted tool -> graph -> answer back in Hindi', async () => {
    const service = new IncidentService(new MemoryStore(), { clock: () => Date.UTC(2026, 10, 21, 12) });
    await service.loadSample();
    const seen: { path: string; body: unknown }[] = [];
    const s = new Sarvam('k', {
      fetchFn: fakeSarvamFetch({
        '/text-lid': { language_code: 'hi-IN' },
        '/translate': (b: unknown) => ({ translated_text: (b as { target_language_code: string }).target_language_code === 'en-IN' ? 'Why is water not coming in Ward 3?' : 'उत्तरी फीडर जाँचें।' }),
        '/v1/chat/completions': (b: unknown) => ({ choices: [{ message: { content: (b as { response_format?: unknown }).response_format ? '{"tool":"root_cause","args":{}}' : 'Check the North feeder first.' } }] }),
      }, seen),
    });
    const tools = { rootCause: () => service.rootCause(), rings: () => service.rings(), downstream: (z: string) => service.downstream(z), wardStatus: (w: string) => service.wardStatus(w), top: () => service.listActive(), repeats: async () => [] };
    const a = await ask('वार्ड 3 में पानी क्यों नहीं आ रहा?', tools, CITY, s);
    expect(a).toMatchObject({ tool: 'root_cause', language: 'hi-IN', questionEn: 'Why is water not coming in Ward 3?', answerEn: 'Check the North feeder first.', answer: 'उत्तरी फीडर जाँचें।', via: { understood: 'sarvam', worded: 'sarvam', translated: true } });
    expect((a.data as { suspects: { assetId: string }[] }).suspects[0].assetId).toBe('M2');
  });
  it('a tool the model invents is ignored (keywords decide)', async () => {
    const s = new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/v1/chat/completions': { choices: [{ message: { content: '{"tool":"drop_database"}' } }] } }) });
    const tools = { rootCause: async () => ({ zonesHit: [], incidents: [], suspects: [], atRisk: [] }), rings: async () => ({ rings: [], targets: [] }), downstream: async () => [], wardStatus: async () => undefined, top: async () => [], repeats: async () => [] };
    expect((await ask('any fake reports?', tools, CITY, s)).tool).toBe('fraud_rings');
    expect(route('kya chal raha hai').tool).toBe('top_incidents');
  });
});

describe('language packs', () => {
  it('translates in batches, keeps {placeholders}, and drops lines that lost them', async () => {
    const s = new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/translate': (b: unknown) => ({ translated_text: (b as { input: string }).input.split('\n').map((l) => l.replace('Report', 'புகார்').replace('{n} people', 'மக்கள்')).join('\n') }) }) });
    const pack = await buildPack({ report: 'Report a problem', people: '{n} people', ok: 'Report {n}' }, 'ta-IN', s);
    expect(pack).toEqual({ report: 'புகார் a problem', ok: 'புகார் {n}' });
  });
  it('is cached in the store after the first build', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const s = new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/translate': (b: unknown) => ({ translated_text: (b as { input: string }).input }) }, seen) });
    const service = new IncidentService(new MemoryStore(), { sarvam: s });
    expect((await service.languagePack('ta-IN', { a: 'One', b: 'Two' })).cached).toBe(false);
    expect((await service.languagePack('ta-IN', { a: 'One', b: 'Two' })).cached).toBe(true);
    expect(seen).toHaveLength(1);
    expect((await failure(service.languagePack('xx', { a: 'One' }))).statusCode).toBe(400);
  });
});
