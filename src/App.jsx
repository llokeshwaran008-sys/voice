import React, { useState, useRef, useEffect } from 'react';
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
  Cpu
} from 'lucide-react';
import './index.css';

const SERVER_URL = 'http://localhost:3001';

export default function App() {
  const [view, setView] = useState('upload');
  const [audioUrl, setAudioUrl] = useState(null);
  const [processingStep, setProcessingStep] = useState('');
  const [progress, setProgress] = useState(0);       // 0–100
  const [chunkInfo, setChunkInfo] = useState('');    // e.g. "Chunk 3/30"
  const [englishText, setEnglishText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [dragActive, setDragActive] = useState(false);

  // Microphone states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  const fileInputRef = useRef(null);
  const eventSourceRef = useRef(null);

  // --- Search Highlighting ---
  const getHighlightedText = (text, highlight) => {
    if (!highlight.trim()) return text;
    const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === highlight.toLowerCase()
        ? <mark key={i} className="highlight-match">{part}</mark>
        : part
    );
  };

  // --- SSE Progress Stream ---
  const openProgressStream = (sessionId) => {
    // Close any old stream
    if (eventSourceRef.current) eventSourceRef.current.close();

    const es = new EventSource(`${SERVER_URL}/progress/${sessionId}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.status === 'loading_model') {
        setProcessingStep('Loading AI model...');
        setProgress(2);
        setChunkInfo('');
      } else if (data.status === 'translating') {
        setProcessingStep(data.message || 'Translating...');
        setProgress(data.percent || 5);
        setChunkInfo(data.total > 1 ? `Chunk ${data.chunk} of ${data.total}` : '');
      } else if (data.status === 'done') {
        setProgress(100);
        setChunkInfo('');
        es.close();
      } else if (data.status === 'error') {
        es.close();
      }
    };

    es.onerror = () => es.close();
    return sessionId;
  };

  // --- Translation Logic ---
  const translateAudio = async (file) => {
    setView('processing');
    setProcessingStep('Decoding audio...');
    setProgress(1);
    setChunkInfo('');
    setEnglishText('');
    setErrorMsg('');
    setSearchQuery('');

    // Unique session ID for SSE pairing
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
      // Decode audio to 16kHz mono Float32Array
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const float32 = audioBuffer.getChannelData(0);

      // Open SSE stream BEFORE sending the audio
      openProgressStream(sessionId);

      setProcessingStep('Sending to local AI...');
      setProgress(3);

      const response = await fetch(`${SERVER_URL}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioData: Array.from(float32),
          sampleRate: 16000,
          sessionId,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Server error');
      }

      const data = await response.json();
      if (!data.success || !data.text) throw new Error('No translation returned.');

      setEnglishText(data.text);
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

  // --- Microphone Logic ---
  const startRecording = async (e) => {
    e.stopPropagation();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        processFile(new File([blob], 'mic-recording.webm', { type: 'audio/webm' }));
        stream.getTracks().forEach(t => t.stop());
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
    };
  }, []);

  const formatTime = (s) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  const handleFileUpload = (e) => processFile(e.target.files[0]);
  const handleDrag = (e) => { e.preventDefault(); e.stopPropagation(); setDragActive(e.type === 'dragenter' || e.type === 'dragover'); };
  const handleDrop = (e) => { e.preventDefault(); e.stopPropagation(); setDragActive(false); processFile(e.dataTransfer.files?.[0]); };

  const handleExport = () => {
    if (!englishText) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([englishText], { type: 'text/plain' }));
    a.download = 'Translation_Export.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const handleCopy = () => { navigator.clipboard.writeText(englishText); alert('Copied!'); };

  const reset = () => {
    setView('upload'); setAudioUrl(null); setEnglishText('');
    setErrorMsg(''); setProcessingStep(''); setSearchQuery('');
    setProgress(0); setChunkInfo('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (eventSourceRef.current) eventSourceRef.current.close();
  };

  return (
    <div className="app-container">

      {/* ── PAGE 1: UPLOAD ── */}
      {view === 'upload' && (
        <div className="upload-wrapper">
          <div className="upload-header">
            <div className="logo-badge">
              <Cpu size={22} />
              <span>Local AI · 100% Private</span>
            </div>
            <h1>Translate Tamil Audio</h1>
            <p>Runs entirely on your computer — free, private, no internet needed.</p>
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

            <div className="upload-drop-text">
              Drag &amp; drop your Tamil audio file here
            </div>
            <div className="upload-drop-sub">or choose an option below</div>

            <div className="action-buttons-group">
              <button className="primary-button"
                onClick={(e) => { e.stopPropagation(); fileInputRef.current.click(); }}
                disabled={isRecording}>
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

      {/* ── PAGE 2: PROCESSING ── */}
      {view === 'processing' && (
        <div className="glass-panel processing-card">
          <div className="loader"></div>

          <h2 className="processing-title">Translating Your Audio</h2>
          <p className="processing-step">{processingStep}</p>

          {/* Live progress bar */}
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
          <div className="progress-meta">
            <span>{chunkInfo}</span>
            <span className="progress-pct">{progress}%</span>
          </div>

          {progress < 10 && (
            <p className="processing-hint">
              ⏱ Large files (15+ min) can take 10–25 minutes. Progress will update as each 30-second chunk is processed.
            </p>
          )}

          {audioUrl && (
            <div className="processing-audio">
              <audio src={audioUrl} controls />
            </div>
          )}
        </div>
      )}

      {/* ── PAGE 3: RESULT ── */}
      {view === 'result' && (
        <div className="glass-panel result-card">
          <div className="panels-container">
            {/* Left: Audio */}
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
                {audioUrl && <audio src={audioUrl} controls />}
              </div>
            </div>

            {/* Right: Translation */}
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

      {/* ── ERROR ── */}
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
