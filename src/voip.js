// == Wavoip GHL header button (final) ==
(function(){
  if (window.__WAVOIP_GHL_BTN__) return console.log('[wavoip] already loaded');
  window.__WAVOIP_GHL_BTN__ = true;

  const DEBUG = false;
  const POPUP_OPTS = 'width=360,height=640,menubar=0,toolbar=0,location=0,status=0';
  const DEFAULT_COUNTRY = '55';
  const FALLBACK_TOKEN_ENDPOINT = '/api/wavoip/token';

  const log = (...a)=>{ if (DEBUG) console.log('[wavoip]', ...a); };
  const errLog = (...a)=>console.error('[wavoip]', ...a);

  /* ---------- phone normalization / extraction ---------- */
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

  function findPhoneInNode(node){
    try {
      if (!node) return null;
      // 1) links tel: / wa.me / whatsapp
      const link = node.querySelector && (node.querySelector('a[href^="tel:"], a[href*="wa.me"], a[href*="whatsapp:"], a[href*="whatsapp"]'));
      if (link){
        const href = (link.getAttribute('href')||link.textContent||'').trim();
        const m = href.match(/(?:tel:|wa\.me\/|whatsapp:)?\+?([0-9\-\s\(\)]+)/i);
        if (m) { const p = normalizePhone(m[1]); if (p) return p; }
      }

      // 2) inputs tipo tel
      const inputTel = node.querySelector && (node.querySelector('input[type="tel"], input[name*="phone"], input[name*="telefone"]'));
      if (inputTel && inputTel.value) {
        const p = normalizePhone(inputTel.value);
        if (p) return p;
      }

      // 3) elementos com classe/atributo comum (data-phone etc)
      const dataPhone = node.querySelector && node.querySelector('[data-phone], .lead-phone, .contact-phone, .phone, .profile-phone');
      if (dataPhone){
        const txt = (dataPhone.dataset && dataPhone.dataset.phone) ? dataPhone.dataset.phone : (dataPhone.textContent||'');
        const p = normalizePhone(txt);
        if (p) return p;
      }

      // 4) labels "Telefone" / "Phone" — procurar siblings / parent text
      const labels = node.querySelectorAll && node.querySelectorAll('label, span, div, p, strong');
      if (labels && labels.length){
        for (let i=0;i<labels.length;i++){
          const t = (labels[i].textContent||'').trim();
          if (/^(telefone|phone)$|Telefone|Phone/i.test(t) || /\bTelefone\b|\bPhone\b/i.test(t)){
            // próximo sibling textual
            const nxt = labels[i].nextElementSibling;
            const candidateText = (nxt && (nxt.value || nxt.textContent || nxt.innerText)) || (labels[i].parentElement && labels[i].parentElement.innerText) || '';
            const m = String(candidateText).match(/(?:\+?\d{1,3}[\s\-\.]?)?(\d[\d\-\s\(\)]{6,}\d)/);
            if (m) { const p = normalizePhone(m[0]); if (p) return p; }
          }
        }
      }

      // 5) scan texto do node (tel pattern)
      const txt = (node.innerText || node.textContent || '');
      const m = txt.match(/(?:\+?\d{1,3}[\s\-\.]?)?(\d[\d\-\s\(\)]{6,}\d)/);
      if (m) { const p = normalizePhone(m[0]); if (p) return p; }

    } catch(e){
      /* swallow */
    }
    return null;
  }

  function extractPhone(){
    try {
      // prioridade 1: painel direito / contact sidebar (onde geralmente aparece)
      const rightSelectors = ['aside', '.right-panel', '.lead-sidebar', '.contact-sidebar', '.contact-details', '.contact-info'];
      for (const sel of rightSelectors){
        const panel = document.querySelector(sel);
        if (panel){
          const p = findPhoneInNode(panel);
          if (p) { log('phone from panel', sel, p); return p; }
        }
      }

      // prioridade 2: header da conversa (próximo ao título e ações)
      const headerCandidates = [
        document.querySelector('#central-panel-header'),
        document.querySelector('.conversation-header-text'),
        document.querySelector('.conversation-title'),
        document.querySelector('[data-testid*="conversation-title"]'),
        document.querySelector('.message-header') // generic
      ];
      for (const h of headerCandidates){
        if (!h) continue;
        const p = findPhoneInNode(h);
        if (p) { log('phone from header', p); return p; }
      }

      // prioridade 3: composer / area central
      const central = document.querySelector('.conversations-list') || document.querySelector('.conversations') || document.querySelector('main') || document.body;
      if (central){
        const p = findPhoneInNode(central);
        if (p) { log('phone from center', p); return p; }
      }

      // fallback global
      const all = document.body.innerText || '';
      const m = all.match(/(?:\+?\d{1,3}[\s\-\.]?)?(\d[\d\-\s\(\)]{6,}\d)/);
      if (m) { const p = normalizePhone(m[0]); if (p) { log('phone fallback global', p); return p; } }
    } catch(e){ errLog('extractPhone err', e); }
    return null;
  }

  /* ---------- token resolution ---------- */
  function guessTokenFromStorage(){
    try {
      const keys = [...Object.keys(localStorage||{}), ...Object.keys(sessionStorage||{})];
      for (const k of keys){
        if (/wavoip|wvoip|wavoip_token|wavoipToken|token|access_token|jwt|bearer/i.test(k)){
          const v = localStorage[k] || sessionStorage[k];
          if (v && String(v).length > 10) return v;
        }
      }
      const cookie = document.cookie.split(';').map(c=>c.trim()).find(c=>/wavoip|token|session|jwt|bearer/i.test(c));
      if (cookie) return cookie.split('=')[1];
      const globals = ['WAVOIP_TOKEN','wavoipToken','wavoip_token','__WAVOIP__','__INITIAL_STATE__'];
      for (const g of globals){
        try {
          const val = eval(g);
          if (typeof val === 'string' && val.length > 10) return val;
          if (val && typeof val === 'object') {
            const s = JSON.stringify(val);
            const m = s.match(/"token"\s*:\s*"(.*?)"/);
            if (m) return m[1];
          }
        } catch(e){}
      }
    } catch(e){ errLog('guessTokenFromStorage error', e); }
    return null;
  }

  async function fetchTokenFromServer(){
    try {
      const r = await fetch(FALLBACK_TOKEN_ENDPOINT, { credentials: 'include' });
      if (!r.ok) { log('fallback token endpoint returned', r.status); return null; }
      const j = await r.json();
      return j && (j.token || j.access_token || j.wavoip_token) || null;
    } catch(e){ log('fetchTokenFromServer error', e); return null; }
  }

  async function resolveToken(){
    const stored = sessionStorage.getItem('wavoip_token_user_override');
    if (stored) { log('token from sessionStorage override'); return stored; }
    const g = guessTokenFromStorage();
    if (g) { log('token guessed from storage'); return g; }
    const srv = await fetchTokenFromServer();
    if (srv) { log('token from fallback endpoint'); return srv; }
    const promptToken = prompt('Wavoip token não encontrado automaticamente. Cole o token aqui (ou cancele):');
    if (promptToken) {
      sessionStorage.setItem('wavoip_token_user_override', promptToken.trim());
      return promptToken.trim();
    }
    return null;
  }

  /* ---------- UI: create header-style button like native ---------- */
  function createHeaderButton(){
    // wrapper kept minimal; the inserted button will mimic existing header buttons classes
    const wrapper = document.createElement('div');
    wrapper.id = 'wavoip-ghl-header-btn';
    wrapper.className = 'wavoip-ghl-header-btn';
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.marginLeft = '8px';

    // create button element with classes similar to GHL header buttons for visual fit
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label','Ligar pelo WhatsApp');
    // add classes similar to existing header items (keeps styling consistent if site uses same CSS)
    btn.className = 'flex items-center px-2.5 py-1 border border-gray-300 rounded-md';
    btn.style.background = '#1db954';
    btn.style.color = '#fff';
    btn.style.borderColor = 'rgba(0,0,0,0.06)';
    btn.style.cursor = 'pointer';
    btn.style.fontWeight = '600';
    btn.style.height = '36px';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.gap = '8px';

    // Whatsapp icon (simple path) + label
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <path d="M20.52 3.48A11.9 11.9 0 0012 0C5.37 0 .01 5.36.01 12c0 2.12.56 4.18 1.62 5.98L0 24l6.27-1.61A11.94 11.94 0 0012 24c6.63 0 12-5.36 12-12 0-3.2-1.25-6.2-3.48-8.52zM12 21.5c-1.33 0-2.63-.34-3.76-.98l-.27-.16-3.72.96.99-3.61-.17-.29A9.5 9.5 0 012.5 12c0-5.24 4.26-9.5 9.5-9.5 2.54 0 4.92.99 6.71 2.78A9.45 9.45 0 0121.5 12c0 5.24-4.26 9.5-9.5 9.5z" fill="currentColor"/>
      </svg>
      <span class="wavoip-text" style="font-size:13px;line-height:1;">Ligar pelo WhatsApp</span>
    `;

    // small hover effect
    btn.onmouseenter = ()=> btn.style.transform = 'translateY(-1px)';
    btn.onmouseleave = ()=> btn.style.transform = '';

    wrapper.appendChild(btn);
    return { wrapper, btn };
  }

  /* ---------- find header container (strict to conversation/contact area) ---------- */
  const candidateHeaderSelectors = [
    '#central-panel-header .message-header-actions',
    '.message-header-actions',
    '.conversation-header .actions',
    '.right-panel .header-actions',
    '.card-header .actions',
    '.contact-actions',
    '.contact-actions-wrapper',
    '.message-header',
    '.lead-sidebar .actions'
  ];

  function findHeaderContainer(){
    for (const sel of candidateHeaderSelectors){
      const el = document.querySelector(sel);
      if (el) {
        // prefer a flex group with buttons inside to insert into
        const prefer = el.querySelector('.button-group, .flex, .actions, .message-header-actions') || el;
        return { el: prefer, sel };
      }
    }
    // fallback near conversation title
    const titleNode = document.querySelector('[data-testid*="conversation-title"], .conversation-title, #central-panel-header h2');
    if (titleNode && titleNode.parentElement){
      const maybe = Array.from(titleNode.parentElement.children).find(c=>c.querySelector && c.querySelector('button, .fa-phone, svg'));
      if (maybe) return { el: maybe, sel: 'sibling-of-title' };
    }
    return null;
  }

  function insertButtonIntoHeader(){
    try {
      if (document.querySelector('#wavoip-ghl-header-btn')) return true;
      const found = findHeaderContainer();
      if (!found) return false;
      const { el } = found;
      const { wrapper, btn } = createHeaderButton();

      // insert before the last element so it appears inline with icons
      try {
        // if the container is a group of buttons, append there
        el.appendChild(wrapper);
      } catch(e){
        document.body.appendChild(wrapper); // very last resort (shouldn't happen)
      }

      btn.addEventListener('click', onClickHandler);
      log('injected into', found.sel);
      return true;
    } catch(e){ errLog('insertButtonIntoHeader err', e); return false; }
  }

  function removeInjectedButton(){
    const node = document.querySelector('#wavoip-ghl-header-btn');
    if (node) node.remove();
  }

  /* ---------- click handler ---------- */
  async function onClickHandler(ev){
    ev.preventDefault();
    const btn = ev.currentTarget;
    try {
      btn.disabled = true;
      const textNode = btn.querySelector('.wavoip-text');
      const origText = textNode ? textNode.textContent : btn.textContent;
      if (textNode) textNode.textContent = 'Carregando...';

      let phone = extractPhone();
      if (!phone){
        const manual = prompt('Número não detectado. Digite o número (ex: 551199999999):');
        phone = normalizePhone(manual);
      }
      if (!phone){ alert('Número inválido.'); if (textNode) textNode.textContent = origText; btn.disabled=false; return; }

      const token = await resolveToken();
      if (!token){ alert('Token Wavoip não encontrado. Cole-o quando solicitado ou configure fallback endpoint.'); if (textNode) textNode.textContent = origText; btn.disabled=false; return; }

      const params = new URLSearchParams({ token, phone, start_if_ready: 'true', close_after_call: 'true' });
      const url = 'https://app.wavoip.com/call?' + params.toString();
      window.open(url, 'wavoip_call', POPUP_OPTS);
      log('opened wavoip', url);
    } catch(e){ errLog('onClickHandler', e); alert('Erro iniciando chamada: ' + (e && e.message || e)); }
    finally {
      const textNode = btn.querySelector('.wavoip-text');
      if (textNode){
        setTimeout(()=>{ textNode.textContent = 'Ligar pelo WhatsApp'; btn.disabled=false; }, 600);
      } else btn.disabled=false;
    }
  }

  /* ---------- page relevance control (only Conversations / Contacts) ---------- */
  function isRelevantPage(){
    try {
      const path = location.pathname || '';
      if (/\/conversations\b|\/conversations\/|\/contacts\b|\/contacts\//i.test(path)) return true;
      // presence of conversation title or contact sidebar
      if (document.querySelector('.conversation-title') || document.querySelector('.lead-sidebar') || document.querySelector('.contact-sidebar')) return true;
      const right = document.querySelector('aside') || document.querySelector('.right-panel') || document.querySelector('.lead-sidebar');
      if (right && /(Contato|Telefone|Phone)/i.test(right.innerText||'')) return true;
    } catch(e){}
    return false;
  }

  /* ---------- observe SPA route/dom changes and maintain button ---------- */
  let lastLocation = location.href;
  function checkAndInject(){
    try {
      if (isRelevantPage()){
        const ok = insertButtonIntoHeader();
        if (!ok) log('header container not found yet; will retry');
      } else {
        removeInjectedButton();
      }
    } catch(e){ errLog('checkAndInject', e); }
  }

  const mo = new MutationObserver((muts)=>{
    if (location.href !== lastLocation){
      lastLocation = location.href;
      setTimeout(checkAndInject, 400);
      return;
    }
    // ensure button exists when relevant elements appear
    if (isRelevantPage()){
      if (!document.querySelector('#wavoip-ghl-header-btn')) checkAndInject();
    } else {
      if (document.querySelector('#wavoip-ghl-header-btn')) removeInjectedButton();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // initial attempt
  setTimeout(checkAndInject, 700);

  // expose debug helpers
  window._wavoipGHL = {
    insertButtonIntoHeader,
    removeInjectedButton,
    extractPhone,
    resolveToken,
    isRelevantPage,
    normalizePhone
  };

  log('wavoip-ghl loader (final) initialized');
})();

