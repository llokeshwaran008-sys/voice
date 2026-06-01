import express from 'express';
import cors from 'cors';
import { pipeline, env } from '@xenova/transformers';

// Tell transformers.js to run in Node.js environment
env.allowLocalModels = false;

const app = express();
const PORT = 3001;

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
// The frontend connects here FIRST, gets a session ID, then POSTs audio
// This endpoint streams back progress events
const sessions = new Map();

app.get('/progress/:id', (req, res) => {
  const id = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sessions.set(id, { send, res });

  req.on('close', () => {
    sessions.delete(id);
  });
});

// ─── Main translation endpoint ─────────────────────────────────────────────
app.post('/translate', async (req, res) => {
  const { audioData, sampleRate, sessionId } = req.body;
  const notify = sessions.get(sessionId)?.send;

  if (!audioData || !Array.isArray(audioData)) {
    return res.status(400).json({ error: 'audioData (Float32Array) required' });
  }

  try {
    const totalSamples = audioData.length;
    const totalSeconds = Math.round(totalSamples / (sampleRate || 16000));
    const totalChunks = Math.max(1, Math.ceil(totalSeconds / 30));

    console.log(`🎧 Received audio: ${totalSamples} samples @ ${sampleRate}Hz (~${totalSeconds}s, ~${totalChunks} chunks)`);
    notify?.({ status: 'loading_model', message: 'Loading AI model...' });

    const model = await getTranscriber();
    const float32Audio = new Float32Array(audioData);

    notify?.({ status: 'translating', chunk: 0, total: totalChunks, message: 'Starting translation...' });

    let chunksDone = 0;

    console.log('🔄 Running translation (Tamil → English)...');
    const result = await model(float32Audio, {
      language: 'tamil',
      task: 'translate',
      chunk_length_s: 30,
      stride_length_s: 5,
      callback_function: (beams) => {
        // called after each chunk is processed
        chunksDone++;
        const pct = Math.min(Math.round((chunksDone / totalChunks) * 100), 99);
        const elapsed = `Chunk ${chunksDone}/${totalChunks}`;
        console.log(`   ${elapsed} — ${pct}%`);
        notify?.({
          status: 'translating',
          chunk: chunksDone,
          total: totalChunks,
          percent: pct,
          message: `Processing ${elapsed} (${pct}%)...`,
        });
      },
    });

    const translated = result.text?.trim();
    console.log(`✅ Translation complete: "${translated?.substring(0, 80)}..."`);

    notify?.({ status: 'done', message: 'Translation complete!' });

    res.json({ success: true, text: translated });
  } catch (err) {
    console.error('❌ Translation error:', err);
    notify?.({ status: 'error', message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Free Local Translation Server running at http://localhost:${PORT}`);
  console.log(`   GET  /progress/:id  → SSE live progress stream`);
  console.log(`   POST /translate     → Transcribes & translates Tamil audio`);
  getTranscriber().catch(console.error);
});
