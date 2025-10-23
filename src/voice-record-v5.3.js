/*!
 * Zaptos GHL Media Tools — v5.3
 * Preview colado acima do botão 🎙️
 * © 2025 Zaptos Company — Apache-2.0
 */
(function () {
  if (window.__ZAPTOS_GHL_MEDIA_MP3__ === 'v5.3') return;
  window.__ZAPTOS_GHL_MEDIA_MP3__ = 'v5.3';

  const preferFormat = 'mp3', log = (...a) => console.log('[Zaptos][MediaTools]', ...a);

  // --- carregar lamejs (mp3 encoder)
  const loadLame = () => new Promise(r => {
    if (window.lamejs) return r(true);
    const urls = [
      'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js',
      'https://unpkg.com/lamejs@1.2.1/lame.min.js'
    ];
    let i = 0; (function next() {
      if (i >= urls.length) return r(false);
      const s = document.createElement('script');
      s.src = urls[i++]; s.async = true;
      s.onload = () => r(!!window.lamejs);
      s.onerror = next;
      document.head.appendChild(s);
    })();
  });

  const waitFor = (pred, { tries = 60, gap = 250 } = {}) => new Promise(res => {
    const t = setInterval(() => {
      const el = pred();
      if (el) { clearInterval(t); res(el); }
      else if (--tries <= 0) { clearInterval(t); res(null); }
    }, gap);
  });

  // ===== NOVA UI =====
  const findBottomBar = () => {
    const list = document.querySelectorAll("div.flex.items-center.h-\\[40px\\]");
    const cand = [...list].filter(el => el.offsetParent !== null);
    return cand.find(el =>
      el.querySelector("div[class*='flex-row'][class*='min-w-0']") &&
      el.querySelector("div[class*='border-l'][class*='gap-1']")
    ) || cand[0] || null;
  };
  const findLeftIconGroup = () => {
    const bar = findBottomBar();
    if (!bar) return null;
    return bar.querySelector("div[class*='flex-row'][class*='items-center'][class*='pl-2'][class*='min-w-0']");
  };

  // ===== ANTIGA =====
  const findLegacyToolbar = () => {
    const c = document.querySelector("div[data-testid*='composer'], div[data-rbd-droppable-id]");
    if (!c) return null;
    let best = null, bestBtns = 0;
    c.querySelectorAll("div[role='group'],div[class*='toolbar'],div:has(button,svg)").forEach(n => {
      const k = n.querySelectorAll('button,[role="button"],svg').length;
      if (k > bestBtns) { best = n; bestBtns = k; }
    });
    return best || c;
  };

  const findComposer = () => document.querySelector("textarea[placeholder*='Digite uma mensagem'], div[contenteditable='true'][role='textbox']")
    ?.closest('div') || document.querySelector("div[data-testid*='composer'], div[data-rbd-droppable-id]") || null;

  // ===== comuns =====
  const findFileInput = () => document.querySelector("input[type='file'][accept*='audio']") ||
    document.querySelector("input[type='file'][accept*='audio/*']") ||
    document.querySelector("input[type='file']");

  const simulateUpload = (file) => {
    let input = findFileInput();
    if (!input) {
      const bar = findBottomBar() || findLegacyToolbar();
      const clip = bar && [...bar.querySelectorAll('svg')].find(svg => /clip|attach|paper/i.test(svg.outerHTML));
      if (clip) clip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      input = findFileInput();
    }
    if (!input) { alert('❌ Campo de upload não encontrado.'); return false; }
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // ===== encoder =====
  const floatTo16 = f => { const i = new Int16Array(f.length); for (let k = 0; k < f.length; k++) { let s = Math.max(-1, Math.min(1, f[k])); i[k] = s < 0 ? s * 0x8000 : s * 0x7FFF; } return i; };
  const encodeWAV = (samples, sr) => {
    const ch = 1, bps = 2, ba = ch * bps, br = sr * ba, buf = new ArrayBuffer(44 + samples.length * bps), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }; let o = 0;
    w(o, 'RIFF'); o += 4; v.setUint32(o, 36 + samples.length * bps, true); o += 4; w(o, 'WAVE'); o += 4; w(o, 'fmt '); o += 4;
    v.setUint32(o, 16, true); o += 4; v.setUint16(o, 1, true); o += 2; v.setUint16(o, 1, true); o += 2;
    v.setUint32(o, sr, true); o += 4; v.setUint32(o, br, true); o += 4; v.setUint16(o, ba, true); o += 2; v.setUint16(o, 16, true); o += 2;
    w(o, 'data'); o += 4; v.setUint32(o, samples.length * bps, true); o += 4;
    const i16 = floatTo16(samples); for (let i = 0; i < i16.length; i++, o += 2) v.setInt16(o, i16[i], true);
    return new Blob([v], { type: 'audio/wav' });
  };
  const encodeMP3 = (samples, sr, kbps = 128) => {
    const e = new lamejs.Mp3Encoder(1, sr, kbps), i16 = floatTo16(samples), cs = 1152, parts = [];
    for (let i = 0; i < i16.length; i += cs) {
      const out = e.encodeBuffer(i16.subarray(i, i + cs)); if (out.length) parts.push(out);
    }
    const end = e.flush(); if (end.length) parts.push(end);
    return new Blob(parts, { type: 'audio/mpeg' });
  };

  // ===== recorder UI =====
  function createRecorderUI() {
    if (document.getElementById('zaptos-rec-btn')) return;

    const leftGroup = findLeftIconGroup();
    const toolbar = leftGroup || findLegacyToolbar();
    if (!toolbar) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'zaptos-rec-wrapper';
    Object.assign(wrapper.style, { display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '6px' });

    const btn = document.createElement('button');
    btn.id = 'zaptos-rec-btn'; btn.type = 'button'; btn.title = 'Gravar áudio (MP3/WAV)';
    btn.innerHTML = '<span style="font-size:14px;line-height:1">🎙️</span>';
    Object.assign(btn.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '24px', height: '24px', borderRadius: '6px',
      background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer'
    });

    const timer = document.createElement('span');
    timer.id = 'zaptos-timer'; timer.textContent = '00:00';
    Object.assign(timer.style, { fontSize: '11px', marginLeft: '4px', opacity: .8 });

    if (leftGroup) leftGroup.prepend(wrapper); else toolbar.appendChild(wrapper);
    wrapper.append(btn, timer);

    // estado
    let ac = null, src = null, proc = null, stream = null, buffers = [], seconds = 0, tHandle = null, sampleRate = 44100;
    const tick = () => { seconds++; const m = String(Math.floor(seconds / 60)).padStart(2, '0'), s = String(seconds % 60).padStart(2, '0'); timer.textContent = `${m}:${s}`; };
    const reset = () => { clearInterval(tHandle); seconds = 0; timer.textContent = '00:00'; };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return alert('Navegador sem suporte a microfone.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        ac = new (window.AudioContext || window.webkitAudioContext)(); sampleRate = ac.sampleRate;
        src = ac.createMediaStreamSource(stream); proc = ac.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => buffers.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        src.connect(proc); proc.connect(ac.destination);
        tHandle = setInterval(tick, 1000); btn.textContent = '⏹️';
      } catch (e) { log('mic err', e); alert('Permita o acesso ao microfone.'); }
    };

    const stop = async () => {
      try { src && src.disconnect(); } catch { } try { proc && proc.disconnect(); } catch { }
      try { stream && stream.getTracks().forEach(t => t.stop()); } catch { } try { ac && ac.close(); } catch { }
      reset(); btn.innerHTML = '<span style="font-size:14px;line-height:1">🎙️</span>';
      let total = 0; buffers.forEach(b => total += b.length); const merged = new Float32Array(total);
      let off = 0; for (const b of buffers) { merged.set(b, off); off += b.length; } buffers = [];
      let blob, name; try { if (preferFormat === 'mp3' && window.lamejs) { blob = encodeMP3(merged, sampleRate, 128); name = 'gravacao.mp3'; } else throw new Error(); }
      catch { blob = encodeWAV(merged, sampleRate); name = 'gravacao.wav'; }
      showPreview(new File([blob], name, { type: blob.type }), btn);
    };

    btn.onclick = () => (btn.textContent.includes('⏹️') ? stop() : start());
  }

  // ===== preview colado acima do botão =====
  const showPreview = (file, anchorBtn) => {
    const old = document.getElementById('zaptos-preview'); if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'zaptos-preview';
    Object.assign(box.style, {
      position: 'fixed', zIndex: 9999,
      left: '0px', top: '0px',
      display: 'flex', gap: '10px', alignItems: 'center',
      background: '#fff',
      padding: '10px 12px',
      borderRadius: '14px',
      boxShadow: '0 12px 28px rgba(0,0,0,.18)'
    });

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = URL.createObjectURL(file);
    audio.style.maxWidth = '300px';

    const send = document.createElement('button');
    send.textContent = '✅ Enviar';
    Object.assign(send.style, {
      padding: '8px 12px', background: '#16a34a', color: '#fff',
      border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700
    });
    send.onclick = () => { simulateUpload(file); box.remove(); };

    const redo = document.createElement('button');
    redo.textContent = '🔁 Regravar';
    Object.assign(redo.style, {
      padding: '8px 12px', background: '#dc2626', color: '#fff',
      border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 700
    });
    redo.onclick = () => box.remove();

    box.append(audio, send, redo);
    document.body.appendChild(box);

    // reposicionar acima do botão
    const OFFSET = 10;
    function reposition() {
      const r = (anchorBtn || document.getElementById('zaptos-rec-btn'))?.getBoundingClientRect();
      if (!r) return;
      const bw = box.offsetWidth, bh = box.offsetHeight;
      let left = Math.round(r.left + r.width / 2 - bw / 2);
      let top = Math.round(r.top - bh - OFFSET);
      if (top < 8) top = Math.round(r.bottom + OFFSET);
      if (left < 8) left = 8;
      if (left > window.innerWidth - bw - 8) left = window.innerWidth - bw - 8;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition);
  };

  // ===== players (auto preview links) =====
  function enhanceAttachmentPlayers(root = document) {
    const sel = ["a.sms-file-attachment",
      "a[href$='.mp3'],a[href$='.wav'],a[href$='.ogg'],a[href$='.webm'],a[href$='.mp4'],a[href$='.mov']",
      "div a[href*='.mp3'],div a[href*='.wav'],div a[href*='.ogg'],div a[href*='.webm'],div a[href*='.mp4'],div a[href*='.mov']"].join(',');
    const links = [...root.querySelectorAll(sel)];
    for (const link of links) {
      if (!link || link.dataset.zaptosEnhanced) continue;
      const href = link.getAttribute('href') || link.textContent || ''; if (!href) continue;
      link.dataset.zaptosEnhanced = 'true';
      let url = href; try { url = new URL(href, location.href).href; } catch { }
      const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase(); if (!ext) continue;
      if (['mp3', 'wav', 'webm', 'ogg'].includes(ext)) {
        const a = document.createElement('audio'); a.controls = true; a.src = url; a.style.maxWidth = '320px'; link.replaceWith(a);
      } else if (['mp4', 'mov', 'webm'].includes(ext)) {
        const v = document.createElement('video'); v.controls = true; v.width = 320; v.src = url; link.replaceWith(v);
      }
    }
  }

  (async () => {
    const ok = await loadLame(); log(ok ? 'MP3 OK' : 'fallback WAV');
    const inject = () => { try { createRecorderUI(); } catch (e) { log('inject', e); } try { enhanceAttachmentPlayers(); } catch (e) { log('players', e); } };
    waitFor(() => findBottomBar() || findLegacyToolbar()).then(() => inject());
    const mo = new MutationObserver(() => inject()); mo.observe(document.documentElement, { childList: true, subtree: true });
    let last = location.href; setInterval(() => { if (location.href !== last) { last = location.href; setTimeout(inject, 300); } }, 300);
    log('Zaptos Media Tools v5.3 — ativo');
  })();
})();
