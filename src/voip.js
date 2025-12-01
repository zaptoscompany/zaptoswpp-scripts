<script>
// == Wavoip GHL header button (final, edge-first, safe storage, polished) ==
(function(){
  if (window.__WAVOIP_GHL_BTN_FINAL__) return console.log('[wavoip] already loaded');
  window.__WAVOIP_GHL_BTN_FINAL__ = true;

  const DEBUG = false; // true para logs no console
  const POPUP_OPTS = 'width=360,height=640,menubar=0,toolbar=0,location=0,status=0';
  const DEFAULT_COUNTRY = '55';
  const EDGE_TOKEN_URL = 'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-wavoip-token'; // ajuste se necessário
  const SESSION_KEYS = {
    token: 'wavoip_token_user_override',
    apiKey: 'wavoip_instance_api_key',
    loc: 'wavoip_location_id'
  };

  const log = (...a)=> { if (DEBUG) console.log('[wavoip]', ...a); };
  const errLog = (...a)=> console.error('[wavoip]', ...a);

  window._wavoipGHL_debug = window._wavoipGHL_debug || { edgeCalls: [], lastResolve: null };

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
      // 1) tel input in contact panel
      const telInput = document.querySelector('aside input[type="tel"], .contact-sidebar input[type="tel"], .contactsApp input[type="tel"], input[name*="phone"], input[name*="telefone"]');
      if (telInput && telInput.value) {
        const p = normalizePhone(telInput.value);
        if (p) { log('phone from input', p); return p; }
      }

      // 2) look for phone in known panels / header near title
      const selectors = ['#central-panel-header','[data-testid*="conversation-title"]','.conversation-header','.contact-sidebar','.lead-sidebar','.right-panel','aside'];
      for (const sel of selectors){
        const el = document.querySelector(sel);
        if (!el) continue;
        const m = (el.innerText||'').match(/(?:\+?\d{1,3}[\s\-\.]?)?(\d[\d\-\s\(\)]{6,}\d)/);
        if (m){
          const p = normalizePhone(m[0]);
          if (p) { log('phone from', sel, p); return p; }
        }
      }

      // 3) fallback: whole document
      const m = (document.body.innerText || '').match(/(?:\+?\d{1,3}[\s\-\.]?)?(\d[\d\-\s\(\)]{6,}\d)/);
      if (m) return normalizePhone(m[0]);

    } catch(e){ errLog('extractPhone err', e); }
    return null;
  }

  // ------- token fetch helpers -------
  async function fetchEdgeToken(locationId, instanceApiKey){
    window._wavoipGHL_debug.edgeCalls = window._wavoipGHL_debug.edgeCalls || [];
    try {
      if (!locationId || !instanceApiKey) return { token: null, status: 'missing-params' };

      // Try simple query GET first (no custom headers -> avoid OPTIONS)
      const url = new URL(EDGE_TOKEN_URL);
      url.searchParams.set('location_id', locationId);
      url.searchParams.set('api_key', instanceApiKey);

      const resp = await fetch(url.toString(), { method: 'GET', credentials: 'omit' });
      const text = await resp.text().catch(()=>null);
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch(e){ json = null; }
      const record = { url: url.toString(), status: resp.status, ok: resp.ok, text, json };
      window._wavoipGHL_debug.edgeCalls.push(record);
      log('edge query result', record);

      // pick token from known properties
      const token = (json && (json.token || json.access_token || (json.data && json.data.token))) || null;
      if (token) return { token, status: 'ok-query', raw: json };

      // if not found, try header fallback (may trigger OPTIONS in some setups)
      try {
        const r2 = await fetch(EDGE_TOKEN_URL, { method:'GET', credentials:'omit', headers: { 'apikey': instanceApiKey, 'x-wavoip-location-id': locationId }});
        const t2 = await r2.text().catch(()=>null);
        let j2 = null;
        try { j2 = t2 ? JSON.parse(t2) : null; } catch(e){ j2 = null; }
        window._wavoipGHL_debug.edgeCalls.push({ url: EDGE_TOKEN_URL, status: r2.status, ok: r2.ok, text: t2, json: j2, via:'header-apikey' });
        const token2 = (j2 && (j2.token || j2.access_token || (j2.data && j2.data.token))) || null;
        if (token2) return { token: token2, status: 'ok-header', raw: j2 };
      } catch(e){ /* ignore */ }

      return { token: null, status: 'no-token-found', raw: json || text };
    } catch(e){ errLog('fetchEdgeToken error', e); return { token: null, status: 'error', error: String(e) }; }
  }

  async function resolveTokenFlow(){
    // 1) session override
    const storedToken = sessionStorage.getItem(SESSION_KEYS.token);
    if (storedToken) { log('using session token'); return { token: storedToken, source: 'session' }; }

    // 2) if apiKey+location saved -> try edge
    const savedApiKey = sessionStorage.getItem(SESSION_KEYS.apiKey);
    const savedLocation = sessionStorage.getItem(SESSION_KEYS.loc) || (location.pathname.match(/\/location\/([^\/]+)/) || [])[1] || null;
    if (savedApiKey && savedLocation){
      const r = await fetchEdgeToken(savedLocation, savedApiKey);
      if (r && r.token){
        sessionStorage.setItem(SESSION_KEYS.token, r.token);
        return { token: r.token, source: 'edge', meta: r };
      } else {
        // saved credentials failed -> remove to force prompt next time
        sessionStorage.removeItem(SESSION_KEYS.apiKey);
        sessionStorage.removeItem(SESSION_KEYS.loc);
        log('saved apiKey failed; cleared', r);
      }
    }

    // 3) prompt user (if allowed) to paste API key + location (only once)
    const ask = confirm('Deseja tentar buscar o token via Edge? (será solicitado API Key + Location ID) — Clique "OK" para informar, "Cancelar" para inserir token manual.');
    if (ask){
      const apiKey = prompt('Cole a Instance API Key (detalhe: será salva na sessão por segurança):');
      if (!apiKey) return { token: null, source: 'user-skip' };
      const locationId = prompt('Cole a Location ID (GHL) associada a essa instância:');
      if (!locationId) return { token: null, source: 'user-skip' };

      // call edge
      const r = await fetchEdgeToken(locationId.trim(), apiKey.trim());
      if (r && r.token){
        // save in session for convenience
        sessionStorage.setItem(SESSION_KEYS.apiKey, apiKey.trim());
        sessionStorage.setItem(SESSION_KEYS.loc, locationId.trim());
        sessionStorage.setItem(SESSION_KEYS.token, r.token);
        return { token: r.token, source: 'edge', meta: r };
      } else {
        alert('Não foi possível obter token da Edge com as credenciais informadas. Verifique API Key / Location ID.');
        return { token: null, source: 'edge-failed', meta: r };
      }
    }

    // 4) fallback: guess from storage/globals
    const guesses = [...Object.keys(localStorage||{}), ...Object.keys(sessionStorage||{})];
    for (const k of guesses){
      if (/wavoip|wvoip|wavoip_token|wavoipToken|token/i.test(k)){
        const v = localStorage[k] || sessionStorage[k];
        if (v && String(v).length > 10) return { token: v, source: 'guess:'+k };
      }
    }

    // 5) manual paste fallback
    const manual = prompt('Cole o token Wavoip aqui (ou cancele):');
    if (manual) { sessionStorage.setItem(SESSION_KEYS.token, manual.trim()); return { token: manual.trim(), source: 'manual' }; }

    return { token: null, source: 'none' };
  }

  function clearSaved() {
    sessionStorage.removeItem(SESSION_KEYS.apiKey);
    sessionStorage.removeItem(SESSION_KEYS.loc);
    sessionStorage.removeItem(SESSION_KEYS.token);
    log('cleared saved credentials');
  }

  // ------- UI: header button (WhatsApp icon, same visual size) -------
  function createHeaderButton(){
    const wrapper = document.createElement('div');
    wrapper.id = 'wavoip-ghl-header-btn';
    Object.assign(wrapper.style, { display:'inline-flex', alignItems:'center', gap:'8px', marginLeft:'8px' });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label','Ligar pelo WhatsApp');
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:8px;">
        <!-- whatsapp-like icon (simple) -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <path d="M21 16.5a16 16 0 0 1-3.6.5 15.3 15.3 0 0 1-7.7-2.7L6 17l1.6-4.4A9.9 9.9 0 0 1 5 9.5C5 6 7.2 3 10.2 2.5 12 .2 15 1 17 3.2c2 2.2 2.7 5.4 2 8.2-.5 2.2-.8 3.1-1 4.6z" fill="currentColor"/>
        </svg>
        <span class="wavoip-text" style="font-weight:600;font-size:13px;">Ligar pelo WhatsApp</span>
      </span>
    `;
    Object.assign(btn.style, {
      background:'#1db954', color:'#fff', border:'none', padding:'6px 10px',
      borderRadius:'12px', cursor:'pointer', fontWeight:700, height:'36px', display:'inline-flex', alignItems:'center'
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
    const title = document.querySelector('[data-testid*="conversation-title"], .conversation-title, #central-panel-header h2');
    if (title && title.parentElement){
      const maybe = Array.from(title.parentElement.children).find(c=>c.querySelector && c.querySelector('button, svg, .fa-phone'));
      if (maybe) return { el: maybe, sel: 'sibling-of-title' };
    }
    return null;
  }

  function insertButton(){
    if (document.querySelector('#wavoip-ghl-header-btn')) return true;
    const found = findHeaderContainer();
    if (!found) return false;
    const { el } = found;
    const { wrapper, btn } = createHeaderButton();
    try {
      const group = el.querySelector('.button-group') || el.querySelector('.flex') || el;
      group.appendChild(wrapper);
    } catch(e){
      el.appendChild(wrapper);
    }
    btn.addEventListener('click', onClickHandler);
    return true;
  }

  function removeButton(){
    const n = document.querySelector('#wavoip-ghl-header-btn'); if (n) n.remove();
  }

  // ------- click handler -------
  async function onClickHandler(ev){
    ev && ev.preventDefault && ev.preventDefault();
    const btn = ev ? ev.currentTarget : document.querySelector('#wavoip-ghl-header-btn button');
    if (!btn) return;
    try {
      btn.disabled = true;
      const textNode = btn.querySelector('.wavoip-text');
      const origText = textNode ? textNode.textContent : btn.textContent;
      if (textNode) textNode.textContent = 'Carregando...';

      // extract phone
      let phone = extractPhone();
      if (!phone){
        const manual = prompt('Número não detectado. Digite o número (ex: 551199999999):');
        phone = normalizePhone(manual);
      }
      if (!phone){ alert('Número inválido.'); if (textNode) textNode.textContent = origText; btn.disabled=false; return; }

      // resolve token
      window._wavoipGHL_debug.lastResolve = { at: Date.now() };
      const r = await resolveTokenFlow();
      window._wavoipGHL_debug.lastResolve.result = r;
      log('resolveTokenFlow result', r);

      if (!r || !r.token){
        alert('Token Wavoip não obtido. Verifique credenciais ou insira token manualmente.');
        if (textNode) textNode.textContent = origText;
        btn.disabled=false;
        return;
      }

      const token = r.token;
      // open wavoip webphone
      const params = new URLSearchParams({ token, phone, start_if_ready: 'true', close_after_call: 'true' });
      const url = 'https://app.wavoip.com/call?' + params.toString();
      window.open(url, 'wavoip_call', POPUP_OPTS);

    } catch(e){
      errLog('onClickHandler err', e);
      alert('Erro ao iniciar chamada: ' + (e && e.message || e));
    } finally {
      const textNode = document.querySelector('#wavoip-ghl-header-btn .wavoip-text');
      setTimeout(()=>{ if (textNode) textNode.textContent = 'Ligar pelo WhatsApp'; const b = document.querySelector('#wavoip-ghl-header-btn button'); if (b) b.disabled=false; }, 700);
    }
  }

  // ------- page relevance & observer -------
  function isRelevantPage(){
    try {
      const p = location.pathname || '';
      if (/\/conversations\b|\/conversations\/|\/contacts\b|\/contacts\//i.test(p)) return true;
      if (document.querySelector('.conversation-title') || document.querySelector('.lead-sidebar') || document.querySelector('.contact-sidebar')) return true;
      const right = document.querySelector('aside') || document.querySelector('.right-panel') || document.querySelector('.lead-sidebar');
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

  const mo = new MutationObserver((muts)=>{
    if (location.href !== lastLocation){ lastLocation = location.href; setTimeout(checkAndEnsure, 450); return; }
    if (isRelevantPage()){
      if (!document.querySelector('#wavoip-ghl-header-btn')) checkAndEnsure();
    } else {
      if (document.querySelector('#wavoip-ghl-header-btn')) removeButton();
    }
  });
  mo.observe(document.documentElement, { childList:true, subtree:true });

  // expose helpers for debugging
  window._wavoipGHL = Object.assign(window._wavoipGHL || {}, {
    resolveTokenFlow, fetchEdgeToken, extractPhone, clearSaved, debug: window._wavoipGHL_debug, EDGE_TOKEN_URL
  });

  // initial
  setTimeout(checkAndEnsure, 700);
  log('wavoip-ghl loader (final) initialized');
})();

</script>