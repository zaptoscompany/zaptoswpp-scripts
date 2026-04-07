/*!
 * Zaptos GHL Media Tools - v5.4
 * Audio recorder + attachment previews for GHL
 * Copyright (c) 2025 Zaptos Company - Apache-2.0
 */
(function () {
  if (window.__ZAPTOS_GHL_MEDIA_MP3__ === 'v5.4') return;
  window.__ZAPTOS_GHL_MEDIA_MP3__ = 'v5.4';

  const preferFormat = 'mp3';
  const MP3_BITRATE = 128;
  const MP3_SAMPLE_RATE = 44100;
  const BUFFER_SIZE = 4096;
  const log = (...args) => console.log('[Zaptos][MediaTools]', ...args);

  window.__ZAPTOS_REC_ACTIVE__ = false;

  const MIC_ICON = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="8" y="3" width="8" height="12" rx="4" stroke="currentColor" stroke-width="1.8"/>
      <path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M12 17v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M9 21h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>
  `;

  const STOP_ICON = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
    </svg>
  `;

  const loadLame = () => new Promise((resolve) => {
    if (window.lamejs) return resolve(true);

    const urls = [
      'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
      'https://unpkg.com/lamejs@1.2.1/lame.min.js'
    ];

    let i = 0;
    (function next() {
      if (i >= urls.length) return resolve(false);
      const script = document.createElement('script');
      script.src = urls[i++];
      script.async = true;
      script.onload = () => resolve(!!window.lamejs);
      script.onerror = next;
      document.head.appendChild(script);
    })();
  });

  const waitFor = (predicate, { tries = 60, gap = 250 } = {}) => new Promise((resolve) => {
    const timer = setInterval(() => {
      const value = predicate();
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (--tries <= 0) {
        clearInterval(timer);
        resolve(null);
      }
    }, gap);
  });

  // ===== GHL selectors =====
  const findBottomBar = () => {
    const list = document.querySelectorAll("div.flex.items-center.h-\\[40px\\]");
    const visible = [...list].filter((el) => el.offsetParent !== null);

    return visible.find((el) =>
      el.querySelector("div[class*='flex-row'][class*='min-w-0']") &&
      el.querySelector("div[class*='border-l'][class*='gap-1']")
    ) || visible[0] || null;
  };

  const findLeftIconGroup = () => {
    const bar = findBottomBar();
    if (!bar) return null;
    return bar.querySelector("div[class*='flex-row'][class*='items-center'][class*='pl-2'][class*='min-w-0']");
  };

  const findLegacyToolbar = () => {
    const composer = document.querySelector("div[data-testid*='composer'], div[data-rbd-droppable-id]");
    if (!composer) return null;

    let best = null;
    let bestCount = 0;

    composer.querySelectorAll("div[role='group'],div[class*='toolbar'],div:has(button,svg)").forEach((node) => {
      const count = node.querySelectorAll('button,[role="button"],svg').length;
      if (count > bestCount) {
        best = node;
        bestCount = count;
      }
    });

    return best || composer;
  };

  const findFileInput = () =>
    document.querySelector("input[type='file'][accept*='audio']") ||
    document.querySelector("input[type='file'][accept*='audio/*']") ||
    document.querySelector("input[type='file']");

  const simulateUpload = (file) => {
    let input = findFileInput();
    if (!input) {
      const bar = findBottomBar() || findLegacyToolbar();
      const clip = bar && [...bar.querySelectorAll('svg')].find((svg) => /clip|attach|paper|anex/i.test(svg.outerHTML));
      if (clip) clip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      input = findFileInput();
    }

    if (!input) {
      alert('Campo de upload nao encontrado.');
      return false;
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // ===== audio helpers =====
  const floatTo16 = (floatBuffer) => {
    const int16 = new Int16Array(floatBuffer.length);
    for (let i = 0; i < floatBuffer.length; i++) {
      const s = Math.max(-1, Math.min(1, floatBuffer[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
  };

  const mergeChunks = (chunks) => {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;

    const merged = new Float32Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return merged;
  };

  const getPeak = (samples) => {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }
    return peak;
  };

  const normalizePeak = (samples, targetPeak = 0.93) => {
    const peak = getPeak(samples);
    if (!peak || peak <= targetPeak) return samples;

    const gain = targetPeak / peak;
    const normalized = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) normalized[i] = samples[i] * gain;
    return normalized;
  };

  const applyEdgeFade = (samples, sampleRate, fadeMs = 8) => {
    const fadeLength = Math.min(Math.floor((sampleRate * fadeMs) / 1000), Math.floor(samples.length / 2));
    if (fadeLength <= 1) return samples;

    const out = new Float32Array(samples);
    for (let i = 0; i < fadeLength; i++) {
      const gain = i / fadeLength;
      out[i] *= gain;
      out[out.length - 1 - i] *= gain;
    }
    return out;
  };

  const resampleLinear = (samples, fromRate, toRate) => {
    if (!samples.length || fromRate === toRate) return samples;

    const ratio = fromRate / toRate;
    const outLength = Math.max(1, Math.round(samples.length / ratio));
    const out = new Float32Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const next = Math.min(idx + 1, samples.length - 1);
      const frac = pos - idx;
      out[i] = samples[idx] + (samples[next] - samples[idx]) * frac;
    }

    return out;
  };

  const prepForEncoding = (samples, fromRate, toRate) => {
    const resampled = resampleLinear(samples, fromRate, toRate);
    const normalized = normalizePeak(resampled);
    return applyEdgeFade(normalized, toRate, 8);
  };

  const encodeWAV = (samples, sampleRate) => {
    const channels = 1;
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;

    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    let offset = 0;
    writeStr(offset, 'RIFF'); offset += 4;
    view.setUint32(offset, 36 + samples.length * bytesPerSample, true); offset += 4;
    writeStr(offset, 'WAVE'); offset += 4;
    writeStr(offset, 'fmt '); offset += 4;
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint16(offset, channels, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, byteRate, true); offset += 4;
    view.setUint16(offset, blockAlign, true); offset += 2;
    view.setUint16(offset, 16, true); offset += 2;
    writeStr(offset, 'data'); offset += 4;
    view.setUint32(offset, samples.length * bytesPerSample, true); offset += 4;

    const int16 = floatTo16(samples);
    for (let i = 0; i < int16.length; i++, offset += 2) view.setInt16(offset, int16[i], true);

    return new Blob([view], { type: 'audio/wav' });
  };

  const encodeMP3 = (samples, sampleRate, kbps = 128) => {
    const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const pcm16 = floatTo16(samples);
    const chunkSize = 1152;
    const parts = [];

    for (let i = 0; i < pcm16.length; i += chunkSize) {
      const out = encoder.encodeBuffer(pcm16.subarray(i, i + chunkSize));
      if (out.length) parts.push(out);
    }

    const end = encoder.flush();
    if (end.length) parts.push(end);

    return new Blob(parts, { type: 'audio/mpeg' });
  };

  // ===== preview =====
  const showPreview = (file, anchorBtn) => {
    const old = document.getElementById('zaptos-preview');
    if (old && typeof old.__zaptosDestroy === 'function') old.__zaptosDestroy();
    else if (old) old.remove();

    const box = document.createElement('div');
    box.id = 'zaptos-preview';
    Object.assign(box.style, {
      position: 'fixed',
      zIndex: 9999,
      left: '0px',
      top: '0px',
      display: 'flex',
      gap: '10px',
      alignItems: 'center',
      background: '#f8fafc',
      border: '1px solid #e4e7ec',
      padding: '12px 14px',
      borderRadius: '14px',
      boxShadow: '0 10px 24px rgba(16, 24, 40, 0.12)',
      maxWidth: 'calc(100vw - 24px)'
    });

    const audio = document.createElement('audio');
    const objectUrl = URL.createObjectURL(file);
    audio.controls = true;
    audio.src = objectUrl;
    audio.style.maxWidth = '360px';

    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = 'Enviar';
    Object.assign(send.style, {
      padding: '9px 14px',
      background: '#16a34a',
      color: '#fff',
      border: 'none',
      borderRadius: '9px',
      cursor: 'pointer',
      fontWeight: 600,
      fontSize: '14px'
    });

    const redo = document.createElement('button');
    redo.type = 'button';
    redo.textContent = 'Regravar';
    Object.assign(redo.style, {
      padding: '9px 14px',
      background: '#dc2626',
      color: '#fff',
      border: 'none',
      borderRadius: '9px',
      cursor: 'pointer',
      fontWeight: 600,
      fontSize: '14px'
    });

    const offset = 10;
    const reposition = () => {
      const rect = (anchorBtn || document.getElementById('zaptos-rec-btn'))?.getBoundingClientRect();
      if (!rect) return;

      const boxWidth = box.offsetWidth;
      const boxHeight = box.offsetHeight;
      let left = Math.round(rect.left + rect.width / 2 - boxWidth / 2);
      let top = Math.round(rect.top - boxHeight - offset);

      if (top < 8) top = Math.round(rect.bottom + offset);
      if (left < 8) left = 8;
      if (left > window.innerWidth - boxWidth - 8) left = window.innerWidth - boxWidth - 8;

      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
    };

    const closePreview = () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      URL.revokeObjectURL(objectUrl);
      box.remove();
    };

    send.onclick = () => {
      simulateUpload(file);
      closePreview();
    };

    redo.onclick = () => closePreview();

    box.append(audio, send, redo);
    document.body.appendChild(box);

    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    reposition();

    box.__zaptosDestroy = closePreview;
  };

  // ===== recorder UI =====
  function createRecorderUI() {
    if (document.getElementById('zaptos-rec-btn')) return;

    const leftGroup = findLeftIconGroup();
    const toolbar = leftGroup || findLegacyToolbar();
    if (!toolbar) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'zaptos-rec-wrapper';
    Object.assign(wrapper.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      marginLeft: '4px',
      marginRight: '2px'
    });

    const btn = document.createElement('button');
    btn.id = 'zaptos-rec-btn';
    btn.type = 'button';
    btn.title = 'Gravar audio';
    btn.setAttribute('aria-label', 'Gravar audio');
    btn.innerHTML = MIC_ICON;
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      borderRadius: '8px',
      background: 'transparent',
      color: '#475467',
      border: '1px solid transparent',
      cursor: 'pointer',
      transition: 'all .16s ease'
    });

    const timer = document.createElement('span');
    timer.id = 'zaptos-timer';
    timer.textContent = '00:00';
    Object.assign(timer.style, {
      fontSize: '13px',
      lineHeight: '1',
      fontWeight: 500,
      color: '#667085',
      letterSpacing: '0.2px',
      minWidth: '42px'
    });

    const setIdleVisual = () => {
      btn.innerHTML = MIC_ICON;
      btn.style.background = 'transparent';
      btn.style.borderColor = 'transparent';
      btn.style.color = '#475467';
      timer.style.color = '#667085';
      timer.style.fontWeight = '500';
    };

    const setRecordingVisual = () => {
      btn.innerHTML = STOP_ICON;
      btn.style.background = '#2f6fed';
      btn.style.borderColor = '#2f6fed';
      btn.style.color = '#ffffff';
      timer.style.color = '#2f6fed';
      timer.style.fontWeight = '600';
    };

    btn.addEventListener('mouseenter', () => {
      if (window.__ZAPTOS_REC_ACTIVE__) return;
      btn.style.background = '#f2f4f7';
      btn.style.borderColor = '#e4e7ec';
    });

    btn.addEventListener('mouseleave', () => {
      if (window.__ZAPTOS_REC_ACTIVE__) return;
      setIdleVisual();
    });

    if (leftGroup) leftGroup.prepend(wrapper);
    else toolbar.appendChild(wrapper);
    wrapper.append(btn, timer);

    let audioContext = null;
    let sourceNode = null;
    let processorNode = null;
    let sinkNode = null;
    let mediaStream = null;
    let buffers = [];
    let seconds = 0;
    let timerHandle = null;
    let sourceSampleRate = 44100;
    let isStarting = false;
    let isStopping = false;

    const tick = () => {
      seconds++;
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      timer.textContent = `${mm}:${ss}`;
    };

    const resetTimer = () => {
      clearInterval(timerHandle);
      seconds = 0;
      timer.textContent = '00:00';
    };

    const cleanupAudioGraph = async () => {
      try { sourceNode && sourceNode.disconnect(); } catch {}
      try { processorNode && processorNode.disconnect(); } catch {}
      try { sinkNode && sinkNode.disconnect(); } catch {}
      try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
      try { audioContext && audioContext.close(); } catch {}

      audioContext = null;
      sourceNode = null;
      processorNode = null;
      sinkNode = null;
      mediaStream = null;
    };

    const start = async () => {
      if (window.__ZAPTOS_REC_ACTIVE__ || isStarting || isStopping) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        alert('Navegador sem suporte a microfone.');
        return;
      }

      isStarting = true;

      try {
        buffers = [];
        resetTimer();

        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
            sampleRate: 48000,
            sampleSize: 16
          }
        });

        try {
          audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 48000,
            latencyHint: 'interactive'
          });
        } catch {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        sourceSampleRate = audioContext.sampleRate;

        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
        sinkNode = audioContext.createGain();
        sinkNode.gain.value = 0;

        processorNode.onaudioprocess = (event) => {
          if (!window.__ZAPTOS_REC_ACTIVE__) return;
          const chunk = event.inputBuffer.getChannelData(0);
          buffers.push(new Float32Array(chunk));
        };

        sourceNode.connect(processorNode);
        processorNode.connect(sinkNode);
        sinkNode.connect(audioContext.destination);

        window.__ZAPTOS_REC_ACTIVE__ = true;
        timerHandle = setInterval(tick, 1000);
        setRecordingVisual();
      } catch (error) {
        log('microphone start error', error);
        await cleanupAudioGraph();
        alert('Nao foi possivel iniciar a gravacao. Verifique permissoes de microfone.');
      } finally {
        isStarting = false;
      }
    };

    const stop = async () => {
      if (!window.__ZAPTOS_REC_ACTIVE__ || isStopping) return;
      isStopping = true;

      window.__ZAPTOS_REC_ACTIVE__ = false;
      resetTimer();
      setIdleVisual();

      try {
        await cleanupAudioGraph();

        const merged = mergeChunks(buffers);
        buffers = [];

        if (!merged.length) {
          alert('Nenhum audio foi capturado.');
          return;
        }

        const prepared = prepForEncoding(merged, sourceSampleRate, MP3_SAMPLE_RATE);

        let blob;
        let fileName;

        try {
          if (preferFormat === 'mp3' && window.lamejs) {
            blob = encodeMP3(prepared, MP3_SAMPLE_RATE, MP3_BITRATE);
            fileName = 'gravacao.mp3';
          } else {
            throw new Error('mp3 encoder unavailable');
          }
        } catch {
          blob = encodeWAV(prepared, MP3_SAMPLE_RATE);
          fileName = 'gravacao.wav';
        }

        showPreview(new File([blob], fileName, { type: blob.type }), btn);
      } finally {
        isStopping = false;
      }
    };

    btn.onclick = () => {
      if (window.__ZAPTOS_REC_ACTIVE__) stop();
      else start();
    };

    setIdleVisual();
  }

  // ===== attachment previews =====
  function enhanceAttachmentPlayers(root = document) {
    if (window.__ZAPTOS_REC_ACTIVE__) return;

    const selector = [
      'a.sms-file-attachment',
      "a[href$='.mp3'],a[href$='.wav'],a[href$='.ogg'],a[href$='.webm'],a[href$='.mp4'],a[href$='.mov'],a[href$='.gif'],a[href$='.webp'],a[href$='.png'],a[href$='.jpg'],a[href$='.jpeg'],a[href$='.bmp']",
      "div a[href*='.mp3'],div a[href*='.wav'],div a[href*='.ogg'],div a[href*='.webm'],div a[href*='.mp4'],div a[href*='.mov'],div a[href*='.gif'],div a[href*='.webp'],div a[href*='.png'],div a[href*='.jpg'],div a[href*='.jpeg'],div a[href*='.bmp']"
    ].join(',');

    const links = [...root.querySelectorAll(selector)];

    for (const link of links) {
      if (!link || link.dataset.zaptosEnhanced) continue;

      const href = link.getAttribute('href') || link.textContent || '';
      if (!href) continue;

      link.dataset.zaptosEnhanced = 'true';

      let url = href;
      try { url = new URL(href, location.href).href; } catch {}

      const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
      if (!ext) continue;

      if (['mp3', 'wav', 'webm', 'ogg'].includes(ext)) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = url;
        audio.style.maxWidth = '320px';
        link.replaceWith(audio);
      } else if (['mp4', 'mov', 'webm'].includes(ext)) {
        const video = document.createElement('video');
        video.controls = true;
        video.width = 320;
        video.src = url;
        link.replaceWith(video);
      } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'preview';
        img.loading = 'lazy';
        img.style.maxWidth = '320px';
        img.style.maxHeight = '240px';
        img.style.objectFit = 'contain';
        link.replaceWith(img);
      }
    }
  }

  // ===== boot =====
  (async () => {
    const lameLoaded = await loadLame();
    log(lameLoaded ? 'MP3 encoder ready' : 'MP3 unavailable, using WAV fallback');

    let injectScheduled = false;
    const scheduleInject = () => {
      if (injectScheduled) return;
      injectScheduled = true;
      requestAnimationFrame(() => {
        injectScheduled = false;
        try { createRecorderUI(); } catch (error) { log('inject error', error); }
      });
    };

    const processAddedNode = (node) => {
      if (!node || node.nodeType !== 1) return;
      try {
        if (node.matches && node.matches('a,div')) enhanceAttachmentPlayers(node.parentNode || node);
        else if (node.querySelectorAll) enhanceAttachmentPlayers(node);
      } catch (error) {
        log('player enhancement error', error);
      }
    };

    waitFor(() => findBottomBar() || findLegacyToolbar()).then(() => scheduleInject());

    try { enhanceAttachmentPlayers(document); } catch (error) { log('initial players error', error); }

    const observer = new MutationObserver((mutations) => {
      let shouldInject = false;

      for (const mutation of mutations) {
        if (mutation.type !== 'childList' || !mutation.addedNodes?.length) continue;
        shouldInject = true;

        if (!window.__ZAPTOS_REC_ACTIVE__) {
          mutation.addedNodes.forEach((node) => processAddedNode(node));
        }
      }

      if (shouldInject) scheduleInject();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      setTimeout(() => {
        scheduleInject();
        if (!window.__ZAPTOS_REC_ACTIVE__) {
          try { enhanceAttachmentPlayers(document); } catch (error) { log('url-change players error', error); }
        }
      }, 300);
    }, 500);

    log('Zaptos Media Tools v5.4 active');
  })();
})();
