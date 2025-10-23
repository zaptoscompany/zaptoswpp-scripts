<script>
/*!
 * Zaptos GHL Media Tools — v4.1 (compat nova bottom bar)
 * © 2025 Zaptos Company — Apache-2.0
 */
(function () {
  if (window.__ZAPTOS_GHL_MEDIA_MP3__ === 'v4.1-mp3') return;
  window.__ZAPTOS_GHL_MEDIA_MP3__ = 'v4.1-mp3';

  const preferFormat = 'mp3';
  const log = (...a) => console.log('[Zaptos][MediaTools]', ...a);

  // ---- lamejs
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
      s.src = urls[i++]; s.async = true;
      s.onload = () => resolve(!!window.lamejs);
      s.onerror = tryNext; document.head.appendChild(s);
    };
    tryNext();
  });

  // ---- helpers
  const waitFor = (pred, { tries = 60, gap = 250 } = {}) => new Promise(res => {
    const t = setInterval(() => {
      const el = pred();
      if (el) { clearInterval(t); res(el); }
      else if (--tries <= 0) { clearInterval(t); res(null); }
    }, gap);
  });

  // === NOVOS SELETORES ===
  // 1) barra inferior dos ícones (precisa escapar [ e ])
  const findBottomBar = () => {
    // a barra tem sempre altura 40px e usa tailwind "flex items-center h-[40px]"
    const list = document.querySelectorAll("div.flex.items-center.h-\\[40px\\]");
    // escolhe a que está visível e perto do campo "Digite uma mensagem..."
    const candidates = [...list].filter(el => el.offsetParent !== null);
    if (!candidates.length) return null;
    // heurística: a barra que tem esquerda (flex-1) + direita (border-l)
    return candidates.find(el =>
      el.querySelector("div[class*='flex-row'][class*='min-w-0']") &&
      el.querySelector("div[class*='border-l'][class*='gap-1']")
    ) || candidates[0];
  };

  // 2) grupo ESQUERDO (onde ficam os ícones) dentro da bottom bar
  const findLeftIconGroup = () => {
    const bar = findBottomBar();
    if (!bar) return null;
    // Exatamente como no dump: "flex flex-row ... pl-2 ... flex-1 min-w-0"
    return bar.querySelector("div[class*='flex-row'][class*='items-center'][class*='pl-2'][class*='min-w-0']");
  };

  // 3) composer para ancorar preview (usa fallback)
  const findComposer = () => document.querySelector("textarea[placeholder*='Digite uma mensagem'], div[contenteditable='true'][role='textbox']")?.closest('div') || null;
  const findPreviewAnchor = () => findComposer()?.parentElement || document.body;

  // 4) input file de upload (geralmente já existe no DOM)
  const findFileInput = () =>
    document.querySelector("input[type='file'][accept*='audio']") ||
    document.querySelector("input[type='file'][accept*='audio/*']") ||
    document.querySelector("input[type='file']");

  const simulateUpload = (file) => {
    let input = findFileInput();
    if (!input) {
      // tenta abrir o seletor de anexo: clica em qualquer ícone de clip (paperclip) se existir
      const bar = findBottomBar();
      const candidate = bar && [...bar.querySelectorAll('svg')].find(svg => /clip|paper|attach/i.test(svg.outerHTML));
      if (candidate) candidate.dispatchEvent(new MouseEvent('click', { bubbles:true }));
      input = findFileInput();
    }
    if (!input) { alert('❌ Campo de upload não encontrado.'); return false; }
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // ---- PCM encode
  const floatTo16 = (f32) => {
    const i16 = new Int16Array(f32.length);
    for (let i=0;i<f32.length;i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return i16;
  };
  const encodeWAV = (samples, sampleRate) => {
    const numChannels = 1, bytesPerSample = 2, blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);
    const w = (o,s) => { for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
    let o=0;
    w(o,'RIFF'); o+=4; view.setUint32(o,36+samples.length*bytesPerSample,true); o+=4;
    w(o,'WAVE'); o+=4; w(o,'fmt '); o+=4; view.setUint32(o,16,true); o+=4;
    view.setUint16(o,1,true); o+=2; view.setUint16(o,1,true); o+=2;
    view.setUint32(o,sampleRate,true); o+=4; view.setUint32(o,byteRate,true); o+=4;
    view.setUint16(o,blockAlign,true); o+=2; view.setUint16(o,8*bytesPerSample,true); o+=2;
    w(o,'data'); o+=4; view.setUint32(o,samples.length*bytesPerSample,true); o+=4;
    const i16 = floatTo16(samples); for (let i=0;i<i16.length;i++,o+=2) view.setInt16(o,i16[i],true);
    return new Blob([view], { type: 'audio/wav' });
  };
  const encodeMP3 = (samples, sampleRate, kbps=128) => {
    const lame = window.lamejs;
    const enc = new lame.Mp3Encoder(1, sampleRate, kbps);
    const i16 = floatTo16(samples), chunk = 1152, parts=[];
    for (let i=0;i<i16.length;i+=chunk) {
      const out = enc.encodeBuffer(i16.subarray(i, i+chunk));
      if (out.length) parts.push(out);
    }
    const end = enc.flush(); if (end.length) parts.push(end);
    return new Blob(parts, { type: 'audio/mpeg' });
  };

  // ---- UI
  function createRecorderUI() {
    if (document.getElementById('zaptos-rec-btn')) return;

    const leftGroup = findLeftIconGroup();
    if (!leftGroup) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'zaptos-rec-wrapper';
    Object.assign(wrapper.style, { display:'inline-flex', alignItems:'center', gap:'6px' });

    // Ícone pequeno para combinar com a barra (w-4 h-4)
    const btn = document.createElement('button');
    btn.id = 'zaptos-rec-btn';
    btn.type = 'button';
    btn.title = 'Gravar áudio (MP3/WAV)';
    btn.innerHTML = '<span style="font-size:14px; line-height:1">🎙️</span>';
    Object.assign(btn.style, {
      display:'inline-flex', alignItems:'center', justifyContent:'center',
      width:'24px', height:'24px',
      borderRadius:'6px', background:'#2563eb', color:'#fff',
      border:'none', cursor:'pointer'
    });

    const timer = document.createElement('span');
    timer.id = 'zaptos-timer';
    timer.textContent = '00:00';
    Object.assign(timer.style, { fontSize:'11px', marginLeft:'4px', opacity:.8 });

    wrapper.append(btn, timer);

    // Insere como primeiro item do grupo esquerdo (antes dos demais ícones)
    leftGroup.prepend(wrapper);

    // estado
    let ac=null, source=null, proc=null, stream=null;
    let buffers=[], seconds=0, tHandle=null, sampleRate=44100;
    const tick = () => { seconds++; const m=String(Math.floor(seconds/60)).padStart(2,'0'); const s=String(seconds%60).padStart(2,'0'); timer.textContent=`${m}:${s}`; };
    const resetTimer = () => { clearInterval(tHandle); seconds=0; timer.textContent='00:00'; };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return alert('Navegador sem suporte a microfone.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true }});
        ac = new (window.AudioContext||window.webkitAudioContext)();
        sampleRate = ac.sampleRate;
        source = ac.createMediaStreamSource(stream);
        proc = ac.createScriptProcessor(4096,1,1);
        proc.onaudioprocess = (e)=> buffers.push(new Float32Array(e.inputBuffer.getChannelData(0)));
        source.connect(proc); proc.connect(ac.destination);
        tHandle = setInterval(tick,1000);
        btn.innerHTML = '⏹️';
      } catch(e){ log('mic error', e); alert('Permita o acesso ao microfone.'); }
    };

    const stop = async () => {
      try{ source&&source.disconnect(); }catch{}
      try{ proc&&proc.disconnect(); }catch{}
      try{ stream&&stream.getTracks().forEach(t=>t.stop()); }catch{}
      try{ ac&&ac.close(); }catch{}
      resetTimer(); btn.innerHTML = '<span style="font-size:14px; line-height:1">🎙️</span>';

      let total=0; buffers.forEach(b=> total+=b.length);
      const merged = new Float32Array(total); let off=0; for (const b of buffers){ merged.set(b,off); off+=b.length; }
      buffers=[];

      let blob, fileName;
      try{
        if (preferFormat==='mp3' && window.lamejs){ blob = encodeMP3(merged, sampleRate, 128); fileName='gravacao.mp3'; }
        else throw new Error('no mp3');
      } catch {
        blob = encodeWAV(merged, sampleRate); fileName='gravacao.wav';
      }
      const file = new File([blob], fileName, { type: blob.type });
      showPreview(file);
    };

    const showPreview = (file) => {
      const old = document.getElementById('zaptos-preview'); if (old) old.remove();
      const anchor = findPreviewAnchor();
      const preview = document.createElement('div');
      preview.id = 'zaptos-preview';
      Object.assign(preview.style, {
        position:'absolute', zIndex:50,
        left:'16px', bottom:'64px',
        display:'flex', gap:'10px', alignItems:'center',
        background:'#fff', padding:'8px 10px', borderRadius:'10px',
        boxShadow:'0 10px 24px rgba(0,0,0,.15)'
      });
      const audio = document.createElement('audio');
      audio.controls = true; audio.src = URL.createObjectURL(file); audio.style.maxWidth='260px';

      const sendBtn = document.createElement('button');
      sendBtn.textContent='✅ Enviar';
      Object.assign(sendBtn.style,{ padding:'6px 10px', background:'#16a34a', color:'#fff', border:'none', borderRadius:'8px', cursor:'pointer', fontWeight:600 });
      sendBtn.onclick = ()=>{ simulateUpload(file); preview.remove(); };

      const redoBtn = document.createElement('button');
      redoBtn.textContent='🔁 Regravar';
      Object.assign(redoBtn.style,{ padding:'6px 10px', background:'#dc2626', color:'#fff', border:'none', borderRadius:'8px', cursor:'pointer', fontWeight:600 });
      redoBtn.onclick = ()=> preview.remove();

      preview.append(audio, sendBtn, redoBtn);
      (anchor||document.body).appendChild(preview);
    };

    btn.onclick = () => (btn.textContent.includes('⏹️') ? stop() : start());
  }

  // ---- players embutidos (idem v4)
  function enhanceAttachmentPlayers(root=document) {
    const sel = [
      "a.sms-file-attachment",
      "a[href$='.mp3'],a[href$='.wav'],a[href$='.ogg'],a[href$='.webm'],a[href$='.mp4'],a[href$='.mov']",
      "div a[href*='.mp3'],div a[href*='.wav'],div a[href*='.ogg'],div a[href*='.webm'],div a[href*='.mp4'],div a[href*='.mov']",
    ].join(',');
    const links = Array.from(root.querySelectorAll(sel));
    for (const link of links) {
      if (!link || link.dataset.zaptosEnhanced) continue;
      const href = link.getAttribute('href')||link.textContent||''; if (!href) continue;
      link.dataset.zaptosEnhanced='true';
      let url=href; try{ url = new URL(href, location.href).href; }catch{}
      const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase(); if (!ext) continue;
      if (['mp3','wav','webm','ogg'].includes(ext)) {
        const audio=document.createElement('audio'); audio.controls=true; audio.src=url; audio.style.maxWidth='320px'; link.replaceWith(audio);
      } else if (['mp4','mov','webm'].includes(ext)) {
        const video=document.createElement('video'); video.controls=true; video.width=320; video.src=url; link.replaceWith(video);
      }
    }
  }

  // ---- boot
  (async () => {
    const lameOK = await loadLame();
    log(lameOK ? 'MP3 OK' : 'fallback WAV');

    const injectAll = () => { try{ createRecorderUI(); }catch(e){ log('inject err', e); } try{ enhanceAttachmentPlayers(); }catch(e){ log('players err', e); } };

    // aguarda a barra inferior aparecer
    waitFor(findBottomBar).then(() => injectAll());

    // observa DOM (troca de rota, abrir contato/conversa)
    const mo = new MutationObserver(() => injectAll());
    mo.observe(document.documentElement, { childList:true, subtree:true });

    // watchdog de rota SPA
    let last=location.href;
    setInterval(()=>{ if (location.href!==last){ last=location.href; setTimeout(injectAll, 300); } }, 300);

    log('Zaptos GHL Media Tools v4.1 — ativo');
  })();
})();
</script>
