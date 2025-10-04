<script>
// == Wavoip quick-inject for GHL Conversations (simple mode) ==
// - Injeta botão "Ligar via Wavoip" na sidebar da conversa
// - Tenta extrair token (localStorage/sessionStorage/cookies/window)
// - Puxa telefone do painel direito (vários seletores tentados)
// - Abre https://app.wavoip.com/call?token=...&phone=...
// - Ajuste `FALLBACK_TOKEN_ENDPOINT` se quiser que o servidor gere token

(function () {
  const FALLBACK_TOKEN_ENDPOINT = '/api/wavoip/token'; // se você tiver um endpoint backend para prover token
  const POPUP_OPTIONS = 'width=360,height=640,menubar=0,toolbar=0,location=0,status=0';
  const DEFAULT_COUNTRY = '55'; // prefixo BR por padrão se número sem DDI

  /* ---------------------- utilitários ---------------------- */
  function safeGet(obj, path) {
    try { return path.split('.').reduce((s,k)=>s && s[k], obj); } catch(e){ return undefined; }
  }

  function normalizePhone(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    // remove common extraneous chars
    s = s.replace(/\(cid:\d+\)/g,'').replace(/[^\d+]/g,'');
    // if starts with '+' remove '+'
    s = s.replace(/^\+/, '');
    // If result looks like local (8-11 digits) and no DDI, add default country
    const onlyDigits = s.replace(/\D/g,'');
    if (onlyDigits.length <= 11 && !s.startsWith(DEFAULT_COUNTRY)) {
      return DEFAULT_COUNTRY + onlyDigits;
    }
    return onlyDigits;
  }

  async function fetchTokenFromServer() {
    try {
      const res = await fetch(FALLBACK_TOKEN_ENDPOINT, { credentials: 'include' });
      if (!res.ok) return null;
      const j = await res.json();
      return j && (j.token || j.access_token || j.wavoip_token) || null;
    } catch (e) {
      console.warn('Wavoip fallback token fetch erro:', e);
      return null;
    }
  }

  function guessTokenFromStorage() {
    try {
      // try common keys in local/session storage
      const candidates = [...Object.keys(localStorage || {}), ...Object.keys(sessionStorage || {})];
      for (const k of candidates) {
        if (/wavoip|wvoip|wavoip_token|wavoipToken|wavoipToken|wavoipToken/i.test(k) ||
            /token|auth|access_token|accessToken|jwt|bearer/i.test(k)) {
          const v = localStorage[k] || sessionStorage[k];
          if (v && typeof v === 'string' && v.length > 10) return v;
        }
      }
      // cookies
      const cookieMatch = document.cookie.split(';').map(c => c.trim()).find(c => /wavoip|token|session|jwt|bearer/i.test(c));
      if (cookieMatch) return cookieMatch.split('=')[1];
      // global vars
      const globals = ['WAVOIP_TOKEN','wavoipToken','wavoip_token','wvoip_token','__INITIAL_STATE__','appState','window.APP_STATE'];
      for (const g of globals) {
        try {
          const val = safeGet(window, g);
          if (typeof val === 'string' && /eyJ|token|Bearer/i.test(val)) return val;
          if (val && typeof val === 'object') {
            const s = JSON.stringify(val);
            const m = s.match(/eyJ[A-Za-z0-9\-_\.]{10,}|"token"\s*:\s*"[A-Za-z0-9\-_\.]{10,}/);
            if (m) return (m[0].replace(/"token"\s*:\s*"/,'').replace(/"/,''));
          }
        } catch (e) {}
      }
    } catch (e) {
      console.warn('guessTokenFromStorage error', e);
    }
    return null;
  }

  async function resolveToken() {
    // 1 - guess in page storage
    let t = guessTokenFromStorage();
    if (t) { console.log('[wavoip] token from storage'); return t; }
    // 2 - try global variables more exhaustively
    try {
      for (const k in window) {
        try {
          if (!k || k.length > 60) continue;
          const val = window[k];
          if (typeof val === 'string' && /eyJ|Bearer|wavoip/i.test(val) && val.length > 20) {
            console.log('[wavoip] token guessed from window.'+k);
            return val;
          }
          if (val && typeof val === 'object') {
            const s = JSON.stringify(val).slice(0,2000);
            const m = s.match(/"token"\s*:\s*"(.*?)"/);
            if (m) return m[1];
          }
        } catch (e) {}
      }
    } catch (e) {}
    // 3 - fallback to server
    const t2 = await fetchTokenFromServer();
    if (t2) { console.log('[wavoip] token from server endpoint'); return t2; }
    return null;
  }

  /* ---------------------- phone extractors (vários seletores comuns) ---------------------- */
  function phoneFromSelectors() {
    // adapt as needed to your GHL DOM. We'll try multiple likely places.
    const selectors = [
      '[data-phone]',                  // custom data attr
      '.lead-phone',                   // common pattern
      '.contact-phone',                // possible
      '.ghl-contact-phone',
      '.sidebar .phone',               // generic
      '.contact-info .phone',
      'input[name="phone"]',
      'input[type="tel"]',
      '.right-panel .phone',           // guess
      '.contact-details .value',       // worst-case: try a few nodes and filter numbers
      '.contact-info .value'
    ];
    for (const s of selectors) {
      try {
        const el = document.querySelector(s);
        if (el) {
          const v = el.dataset && el.dataset.phone ? el.dataset.phone : (el.value || el.textContent || el.innerText);
          const p = normalizePhone(v);
          if (p) return p;
        }
      } catch(e){}
    }

    // As fallback, probe the right sidebar for any phone-looking text
    try {
      // narrow down to the right-hand panel common in GHL
      const rightPanels = Array.from(document.querySelectorAll('aside, .sidebar, .right-pane, .right-panel, .panel, .card'));
      for (const panel of rightPanels) {
        const txt = (panel.innerText || '').replace(/\s+/g,' ');
        const m = txt.match(/(?:\+?\d{2,3}\s?)?(\d[\d\-\(\)\s]{6,}\d)/);
        if (m) {
          const p = normalizePhone(m[0]);
          if (p) return p;
        }
      }
    } catch(e){}

    return null;
  }

  /* ---------------------- UI injection ---------------------- */
  function createWavoipBtn() {
    const btn = document.createElement('button');
    btn.id = 'wavoip-call-btn';
    btn.textContent = 'Ligar via Wavoip';
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:8px',
      'background:#0b74de',
      'color:#fff',
      'border:none',
      'padding:8px 12px',
      'border-radius:8px',
      'cursor:pointer',
      'font-weight:600',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.08)'
    ].join(';');
    return btn;
  }

  async function onCallClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Carregando...';

    try {
      const phone = phoneFromSelectors() || await new Promise(res => {
        // last resort: prompt user
        const p = prompt('Número para ligar (formato internacional, ex: 551199999999):');
        res(normalizePhone(p));
      });
      if (!phone) { alert('Número não encontrado'); btn.disabled = false; btn.textContent = 'Ligar via Wavoip'; return; }

      const token = await resolveToken();
      if (!token) { alert('Token Wavoip não encontrado. Configure FALLBACK_TOKEN_ENDPOINT ou coloque token no localStorage/window.'); btn.disabled = false; btn.textContent = 'Ligar via Wavoip'; return; }

      // mount url
      const params = new URLSearchParams({
        token: token,
        phone: phone,
        start_if_ready: 'true',
        close_after_call: 'true'
      });
      const url = 'https://app.wavoip.com/call?' + params.toString();
      window.open(url, 'wavoip_call', POPUP_OPTIONS);
      btn.textContent = 'Abrindo...';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Ligar via Wavoip'; }, 1500);
    } catch (err) {
      console.error('Wavoip call error', err);
      alert('Erro ao iniciar ligação: ' + (err && err.message || err));
      const btn = document.querySelector('#wavoip-call-btn');
      if (btn) { btn.disabled = false; btn.textContent = 'Ligar via Wavoip'; }
    }
  }

  function injectIntoSidebar() {
    // Try a few candidate containers where to append the button (GHL UI varies)
    const candidateSelectors = [
      '.lead-sidebar .actions',        // hypothetical
      '.lead-sidebar',                 // common place
      '.contact-actions',              // screenshot likely has a header where buttons live
      '.right-panel .header-actions',
      '.card-header',                  // generic card header
      '.panel-actions',
      '.contact-actions-wrapper'
    ];
    for (const sel of candidateSelectors) {
      const container = document.querySelector(sel);
      if (container) {
        // avoid double-injection
        if (document.querySelector('#wavoip-call-btn')) return;
        const btn = createWavoipBtn();
        btn.addEventListener('click', onCallClick);
        // prefer appendChild or insert before other action buttons
        container.appendChild(btn);
        console.log('[wavoip] botão injetado em', sel);
        return;
      }
    }
    // fallback: append to body bottom-right
    if (!document.querySelector('#wavoip-call-btn')) {
      const btn = createWavoipBtn();
      btn.style.position = 'fixed';
      btn.style.right = '14px';
      btn.style.bottom = '88px';
      btn.style.zIndex = 99999;
      btn.addEventListener('click', onCallClick);
      document.body.appendChild(btn);
      console.log('[wavoip] botão injetado flutuante');
    }
  }

  /* ---------------------- observe DOM (GHL builds components dynamically) ---------------------- */
  let injected = false;
  const mo = new MutationObserver((mutations) => {
    if (injected) return;
    try {
      // look for a known area in the right panel (common to GHL)
      const rightPanel = document.querySelector('aside, .right-panel, .lead-sidebar, .contact-actions, .contact-sidebar');
      if (rightPanel) {
        injectIntoSidebar();
        injected = true;
        mo.disconnect();
      }
    } catch(e){}
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // try immediate injection
  setTimeout(() => {
    injectIntoSidebar();
    if (!injected) console.log('[wavoip] aguardando DOM dinâmico. Se não aparecer, ajuste candidateSelectors em script.');
  }, 800);

  // expose util for debugging
  window._wavoipQuick = {
    resolveToken,
    phoneFromSelectors,
    injectIntoSidebar,
    normalizePhone,
    guessTokenFromStorage
  };
})();
  
</script>
