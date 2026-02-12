// == ZaptosVoip GHL header button (voip.zaptoswpp.com) ==
(function(){
  if (window.__ZAPTOSVOIP_GHL_BTN_FINAL__) return console.log('[ZaptosVoip] already loaded');
  window.__ZAPTOSVOIP_GHL_BTN_FINAL__ = true;

  const DEBUG = false; // true para logs no console
  const POPUP_OPTS = 'width=360,height=640,menubar=0,toolbar=0,location=0,status=0';
  const DEFAULT_COUNTRY = '55';
  const EDGE_TOKEN_URL = 'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-wavoip-token';
  const SESSION_KEYS = {
    token: 'zaptosvoip_token_user_override',
    apiKey: 'zaptosvoip_instance_api_key',
    loc:   'zaptosvoip_location_id'
  };

  const log    = (...a)=> { if (DEBUG) console.log('[ZaptosVoip]', ...a); };
  const errLog = (...a)=> console.error('[ZaptosVoip]', ...a);

  window._zaptosVoipGHL_debug = window._zaptosVoipGHL_debug || { edgeCalls: [], lastResolve: null };
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
      const origText = textNode ? textNode.textContent : btn.textContent;
      if (textNode) textNode.textContent = 'Carregando...';

      let phone = extractPhone();
      if (!phone){
        const manual = prompt('Número não detectado. Digite o número (ex: 551199999999):');
        phone = normalizePhone(manual);
      }
      if (!phone){
        alert('Número inválido.');
        if (textNode) textNode.textContent = origText;
        btn.disabled=false;
        return;
      }

      const photo = extractPhoto() || '';
      const name  = extractName() || '';

      window._zaptosVoipGHL_debug.lastResolve = { at: Date.now() };
      const r = await resolveTokenFlow();
      window._zaptosVoipGHL_debug.lastResolve.result = r;
      log('resolveTokenFlow result', r);

      if (!r || !r.token){
        alert('Token de ligação não obtido. Verifique a API Key ou tente novamente.');
        if (textNode) textNode.textContent = origText;
        btn.disabled=false;
        return;
      }

      const token = r.token;

      const params = new URLSearchParams({
        token,
        phone,
        name,
        photo,
        start_if_ready: 'true',
        close_after_call: 'true'
      });

      const url = 'https://voip.zaptoswpp.com/call/?' + params.toString();
      window.open(url, 'zaptosvoip_call', POPUP_OPTS);

    } catch(e){
      errLog('onClickHandler err', e);
      alert('Erro ao iniciar chamada: ' + (e && e.message || e));
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
    extractPhone,
    extractName,
    extractPhoto,
    clearSaved,
    debug: window._zaptosVoipGHL_debug,
    EDGE_TOKEN_URL
  });

  setTimeout(checkAndEnsure, 700);
  log('zaptosvoip-ghl loader initialized');
})();

