/*!
 * Zaptos GHL Media Tools
 * Copyright (c) 2025 Zaptos Company
 *
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
// 🎯 Zaptos GHL Media Tools — grava MP3 (fallback para WAV), preview + enviar + players embutidos
(function () {
  if (window.__ZAPTOS_GHL_MEDIA_MP3__) return;
  window.__ZAPTOS_GHL_MEDIA_MP3__ = 'v3-mp3';

  const log = (...a) => console.log('[Zaptos]', ...a);
  const preferFormat = 'mp3'; // 'mp3' preferido; cai p/ wav se falhar

  // --- loader de lamejs (tenta 2 CDNs; ignora se já tiver)
  const loadLame = () => new Promise((resolve) => {
    if (window.lamejs) return resolve(true);
    const urls = [
      'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
      'https://unpkg.com/lamejs@1.2.1/lame.min.js'
    ];
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) return resolve(false);
      const s = document.createElement('script');
      s.src = urls[i++]; s.async = true; s.onload = () => resolve(!!window.lamejs);
      s.onerror = tryNext; document.head.appendChild(s);
    };
    tryNext();
  });

  // --- utils UI/GHL
  const findClearBtn = () => Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent||'').trim().toLowerCase() === 'clear') || null;
  const findComposer = () => document.querySelector("div[data-testid*='composer'], div[data-rbd-droppable-id]");
  const findFileInput = () =>
    document.querySelector("input[type='file'][accept*='audio']") ||
    document.querySelector("input[type='file'][name*='file']")   ||
    document.querySelector("input[type='file']");

  const simulateUpload = (file) => {
    const input = findFileInput();
    if (!input) { alert('❌ Campo de upload não encontrado.'); return false; }
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // --- encoder helpers
  const floatTo16 = (f32) => {
    const i16 = new Int16Array(f32.length);
    for (let i=0;i<f32.length;i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return i16;
  };

  const encodeWAV = (samples, sampleRate) => {
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    const writeStr = (off, str) => { for (let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i)); };
    let offset = 0;
    writeStr(offset, 'RIFF'); offset += 4;
    view.setUint32(offset, 36 + samples.length * bytesPerSample, true); offset += 4;
    writeStr(offset, 'WAVE'); offset += 4;
    writeStr(offset, 'fmt '); offset += 4;
    view.setUint32(offset, 16, true); offset += 4;             // Subchunk1Size
    view.setUint16(offset, 1, true); offset += 2;               // PCM
    view.setUint16(offset, numChannels, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, byteRate, true); offset += 4;
    view.setUint16(offset, blockAlign, true); offset += 2;
    view.setUint16(offset, 8 * bytesPerSample, true); offset += 2; // bits per sample
    writeStr(offset, 'data'); offset += 4;
    view.setUint32(offset, samples.length * bytesPerSample, true); offset += 4;

    const i16 = floatTo16(samples);
    for (let i=0;i<i16.length;i++, offset+=2) view.setInt16(offset, i16[i], true);

    return new Blob([view], { type: 'audio/wav' });
  };

  const encodeMP3 = (samples, sampleRate, kbps=128) => {
    const lame = window.lamejs;
    const mp3encoder = new lame.Mp3Encoder(1, sampleRate, kbps);
    const i16 = floatTo16(samples);
    const chunkSize = 1152;
    const chunks = [];
    for (let i=0; i<i16.length; i+=chunkSize) {
      const part = i16.subarray(i, i+chunkSize);
      const mp3buf = mp3encoder.encodeBuffer(part);
      if (mp3buf.length) chunks.push(mp3buf);
    }
    const end = mp3encoder.flush();
    if (end.length) chunks.push(end);
    return new Blob(chunks, { type: 'audio/mpeg' });
  };

  // --- gravação via WebAudio (ScriptProcessor) para capturar PCM
  function createRecorderUI() {
    if (document.getElementById('zaptos-rec-btn')) return;

    const clearBtn = findClearBtn();
    if (!clearBtn || !clearBtn.parentNode) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'zaptos-rec-wrapper';
    Object.assign(wrapper.style, {
      display: 'inline-flex', alignItems: 'center', gap: '6px', marginRight: '8px', position: 'relative'
    });

    const btn = document.createElement('button');
    btn.id = 'zaptos-rec-btn';
    btn.textContent = '🎙️';
    btn.title = 'Gravar áudio (MP3/WAV)';
    Object.assign(btn.style, {
      padding: '6px 12px', borderRadius: '4px', backgroundColor: '#007bff',
      color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 'bold'
    });

    const timer = document.createElement('span');
    timer.id = 'zaptos-timer';
    timer.textContent = '00:00';
    Object.assign(timer.style, { fontSize: '14px', color: '#333', padding: '4px' });

    wrapper.append(btn, timer);
    clearBtn.parentNode.insertBefore(wrapper, clearBtn);

    // estado de gravação
    let ac = null, source = null, proc = null, stream = null;
    let buffers = []; // Float32Array chunks
    let seconds = 0, tHandle = null, sampleRate = 44100;

    const tick = () => {
      seconds++;
      const m = String(Math.floor(seconds/60)).padStart(2,'0');
      const s = String(seconds%60).padStart(2,'0');
      timer.textContent = `${m}:${s}`;
    };
    const resetTimer = () => { clearInterval(tHandle); seconds = 0; timer.textContent = '00:00'; };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) { alert('Navegador sem suporte a getUserMedia.'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }});
        ac = new (window.AudioContext || window.webkitAudioContext)();
        sampleRate = ac.sampleRate;
        source = ac.createMediaStreamSource(stream);
        // ScriptProcessor (suporte amplo). Buffer 4096, mono.
        const bufSize = 4096;
        proc = ac.createScriptProcessor(bufSize, 1, 1);
        proc.onaudioprocess = (e) => {
          const ch = e.inputBuffer.getChannelData(0);
          // copiar chunk
          buffers.push(new Float32Array(ch));
        };
        source.connect(proc); proc.connect(ac.destination);

        tHandle = setInterval(tick, 1000);
        btn.textContent = '⏹️';
      } catch (e) {
        log('erro mic', e);
        alert('Permita o acesso ao microfone para gravar áudio.');
      }
    };

    const stop = async () => {
      try { source && source.disconnect(); } catch {}
      try { proc && proc.disconnect(); } catch {}
      try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}
      try { ac && ac.close(); } catch {}

      resetTimer();
      btn.textContent = '🎙️';

      // merge dos buffers
      let total = 0; buffers.forEach(b => total += b.length);
      const merged = new Float32Array(total);
      let off = 0; for (const b of buffers) { merged.set(b, off); off += b.length; }
      buffers = [];

      // tenta MP3; cai para WAV
      let blob, fileName;
      try {
        if (preferFormat === 'mp3' && window.lamejs) {
          blob = encodeMP3(merged, sampleRate, 128);
          fileName = 'gravacao.mp3';
        } else {
          throw new Error('lamejs indisponível');
        }
      } catch {
        blob = encodeWAV(merged, sampleRate);
        fileName = 'gravacao.wav';
      }

      const file = new File([blob], fileName, { type: blob.type });
      showPreview(file);
    };

    const showPreview = (file) => {
      const old = document.getElementById('zaptos-preview'); if (old) old.remove();

      const preview = document.createElement('div');
      preview.id = 'zaptos-preview';
      Object.assign(preview.style, {
        position: 'absolute', bottom: '55px', left: '20px', zIndex: 9999,
        display: 'flex', flexDirection: 'row', gap: '10px', alignItems: 'center',
        background: '#fff', padding: '8px', borderRadius: '6px',
        boxShadow: '0 6px 20px rgba(0,0,0,.15)'
      });

      const audio = document.createElement('audio');
      audio.controls = true; audio.src = URL.createObjectURL(file); audio.style.maxWidth = '260px';

      const sendBtn = document.createElement('button');
      sendBtn.textContent = '✅ Enviar';
      Object.assign(sendBtn.style, {
        padding: '6px 10px', background: '#28a745', color: '#fff',
        border: 'none', borderRadius: '4px', cursor: 'pointer'
      });
      sendBtn.onclick = () => { simulateUpload(file); preview.remove(); };

      const redoBtn = document.createElement('button');
      redoBtn.textContent = '🔁 Gravar novamente';
      Object.assign(redoBtn.style, {
        padding: '6px 10px', background: '#dc3545', color: '#fff',
        border: 'none', borderRadius: '4px', cursor: 'pointer'
      });
      redoBtn.onclick = () => preview.remove();

      preview.append(audio, sendBtn, redoBtn);

      const composer = findComposer();
      if (composer && composer.parentNode) composer.parentNode.appendChild(preview);
      else wrapper.parentNode.insertBefore(preview, wrapper.nextSibling);
    };

    btn.onclick = () => {
      // se está gravando? (usa timer como indício)
      if (btn.textContent === '⏹️') stop();
      else start();
    };
  }

  // --- players embutidos (sem quebrar links)
  function enhanceAttachmentPlayers(root=document) {
    const links = Array.from(root.querySelectorAll('a.sms-file-attachment'));
    for (const link of links) {
      if (!link || link.dataset.zaptosEnhanced) continue;
      const href = link.getAttribute('href') || link.textContent || '';
      if (!href) continue;
      link.dataset.zaptosEnhanced = 'true';

      let url = href; try { url = new URL(href, location.href).href; } catch {}
      const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
      if (!ext) continue;

      if (['mp3','wav','webm','ogg'].includes(ext)) {
        const audio = document.createElement('audio');
        audio.controls = true; audio.src = url; audio.style.maxWidth = '300px';
        link.replaceWith(audio);
      } else if (['mp4','mov','webm'].includes(ext)) {
        const video = document.createElement('video');
        video.controls = true; video.width = 300; video.src = url;
        link.replaceWith(video);
      }
    }
  }

  // boot
  (async () => {
    const lameOK = await loadLame();
    log(lameOK ? 'MP3 encoder carregado (lamejs)' : 'Encoder MP3 indisponível — fallback para WAV');

    const tryInject = () => { try { createRecorderUI(); } catch(e){ log('inject err', e); } };
    const tryPlayers = (n) => { try { enhanceAttachmentPlayers(n||document); } catch(e){ log('player err', e); } };

    tryInject(); tryPlayers();

    const mo = new MutationObserver((muts) => {
      let ui=false, links=false;
      for (const m of muts) {
        if (m.type === 'childList' && m.addedNodes?.length) {
          ui = links = true;
          m.addedNodes.forEach(n => { if (n.querySelectorAll) tryPlayers(n); });
        }
      }
      if (ui) tryInject();
      if (links) tryPlayers();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    log('🎯 Zaptos GHL Media Tools — MP3/WAV ativo');
  })();
})();