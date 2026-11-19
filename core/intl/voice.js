'use strict';

// Voice transcription is not wired into the engine yet: nothing calls processVoiceMessage.
// If it is wired later, it must stay behind the same INTL_AI_OPTIONS opt-in as the reply options,
// because the audio (a recording of the client) leaves the server.
const { request } = require('undici');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Download voice/audio file from Telegram Bot API as a Buffer
 */
async function downloadTelegramAudio(token, fileId) {
  if (!token || !fileId) return null;
  try {
    const fileRes = await request(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      method: 'GET',
      headersTimeout: 10000,
      bodyTimeout: 15000,
    });
    if (fileRes.statusCode !== 200) return null;
    const fileData = await fileRes.body.json();
    const filePath = fileData.result?.file_path;
    if (!filePath) return null;

    const audioRes = await request(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      method: 'GET',
      headersTimeout: 10000,
      bodyTimeout: 20000,
    });
    if (audioRes.statusCode !== 200) return null;
    const arrayBuf = await audioRes.body.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    console.warn('downloadTelegramAudio error:', err.message);
    return null;
  }
}

/**
 * Transcribe voice note audio buffer using Gemini Flash Speech-to-Text
 */
async function transcribeVoiceWithGemini(apiKey, audioBuffer, mimeType = 'audio/ogg') {
  if (!apiKey || !audioBuffer || !audioBuffer.length) return null;
  const base64Audio = audioBuffer.toString('base64');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const payload = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Audio,
            },
          },
          {
            text: 'Transcribe this voice recording accurately into the original language spoken (Russian, English, etc.). Output ONLY the raw transcript text without commentary, quotes, or markdown formatting.',
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 600,
    },
  };

  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
      body: JSON.stringify(payload),
      headersTimeout: 15000,
      bodyTimeout: 30000,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errText = await res.body.text();
      console.warn('Gemini audio transcription error:', errText.slice(0, 200));
      return null;
    }
    const data = await res.body.json();
    const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    return transcript;
  } catch (err) {
    console.warn('transcribeVoiceWithGemini network error:', err.message);
    return null;
  }
}

/**
 * Process Telegram voice or audio message into text
 */
async function processVoiceMessage(token, geminiApiKey, message) {
  const voiceObj = message.voice || message.audio;
  if (!voiceObj || !voiceObj.file_id) return null;
  if (!token || !geminiApiKey) return null;

  const audioBuf = await downloadTelegramAudio(token, voiceObj.file_id);
  if (!audioBuf) return null;

  const mime = voiceObj.mime_type || (message.voice ? 'audio/ogg' : 'audio/mp3');
  const transcript = await transcribeVoiceWithGemini(geminiApiKey, audioBuf, mime);
  return transcript;
}

module.exports = {
  downloadTelegramAudio,
  transcribeVoiceWithGemini,
  processVoiceMessage,
};
