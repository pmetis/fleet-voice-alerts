'use strict';

/**
 * TTS Cache — Google Cloud Text-to-Speech + GCS
 *
 * Synthesizes text with WaveNet voices, caches the MP3 in GCS, and returns
 * a signed URL that Twilio can fetch with its <Play> tag.
 *
 * Cache key = SHA-256(lang + "|" + speakingRate + "|" + text), stored as
 * tts/{hash}.mp3 in the configured GCS bucket. Identical scripts always
 * reuse the same file — important because the greeting script for the same
 * exception fires across the entire escalation chain.
 *
 * Signed URLs are valid for 60 minutes — well within any call duration.
 *
 * Environment variables required (set in Cloud Function deploy):
 *   TTS_BUCKET  — GCS bucket name, e.g. "fleet-voice-alerts-tts-yourproject"
 *
 * GCP permissions required on the Cloud Function service account:
 *   roles/texttospeech.user
 *   roles/storage.objectAdmin   (on the TTS bucket)
 */

const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { Storage }            = require('@google-cloud/storage');
const crypto                 = require('crypto');

const ttsClient = new TextToSpeechClient();
const storage   = new Storage();

// ─── WaveNet voice config per language ───────────────────────────────────────
const TTS_VOICES = {
  en: { languageCode: 'en-US', name: 'en-US-Wavenet-D', ssmlGender: 'MALE' },
  es: { languageCode: 'es-US', name: 'es-US-Wavenet-B', ssmlGender: 'MALE' },
  pt: { languageCode: 'pt-BR', name: 'pt-BR-Wavenet-B', ssmlGender: 'MALE' }
};

const SPEAKING_RATE   = 0.95;
const SIGNED_URL_TTL  = 60 * 60 * 1000; // 1 hour in ms

/**
 * Return a public-access signed URL for the synthesized audio of `text`.
 *
 * Flow:
 *   1. Hash the input → deterministic GCS object name
 *   2. If object already exists → return signed URL immediately (cache hit)
 *   3. Otherwise → call TTS API → upload MP3 → return signed URL (cache miss)
 *
 * @param {string} text   Text to synthesize (plain text, not SSML)
 * @param {string} lang   'en' | 'es' | 'pt'
 * @returns {Promise<string>}  HTTPS signed URL Twilio can fetch
 */
async function synthesizeAndCache(text, lang) {
  const bucket = process.env.TTS_BUCKET;
  if (!bucket) throw new Error('TTS_BUCKET environment variable not set');

  const voice      = TTS_VOICES[lang] || TTS_VOICES.en;
  const cacheKey   = buildCacheKey(text, lang, SPEAKING_RATE);
  const objectName = `tts/${cacheKey}.mp3`;
  const gcsFile    = storage.bucket(bucket).file(objectName);

  // ── Cache hit ─────────────────────────────────────────────────────────────
  try {
    const [exists] = await gcsFile.exists();
    if (exists) {
      console.log(`[TTS] Cache hit: ${objectName}`);
      return signedUrl(gcsFile);
    }
  } catch (err) {
    // If we can't check existence, fall through to synthesis
    console.warn('[TTS] Existence check failed, re-synthesizing:', err.message);
  }

  // ── Cache miss — call TTS API ─────────────────────────────────────────────
  console.log(`[TTS] Synthesizing ${voice.name} (${lang}) — ${text.length} chars`);

  const [response] = await ttsClient.synthesizeSpeech({
    input:       { text },
    voice:       { languageCode: voice.languageCode, name: voice.name },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate:  SPEAKING_RATE,
      effectsProfileId: ['telephony-class-application'] // optimize for phone calls
    }
  });

  // Upload to GCS
  await gcsFile.save(response.audioContent, {
    metadata: {
      contentType: 'audio/mpeg',
      cacheControl: 'public, max-age=86400',
      metadata: {
        lang,
        voice:   voice.name,
        textLen: String(text.length),
        created: new Date().toISOString()
      }
    }
  });

  console.log(`[TTS] Cached: ${objectName} (${response.audioContent.length} bytes)`);
  return signedUrl(gcsFile);
}

/**
 * Synthesize multiple texts in parallel, preserving order.
 * Used to pre-generate greeting + menu prompt in a single batch.
 */
async function synthesizeMany(items) {
  // items: [{ text, lang }]
  return Promise.all(items.map(({ text, lang }) => synthesizeAndCache(text, lang)));
}

/**
 * Deterministic SHA-256 cache key from (text, lang, rate).
 * Same text + same voice + same rate always returns the same key.
 */
function buildCacheKey(text, lang, rate) {
  return crypto
    .createHash('sha256')
    .update(`${lang}|${rate}|${text}`)
    .digest('hex');
}

/**
 * Generate a V4 signed URL valid for 1 hour.
 * Twilio fetches audio at call time — 1h is well above any real call duration.
 */
async function signedUrl(gcsFile) {
  const [url] = await gcsFile.getSignedUrl({
    action:  'read',
    expires: Date.now() + SIGNED_URL_TTL,
    version: 'v4'
  });
  return url;
}

/**
 * Delete all cached TTS files for a given language prefix.
 * Useful when you want to force re-synthesis after a voice config change.
 */
async function purgeTtsCache(lang) {
  const bucket = process.env.TTS_BUCKET;
  if (!bucket) throw new Error('TTS_BUCKET not set');
  const [files] = await storage.bucket(bucket).getFiles({ prefix: 'tts/' });
  // We can't filter by lang from the name alone, but metadata has it
  let deleted = 0;
  for (const f of files) {
    const [meta] = await f.getMetadata();
    if (!lang || meta.metadata?.lang === lang) {
      await f.delete();
      deleted++;
    }
  }
  return deleted;
}

module.exports = { synthesizeAndCache, synthesizeMany, purgeTtsCache };
