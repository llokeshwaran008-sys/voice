import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  UploadCloud,
  Download,
  Copy,
  PlaySquare,
  FileAudio,
  Type,
  MessageSquare,
  AlertCircle,
  RefreshCw,
  Mic,
  Square,
  Search,
  Cpu,
  Sun,
  Moon,
  Clock,
  CheckCircle2,
  XCircle,
  Languages,
  Timer,
} from 'lucide-react';
import './index.css';

// In production (Render), frontend & backend are on the same origin.
// In dev, use localhost:3001.
const SERVER_URL = import.meta.env.VITE_API_URL ||
  (window.location.hostname === 'localhost' ? 'http://localhost:3001' : '');

const LANGUAGES = [
  { code: 'tamil', label: 'Tamil', flag: '🇮🇳' },
  { code: 'hindi', label: 'Hindi', flag: '🇮🇳' },
  { code: 'telugu', label: 'Telugu', flag: '🇮🇳' },
  { code: 'malayalam', label: 'Malayalam', flag: '🇮🇳' },
  { code: 'kannada', label: 'Kannada', flag: '🇮🇳' },
];

export default function App() {
  // ── Theme ──────────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // ── Core state ─────────────────────────────────────────────────────────────
  const [view, setView] = useState('upload');
  const [audioUrl, setAudioUrl] = useState(null);
  const [processingStep, setProcessingStep] = useState('');
  const [progress, setProgress] = useState(0);
  const [chunkInfo, setChunkInfo] = useState('');
  const [eta, setEta] = useState(null);                // seconds remaining
  const [englishText, setEnglishText] = useState('');
  const [streamingChunks, setStreamingChunks] = useState([]);  // partial text as it arrives
  const [errorMsg, setErrorMsg] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState('tamil');
  const [confidence, setConfidence] = useState(null);   // 0-100
  const [timestamps, setTimestamps] = useState([]);     // [{text, start, end}]
  const [searchQuery, setSearchQuery] = useState('');
  const [sessionId, setSessionId] = useState(null);

  // ── Mic state ──────────────────────────────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);

  // ── Waveform ───────────────────────────────────────────────────────────────
  const waveCanvasRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);

  // ── Playback seek ref (for timestamp pills) ────────────────────────────────
  const audioRef = useRef(null);

  const fileInputRef = useRef(null);
  const eventSourceRef = useRef(null);

  // ── Waveform drawing ───────────────────────────────────────────────────────
  const drawWaveform = useCallback(() => {
    const canvas = waveCanvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const bufLen = analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, W, H);

    const barW = (W / bufLen) * 2.5;
    const isDark = theme === 'dark';

    for (let i = 0, x = 0; i < bufLen; i++) {
      const barH = (data[i] / 255) * H;
      const hue = 260 + (i / bufLen) * 80;  // purple → pink gradient
      ctx.fillStyle = isDark
        ? `hsla(${hue}, 80%, 65%, 0.85)`
        : `hsla(${hue}, 70%, 45%, 0.85)`;
      ctx.fillRect(x, H - barH, barW - 1, barH);
      x += barW + 1;
    }

    animFrameRef.current = requestAnimationFrame(drawWaveform);
  }, [theme]);

  const stopWaveform = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    analyserRef.current = null;
    if (waveCanvasRef.current) {
      const ctx = waveCanvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, waveCanvasRef.current.width, waveCanvasRef.current.height);
    }
  }, []);

  // ── Search highlighting ────────────────────────────────────────────────────
  const getHighlightedText = (text, highlight) => {
    if (!highlight.trim()) return text;
    const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === highlight.toLowerCase()
        ? <mark key={i} className="highlight-match">{part}</mark>
        : part
    );
  };

  // ── SSE Progress stream ────────────────────────────────────────────────────
  const openProgressStream = (sid) => {
    if (eventSourceRef.current) eventSourceRef.current.close();

    const es = new EventSource(`${SERVER_URL}/progress/${sid}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.status === 'loading_model') {
        setProcessingStep('Loading AI model...');
        setProgress(2);
        setChunkInfo('');
        setEta(null);
      } else if (data.status === 'translating') {
        setProcessingStep(data.message || 'Translating...');
        setProgress(data.percent || 5);
        setChunkInfo(data.total > 1 ? `Chunk ${data.chunk} of ${data.total}` : '');
        if (data.eta !== null && data.eta !== undefined) setEta(data.eta);
      } else if (data.status === 'done') {
        setProgress(100);
        setChunkInfo('');
        setEta(null);
        es.close();
      } else if (data.status === 'error' || data.status === 'cancelled') {
        es.close();
      }
    };

    es.onerror = () => es.close();
    return sid;
  };

  // ── Cancel translation ─────────────────────────────────────────────────────
  const handleCancel = async () => {
    if (!sessionId) return;
    try {
      await fetch(`${SERVER_URL}/cancel/${sessionId}`, { method: 'DELETE' });
    } catch (_) { }
    if (eventSourceRef.current) eventSourceRef.current.close();
    reset();
  };

  // ── Translation logic ──────────────────────────────────────────────────────
  const translateAudio = async (file) => {
    setView('processing');
    setProcessingStep('Decoding audio...');
    setProgress(1);
    setChunkInfo('');
    setEta(null);
    setEnglishText('');
    setStreamingChunks([]);
    setErrorMsg('');
    setSearchQuery('');
    setConfidence(null);
    setTimestamps([]);

    const sid = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setSessionId(sid);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const float32 = audioBuffer.getChannelData(0);

      openProgressStream(sid);

      setProcessingStep('Sending to local AI...');
      setProgress(3);

      const response = await fetch(`${SERVER_URL}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioData: Array.from(float32),
          sampleRate: 16000,
          sessionId: sid,
          language: selectedLanguage,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Server error');
      }

      const data = await response.json();
      if (!data.success || !data.text) throw new Error('No translation returned.');

      setEnglishText(data.text);
      setConfidence(data.confidence ?? null);
      setTimestamps(data.chunks || []);
      setProgress(100);
      setView('result');
    } catch (err) {
      console.error(err);
      setErrorMsg(err.message);
      setView('error');
    } finally {
      if (eventSourceRef.current) eventSourceRef.current.close();
    }
  };

  const processFile = (file) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !file.type.startsWith('video/webm')) {
      alert('Please upload a valid audio file (mp3, wav, m4a, webm, etc.)');
      return;
    }
    setAudioUrl(URL.createObjectURL(file));
    translateAudio(file);
  };

  // ── Mic logic ──────────────────────────────────────────────────────────────
  const startRecording = async (e) => {
    e.stopPropagation();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // ── Waveform analyser ────────────────────────────────────────────────
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      drawWaveform();

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      mediaRecorder.onstop = () => {
        stopWaveform();
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        processFile(new File([blob], 'mic-recording.webm', { type: 'audio/webm' }));
        stream.getTracks().forEach(t => t.stop());
        audioCtx.close();
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime(p => p + 1), 1000);
    } catch (err) {
      alert('Could not access microphone. Please allow microphone permission.');
    }
  };

  const stopRecording = (e) => {
    if (e) e.stopPropagation();
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      clearInterval(timerRef.current);
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (eventSourceRef.current) eventSourceRef.current.close();
      stopWaveform();
    };
  }, [stopWaveform]);

  const formatTime = (s) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  const formatETA = (s) => {
    if (s === null || s === undefined) return null;
    if (s < 60) return `~${s}s remaining`;
    const m = Math.floor(s / 60), sec = s % 60;
    return `~${m}m ${sec}s remaining`;
  };

  const handleFileUpload = (e) => processFile(e.target.files[0]);
  const handleDrag = (e) => { e.preventDefault(); e.stopPropagation(); setDragActive(e.type === 'dragenter' || e.type === 'dragover'); };
  const handleDrop = (e) => { e.preventDefault(); e.stopPropagation(); setDragActive(false); processFile(e.dataTransfer.files?.[0]); };

  const handleExport = () => {
    if (!englishText) return;
    const content = timestamps.length > 0
      ? timestamps.map(c => `[${formatTime(Math.round(c.start || 0))}] ${c.text}`).join('\n')
      : englishText;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    a.download = 'Translation_Export.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(englishText);
    alert('Copied!');
  };

  const seekAudio = (seconds) => {
    if (audioRef.current && seconds !== null) {
      audioRef.current.currentTime = seconds;
      audioRef.current.play();
    }
  };

  const reset = () => {
    setView('upload'); setAudioUrl(null); setEnglishText('');
    setErrorMsg(''); setProcessingStep(''); setSearchQuery('');
    setProgress(0); setChunkInfo(''); setEta(null);
    setConfidence(null); setTimestamps([]); setStreamingChunks([]);
    setSessionId(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (eventSourceRef.current) eventSourceRef.current.close();
  };

  // ── Confidence color helper ────────────────────────────────────────────────
  const confidenceColor = (c) => {
    if (c >= 80) return 'var(--success)';
    if (c >= 50) return '#f59e0b';
    return 'var(--error)';
  };

  const selectedLang = LANGUAGES.find(l => l.code === selectedLanguage);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* ── Theme Toggle (global, top-right) ── */}
      <button
        className="theme-toggle"
        onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        title="Toggle theme"
        aria-label="Toggle theme"
      >
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      {/* ══════════════════════════════════════════════════════════════════════
          PAGE 1: UPLOAD
      ══════════════════════════════════════════════════════════════════════ */}
      {view === 'upload' && (
        <div className="upload-wrapper">
          <div className="upload-header">
            <div className="logo-badge">
              <Cpu size={22} />
              <span>Local AI · 100% Private</span>
            </div>
            <h1>Translate Audio to English</h1>
            <p>Runs entirely on your computer — free, private, no internet needed.</p>
          </div>

          {/* ── Language Selector ── */}
          <div className="lang-selector-row">
            <Languages size={18} className="lang-icon" />
            <span className="lang-label">Source Language:</span>
            <div className="lang-pills">
              {LANGUAGES.map(l => (
                <button
                  key={l.code}
                  className={`lang-pill ${selectedLanguage === l.code ? 'active' : ''}`}
                  onClick={() => setSelectedLanguage(l.code)}
                >
                  {l.flag} {l.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className={`glass-panel upload-box ${dragActive ? 'drag-active' : ''}`}
            onDragEnter={handleDrag} onDragLeave={handleDrag}
            onDragOver={handleDrag} onDrop={handleDrop}
            onClick={() => !isRecording && fileInputRef.current.click()}
          >
            <div className="icon-circle">
              <PlaySquare size={48} />
            </div>

            {/* ── Live Waveform Canvas (visible while recording) ── */}
            <canvas
              ref={waveCanvasRef}
              className={`waveform-canvas ${isRecording ? 'visible' : ''}`}
              width={460} height={80}
            />

            <div className="upload-drop-text">
              {isRecording
                ? `🎙️ Recording… ${formatTime(recordingTime)}`
                : `Drag & drop your ${selectedLang?.label || 'audio'} file here`}
            </div>
            <div className="upload-drop-sub">or choose an option below</div>

            <div className="action-buttons-group">
              <button
                className="primary-button"
                onClick={(e) => { e.stopPropagation(); fileInputRef.current.click(); }}
                disabled={isRecording}
              >
                <UploadCloud size={20} /> Browse Files
              </button>

              {isRecording
                ? <button className="mic-button recording" onClick={stopRecording}>
                  <Square size={20} /> Stop · {formatTime(recordingTime)}
                </button>
                : <button className="mic-button" onClick={startRecording}>
                  <Mic size={20} /> Record Audio
                </button>
              }
            </div>

            <input type="file" ref={fileInputRef} onChange={handleFileUpload}
              accept="audio/*" style={{ display: 'none' }} />

            <div className="upload-formats">
              <FileAudio size={15} />
              <span>mp3 · wav · m4a · ogg · webm &nbsp;·&nbsp; Max 500 MB</span>
            </div>
          </div>

          {/* Tips */}
          <div className="tip-row">
            <div className="tip-card">⚡ Short clips (&lt;2 min) translate in under 2 minutes</div>
            <div className="tip-card">🧠 15-min audio may take 10–25 minutes on CPU</div>
            <div className="tip-card">🔒 Audio never leaves your computer</div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          PAGE 2: PROCESSING
      ══════════════════════════════════════════════════════════════════════ */}
      {view === 'processing' && (
        <div className="glass-panel processing-card">
          <div className="loader"></div>

          <h2 className="processing-title">Translating Your Audio</h2>
          <p className="processing-step">{processingStep}</p>

          {/* Progress bar */}
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
          <div className="progress-meta">
            <span>{chunkInfo}</span>
            <span className="progress-pct">{progress}%</span>
          </div>

          {/* ETA badge */}
          {eta !== null && eta > 0 && (
            <div className="eta-badge">
              <Timer size={14} />
              {formatETA(eta)}
            </div>
          )}

          {progress < 10 && (
            <p className="processing-hint">
              ⏱ Large files (15+ min) can take 10–25 minutes. Progress updates as each 30-second chunk finishes.
            </p>
          )}

          {audioUrl && (
            <div className="processing-audio">
              <audio src={audioUrl} controls />
            </div>
          )}

          {/* Cancel button */}
          <button className="cancel-button" onClick={handleCancel}>
            <XCircle size={16} /> Cancel
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          PAGE 3: RESULT
      ══════════════════════════════════════════════════════════════════════ */}
      {view === 'result' && (
        <div className="glass-panel result-card">
          <div className="panels-container">

            {/* Left: Audio + metadata */}
            <div className="panel" style={{ flex: '0.38' }}>
              <div className="panel-header">
                <span className="panel-title">
                  <MessageSquare size={18} /> Source Audio
                </span>
                <button className="icon-button" onClick={reset} title="New file">
                  <RefreshCw size={15} />
                </button>
              </div>

              <div className="audio-player-wrap">
                {audioUrl && (
                  <audio
                    ref={audioRef}
                    src={audioUrl}
                    controls
                  />
                )}
              </div>

              {/* ── Confidence Badge ── */}
              {confidence !== null && (
                <div className="confidence-card">
                  <div className="confidence-label">
                    <CheckCircle2 size={16} style={{ color: confidenceColor(confidence) }} />
                    Translation Confidence
                  </div>
                  <div className="confidence-bar-track">
                    <div
                      className="confidence-bar-fill"
                      style={{
                        width: `${confidence}%`,
                        background: confidenceColor(confidence),
                      }}
                    />
                  </div>
                  <div className="confidence-pct" style={{ color: confidenceColor(confidence) }}>
                    {confidence}%
                  </div>
                </div>
              )}

              {/* ── Language tag ── */}
              <div className="meta-tag">
                <Languages size={14} />
                {LANGUAGES.find(l => l.code === selectedLanguage)?.label || selectedLanguage} → English
              </div>

              {/* ── Timestamp pills (if available) ── */}
              {timestamps.length > 0 && (
                <div className="timestamps-section">
                  <div className="timestamps-title">
                    <Clock size={15} /> Segments
                  </div>
                  <div className="timestamps-list">
                    {timestamps.map((chunk, i) => (
                      <button
                        key={i}
                        className="timestamp-pill"
                        onClick={() => seekAudio(chunk.start)}
                        title={`Seek to ${formatTime(Math.round(chunk.start || 0))}`}
                      >
                        <span className="ts-time">
                          {chunk.start !== null ? formatTime(Math.round(chunk.start)) : '??'}
                        </span>
                        <span className="ts-text">{chunk.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right: Translation text */}
            <div className="panel" style={{ flex: '0.62' }}>
              <div className="panel-header">
                <span className="panel-title">
                  <Type size={18} /> English Translation
                </span>
                <div className="action-buttons">
                  <div className="search-container">
                    <Search size={15} color="#666" />
                    <input
                      type="text"
                      placeholder="Search..."
                      className="search-input"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <button className="icon-button" onClick={handleCopy} title="Copy">
                    <Copy size={16} />
                  </button>
                  <button className="primary-button btn-sm" onClick={handleExport}>
                    <Download size={15} /> Export
                  </button>
                </div>
              </div>
              <div className="panel-content translated-content">
                {getHighlightedText(englishText, searchQuery)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ERROR
      ══════════════════════════════════════════════════════════════════════ */}
      {view === 'error' && (
        <div className="glass-panel processing-card">
          <AlertCircle size={52} color="#ef4444" style={{ marginBottom: '1.5rem' }} />
          <h2 className="processing-title" style={{ color: '#ef4444' }}>Translation Failed</h2>
          <p className="processing-step">{errorMsg}</p>
          <button className="primary-button" style={{ marginTop: '2rem' }} onClick={reset}>
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      )}
    </div>
  );
}
