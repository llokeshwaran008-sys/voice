import express from 'express';
import cors from 'cors';
import { pipeline, env } from '@xenova/transformers';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

// Load .env in development
import 'dotenv/config';

// Tell transformers.js to run in Node.js environment
env.allowLocalModels = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Allow any frontend port to connect
app.use(cors());
app.use(express.json({ limit: '500mb' }));

// Cache the model so it only loads once
let transcriber = null;

async function getTranscriber() {
  if (!transcriber) {
    console.log('⏳ Loading Whisper model (first time may take a minute)...');
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-small',
      { quantized: true }
    );
    console.log('✅ Whisper model loaded and ready!');
  }
  return transcriber;
}

// ─── SSE Progress endpoint ─────────────────────────────────────────────────
const sessions = new Map();         // sessionId → { send, res, cancelled }

app.get('/progress/:id', (req, res) => {
  const id = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  sessions.set(id, { send, res, cancelled: false });

  req.on('close', () => {
    sessions.delete(id);
  });
});

// ─── Cancel endpoint ────────────────────────────────────────────────────────
app.delete('/cancel/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) {
    session.cancelled = true;
    session.send({ status: 'cancelled', message: 'Translation cancelled.' });
    console.log(`🛑 Session ${req.params.id} cancelled by user.`);
  }
  res.json({ ok: true });
});

// ─── Supported languages ───────────────────────────────────────────────────
const SUPPORTED_LANGUAGES = {
  tamil:     'Tamil',
  hindi:     'Hindi',
  telugu:    'Telugu',
  malayalam: 'Malayalam',
  kannada:   'Kannada',
};

// ─── Main translation endpoint ─────────────────────────────────────────────
app.post('/translate', async (req, res) => {
  const { audioData, sampleRate, sessionId, language = 'tamil' } = req.body;
  const session = sessions.get(sessionId);
  const notify  = session?.send;

  if (!audioData || !Array.isArray(audioData)) {
    return res.status(400).json({ error: 'audioData (Float32Array) required' });
  }

  const lang = SUPPORTED_LANGUAGES[language] ? language : 'tamil';
  console.log(`🌐 Language selected: ${SUPPORTED_LANGUAGES[lang]}`);

  try {
    const totalSamples = audioData.length;
    const totalSeconds = Math.round(totalSamples / (sampleRate || 16000));
    const totalChunks  = Math.max(1, Math.ceil(totalSeconds / 30));

    console.log(`🎧 Received audio: ${totalSamples} samples @ ${sampleRate}Hz (~${totalSeconds}s, ~${totalChunks} chunks)`);
    notify?.({ status: 'loading_model', message: 'Loading AI model...' });

    const model = await getTranscriber();
    const float32Audio = new Float32Array(audioData);

    if (session?.cancelled) return res.status(499).json({ error: 'Cancelled' });

    notify?.({ status: 'translating', chunk: 0, total: totalChunks, percent: 1, message: 'Starting translation...' });

    let chunksDone  = 0;
    const startTime = Date.now();
    const partialTexts = [];   // collect chunk texts for streaming

    console.log(`🔄 Running translation (${SUPPORTED_LANGUAGES[lang]} → English)...`);

    const result = await model(float32Audio, {
      language: lang,
      task: 'translate',
      chunk_length_s:  30,
      stride_length_s: 5,
      return_timestamps: true,          // enable sentence-level timestamps
      callback_function: (beams) => {
        // Check cancel
        if (session?.cancelled) return;

        chunksDone++;
        const pct     = Math.min(Math.round((chunksDone / totalChunks) * 100), 99);
        const elapsed = Date.now() - startTime;                       // ms elapsed
        const eta     = chunksDone > 0
          ? Math.round((elapsed / chunksDone) * (totalChunks - chunksDone) / 1000)
          : null;  // seconds remaining

        const elapsed_label = `Chunk ${chunksDone}/${totalChunks}`;
        console.log(`   ${elapsed_label} — ${pct}% — ETA: ${eta !== null ? eta + 's' : '?'}`);

        // Try to extract partial text from beams
        let partialText = '';
        try {
          if (beams && beams[0] && beams[0].output_token_ids) {
            // partial decode not available directly; emit placeholder
            partialText = `[Chunk ${chunksDone} processed]`;
          }
        } catch (_) {}

        notify?.({
          status:      'translating',
          chunk:       chunksDone,
          total:       totalChunks,
          percent:     pct,
          message:     `Processing ${elapsed_label} (${pct}%)...`,
          eta,                          // seconds remaining
          partialText,
        });
      },
    });

    if (session?.cancelled) return res.status(499).json({ error: 'Cancelled' });

    const translated = result.text?.trim();

    // ── Extract timestamps from chunks ──────────────────────────────────────
    // result.chunks → [{ text: "...", timestamp: [start, end] }, ...]
    const timestampedChunks = (result.chunks || []).map(c => ({
      text:  c.text?.trim() || '',
      start: c.timestamp?.[0] ?? null,
      end:   c.timestamp?.[1] ?? null,
    })).filter(c => c.text);

    // ── Confidence score ────────────────────────────────────────────────────
    // avg_logprob is in result metadata if available; otherwise estimate from chunks
    let confidence = null;
    if (result.chunks && result.chunks.length > 0) {
      // Whisper doesn't expose logprob via transformers.js directly,
      // so we estimate: penalize empty chunks
      const filledChunks = result.chunks.filter(c => c.text?.trim()).length;
      confidence = Math.round((filledChunks / Math.max(result.chunks.length, 1)) * 100);
    }

    console.log(`✅ Translation complete: "${translated?.substring(0, 80)}..."`);
    console.log(`   Chunks with timestamps: ${timestampedChunks.length}, Confidence: ${confidence}%`);

    notify?.({ status: 'done', message: 'Translation complete!' });

    res.json({
      success: true,
      text: translated,
      chunks: timestampedChunks,   // [{text, start, end}]
      confidence,                  // 0–100
      language: lang,
    });

  } catch (err) {
    console.error('❌ Translation error:', err);
    notify?.({ status: 'error', message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve React frontend in production ───────────────────────────────────
const distPath = join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // For any route not matched by API, send React's index.html
  app.get('*', (req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
  console.log('📦 Serving static React build from /dist');
}

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`   GET    /progress/:id  → SSE live progress stream`);
  console.log(`   POST   /translate     → Transcribes & translates audio`);
  console.log(`   DELETE /cancel/:id    → Cancels a running session`);
  console.log(`   Languages: ${Object.values(SUPPORTED_LANGUAGES).join(', ')}`);
  getTranscriber().catch(console.error);
});
