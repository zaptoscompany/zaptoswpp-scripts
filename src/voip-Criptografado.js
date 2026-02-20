// == ZaptosVoip GHL header button (voip.zaptoswpp.com) ==
(function(){
  if (window.__ZAPTOSVOIP_GHL_BTN_FINAL__) return console.log('[ZaptosVoip] already loaded');
  window.__ZAPTOSVOIP_GHL_BTN_FINAL__ = true;

  const DEBUG = false; // true para logs no console
  const POPUP_OPTS = 'width=360,height=640,menubar=0,toolbar=0,location=0,status=0';
  const DEFAULT_COUNTRY = '55';
  const CALL_PAGE_URL = 'https://voip.zaptoswpp.com/call/';
  const EDGE_TOKEN_URL = 'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-wavoip-token';
  const INSTANCE_PICKER_URL = 'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-voip-instances';
  const VOIP_DIALOG_STYLE_ID = 'zaptos-voip-dialog-style-legacy';
  const EDGE_ACTIONS = {
    sessionStart: 'session_start',
    getInstances: 'get_instances',
    getContact: 'get_contact',
    prepareCall: 'prepare_call'
  };
  const EDGE_SESSION_REFRESH_MARGIN_MS = 20 * 1000;
  const SESSION_KEYS = {
    token: 'zaptosvoip_token_user_override',
    apiKey: 'zaptosvoip_instance_api_key',
    loc:   'zaptosvoip_location_id'
  };
  const WAVOIP_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@wavoip/wavoip-webphone/dist/index.umd.min.js';
  const WAVOIP_TOKEN_KEY = 'zaptos_voip_user_token';

  let wavoipScriptPromise = null;
  let wavoipReadyPromise = null;
  let wavoipRendered = false;
  let wavoipActiveToken = null;
  let wavoipActiveTokens = [];
  let activeVoipDialogClose = null;
  let edgeSession = {
    token: '',
    locationId: '',
    expiresAt: 0
  };

  const log    = (...a)=> { if (DEBUG) console.log('[ZaptosVoip]', ...a); };
  const errLog = (...a)=> console.error('[ZaptosVoip]', ...a);

  window._zaptosVoipGHL_debug =
    window._zaptosVoipGHL_debug || {
      edgeCalls: [],
      instanceCalls: [],
      contactCalls: [],
      lastResolve: null
    };
  window._zaptosVoipAvatarMeta = window._zaptosVoipAvatarMeta || null;

  // ------- util phone formatting / extraction -------
  function normalizePhone(raw){
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/\(cid:\d+\)/g,'').replace(/[^\d+]/g,'');
    s = s.replace(/^\+/, '');
    const only = s.replace(/\D/g,'');
    if (!only) return null;
    if (only.length <= 11 && !only.startsWith(DEFAULT_COUNTRY)) return DEFAULT_COUNTRY + only;
    return only;
  }

  function parseJsonSafe(text){
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  function makeEdgeNonce(){
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function'){
        return window.crypto.randomUUID();
      }
    } catch {}
    return (
      'zv-' +
      Date.now() +
      '-' +
      Math.random().toString(16).slice(2) +
      '-' +
      Math.random().toString(16).slice(2)
    );
  }

  function parseIsoTimeMs(value){
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clearEdgeSession(reason){
    edgeSession = {
      token: '',
      locationId: '',
      expiresAt: 0
    };
    log('edge session cleared', reason || 'manual');
  }

  function isEdgeSessionExpiredForLocation(locationId){
    const now = Date.now();
    const sessionExpiresAt = Number(edgeSession.expiresAt || 0);
    if (!edgeSession.token) return true;
    if (!edgeSession.locationId) return true;
    if (edgeSession.locationId !== String(locationId || '').trim()) return true;
    if (!sessionExpiresAt) return true;
    return now >= sessionExpiresAt - EDGE_SESSION_REFRESH_MARGIN_MS;
  }

  async function startEdgeSession(locationId){
    const normalizedLocation = String(locationId || '').trim();
    if (!normalizedLocation){
      throw new Error('Subconta invalida para iniciar sessao.');
    }

    const requestBody = {
      action: EDGE_ACTIONS.sessionStart,
      location_id: normalizedLocation
    };

    const response = await fetch(INSTANCE_PICKER_URL, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    const text = await response.text().catch(()=>null);
    const json = parseJsonSafe(text);

    window._zaptosVoipGHL_debug.edgeCalls = window._zaptosVoipGHL_debug.edgeCalls || [];
    window._zaptosVoipGHL_debug.edgeCalls.push({
      action: EDGE_ACTIONS.sessionStart,
      status: response.status,
      ok: response.ok,
      text,
      json
    });

    if (!response.ok || !json || json.ok === false){
      const message = String(
        (json && (json.error || json.message || json.code)) ||
        'Falha ao iniciar sessao segura.'
      ).trim();
      throw new Error(message);
    }

    const token = String((json && (json.session_token || (json.data && json.data.session_token))) || '').trim();
    if (!token){
      throw new Error('Sessao invalida retornada pela edge function.');
    }

    const expiresAtMs = parseIsoTimeMs(
      (json && (json.expires_at || (json.data && json.data.expires_at))) || ''
    );

    edgeSession = {
      token,
      locationId: normalizedLocation,
      expiresAt: expiresAtMs || Date.now() + 9 * 60 * 1000
    };
    return edgeSession.token;
  }

  async function ensureEdgeSession(locationId, forceRenew){
    const normalizedLocation = String(locationId || '').trim();
    if (!normalizedLocation){
      throw new Error('Subconta invalida para autenticar requisicao.');
    }

    if (forceRenew || isEdgeSessionExpiredForLocation(normalizedLocation)){
      return await startEdgeSession(normalizedLocation);
    }
    return edgeSession.token;
  }

  async function callEdgeAction(action, payload, options){
    const opts = options || {};
    const attempt = Number(opts.attempt || 0);
    const requireSession = opts.requireSession !== false;
    const bodyPayload =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : {};

    const locationId = String(
      bodyPayload.location_id || getLocationIdFromPath() || ''
    ).trim();

    const headers = { 'Content-Type': 'application/json' };
    if (requireSession){
      const sessionToken = await ensureEdgeSession(locationId, !!opts.forceRenew);
      headers.Authorization = `Bearer ${sessionToken}`;
      headers['x-zv-ts'] = String(Date.now());
      headers['x-zv-nonce'] = makeEdgeNonce();
    }

    const requestBody = { action, ...bodyPayload };
    const response = await fetch(INSTANCE_PICKER_URL, {
      method: 'POST',
      credentials: 'omit',
      headers,
      body: JSON.stringify(requestBody)
    });
    const text = await response.text().catch(()=>null);
    const json = parseJsonSafe(text);

    if (requireSession && response.status === 401 && attempt < 1){
      const code = String((json && json.code) || '').trim().toLowerCase();
      if (
        code === 'session_invalid' ||
        code === 'session_expired' ||
        code === 'session_required' ||
        code === 'session_revoked'
      ) {
        clearEdgeSession(code || 'expired');
        return await callEdgeAction(action, bodyPayload, {
          ...opts,
          attempt: attempt + 1,
          forceRenew: true
        });
      }
    }

    return { response, text, json };
  }

  function ensureVoipDialogStyle(){
    if (document.getElementById(VOIP_DIALOG_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = VOIP_DIALOG_STYLE_ID;
    style.textContent = `
      .zv-dialog-overlay{position:fixed;inset:0;z-index:2147483646;background:rgba(8,12,24,.58);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:16px}
      .zv-dialog-card{width:min(440px,calc(100vw - 32px));max-height:min(80vh,720px);background:linear-gradient(180deg,#22314a 0%,#1a253a 100%);border:1px solid rgba(255,255,255,.08);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.45);color:#e9eefb;display:flex;flex-direction:column;overflow:hidden;font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif}
      .zv-dialog-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
      .zv-dialog-title-wrap{min-width:0}
      .zv-dialog-title{margin:0;font-size:20px;line-height:1.15;font-weight:700;letter-spacing:.01em;color:#f3f6ff}
      .zv-dialog-subtitle{margin:6px 0 0;font-size:12px;color:#aeb9cf}
      .zv-dialog-close{border:none;width:30px;height:30px;border-radius:8px;cursor:pointer;color:#d4ddf1;background:rgba(255,255,255,.08);font-size:20px;line-height:1}
      .zv-dialog-close:hover{background:rgba(255,255,255,.16)}
      .zv-dialog-body{overflow:auto;padding:12px 14px 4px}
      .zv-dialog-list{display:flex;flex-direction:column;gap:10px}
      .zv-option{border:1px solid rgba(255,255,255,.06);border-radius:10px;background:#2d3b55;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:12px;text-align:left}
      .zv-option:hover{border-color:rgba(103,173,255,.5)}
      .zv-option.is-selected{border-color:#46b26e;box-shadow:inset 0 0 0 1px rgba(70,178,110,.35)}
      .zv-option.is-disabled{cursor:not-allowed;opacity:.62}
      .zv-option-main{min-width:0;flex:1}
      .zv-option-label{font-size:18px;font-weight:700;line-height:1.2;color:#f2f6ff;word-break:break-word}
      .zv-option-subtitle{margin-top:3px;font-size:14px;color:#b7c4de;word-break:break-word}
      .zv-option-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
      .zv-badge{font-size:12px;line-height:1;border-radius:7px;padding:6px 8px;white-space:nowrap;border:1px solid transparent}
      .zv-badge.connected{color:#c8ffe0;background:rgba(37,168,83,.22);border-color:rgba(91,217,138,.35)}
      .zv-badge.connecting{color:#ffe4b2;background:rgba(180,107,32,.3);border-color:rgba(255,179,83,.35)}
      .zv-badge.disconnected{color:#ffd4d4;background:rgba(171,55,55,.26);border-color:rgba(255,114,114,.34)}
      .zv-badge.muted{color:#d4dcec;background:rgba(104,118,148,.22);border-color:rgba(164,177,208,.26)}
      .zv-select-marker{width:22px;height:22px;border-radius:999px;border:2px solid rgba(240,244,255,.58);display:inline-flex;align-items:center;justify-content:center;background:transparent}
      .zv-select-marker:after{content:"";width:10px;height:10px;border-radius:999px;background:#5cf08f;transform:scale(0);transition:transform .13s ease}
      .zv-option.is-selected .zv-select-marker:after{transform:scale(1)}
      .zv-toggle-marker{width:38px;height:22px;border-radius:999px;background:rgba(255,255,255,.22);position:relative}
      .zv-toggle-marker:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:999px;background:#f7f8ff;transition:transform .15s ease}
      .zv-option.is-selected .zv-toggle-marker{background:#38c768}
      .zv-option.is-selected .zv-toggle-marker:after{transform:translateX(16px)}
      .zv-dialog-feedback{margin:10px 14px 2px;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,126,126,.33);color:#ffd6d6;font-size:12px;background:rgba(120,39,39,.25);display:none}
      .zv-dialog-footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 14px 14px}
      .zv-btn{border-radius:8px;border:1px solid rgba(255,255,255,.2);min-height:34px;padding:0 14px;color:#ebf0fd;background:rgba(255,255,255,.08);cursor:pointer;font-size:13px;font-weight:600}
      .zv-btn:hover{background:rgba(255,255,255,.16)}
      .zv-btn.primary{background:#2b8ef9;border-color:#2b8ef9;color:#fff}
      .zv-btn.primary:hover{background:#197adf;border-color:#197adf}
      .zv-btn:disabled{cursor:not-allowed;opacity:.55}
      .zv-message{font-size:14px;line-height:1.5;color:#e6ecff;padding:8px 0 6px;white-space:pre-wrap}
    `;
    document.head.appendChild(style);
  }

  function resolveStatusBadge(status, canCall, hasToken){
    if (!hasToken) return { text:'Sem token', tone:'muted' };
    const normalized = String(status || '').trim().toLowerCase();
    if (canCall || normalized === 'open') return { text:'Connected', tone:'connected' };
    if (normalized === 'connecting') return { text:'Connecting', tone:'connecting' };
    if (normalized) return { text:'Disconnected', tone:'disconnected' };
    return { text:'Status desconhecido', tone:'muted' };
  }

  function mountVoipDialog(title, subtitle, onCancel){
    ensureVoipDialogStyle();
    if (typeof activeVoipDialogClose === 'function'){
      try { activeVoipDialogClose(); } catch {}
      activeVoipDialogClose = null;
    }

    const overlay = document.createElement('div');
    overlay.className = 'zv-dialog-overlay';
    const card = document.createElement('div');
    card.className = 'zv-dialog-card';
    overlay.appendChild(card);

    const header = document.createElement('div');
    header.className = 'zv-dialog-header';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'zv-dialog-title-wrap';
    const titleEl = document.createElement('h3');
    titleEl.className = 'zv-dialog-title';
    titleEl.textContent = title || 'VOIP';
    titleWrap.appendChild(titleEl);
    if (subtitle){
      const subtitleEl = document.createElement('p');
      subtitleEl.className = 'zv-dialog-subtitle';
      subtitleEl.textContent = subtitle;
      titleWrap.appendChild(subtitleEl);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'zv-dialog-close';
    closeBtn.textContent = 'x';
    closeBtn.setAttribute('aria-label', 'Fechar');

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'zv-dialog-body';
    const feedback = document.createElement('div');
    feedback.className = 'zv-dialog-feedback';
    const footer = document.createElement('div');
    footer.className = 'zv-dialog-footer';

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(feedback);
    card.appendChild(footer);

    const close = ()=>{
      overlay.remove();
      document.removeEventListener('keydown', onKeydown, true);
      if (activeVoipDialogClose === close) activeVoipDialogClose = null;
    };
    const cancel = ()=>{
      close();
      if (typeof onCancel === 'function') onCancel();
    };
    const onKeydown = (ev)=>{
      if (ev.key === 'Escape'){
        ev.preventDefault();
        cancel();
      }
    };

    overlay.addEventListener('click', (ev)=>{ if (ev.target === overlay) cancel(); });
    closeBtn.addEventListener('click', cancel);
    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
    activeVoipDialogClose = close;

    return { overlay, card, body, footer, feedback, close, cancel };
  }

  async function showVoipNotice(message, opts){
    const options = opts || {};
    const title = String(options.title || 'VOIP').trim() || 'VOIP';
    return new Promise((resolve)=>{
      const dlg = mountVoipDialog(title, '', ()=>resolve(false));
      const msg = document.createElement('div');
      msg.className = 'zv-message';
      msg.textContent = String(message || '').trim();
      dlg.body.appendChild(msg);
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'zv-btn primary';
      okBtn.textContent = 'OK';
      okBtn.addEventListener('click', ()=>{
        dlg.close();
        resolve(true);
      });
      dlg.footer.appendChild(okBtn);
      okBtn.focus();
    });
  }

  async function showVoipSingleSelectDialog(config){
    const cfg = config || {};
    const options = Array.isArray(cfg.options) ? cfg.options : [];
    if (!options.length) return null;

    let selectedIndex = Number.isFinite(cfg.defaultIndex) && cfg.defaultIndex >= 0
      ? cfg.defaultIndex
      : -1;
    if (selectedIndex >= options.length || (options[selectedIndex] && options[selectedIndex].disabled)){
      selectedIndex = options.findIndex((item)=>!item.disabled);
    }

    return new Promise((resolve)=>{
      const dlg = mountVoipDialog(
        String(cfg.title || 'Selecione').trim(),
        String(cfg.subtitle || '').trim(),
        ()=>resolve(null)
      );
      const list = document.createElement('div');
      list.className = 'zv-dialog-list';
      dlg.body.appendChild(list);

      const rows = [];
      let confirmBtn = null;

      const render = ()=>{
        for (let i=0; i<rows.length; i++) rows[i].classList.toggle('is-selected', i === selectedIndex);
        if (confirmBtn){
          confirmBtn.disabled =
            selectedIndex < 0 ||
            selectedIndex >= options.length ||
            !!(options[selectedIndex] && options[selectedIndex].disabled);
        }
      };

      for (let i=0; i<options.length; i++){
        const option = options[i] || {};
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'zv-option';
        if (option.disabled) row.classList.add('is-disabled');

        const main = document.createElement('div');
        main.className = 'zv-option-main';
        const label = document.createElement('div');
        label.className = 'zv-option-label';
        label.textContent = String(option.label || `Opcao ${i+1}`);
        main.appendChild(label);
        if (option.subtitle){
          const subtitle = document.createElement('div');
          subtitle.className = 'zv-option-subtitle';
          subtitle.textContent = String(option.subtitle);
          main.appendChild(subtitle);
        }

        const right = document.createElement('div');
        right.className = 'zv-option-right';
        if (option.statusText){
          const badge = document.createElement('span');
          badge.className = `zv-badge ${option.statusTone || 'muted'}`;
          badge.textContent = String(option.statusText);
          right.appendChild(badge);
        }
        const marker = document.createElement('span');
        marker.className = 'zv-select-marker';
        right.appendChild(marker);

        row.appendChild(main);
        row.appendChild(right);
        row.addEventListener('click', ()=>{
          if (option.disabled) return;
          selectedIndex = i;
          render();
        });
        rows.push(row);
        list.appendChild(row);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'zv-btn';
      cancelBtn.textContent = String(cfg.cancelText || 'Cancelar');
      cancelBtn.addEventListener('click', ()=>{
        dlg.close();
        resolve(null);
      });

      confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'zv-btn primary';
      confirmBtn.textContent = String(cfg.confirmText || 'Selecionar');
      confirmBtn.addEventListener('click', ()=>{
        if (selectedIndex < 0 || selectedIndex >= options.length){
          dlg.feedback.textContent = 'Selecione uma opcao para continuar.';
          dlg.feedback.style.display = 'block';
          return;
        }
        if (options[selectedIndex] && options[selectedIndex].disabled){
          dlg.feedback.textContent = 'Esta opcao nao pode ser selecionada.';
          dlg.feedback.style.display = 'block';
          return;
        }
        dlg.close();
        resolve(selectedIndex);
      });

      dlg.footer.appendChild(cancelBtn);
      dlg.footer.appendChild(confirmBtn);
      render();
    });
  }

  function extractPhone(){
    try {
      const telInput = document.querySelector(
        'aside input[type="tel"], .contact-sidebar input[type="tel"], .contactsApp input[type="tel"], input[name*="phone"], input[name*="telefone"]'
      );
      if (telInput && telInput.value) {
        const p = normalizePhone(telInput.value);
        if (p) { log('phone from input', p); return p; }
      }

      const selectors = [
        '#central-panel-header',
        '[data-testid*="conversation-title"]',
        '.conversation-header',
        '.contact-sidebar',
        '.lead-sidebar',
        '.right-panel',
        'aside'
      ];
      for (const sel of selectors){
        const el = document.querySelector(sel);
        if (!el) continue;
        const m = (el.innerText||'').match(/(?:\+?\d{1,3}[\s\-\.]?)?(\d[\d\-\s\(\)]{6,}\d)/);
        if (m){
          const p = normalizePhone(m[0]);
          if (p) { log('phone from', sel, p); return p; }
        }
      }

      const m = (document.body.innerText || '').match(/(?:\+?\d{1,3}[\s\-\.]?)?(\d[\d\-\s\(\)]{6,}\d)/);
      if (m) return normalizePhone(m[0]);

    } catch(e){ errLog('extractPhone err', e); }
    return null;
  }

  // ------- util: name & photo extraction -------
  function extractName(){
    // 1) tentar sempre pegar do texto da UI (título / painel do contato)
    try {
      const selectors = [
        '.contact-sidebar [data-testid*="contact-name"]',
        '.contact-sidebar header h1',
        '.contact-sidebar header h2',
        '.contact-sidebar h1',
        '.contact-sidebar h2',
        '.right-panel [data-testid*="contact-name"]',
        '.right-panel h1',
        '.right-panel h2',
        '.conversation-header [data-testid*="conversation-title"]',
        '.conversation-header h2',
        '#central-panel-header h2',
        'aside .contact-name',
        'aside h1',
        'aside h2'
      ];
      for (const sel of selectors){
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = (el.textContent || '').trim();
        if (txt && txt.length > 1) {
          log('name from', sel, txt);
          return txt;
        }
      }
    } catch(e){ errLog('extractName text err', e); }

    // 2) fallback: usar ALT do avatar, mas ignorando textos genéricos
    try {
      const meta = window._zaptosVoipAvatarMeta;
      if (meta && meta.alt){
        const alt = meta.alt.trim();
        if (
          alt &&
          !/user\s+image/i.test(alt) &&
          !/user\s+avatar/i.test(alt) &&
          !/profile\s+picture/i.test(alt) &&
          !/foto\s+do\s+usuário/i.test(alt)
        ){
          log('name from avatar alt fallback', alt);
          return alt;
        }
      }
    } catch(e){ errLog('extractName alt err', e); }

    return '';
  }

  function extractPhoto(){
    const name = extractName();
    try {
      let candidates = [];

      const scopedSelectors = [
        '.contact-sidebar',
        '.right-panel',
        '#central-panel-header',
        '.conversation-header',
        'aside'
      ];
      for (const sel of scopedSelectors){
        const container = document.querySelector(sel);
        if (!container) continue;
        if (name && container.innerText && !container.innerText.includes(name)) continue;
        candidates.push(...container.querySelectorAll('img'));
      }

      if (!candidates.length) {
        candidates = Array.from(document.querySelectorAll(
          '.contact-sidebar img, .right-panel img, #central-panel-header img, .conversation-header img, aside img[class*="avatar"], aside [class*="avatar"] img'
        ));
      }

      if (!candidates.length) return '';

      function recordMeta(img, src){
        const alt = (img.getAttribute('alt') || '').trim();
        window._zaptosVoipAvatarMeta = { src, alt };
        if (alt) log('avatar meta alt=', alt);
      }

      for (const img of candidates){
        const src = img.src || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;
        if (/pps\.whatsapp\.net/i.test(src)) {
          log('photo from pps.whatsapp.net (scoped)', src);
          recordMeta(img, src);
          return src;
        }
      }

      if (name){
        for (const img of candidates){
          const src = img.src || img.getAttribute('src') || '';
          if (!src || src.startsWith('data:')) continue;
          const alt = (img.getAttribute('alt') || '').trim();
          if (alt && alt.toLowerCase().includes(name.toLowerCase())){
            log('photo from alt~name (scoped)', src);
            recordMeta(img, src);
            return src;
          }
        }
      }

      for (const img of candidates){
        const src = img.src || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;
        if (!/logo|icon|sprite|emoji/i.test(src)){
          log('photo fallback generic (scoped)', src);
          recordMeta(img, src);
          return src;
        }
      }

    } catch(e){ errLog('extractPhoto err', e); }
    return '';
  }

  // ------- VOIP webphone helpers -------
  function getWavoipTokenStorageKey(){
    return WAVOIP_TOKEN_KEY;
  }

  function getSavedWavoipToken(){
    try {
      const raw = localStorage.getItem(getWavoipTokenStorageKey());
      return raw ? raw.trim() : '';
    } catch { return ''; }
  }

  function saveWavoipToken(token){
    const clean = (token || '').trim();
    if (!clean) return;
    try { localStorage.setItem(getWavoipTokenStorageKey(), clean); } catch {}
  }

  function clearWavoipToken(){
    try { localStorage.removeItem(getWavoipTokenStorageKey()); } catch {}
    wavoipActiveToken = null;
    wavoipActiveTokens = [];
    wavoipReadyPromise = null;
    clearEdgeSession('clear-voip-token');
  }

  function requestWavoipToken(){
    const saved = getSavedWavoipToken();
    const typed = prompt('Insira o token do Webphone VOIP:', saved || '');
    if (!typed) return null;
    const token = typed.trim();
    if (!token) return null;
    saveWavoipToken(token);
    return token;
  }

  function ensureWavoipToken(forcePrompt){
    if (forcePrompt) return requestWavoipToken();
    const saved = getSavedWavoipToken();
    if (saved) return saved;
    return requestWavoipToken();
  }

  function loadWavoipScript(){
    if (window.wavoipWebphone) return Promise.resolve();
    if (wavoipScriptPromise) return wavoipScriptPromise;

    wavoipScriptPromise = new Promise((resolve, reject)=>{
      const existing = document.querySelector('script[data-zaptos-wavoip-script="1"]');
      if (existing){
        if (window.wavoipWebphone){ resolve(); return; }
        existing.addEventListener('load', ()=>resolve(), { once: true });
        existing.addEventListener('error', ()=>reject(new Error('Falha ao carregar o script do VOIP.')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = WAVOIP_SCRIPT_URL;
      script.async = true;
      script.dataset.zaptosWavoipScript = '1';
      script.onload = ()=>resolve();
      script.onerror = ()=>reject(new Error('Falha ao carregar o script do VOIP.'));
      document.head.appendChild(script);
    }).catch((e)=>{
      wavoipScriptPromise = null;
      throw e;
    });

    return wavoipScriptPromise;
  }

  function enforceWavoipWidgetButtonHidden(){
    try {
      if (
        window.wavoip &&
        window.wavoip.settings &&
        typeof window.wavoip.settings.setShowWidgetButton === 'function'
      ) {
        window.wavoip.settings.setShowWidgetButton(false);
      }
    } catch(e){
      log('setShowWidgetButton(false) failed', e);
    }

    hideWavoipSettingsButton();
  }

  function findWavoipDialerRootForHeaderActions(){
    const allNodes = Array.from(document.querySelectorAll('*'));
    const versionNode = allNodes.find((el)=>{
      const text = String(el.textContent || '').trim();
      return text && text.length <= 40 && /\bv\s*\d+\.\d+\.\d+/i.test(text);
    });
    if (!versionNode) return null;

    let current = versionNode;
    for (let i=0; i<8 && current && current.parentElement; i++){
      current = current.parentElement;
      const rect = current.getBoundingClientRect();
      if (!rect || rect.width < 220 || rect.height < 300) continue;
      if (rect.left < window.innerWidth * 0.45) continue;

      const buttons = current.querySelectorAll('button, [role="button"]');
      if (buttons.length >= 4) return current;
    }
    return null;
  }

  function hideWavoipSettingsButtonByApi(){
    try {
      if (!window.wavoip || !window.wavoip.settings) return;
      const settingsApi = window.wavoip.settings;
      const candidates = [
        'setShowSettingsButton',
        'setShowWidgetSettingsButton',
        'setShowWidgetSettings',
        'setShowSettings'
      ];
      for (const fnName of candidates){
        const fn = settingsApi[fnName];
        if (typeof fn !== 'function') continue;
        try { fn.call(settingsApi, false); } catch (e){ log(`${fnName}(false) failed`, e); }
      }
    } catch (e){
      log('hideWavoipSettingsButtonByApi failed', e);
    }
  }

  function hideWavoipSettingsButtonByDom(){
    try {
      const root = findWavoipDialerRootForHeaderActions();
      if (!root) return;

      const targetedSelectors = [
        'button[aria-label*="setting" i]',
        'button[aria-label*="config" i]',
        'button[title*="setting" i]',
        'button[title*="config" i]',
        '[role="button"][aria-label*="setting" i]',
        '[role="button"][aria-label*="config" i]',
        '[data-testid*="setting" i]',
        '[data-testid*="config" i]'
      ];

      let hiddenAny = false;
      for (const selector of targetedSelectors){
        const matches = root.querySelectorAll(selector);
        for (const node of matches){
          node.style.display = 'none';
          node.style.visibility = 'hidden';
          hiddenAny = true;
        }
      }
      if (hiddenAny) return;

      const rootRect = root.getBoundingClientRect();
      const topButtons = Array.from(root.querySelectorAll('button, [role="button"]'))
        .filter((node)=>{
          const rect = node.getBoundingClientRect();
          if (!rect || rect.width < 14 || rect.height < 14) return false;
          if (rect.top > rootRect.top + 64) return false;
          if (rect.right < rootRect.right - 180) return false;
          return true;
        })
        .sort((a,b)=>a.getBoundingClientRect().left - b.getBoundingClientRect().left);

      if (topButtons.length >= 3){
        const settingsBtn = topButtons[topButtons.length - 2];
        settingsBtn.style.display = 'none';
        settingsBtn.style.visibility = 'hidden';
      }
    } catch (e){
      log('hideWavoipSettingsButtonByDom failed', e);
    }
  }

  function hideWavoipSettingsButton(){
    hideWavoipSettingsButtonByApi();
    hideWavoipSettingsButtonByDom();
  }

  async function initWavoipWebphone(forcePromptToken, options){
    const opts = options || {};
    const preferredToken = String(opts.preferredToken || '').trim();

    if (forcePromptToken) clearWavoipToken();

    if (!wavoipReadyPromise){
      wavoipReadyPromise = (async ()=>{
        await loadWavoipScript();

        if (!window.wavoipWebphone || typeof window.wavoipWebphone.render !== 'function'){
          throw new Error('Biblioteca VOIP indisponivel.');
        }

        if (!wavoipRendered){
          await window.wavoipWebphone.render({
            widget: {
              showWidgetButton: false,
              startOpen: false
            }
          });
          wavoipRendered = true;
        }

        if (!window.wavoip || !window.wavoip.device){
          throw new Error('Webphone VOIP nao inicializou.');
        }

        enforceWavoipWidgetButtonHidden();
        return true;
      })().catch((e)=>{
        wavoipReadyPromise = null;
        throw e;
      });
    }

    await wavoipReadyPromise;

    const token = preferredToken || ensureWavoipToken(forcePromptToken);
    if (!token) throw new Error('Token do VOIP nao informado.');

    if (
      window.wavoip &&
      window.wavoip.device &&
      typeof window.wavoip.device.add === 'function' &&
      !wavoipActiveTokens.includes(token)
    ) {
      window.wavoip.device.add(token);
      wavoipActiveTokens.push(token);
    }

    wavoipActiveToken = token;
    enforceWavoipWidgetButtonHidden();
    return true;
  }

  function wait(ms){
    return new Promise((resolve)=>setTimeout(resolve, ms));
  }

  function getVoipStartResultError(result){
    if (!result || typeof result !== 'object') return '';
    if (!result.err) return '';
    return (
      (result.err.devices && result.err.devices[0] && result.err.devices[0].reason) ||
      result.err.message ||
      String(result.err) ||
      ''
    );
  }

  function hasVoipCallInProgress(){
    function isActiveCallShape(callObj){
      if (!callObj) return false;
      if (Array.isArray(callObj)) return callObj.some((item)=>isActiveCallShape(item));
      if (typeof callObj !== 'object') return false;

      if (callObj.id || callObj.call_id || callObj.peer || callObj.transport || callObj.startedAt || callObj.createdAt){
        return true;
      }

      const rawState = String(callObj.status || callObj.state || '').trim().toLowerCase();
      if (!rawState) return false;
      const nonActiveStates = new Set(['idle','ended','end','terminated','hangup','disconnected','closed']);
      return !nonActiveStates.has(rawState);
    }

    try {
      if (!window.wavoip || !window.wavoip.call) return false;
      const outgoing = typeof window.wavoip.call.getCallOutgoing === 'function'
        ? window.wavoip.call.getCallOutgoing()
        : null;
      if (isActiveCallShape(outgoing)) return true;
      const active = typeof window.wavoip.call.getCallActive === 'function'
        ? window.wavoip.call.getCallActive()
        : null;
      if (isActiveCallShape(active)) return true;
    } catch (e){
      log('hasVoipCallInProgress check failed', e);
    }
    return false;
  }

  async function waitForVoipCallStart(timeoutMs){
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 1800;
    const interval = 150;
    const startAt = Date.now();
    while (Date.now() - startAt < timeout){
      if (hasVoipCallInProgress()) return true;
      await wait(interval);
    }
    return hasVoipCallInProgress();
  }

  function getUniqueTrimmedTokens(list){
    return Array.from(new Set((list || []).map((v)=>String(v || '').trim()).filter(Boolean)));
  }

  async function isolateOutgoingTokenForCall(selectedToken){
    const target = String(selectedToken || '').trim();
    if (!target) return async ()=>{};

    const deviceApi = window.wavoip && window.wavoip.device ? window.wavoip.device : null;
    if (!deviceApi || typeof deviceApi.add !== 'function') return async ()=>{};

    const previousTokens = getUniqueTrimmedTokens(wavoipActiveTokens);
    if (!previousTokens.length || previousTokens.length === 1) return async ()=>{};

    let isolated = false;
    if (typeof deviceApi.removeAll === 'function'){
      try {
        deviceApi.removeAll();
        deviceApi.add(target);
        isolated = true;
      } catch (e){
        log('removeAll isolation failed', e);
      }
    } else if (typeof deviceApi.remove === 'function'){
      try {
        for (const token of previousTokens){
          if (token === target) continue;
          try { deviceApi.remove(token); } catch (removeErr){ log('remove token for isolation failed', token, removeErr); }
        }
        deviceApi.add(target);
        isolated = true;
      } catch (e){
        log('remove isolation failed', e);
      }
    }

    if (!isolated) return async ()=>{};

    return async ()=>{
      try {
        for (const token of previousTokens){
          try { deviceApi.add(token); } catch (addErr){ log('restore token after call start failed', token, addErr); }
        }
      } catch (e){
        log('restore isolated tokens failed', e);
      }
    };
  }

  async function triggerVoipCall(phone, selectedToken){
    const callApi = window.wavoip && window.wavoip.call ? window.wavoip.call : null;
    if (!callApi) return { ok:false, reason:'Modulo de chamadas VOIP indisponivel.' };

    const startCallFn = typeof callApi.startCall === 'function' ? callApi.startCall.bind(callApi) : null;
    const startFn = typeof callApi.start === 'function' ? callApi.start.bind(callApi) : null;
    const startPrimary = startCallFn || startFn;
    if (!startPrimary) return { ok:false, reason:'API de chamada VOIP nao disponivel.' };

    function getRuntimeDeviceList(){
      try {
        if (window.wavoip && window.wavoip.device && typeof window.wavoip.device.get === 'function'){
          const list = window.wavoip.device.get();
          if (Array.isArray(list)) return list;
        }
      } catch (e){ log('device.get failed', e); }
      try {
        if (window.wavoip && window.wavoip.device && typeof window.wavoip.device.getDevices === 'function'){
          const list = window.wavoip.device.getDevices();
          if (Array.isArray(list)) return list;
        }
      } catch (e){ log('device.getDevices failed', e); }
      return [];
    }

    function parseRgbChannels(colorValue){
      const raw = String(colorValue || '').trim();
      const match = raw.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (!match) return null;
      return { r:Number(match[1]), g:Number(match[2]), b:Number(match[3]) };
    }

    function isGreenishBackground(colorValue){
      const channels = parseRgbChannels(colorValue);
      if (!channels) return false;
      return channels.g >= 110 && channels.g > channels.r + 20 && channels.g > channels.b + 20;
    }

    function findWavoipDialerRoot(){
      const allNodes = Array.from(document.querySelectorAll('*'));
      const versionNode = allNodes.find((el)=>{
        const text = String(el.textContent || '').trim();
        return text && text.length <= 40 && /\bv\s*\d+\.\d+\.\d+/i.test(text);
      });
      if (!versionNode) return null;

      let current = versionNode;
      for (let i=0; i<8 && current && current.parentElement; i++){
        current = current.parentElement;
        const rect = current.getBoundingClientRect();
        if (!rect || rect.width < 220 || rect.height < 300) continue;
        if (rect.left < window.innerWidth * 0.45) continue;
        const buttons = current.querySelectorAll('button, [role="button"]');
        if (buttons.length >= 8) return current;
      }
      return null;
    }

    function clickNode(node){
      if (!node) return false;
      try {
        const events = ['pointerdown','mousedown','pointerup','mouseup','click'];
        for (const type of events){
          node.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window }));
        }
        return true;
      } catch (e){
        log('clickNode failed', e);
        return false;
      }
    }

    function clickWidgetDialButtonFallback(){
      const root = findWavoipDialerRoot();
      if (!root) return false;

      const withPhoneIcon = Array.from(root.querySelectorAll('button, [role="button"], div'))
        .filter((el)=>{
          const rect = el.getBoundingClientRect();
          if (!rect || rect.width < 34 || rect.height < 34) return false;
          if (rect.bottom < window.innerHeight * 0.4) return false;
          const path = el.querySelector('svg path[d*="M8.38 8.853"], svg path[d*="14.603"], svg path[d*="call"], svg path[d*="phone"]');
          if (!path) return false;
          const style = window.getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') return false;
          return true;
        });

      if (withPhoneIcon.length){
        const bestPhoneButton = withPhoneIcon.sort((a,b)=>{
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const scoreA = ra.width * ra.height + ra.top;
          const scoreB = rb.width * rb.height + rb.top;
          return scoreB - scoreA;
        })[0];
        return clickNode(bestPhoneButton);
      }

      const candidates = Array.from(root.querySelectorAll('button, [role="button"]'))
        .filter((el)=>{
          const rect = el.getBoundingClientRect();
          if (!rect || rect.width < 36 || rect.height < 36) return false;
          const style = window.getComputedStyle(el);
          const radius = Number.parseFloat(style.borderRadius || '0') || 0;
          if (radius < 14) return false;
          if (!isGreenishBackground(style.backgroundColor)) return false;
          if (!el.querySelector('svg')) return false;
          return true;
        });
      if (!candidates.length) return false;
      const best = candidates.sort((a,b)=>{
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })[0];
      return clickNode(best);
    }

    function findRuntimeDeviceByToken(token){
      const target = String(token || '').trim();
      if (!target) return null;
      const list = getRuntimeDeviceList();
      return list.find((item)=>String(item && item.token || '').trim() === target) || null;
    }

    function isRuntimeDeviceReadyStatus(status){
      const normalized = String(status || '').trim().toLowerCase();
      return normalized === 'open' || normalized === 'connected' || normalized === 'ready';
    }

    async function waitForRuntimeDeviceReady(token, timeoutMs){
      const target = String(token || '').trim();
      if (!target) return true;
      const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
      const interval = 300;
      const startAt = Date.now();
      while (Date.now() - startAt < timeout){
        const device = findRuntimeDeviceByToken(target);
        const status = String(device && device.status || '').trim().toLowerCase();
        if (isRuntimeDeviceReadyStatus(status)) return true;
        await wait(interval);
      }
      const last = findRuntimeDeviceByToken(target);
      return isRuntimeDeviceReadyStatus(last && last.status);
    }

    async function setPreferredOutgoingToken(token){
      const target = String(token || '').trim();
      if (!target || !window.wavoip || !window.wavoip.device) return;
      const deviceApi = window.wavoip.device;
      const methods = [
        deviceApi.enable,
        deviceApi.enableDevice,
        deviceApi.setPrimary,
        deviceApi.setPrimaryDevice,
        deviceApi.setDefault,
        deviceApi.setDefaultDevice,
        deviceApi.setMain,
        deviceApi.setMainDevice,
        deviceApi.setOutgoingDevice,
        deviceApi.select,
        deviceApi.selectDevice,
        deviceApi.activate
      ].filter((fn)=>typeof fn === 'function');

      for (const fn of methods){
        try {
          await fn.call(deviceApi, target);
          return;
        } catch (e1){
          try {
            await fn.call(deviceApi, [target]);
            return;
          } catch (e2){
            try {
              await fn.call(deviceApi, { token: target });
              return;
            } catch (e3){
              log('set preferred token failed', e1 || e2 || e3);
            }
          }
        }
      }
    }

    if (selectedToken){
      await setPreferredOutgoingToken(selectedToken);
      await waitForRuntimeDeviceReady(selectedToken, 15000);
    }

    const clickedFirst = clickWidgetDialButtonFallback();
    if (clickedFirst){
      const startedAfterFirstClick = await waitForVoipCallStart(2500);
      if (startedAfterFirstClick) return { ok:true };
    }

    const callAttempts = [];
    if (selectedToken){
      const options = { fromTokens:[selectedToken], fromToken:selectedToken };
      if (startCallFn){
        callAttempts.push(()=>startCallFn(phone, options));
        callAttempts.push(()=>startCallFn(phone, { fromTokens:[selectedToken] }));
        callAttempts.push(()=>startCallFn(phone, { fromToken:selectedToken }));
      }
      if (startFn){
        callAttempts.push(()=>startFn(phone, options));
        callAttempts.push(()=>startFn(phone, { fromTokens:[selectedToken] }));
        callAttempts.push(()=>startFn(phone, { fromToken:selectedToken }));
      }
      callAttempts.push(()=>startPrimary({ to:phone, fromTokens:[selectedToken], fromToken:selectedToken }));
      callAttempts.push(()=>startPrimary({ to:phone, fromTokens:[selectedToken] }));
      callAttempts.push(()=>startPrimary({ to:phone, fromToken:selectedToken }));
    }
    callAttempts.push(()=>startPrimary({ to:phone }));
    if (startCallFn) callAttempts.push(()=>startCallFn(phone));
    else if (startFn) callAttempts.push(()=>startFn(phone));

    const maxAttempts = 22;
    const retryDelayMs = 1000;
    let lastReason = '';
    for (let attempt=1; attempt<=maxAttempts; attempt++){
      for (const invoke of callAttempts){
        try {
          const result = await invoke();
          const errReason = getVoipStartResultError(result);
          if (errReason){
            lastReason = errReason;
          } else {
            if (result && result.call) return { ok:true };
            const started = await waitForVoipCallStart(1800);
            if (started) return { ok:true };
          }
        } catch (e){
          const message = String((e && e.message) || e || '').trim();
          if (message) lastReason = message;
        }
      }
      if (attempt < maxAttempts) await wait(retryDelayMs);
    }

    const clicked = clickWidgetDialButtonFallback();
    if (clicked){
      const startedAfterClick = await waitForVoipCallStart(2500);
      if (startedAfterClick) return { ok:true };
    }

    return { ok:false, reason:lastReason || 'Nao foi possivel iniciar a ligacao automaticamente.' };
  }

  async function startVoipLeadCall(phone, preferredToken){
    const locationId = getLocationIdFromPath();
    const locationInstances = await fetchVoipInstancesWithTokenForLocation(locationId);
    if (!locationInstances.length){
      throw new Error(
        'Nenhuma instancia VOIP com token foi encontrada nesta subconta. A ligacao nao pode ser iniciada.'
      );
    }

    const requestedToken = String(preferredToken || '').trim();
    await initWavoipWebphone(false, { preferredToken: requestedToken });

    if (!window.wavoip || !window.wavoip.call){
      throw new Error('Modulo de chamadas VOIP indisponivel.');
    }

    enforceWavoipWidgetButtonHidden();

    const selectedToken = requestedToken || wavoipActiveToken;
    if (!selectedToken){
      return { ok:true, started:false, reason:'user-cancel' };
    }

    if (
      requestedToken &&
      !locationInstances.some((item)=>String((item && item.token) || '').trim() === requestedToken)
    ) {
      throw new Error('A instancia selecionada nao esta disponivel nesta subconta para realizar a ligacao.');
    }

    if (typeof window.wavoip.call.setInput === 'function'){
      window.wavoip.call.setInput(phone);
    }

    const restoreOutgoingIsolation = await isolateOutgoingTokenForCall(selectedToken);

    if (
      window.wavoip &&
      window.wavoip.device &&
      typeof window.wavoip.device.add === 'function'
    ) {
      try {
        window.wavoip.device.add(selectedToken);
        if (!wavoipActiveTokens.includes(selectedToken)) wavoipActiveTokens.push(selectedToken);
      } catch (e){
        log('device.add selected token failed', selectedToken, e);
      }
    }

    if (window.wavoip.widget && typeof window.wavoip.widget.open === 'function'){
      window.wavoip.widget.open();
    } else if (
      window.wavoip &&
      window.wavoip.widget &&
      typeof window.wavoip.widget.toggle === 'function'
    ) {
      window.wavoip.widget.toggle();
    }

    enforceWavoipWidgetButtonHidden();

    if (typeof window.wavoip.call.setInput === 'function'){
      window.wavoip.call.setInput(phone);
    }

    await wait(650);

    try {
      const trigger = await triggerVoipCall(phone, selectedToken);
      if (!trigger.ok){
        throw new Error(trigger.reason || 'Falha ao iniciar chamada no VOIP.');
      }
    } finally {
      await restoreOutgoingIsolation();
    }

    return { ok:true, started:true };
  }

  async function openVoipForManualDial(message){
    await initWavoipWebphone(false);

    if (window.wavoip && window.wavoip.widget){
      if (typeof window.wavoip.widget.open === 'function'){
        window.wavoip.widget.open();
      } else if (typeof window.wavoip.widget.toggle === 'function'){
        window.wavoip.widget.toggle();
      }
    }

    enforceWavoipWidgetButtonHidden();
    if (message) await showVoipNotice(message);
  }

  // ------- token fetch helpers (API) -------
  async function fetchEdgeToken(locationId, instanceApiKey){
    window._zaptosVoipGHL_debug.edgeCalls = window._zaptosVoipGHL_debug.edgeCalls || [];
    try {
      if (!locationId || !instanceApiKey) return { token: null, status: 'missing-params' };

      const url = new URL(EDGE_TOKEN_URL);
      url.searchParams.set('location_id', locationId);
      url.searchParams.set('api_key', instanceApiKey);

      const resp = await fetch(url.toString(), { method: 'GET', credentials: 'omit' });
      const text = await resp.text().catch(()=>null);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch(e){ json = null; }
      const record = { url: url.toString(), status: resp.status, ok: resp.ok, text, json };
      window._zaptosVoipGHL_debug.edgeCalls.push(record);
      log('token query result', record);

      const token = (json && (json.token || json.access_token || (json.data && json.data.token))) || null;
      if (token) return { token, status: 'ok-query', raw: json };

      try {
        const r2 = await fetch(EDGE_TOKEN_URL, {
          method:'GET',
          credentials:'omit',
          headers: { 'apikey': instanceApiKey, 'x-wavoip-location-id': locationId }
        });
        const t2 = await r2.text().catch(()=>null);
        let j2 = null;
        try { j2 = t2 ? JSON.parse(t2) : null; } catch(e){ j2 = null; }
        window._zaptosVoipGHL_debug.edgeCalls.push({
          url: EDGE_TOKEN_URL,
          status: r2.status,
          ok: r2.ok,
          text: t2,
          json: j2,
          via:'header-apikey'
        });
        const token2 = (j2 && (j2.token || j2.access_token || (j2.data && j2.data.token))) || null;
        if (token2) return { token: token2, status: 'ok-header', raw: j2 };
      } catch(e){ /* ignore */ }

      return { token: null, status: 'no-token-found', raw: json || text };
    } catch(e){ errLog('fetchEdgeToken error', e); return { token: null, status: 'error', error: String(e) }; }
  }

  function getLocationIdFromPath(){
    try {
      const match = location.pathname.match(/\/location\/([^\/]+)/);
      return match ? match[1] : null;
    } catch { return null; }
  }

  function looksLikeGhlId(value){
    return /^[A-Za-z0-9]{8,}$/.test(String(value || '').trim());
  }

  function readUrlParam(names){
    try {
      const u = new URL(location.href);
      for (const name of names){
        const v = String(u.searchParams.get(name) || '').trim();
        if (v) return v;
      }
    } catch {}
    return '';
  }

  function extractEntityIdsFromUrl(){
    const contactFromQuery = readUrlParam(['contactId','contact_id','contactid']);
    const conversationFromQuery = readUrlParam(['conversationId','conversation_id','conversationid']);

    const segments = String(location.pathname || '')
      .split('/')
      .map((s)=>decodeURIComponent(s || '').trim())
      .filter(Boolean);

    const ignored = new Set([
      'v2','location','contacts','conversations','manual_actions','templates',
      'trigger-links','settings','opportunities'
    ]);

    function findIdAfter(keyword){
      const kw = String(keyword || '').toLowerCase();
      for (let i=0; i<segments.length; i++){
        if (segments[i].toLowerCase() !== kw) continue;
        for (let j=i+1; j<Math.min(i+4, segments.length); j++){
          const candidate = segments[j];
          if (!candidate) continue;
          if (ignored.has(candidate.toLowerCase())) continue;
          if (looksLikeGhlId(candidate)) return candidate;
        }
      }
      return '';
    }

    const contactId = contactFromQuery || findIdAfter('contacts');
    const conversationId = conversationFromQuery || findIdAfter('conversations');
    return {
      contactId: contactId && looksLikeGhlId(contactId) ? contactId : '',
      conversationId: conversationId && looksLikeGhlId(conversationId) ? conversationId : ''
    };
  }

  function firstNonEmptyString(values){
    if (!Array.isArray(values)) return '';
    for (const value of values){
      const s = String(value || '').trim();
      if (s) return s;
    }
    return '';
  }

  function collectPhonesFromKnownList(target, values){
    if (!Array.isArray(values) || !Array.isArray(target)) return;
    for (const value of values){
      if (!value) continue;
      if (Array.isArray(value)){
        collectPhonesFromKnownList(target, value);
        continue;
      }
      if (typeof value === 'string' || typeof value === 'number'){
        const normalized = normalizePhone(String(value));
        if (normalized && !target.includes(normalized)) target.push(normalized);
        continue;
      }
      if (typeof value === 'object'){
        const objValue = value.phone || value.number || value.value || value.phoneNumber || value.whatsapp || '';
        if (!objValue) continue;
        const normalized = normalizePhone(String(objValue));
        if (normalized && !target.includes(normalized)) target.push(normalized);
      }
    }
  }

  function collectPhonesByKeyHint(value, keyHint, out, seen, depth){
    if (value == null || depth > 6) return;
    if (typeof value === 'string' || typeof value === 'number'){
      if (/phone|telefone|whatsapp|celular|mobile/i.test(String(keyHint || ''))){
        const normalized = normalizePhone(String(value));
        if (normalized && !out.includes(normalized)) out.push(normalized);
      }
      return;
    }
    if (Array.isArray(value)){
      for (const item of value) collectPhonesByKeyHint(item, keyHint, out, seen, depth + 1);
      return;
    }
    if (typeof value === 'object'){
      if (seen.has(value)) return;
      seen.add(value);
      for (const [k,v] of Object.entries(value)) collectPhonesByKeyHint(v, k, out, seen, depth + 1);
    }
  }

  function extractContactDataFromEdgePayload(payload){
    const contact = (payload && payload.contact) || (payload && payload.data && payload.data.contact) || null;
    const phones = [];
    collectPhonesFromKnownList(phones, [
      payload && payload.phone,
      payload && payload.phone_number,
      payload && payload.mobile,
      payload && payload.whatsapp_phone,
      payload && payload.phones,
      payload && payload.phoneNumbers,
      contact && contact.phone,
      contact && contact.mobile,
      contact && contact.mobilePhone,
      contact && contact.whatsappPhone,
      contact && contact.secondaryPhone,
      contact && contact.phones,
      contact && contact.phoneNumbers,
      contact && contact.additionalPhones,
      contact && contact.additionalPhoneNumbers
    ]);

    if (contact && Array.isArray(contact.customFields)){
      for (const field of contact.customFields){
        if (!field || typeof field !== 'object') continue;
        const key = String(field.key || field.name || field.field || field.label || field.id || '');
        if (!/phone|telefone|whatsapp|celular|mobile/i.test(key)) continue;
        collectPhonesFromKnownList(phones, [field.value]);
      }
    }
    if (contact && typeof contact === 'object'){
      collectPhonesByKeyHint(contact, 'contact', phones, new Set(), 0);
    }

    const firstName = firstNonEmptyString([contact && contact.firstName, contact && contact.first_name]);
    const lastName = firstNonEmptyString([contact && contact.lastName, contact && contact.last_name]);
    const composedName = [firstName, lastName].filter(Boolean).join(' ').trim();

    const name = firstNonEmptyString([contact && contact.name, composedName, payload && payload.name]);
    const photo = firstNonEmptyString([
      contact && contact.profilePic,
      contact && contact.profilePicture,
      contact && contact.profilePhoto,
      contact && contact.photo,
      contact && contact.avatar,
      contact && contact.profileImage,
      payload && payload.photo,
      payload && payload.avatar
    ]);

    return { phones, name: name || null, photo: photo || null, contact: contact || null };
  }

  async function fetchLeadContactByEdge(){
    window._zaptosVoipGHL_debug.contactCalls = window._zaptosVoipGHL_debug.contactCalls || [];
    const locationId = getLocationIdFromPath();
    if (!locationId) return null;

    const ids = extractEntityIdsFromUrl();
    if (!ids.contactId && !ids.conversationId) return null;

    try {
      const payload = { location_id: locationId };
      if (ids.contactId) payload.contact_id = ids.contactId;
      if (ids.conversationId) payload.conversation_id = ids.conversationId;

      const { response, text, json } = await callEdgeAction(
        EDGE_ACTIONS.getContact,
        payload,
        { requireSession: true }
      );

      window._zaptosVoipGHL_debug.contactCalls.push({
        action: EDGE_ACTIONS.getContact,
        status: response.status,
        ok: response.ok,
        text,
        json
      });

      if (!response.ok || !json || json.ok === false) return null;
      return extractContactDataFromEdgePayload(json);
    } catch(e){
      errLog('fetchLeadContactByEdge error', e);
      return null;
    }
  }

  function getInstanceIdentity(instance){
    if (!instance) return '';
    const id = instance.instance_id || instance.instanceId || instance.id || instance.instance_name || instance.name || '';
    return String(id || '').trim();
  }

  function extractInstanceRows(payload){
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.instances)) return payload.instances;
    if (Array.isArray(payload.data)) return payload.data;
    if (payload.data && Array.isArray(payload.data.instances)) return payload.data.instances;
    return [];
  }

  function normalizeInstanceRows(rows){
    if (!Array.isArray(rows)) return [];
    const normalized = [];
    for (const row of rows){
      const name = String(
        row &&
          (row.instance_name || row.instanceName || row.name || row.instance || row.label || '')
      ).trim();
      if (!name) continue;
      const id = getInstanceIdentity(row) || name;
      const token = String((row && (row.wavoip_token || row.token || row.access_token || row.webphone_token)) || '').trim();
      const wavoipStatus = String((row && (row.wavoip_status || row.status || (row.device && row.device.status) || '')) || '')
        .trim()
        .toLowerCase();
      const canCallRaw = row && row.can_call;
      const canCall =
        canCallRaw === true ||
        canCallRaw === 'true' ||
        canCallRaw === 1 ||
        canCallRaw === '1' ||
        wavoipStatus === 'open';
      const callError = String((row && row.call_error) || '').trim();
      normalized.push({
        id,
        instance_id: id,
        instance_name: name,
        token,
        wavoip_status: wavoipStatus || null,
        can_call: canCall,
        call_error: callError || null
      });
    }
    return normalized;
  }

  async function fetchVoipInstances(locationId){
    window._zaptosVoipGHL_debug.instanceCalls = window._zaptosVoipGHL_debug.instanceCalls || [];
    if (!locationId) return [];

    try {
      const { response, text, json } = await callEdgeAction(
        EDGE_ACTIONS.getInstances,
        { location_id: locationId },
        { requireSession: true }
      );

      window._zaptosVoipGHL_debug.instanceCalls.push({
        action: EDGE_ACTIONS.getInstances,
        status: response.status,
        ok: response.ok,
        text,
        json
      });

      if (!response.ok || !json || json.ok === false) return [];
      const instances = normalizeInstanceRows(extractInstanceRows(json));
      return instances;
    } catch(e){
      errLog('fetchVoipInstances error', e);
      return [];
    }
  }

  async function fetchVoipInstancesWithTokenForLocation(locationId){
    if (!locationId) return [];
    const instances = await fetchVoipInstances(locationId);
    return (instances || []).filter((item)=>{
      const token = String((item && item.token) || '').trim();
      return !!token;
    });
  }

  function isInstanceOpenStatus(value){
    return String(value || '').trim().toLowerCase() === 'open';
  }

  function hasCanCallFlag(value){
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  async function verifyOutgoingCallSelection(locationId, selectedOption){
    if (!locationId){
      return { ok:false, reason:'Subconta invalida para verificar a instancia.' };
    }
    const latest = await fetchVoipInstances(locationId);
    if (!latest.length){
      return { ok:false, reason:'Nao foi possivel verificar o status da instancia para ligar.' };
    }

    const selectedToken = String((selectedOption && selectedOption.token) || '').trim();
    const selectedId = String((selectedOption && selectedOption.id) || '').trim();
    const selectedName = String((selectedOption && selectedOption.instance_name) || (selectedOption && selectedOption.name) || '').trim();

    let matched = null;
    if (selectedToken){
      matched = latest.find((item)=>String(item.token || '').trim() === selectedToken) || null;
    }
    if (!matched && selectedId){
      matched = latest.find((item)=>getInstanceIdentity(item) === selectedId) || null;
    }
    if (!matched && selectedName){
      matched =
        latest.find(
          (item)=>String(item.instance_name || '').trim().toLowerCase() === selectedName.toLowerCase()
        ) || null;
    }
    if (!matched){
      return { ok:false, reason:'Nao foi possivel validar a instancia selecionada para ligacao.' };
    }

    const status = String(matched.wavoip_status || matched.status || '').trim().toLowerCase();
    const canCall = hasCanCallFlag(matched.can_call) || isInstanceOpenStatus(status);
    const name = String(matched.instance_name || selectedName || 'Instancia').trim();
    const reason = canCall
      ? ''
      : String(matched.call_error || '').trim() ||
        `A instancia "${name}" nao esta com status open (status atual: ${status || 'desconhecido'}).`;

    return {
      ok: canCall,
      token: String(matched.token || selectedToken || '').trim(),
      reason,
      option: {
        token: String(matched.token || selectedToken || '').trim(),
        id: String(getInstanceIdentity(matched) || selectedId || '').trim(),
        name,
        wavoip_status: status || '',
        can_call: canCall,
        call_error: String(matched.call_error || '').trim()
      }
    };
  }

  async function chooseCallInstanceForClickToCall(locationId){
    const instances = await fetchVoipInstances(locationId);
    if (!instances.length){
      await showVoipNotice('Nenhuma instancia VOIP foi encontrada para esta subconta. Verifique o cadastro da location.');
      return null;
    }

    const withToken = instances.filter((item)=>!!String((item && item.token) || '').trim());
    if (!withToken.length){
      await showVoipNotice('As instancias desta subconta nao possuem token VOIP para iniciar a ligacao.');
      return null;
    }

    if (withToken.length === 1){
      const selected = withToken[0];
      const validated = await verifyOutgoingCallSelection(locationId, selected);
      if (!validated.ok){
        await showVoipNotice(validated.reason || 'A instancia selecionada nao esta pronta/conectada para ligacao.');
        return null;
      }
      return { ...selected, token: String(validated.token || selected.token || '').trim() };
    }

    const options = withToken.map((item)=>{
      const statusMeta = resolveStatusBadge(
        item && item.wavoip_status,
        item && item.can_call,
        !!String((item && item.token) || '').trim()
      );
      return {
        label: String((item && item.instance_name) || 'Instancia'),
        subtitle: String((item && item.token) || '').trim(),
        statusText: statusMeta.text,
        statusTone: statusMeta.tone,
        disabled: false
      };
    });

    while (true){
      const selectedIndex = await showVoipSingleSelectDialog({
        title: 'Escolher instancia',
        subtitle: 'Selecione de qual instancia deseja ligar',
        options,
        defaultIndex: 0,
        confirmText: 'Continuar',
        cancelText: 'Cancelar'
      });
      if (selectedIndex == null) return null;

      const selected = withToken[selectedIndex];
      const validated = await verifyOutgoingCallSelection(locationId, selected);
      if (!validated.ok){
        await showVoipNotice(
          validated.reason ||
            `A instancia "${selected.instance_name}" nao esta pronta/conectada para ligacao.`
        );
        continue;
      }
      return { ...selected, token: String(validated.token || selected.token || '').trim() };
    }
  }

  async function choosePhoneForClickToCall(phones){
    const normalizedPhones = Array.from(
      new Set((phones || []).map((phone)=>normalizePhone(phone)).filter(Boolean))
    );
    if (!normalizedPhones.length) return null;
    if (normalizedPhones.length === 1) return normalizedPhones[0];

    const options = normalizedPhones.map((phone)=>({
      label: phone,
      subtitle: 'Numero do contato',
      statusText: 'Telefone',
      statusTone: 'muted',
      disabled: false
    }));
    const selectedIndex = await showVoipSingleSelectDialog({
      title: 'Escolher numero',
      subtitle: 'Este contato possui mais de um telefone',
      options,
      defaultIndex: 0,
      confirmText: 'Usar numero',
      cancelText: 'Cancelar'
    });
    if (selectedIndex == null) return null;
    return normalizedPhones[selectedIndex] || null;
  }

  function openClickToCallWindow(data){
    if (!data) return;
    const token = String((data && data.token) || '').trim();
    const phone = String((data && data.phone) || '').trim();
    if (!token || !phone) return;

    const params = new URLSearchParams({
      token,
      phone,
      start_if_ready: 'true',
      close_after_call: 'true'
    });
    const name = String((data && data.name) || '').trim();
    const photo = String((data && data.photo) || '').trim();
    if (name) params.set('name', name);
    if (photo) params.set('photo', photo);

    const url = CALL_PAGE_URL + '?' + params.toString();
    log('opening call URL:', url);
    window.open(url, 'zaptos_voip_call', POPUP_OPTS);
  }

  async function resolveTokenFlow(){
    const storedToken = sessionStorage.getItem(SESSION_KEYS.token);
    if (storedToken) { log('using session token'); return { token: storedToken, source: 'session' }; }

    const locationId = getLocationIdFromPath();
    const savedApiKey = sessionStorage.getItem(SESSION_KEYS.apiKey);

    if (savedApiKey && locationId){
      const r = await fetchEdgeToken(locationId, savedApiKey);
      if (r && r.token){
        sessionStorage.setItem(SESSION_KEYS.token, r.token);
        sessionStorage.setItem(SESSION_KEYS.loc, locationId);
        return { token: r.token, source: 'api-key-saved', meta: r };
      } else {
        sessionStorage.removeItem(SESSION_KEYS.apiKey);
        sessionStorage.removeItem(SESSION_KEYS.loc);
        log('saved apiKey failed; cleared', r);
      }
    }

    const apiKey = prompt('Insira a API KEY da instância:');
    if (!apiKey) return { token: null, source: 'user-skip' };

    const locFromUrl = locationId || getLocationIdFromPath();
    if (!locFromUrl){
      alert('Não foi possível detectar o Location ID na URL da GHL. Abra a subconta (/location/...) e tente novamente.');
      return { token: null, source: 'no-location' };
    }

    const r = await fetchEdgeToken(locFromUrl.trim(), apiKey.trim());
    if (r && r.token){
      sessionStorage.setItem(SESSION_KEYS.apiKey, apiKey.trim());
      sessionStorage.setItem(SESSION_KEYS.loc, locFromUrl.trim());
      sessionStorage.setItem(SESSION_KEYS.token, r.token);
      return { token: r.token, source: 'api-key-prompt', meta: r };
    } else {
      alert('Não foi possível obter o token. Verifique a API Key ou as permissões.');
      return { token: null, source: 'api-key-failed', meta: r };
    }
  }

  function clearSaved() {
    sessionStorage.removeItem(SESSION_KEYS.apiKey);
    sessionStorage.removeItem(SESSION_KEYS.loc);
    sessionStorage.removeItem(SESSION_KEYS.token);
    clearEdgeSession('clear-saved');
    log('cleared saved credentials');
  }

  // ------- UI: header button (compacto) -------
  function createHeaderButton(){
    const wrapper = document.createElement('div');
    wrapper.id = 'zaptosvoip-ghl-header-btn';
    Object.assign(wrapper.style, {
      display:'inline-flex',
      alignItems:'center',
      marginLeft:'4px',
      marginRight:'0'
    });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label','Ligar pelo WhatsApp');
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:8px;justify-content:center;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
             xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <path d="M6.6 10.2a8.7 8.7 0 0 0 3.2 3.2l.7.4a1.5 1.5 0 0 0 1.5-.1l1.2-.8a1 1 0 0 1 1.1.1l2.3 1.7a1 1 0 0 1 .4 1.1 3.1 3.1 0 0 1-3 2.2 9.3 9.3 0 0 1-4.1-1.1 9.5 9.5 0 0 1-4.5-4.5A9.3 9.3 0 0 1 4.9 7a3.1 3.1 0 0 1 2.2-3 1 1 0 0 1 1.1.4l1.7 2.3a1 1 0 0 1 .1 1.1l-.8 1.2a1.5 1.5 0 0 0-.1 1.5l.5.7Z"
                fill="currentColor"/>
        </svg>
        <span class="zaptosvoip-text" style="font-weight:600;font-size:13px;">Ligar pelo WhatsApp</span>
      </span>
    `;

    Object.assign(btn.style, {
      background: 'linear-gradient(90deg, #0EB636 0%, #0069FF 100%)',
      color: '#011023',
      border: 'none',
      padding: '0 12px',
      borderRadius: '15px',
      cursor: 'pointer',
      fontWeight: 700,
      height: '34px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 0 0 rgba(0,0,0,0)',
      fontSize: '13px',
      whiteSpace: 'nowrap',
      margin: '0'
    });

    btn.onmouseenter = ()=> btn.style.transform = 'translateY(-1px)';
    btn.onmouseleave = ()=> btn.style.transform = '';

    wrapper.appendChild(btn);
    return { wrapper, btn };
  }

  // ------- header insertion logic -------
  const headerSelectors = [
    '#central-panel-header .message-header-actions',
    '.message-header .message-header-actions',
    '.conversation-header .actions',
    '.right-panel .header-actions',
    '.card-header .actions',
    '.contact-actions',
    '.contact-actions-wrapper',
    '.message-header',
    '.lead-sidebar .actions'
  ];

  function findHeaderContainer(){
    for (const s of headerSelectors){
      const el = document.querySelector(s);
      if (el) return { el, sel: s };
    }
    const title = document.querySelector(
      '[data-testid*="conversation-title"], .conversation-title, #central-panel-header h2'
    );
    if (title && title.parentElement){
      const maybe = Array.from(title.parentElement.children)
        .find(c=>c.querySelector && c.querySelector('button, svg, .fa-phone'));
      if (maybe) return { el: maybe, sel: 'sibling-of-title' };
    }
    return null;
  }

  function insertButton(){
    if (document.querySelector('#zaptosvoip-ghl-header-btn')) return true;
    const found = findHeaderContainer();
    if (!found) return false;
    const { el } = found;
    const { wrapper, btn } = createHeaderButton();
    try {
      const group = el.querySelector('.button-group') || el.querySelector('.flex') || el;

      // botão como PRIMEIRO ícone
      if (group.firstElementChild) {
        group.insertBefore(wrapper, group.firstElementChild);
      } else {
        group.appendChild(wrapper);
      }
    } catch(e){
      el.appendChild(wrapper);
    }
    btn.addEventListener('click', onClickHandler);
    return true;
  }

  function removeButton(){
    const n = document.querySelector('#zaptosvoip-ghl-header-btn'); if (n) n.remove();
  }

  // ------- click handler -------
  async function onClickHandler(ev){
    ev && ev.preventDefault && ev.preventDefault();
    const btn = ev ? ev.currentTarget : document.querySelector('#zaptosvoip-ghl-header-btn button');
    if (!btn) return;
    try {
      btn.disabled = true;
      const textNode = btn.querySelector('.zaptosvoip-text');
      if (textNode) textNode.textContent = 'Carregando...';

      const locationId = getLocationIdFromPath();
      if (!locationId){
        await showVoipNotice('Este recurso esta disponivel apenas dentro de subcontas (URL com /location/...).');
        return;
      }

      const selectedInstance = await chooseCallInstanceForClickToCall(locationId);
      if (!selectedInstance) return;

      const edgeContact = await fetchLeadContactByEdge();
      const fallbackPhone = normalizePhone(extractPhone());

      const phones = [];
      if (edgeContact && Array.isArray(edgeContact.phones)) phones.push(...edgeContact.phones);
      if (fallbackPhone) phones.push(fallbackPhone);

      const finalPhone = await choosePhoneForClickToCall(phones);
      if (!finalPhone){
        await showVoipNotice('Nao foi possivel identificar o numero do contato para ligar.');
        return;
      }
      const callResult = await startVoipLeadCall(finalPhone, selectedInstance.token);
      if (callResult && callResult.started === false){
        if (callResult.reason === 'user-cancel') return;
        await openVoipForManualDial(
          'Nao foi possivel iniciar a ligacao automaticamente. Use o VOIP para discagem manual.'
        );
      }

    } catch(e){
      errLog('onClickHandler err', e);
      const msg = String((e && e.message) || e || '');
      if (/cancelada/i.test(msg)) return;
      await showVoipNotice('Erro ao iniciar chamada: ' + (e && e.message || e));
    } finally {
      const textNode = document.querySelector('#zaptosvoip-ghl-header-btn .zaptosvoip-text');
      setTimeout(()=>{ 
        if (textNode) textNode.textContent = 'Ligar pelo WhatsApp'; 
        const b = document.querySelector('#zaptosvoip-ghl-header-btn button'); 
        if (b) b.disabled=false; 
      }, 700);
    }
  }

  // ------- page relevance & observer -------
  function isRelevantPage(){
    try {
      const p = location.pathname || '';
      if (/\/conversations\b|\/conversations\/|\/contacts\b|\/contacts\//i.test(p)) return true;
      if (document.querySelector('.conversation-title') ||
          document.querySelector('.lead-sidebar') ||
          document.querySelector('.contact-sidebar')) return true;
      const right = document.querySelector('aside') ||
                    document.querySelector('.right-panel') ||
                    document.querySelector('.lead-sidebar');
      if (right && /(Contato|Telefone|Phone)/i.test(right.innerText||'')) return true;
    } catch(e){}
    return false;
  }

  let lastLocation = location.href;
  function checkAndEnsure(){
    try {
      enforceWavoipWidgetButtonHidden();
      if (isRelevantPage()){
        const ok = insertButton();
        if (!ok) log('header container not found yet');
      } else {
        removeButton();
      }
    } catch(e){ errLog('checkAndEnsure', e); }
  }

  const mo = new MutationObserver(()=>{
    if (location.href !== lastLocation){
      lastLocation = location.href;
      setTimeout(checkAndEnsure, 450);
      return;
    }
    if (isRelevantPage()){
      if (!document.querySelector('#zaptosvoip-ghl-header-btn')) checkAndEnsure();
    } else {
      if (document.querySelector('#zaptosvoip-ghl-header-btn')) removeButton();
    }
  });
  mo.observe(document.documentElement, { childList:true, subtree:true });

  window._zaptosVoipGHL = Object.assign(window._zaptosVoipGHL || {}, {
    resolveTokenFlow,
    fetchEdgeToken,
    fetchVoipInstances,
    fetchLeadContactByEdge,
    chooseCallInstanceForClickToCall,
    choosePhoneForClickToCall,
    openClickToCallWindow,
    extractPhone,
    extractName,
    extractPhoto,
    clearSaved,
    clearWavoipToken,
    requestWavoipToken,
    initWavoipWebphone,
    startVoipLeadCall,
    openVoipForManualDial,
    debug: window._zaptosVoipGHL_debug,
    EDGE_TOKEN_URL,
    INSTANCE_PICKER_URL,
    CALL_PAGE_URL
  });

  setTimeout(checkAndEnsure, 700);
  log('zaptosvoip-ghl loader initialized');
})();

