/**
 * ============================================================================
 * الملف: src/features/dashboard-app/routes/voice-routes.ts
 * القسم: Features -> Dashboard App -> Routes (مسارات النطق العربي المحلي)
 * Hint بالعربي: حالة محرك النطق العربي على هذا الجهاز، وتوليد ملف WAV لجملة واحدة.
 *               الصوت يُولَّد محلياً بالكامل، ولا يُرسل النص لأي خدمة خارجية.
 *               وتنزيل الصوت العربي المدمج (Piper) بضغطة زر من القائد، من المصادر الرسمية فقط.
 * ============================================================================
 */

import { installArabicVoice } from '../../../tools/install-arabic-voice.ts';
import { detectTtsEngine, MAX_TTS_CHARS, resetTtsCache, resolveVendorDir, synthesizeSpeech } from '../../voice/tts-service.ts';
import { HttpError, readString, sendJson, type RouteDefinition } from '../http-utils.ts';

/** يمنع تشغيل تنزيلين في الوقت نفسه */
let installing = false;

/**
 * Hint بالعربي: دالة إرجاع مسارات النطق.
 */
export function getVoiceRoutes(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/tts/status',
      handler: async ({ res }) => sendJson(res, 200, await detectTtsEngine()),
    },
    {
      method: 'POST',
      path: '/api/tts/install',
      requiresSession: true,
      commanderOnly: true,
      handler: async ({ res }) => {
        if (installing) throw new HttpError(409, 'التنزيل جارٍ بالفعل.');
        installing = true;
        try {
          await installArabicVoice(resolveVendorDir());
        } catch (err) {
          throw new HttpError(502, `تعذر تنزيل الصوت العربي: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          installing = false;
          resetTtsCache();
        }
        sendJson(res, 200, { ok: true, status: await detectTtsEngine(), messageAr: '🎉 نُزّل الصوت العربي المدمج.' });
      },
    },
    {
      method: 'POST',
      path: '/api/tts',
      handler: async ({ res, body }) => {
        const text = readString(body, 'text', MAX_TTS_CHARS).trim();
        if (!text) throw new HttpError(400, 'لا يوجد نص للنطق.');
        let result;
        try {
          result = await synthesizeSpeech(text, body.speaker);
        } catch (err) {
          throw new HttpError(503, err instanceof Error ? err.message : 'تعذر توليد الصوت.');
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': String(result.wav.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-TTS-Engine': String(result.engine),
        });
        res.end(result.wav);
      },
    },
  ];
}
