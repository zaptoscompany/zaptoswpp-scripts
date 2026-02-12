// ======================= ZaptosVoip – Nova UI GHL (V2) =======================
(function () {
  if (window.__ZAPTOS_VOIP_GHL_V2__) return;
  window.__ZAPTOS_VOIP_GHL_V2__ = true;

  const DEBUG = false;
  const POPUP_OPTS =
    'width=360,height=640,menubar=0,toolbar=0,location=0,status=0';
  const DEFAULT_COUNTRY = '55';

  // URL que devolve o token de ligação
  const TOKEN_URL =
    'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-wavoip-token';

  // chaves usadas no sessionStorage
  const SESSION_KEYS = {
    token: 'zaptosvoip_token_user_override',
    apiKey: 'zaptosvoip_instance_api_key',
    loc: 'zaptosvoip_location_id'
  };

  const BUTTON_ID = 'zaptos-voip-button-v2';
  const WAVOIP_BUTTON_ID = 'zaptos-wavoip-button-v2';
  const CHECK_INTERVAL = 1500; // ms
  const CALL_PAGE_URL = 'https://voip.zaptoswpp.com/call/';
  const WAVOIP_SCRIPT_URL =
    'https://cdn.jsdelivr.net/npm/@wavoip/wavoip-webphone/dist/index.umd.min.js';
  const WAVOIP_TOKEN_KEY = 'zaptos_wavoip_user_token';
  const WAVOIP_HEADER_SLOT_ID = 'whatsAppHeaderSlotShared';

  let wavoipScriptPromise = null;
  let wavoipReadyPromise = null;
  let wavoipRendered = false;
  let wavoipActiveToken = null;

  const log = (...a) => {
    if (DEBUG) console.log('[ZaptosVoip][v2]', ...a);
  };
  const errLog = (...a) => console.error('[ZaptosVoip][v2]', ...a);

  window._zaptosVoipGHL_debug =
    window._zaptosVoipGHL_debug || { edgeCalls: [], lastResolve: null };

  // ----------- helpers básicos -----------

  function normalizePhone(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/\(cid:\d+\)/g, '').replace(/[^\d+]/g, '');
    s = s.replace(/^\+/, '');
    const only = s.replace(/\D/g, '');
    if (!only) return null;
    if (only.length <= 11 && !only.startsWith(DEFAULT_COUNTRY))
      return DEFAULT_COUNTRY + only;
    return only;
  }

  function getLocationId() {
    try {
      const p = location.pathname || '';
      const m =
        p.match(/\/location\/([^/]+)/i) || p.match(/\/locations\/([^/]+)/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  // ----------- chamada para pegar token (API KEY → token) -----------

  async function fetchToken(locationId, instanceApiKey) {
    window._zaptosVoipGHL_debug.edgeCalls =
      window._zaptosVoipGHL_debug.edgeCalls || [];

    if (!locationId || !instanceApiKey) {
      return { token: null, status: 'missing-params' };
    }

    try {
      // 1) GET com query params
      const url = new URL(TOKEN_URL);
      url.searchParams.set('location_id', locationId);
      url.searchParams.set('api_key', instanceApiKey);

      const resp = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'omit'
      });

      const text = await resp.text().catch(() => null);
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      const record = {
        url: url.toString(),
        status: resp.status,
        ok: resp.ok,
        text,
        json
      };
      window._zaptosVoipGHL_debug.edgeCalls.push(record);
      log('fetchToken query result', record);

      const token =
        (json &&
          (json.token ||
            json.access_token ||
            (json.data && json.data.token))) ||
        null;

      if (token) {
        return { token, status: 'ok-query', raw: json };
      }

      // 2) fallback: GET com headers (apikey + location)
      try {
        const r2 = await fetch(TOKEN_URL, {
          method: 'GET',
          credentials: 'omit',
          headers: {
            apikey: instanceApiKey,
            'x-wavoip-location-id': locationId
          }
        });
        const t2 = await r2.text().catch(() => null);
        let j2 = null;
        try {
          j2 = t2 ? JSON.parse(t2) : null;
        } catch {
          j2 = null;
        }
        window._zaptosVoipGHL_debug.edgeCalls.push({
          url: TOKEN_URL,
          status: r2.status,
          ok: r2.ok,
          text: t2,
          json: j2,
          via: 'header-apikey'
        });
        const token2 =
          (j2 &&
            (j2.token ||
              j2.access_token ||
              (j2.data && j2.data.token))) ||
          null;
        if (token2) {
          return { token: token2, status: 'ok-header', raw: j2 };
        }
      } catch (e) {
        /* ignora fallback falho */
      }

      return { token: null, status: 'no-token-found', raw: json || text };
    } catch (e) {
      errLog('fetchToken error', e);
      return { token: null, status: 'error', error: String(e) };
    }
  }

  async function resolveTokenFlow() {
    window._zaptosVoipGHL_debug.lastResolve = { at: Date.now() };

    // 1) token já salvo
    const storedToken = sessionStorage.getItem(SESSION_KEYS.token);
    if (storedToken) {
      log('using token from session');
      return { token: storedToken, source: 'session' };
    }

    const locationId = getLocationId();
    const savedApiKey = sessionStorage.getItem(SESSION_KEYS.apiKey);

    // 2) já tem apiKey salva
    if (savedApiKey && locationId) {
      const r = await fetchToken(locationId, savedApiKey);
      if (r && r.token) {
        sessionStorage.setItem(SESSION_KEYS.token, r.token);
        sessionStorage.setItem(SESSION_KEYS.loc, locationId);
        return { token: r.token, source: 'stored-api-key', meta: r };
      } else {
        log('stored API key failed, clearing', r);
        sessionStorage.removeItem(SESSION_KEYS.apiKey);
        sessionStorage.removeItem(SESSION_KEYS.loc);
      }
    }

    // 3) pedir API KEY
    const apiKey = prompt('Insira a API KEY da instância');
    if (!apiKey) return { token: null, source: 'user-skip' };

    const locId = locationId || getLocationId() || '';
    const r = await fetchToken(locId.trim(), apiKey.trim());
    window._zaptosVoipGHL_debug.lastResolve.result = r;

    if (r && r.token) {
      sessionStorage.setItem(SESSION_KEYS.apiKey, apiKey.trim());
      sessionStorage.setItem(SESSION_KEYS.loc, locId.trim());
      sessionStorage.setItem(SESSION_KEYS.token, r.token);
      return { token: r.token, source: 'api-key', meta: r };
    } else {
      alert('Não foi possível obter o token. Verifique a API KEY da instância.');
      return { token: null, source: 'api-key-failed', meta: r };
    }
  }

  function clearSaved() {
    sessionStorage.removeItem(SESSION_KEYS.apiKey);
    sessionStorage.removeItem(SESSION_KEYS.loc);
    sessionStorage.removeItem(SESSION_KEYS.token);
    log('credenciais salvas limpas');
  }

  // ----------- CAPTURA DE NOME/FOTO/TELEFONE (base V2 + ajuste do input) -----------

  function findContactDetailsPanel() {
    const allDivs = Array.from(document.querySelectorAll('div'));
    for (const el of allDivs) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      if (
        /Detalhes do contato/i.test(text) &&
        /Contato/i.test(text) &&
        /Telefone/i.test(text)
      ) {
        return el;
      }
    }
    return null;
  }

  function getFieldValue(panel, labelText) {
    if (!panel) return null;
    const elems = Array.from(panel.querySelectorAll('*'));
    const labelEl = elems.find(
      (el) => (el.textContent || '').trim() === labelText
    );
    if (!labelEl) return null;

    let container = labelEl.parentElement;
    if (!container) return null;

    const candidates = Array.from(
      container.querySelectorAll('input, textarea, span, div, a')
    ).filter((el) => el !== labelEl);

    for (const c of candidates) {
      let txt = '';
      if ('value' in c && c.value) txt = String(c.value);
      else txt = (c.textContent || '').trim();

      if (!txt) continue;
      if (txt === labelText) continue;
      return txt;
    }

    return null;
  }

  function extractContactInfoNewUI() {
    const panel = findContactDetailsPanel();
    if (!panel) {
      log('no contact panel found');
      return { phone: null, name: null, photo: null };
    }

    let phone = null;
    let name = null;
    let photo = null;

    // 1) link tel:
    const telLink = panel.querySelector('a[href^="tel:"]');
    if (telLink) {
      const raw = telLink.getAttribute('href').replace(/^tel:/i, '');
      phone = normalizePhone(raw);
    }

    // 2) input[type="tel"] (caso da nova UI)
    if (!phone) {
      const telInput =
        panel.querySelector('input[type="tel"].hr-input__input-el') ||
        panel.querySelector('input[type="tel"]');
      if (telInput && telInput.value) {
        phone = normalizePhone(telInput.value);
      }
    }

    // 3) fallback pelo label "Telefone"
    if (!phone) {
      const telText = getFieldValue(panel, 'Telefone');
      phone = normalizePhone(telText);
    }

    // nome (Nome + Sobrenome)
    const firstName = getFieldValue(panel, 'Nome');
    const lastName = getFieldValue(panel, 'Sobrenome');
    if (firstName || lastName) {
      name = [firstName, lastName].filter(Boolean).join(' ').trim();
    }

    if (!name) {
      const heading = Array.from(
        panel.querySelectorAll('h2, h3, [role="heading"]')
      )
        .map((el) => (el.textContent || '').trim())
        .find((t) => t && !/Detalhes do contato/i.test(t));
      if (heading) name = heading;
    }

    // foto
    const avatarImg =
      Array.from(panel.querySelectorAll('img')).find((img) => {
        const src = img.src || '';
        return /locationFiles|contact|pps\.whatsapp\.net|whatsapp/i.test(src);
      }) || panel.querySelector('img');

    if (avatarImg && avatarImg.src) {
      photo = avatarImg.src;
    }

    log('extractContactInfoNewUI result', { phone, name, photo });
    return { phone, name, photo };
  }

  // ----------- barra onde ficam os ícones (phone-calls, etc) -----------

  function findTopIconBarContainer() {
    const phoneTag = document.querySelector('#phone-calls');
    if (!phoneTag || !phoneTag.parentElement) return null;
    return phoneTag.parentElement;
  }

  function getWavoipTokenStorageKey() {
    return WAVOIP_TOKEN_KEY;
  }

  function getSavedWavoipToken() {
    try {
      const raw = localStorage.getItem(getWavoipTokenStorageKey());
      return raw ? raw.trim() : '';
    } catch {
      return '';
    }
  }

  function saveWavoipToken(token) {
    const clean = (token || '').trim();
    if (!clean) return;
    try {
      localStorage.setItem(getWavoipTokenStorageKey(), clean);
    } catch {
      /* ignore storage failures */
    }
  }

  function clearWavoipToken() {
    try {
      localStorage.removeItem(getWavoipTokenStorageKey());
    } catch {
      /* ignore storage failures */
    }
    wavoipActiveToken = null;
    wavoipReadyPromise = null;
  }

  function requestWavoipToken() {
    const saved = getSavedWavoipToken();
    const typed = prompt('Insira o token do Webphone Wavoip:', saved || '');
    if (!typed) return null;
    const token = typed.trim();
    if (!token) return null;
    saveWavoipToken(token);
    return token;
  }

  function ensureWavoipToken(forcePrompt) {
    if (forcePrompt) return requestWavoipToken();
    const saved = getSavedWavoipToken();
    if (saved) return saved;
    return requestWavoipToken();
  }

  function loadWavoipScript() {
    if (window.wavoipWebphone) return Promise.resolve();
    if (wavoipScriptPromise) return wavoipScriptPromise;

    wavoipScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(
        'script[data-zaptos-wavoip-script="1"]'
      );
      if (existing) {
        if (window.wavoipWebphone) {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener(
          'error',
          () => reject(new Error('Falha ao carregar o script da Wavoip.')),
          { once: true }
        );
        return;
      }

      const script = document.createElement('script');
      script.src = WAVOIP_SCRIPT_URL;
      script.async = true;
      script.dataset.zaptosWavoipScript = '1';
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error('Falha ao carregar o script da Wavoip.'));
      document.head.appendChild(script);
    }).catch((e) => {
      wavoipScriptPromise = null;
      throw e;
    });

    return wavoipScriptPromise;
  }

  function enforceWavoipWidgetButtonHidden() {
    try {
      if (
        window.wavoip &&
        window.wavoip.settings &&
        typeof window.wavoip.settings.setShowWidgetButton === 'function'
      ) {
        window.wavoip.settings.setShowWidgetButton(false);
      }
    } catch (e) {
      log('setShowWidgetButton(false) failed', e);
    }
  }

  async function initWavoipWebphone(forcePromptToken) {
    if (forcePromptToken) {
      clearWavoipToken();
    }

    if (wavoipReadyPromise) return wavoipReadyPromise;

    wavoipReadyPromise = (async () => {
      await loadWavoipScript();

      if (
        !window.wavoipWebphone ||
        typeof window.wavoipWebphone.render !== 'function'
      ) {
        throw new Error('Biblioteca Wavoip indisponivel.');
      }

      if (!wavoipRendered) {
        await window.wavoipWebphone.render({
          widget: {
            showWidgetButton: false,
            startOpen: false
          }
        });
        wavoipRendered = true;
      }

      if (!window.wavoip || !window.wavoip.device) {
        throw new Error('Webphone Wavoip nao inicializou.');
      }

      const token = ensureWavoipToken(forcePromptToken);
      if (!token) {
        throw new Error('Token do Wavoip nao informado.');
      }

      if (wavoipActiveToken !== token) {
        window.wavoip.device.add(token);
        wavoipActiveToken = token;
      }

      enforceWavoipWidgetButtonHidden();

      return true;
    })().catch((e) => {
      wavoipReadyPromise = null;
      throw e;
    });

    return wavoipReadyPromise;
  }

  // ----------- BOTÃO GRADIENTE ZAPTOS -----------

  function createGradientButton() {
    if (document.getElementById(BUTTON_ID)) return null;

    const container = findTopIconBarContainer();
    if (!container) return null;

    const reference = document.querySelector('#phone-calls');

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = 'Ligar pelo WhatsApp (Zaptos Voip)';

    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.gap = '6px';
    btn.style.padding = '2px 10px';
    btn.style.height = '26px';
    btn.style.border = 'none';
    btn.style.outline = 'none';
    btn.style.borderRadius = '15px';
    btn.style.background =
      'linear-gradient(90deg, #0EB636 0%, #0069FF 100%)';
    btn.style.color = '#011023';
    btn.style.fontSize = '11px';
    btn.style.fontWeight = '600';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.18)';
    btn.style.whiteSpace = 'nowrap';

    const icon = document.createElement('span');
    icon.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg"
           viewBox="0 0 24 24"
           width="14" height="14"
           fill="none"
           stroke="currentColor"
           stroke-width="2"
           stroke-linecap="round"
           stroke-linejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2
                 19.79 19.79 0 0 1-8.63-3.07
                 19.5 19.5 0 0 1-6-6
                 19.79 19.79 0 0 1-3.07-8.67
                 A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72
                 12.84 12.84 0 0 0 .7 2.81
                 2 2 0 0 1-.45 2.11L8 9.91a16 16 0 0 0 6 6l1.27-1.27
                 a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7
                 A2 2 0 0 1 22 16.92z"/>
      </svg>
    `;

    const label = document.createElement('span');
    label.textContent = 'Ligar pelo WhatsApp';

    btn.appendChild(icon);
    btn.appendChild(label);

    btn.addEventListener('click', onClickCallButton);

    if (reference && reference.parentElement === container) {
      container.insertBefore(btn, reference);
    } else {
      container.appendChild(btn);
    }

    log('ZaptosVoip gradient button inserted');
    return btn;
  }

  // ----------- clique do botão -----------

  function findWavoipButtonTarget() {
    const slot = document.getElementById(WAVOIP_HEADER_SLOT_ID);
    if (slot) {
      return { container: slot, reference: null, isSlot: true };
    }

    const controls = document.querySelector('header.hl_header .hl_header--controls');
    if (controls) {
      const reference =
        controls.querySelector('#i18n-feedback') ||
        controls.querySelector('.btn.btn-circle') ||
        controls.firstElementChild;
      return { container: controls, reference, isSlot: false };
    }

    const fallback = findTopIconBarContainer();
    const fallbackReference =
      document.getElementById(BUTTON_ID) || document.querySelector('#phone-calls');
    return { container: fallback, reference: fallbackReference, isSlot: false };
  }

  function mountWavoipButton(btn) {
    const target = findWavoipButtonTarget();
    if (!target || !target.container) return false;

    const { container, reference, isSlot } = target;
    if (isSlot) {
      container.style.display = 'flex';
      container.style.alignItems = 'center';
      container.style.marginRight = '10px';
    }

    if (btn.parentElement === container) return true;

    if (reference && reference.parentElement === container) {
      container.insertBefore(btn, reference);
    } else {
      container.appendChild(btn);
    }

    return true;
  }

  function createWavoipButton() {
    if (document.getElementById(WAVOIP_BUTTON_ID)) return null;

    const btn = document.createElement('button');
    btn.id = WAVOIP_BUTTON_ID;
    btn.type = 'button';
    btn.title = 'Abrir Webphone WhatsAPP';

    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.gap = '6px';
    btn.style.padding = '2px 10px';
    btn.style.height = '26px';
    btn.style.border = 'none';
    btn.style.outline = 'none';
    btn.style.borderRadius = '15px';
    btn.style.background = '#1C9A43';
    btn.style.color = '#FFFFFF';
    btn.style.fontSize = '11px';
    btn.style.fontWeight = '700';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.18)';
    btn.style.whiteSpace = 'nowrap';

    const icon = document.createElement('span');
    icon.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg"
           viewBox="0 0 24 24"
           width="13" height="13"
           fill="none"
           stroke="currentColor"
           stroke-width="2"
           stroke-linecap="round"
           stroke-linejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2
                 19.79 19.79 0 0 1-8.63-3.07
                 19.5 19.5 0 0 1-6-6
                 19.79 19.79 0 0 1-3.07-8.67
                 A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72
                 12.84 12.84 0 0 0 .7 2.81
                 2 2 0 0 1-.45 2.11L8 9.91a16 16 0 0 0 6 6l1.27-1.27
                 a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7
                 A2 2 0 0 1 22 16.92z"/>
      </svg>
    `;

    const label = document.createElement('span');
    label.textContent = 'WhatsAPP';

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener('click', onClickWavoipButton);
    btn.addEventListener('contextmenu', onContextMenuWavoipButton);

    if (!mountWavoipButton(btn)) {
      return null;
    }

    log('Wavoip button inserted');
    return btn;
  }

  async function onClickWavoipButton(ev) {
    ev && ev.preventDefault && ev.preventDefault();
    const btn =
      (ev && ev.currentTarget) || document.getElementById(WAVOIP_BUTTON_ID);
    if (!btn) return;

    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const origOpacity = btn.style.opacity;
    const origPointer = btn.style.pointerEvents;
    btn.style.opacity = '0.65';
    btn.style.pointerEvents = 'none';

    try {
      await initWavoipWebphone(false);

      if (
        !window.wavoip ||
        !window.wavoip.widget ||
        typeof window.wavoip.widget.toggle !== 'function'
      ) {
        throw new Error('Widget Wavoip indisponivel.');
      }

      enforceWavoipWidgetButtonHidden();

      window.wavoip.widget.toggle();
      enforceWavoipWidgetButtonHidden();
    } catch (e) {
      errLog('onClickWavoipButton error', e);
      alert('Erro ao abrir Webphone Wavoip: ' + (e && e.message ? e.message : e));
    } finally {
      btn.dataset.busy = '0';
      btn.style.opacity = origOpacity;
      btn.style.pointerEvents = origPointer;
    }
  }

  async function onContextMenuWavoipButton(ev) {
    ev && ev.preventDefault && ev.preventDefault();
    try {
      await initWavoipWebphone(true);
      alert('Token do Wavoip atualizado.');
    } catch (e) {
      if (e && /nao informado/i.test(String(e.message || e))) return;
      errLog('onContextMenuWavoipButton error', e);
      alert('Nao foi possivel atualizar o token do Wavoip.');
    }
  }

  async function onClickCallButton(ev) {
    ev && ev.preventDefault && ev.preventDefault();
    const btn =
      (ev && ev.currentTarget) || document.getElementById(BUTTON_ID);
    if (!btn) return;

    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const origOpacity = btn.style.opacity;
    const origPointer = btn.style.pointerEvents;
    btn.style.opacity = '0.6';
    btn.style.pointerEvents = 'none';

    try {
      const { phone, name, photo } = extractContactInfoNewUI();
      let finalPhone = phone;

      if (!finalPhone) {
        const manual = prompt(
          'Número não detectado. Digite o número (ex: 551199999999):'
        );
        finalPhone = normalizePhone(manual);
      }
      if (!finalPhone) {
        alert('Número inválido.');
        return;
      }

      const tokenInfo = await resolveTokenFlow();
      if (!tokenInfo || !tokenInfo.token) {
        return;
      }

      const params = new URLSearchParams({
        token: tokenInfo.token,
        phone: finalPhone,
        start_if_ready: 'true',
        close_after_call: 'true'
      });

      if (name) params.set('name', name);
      if (photo) params.set('photo', photo);

      const url = CALL_PAGE_URL + '?' + params.toString();
      log('opening call URL:', url);
      window.open(url, 'zaptos_voip_call', POPUP_OPTS);
    } catch (e) {
      errLog('onClickCallButton error', e);
      alert('Erro ao iniciar chamada: ' + (e && e.message ? e.message : e));
    } finally {
      btn.dataset.busy = '0';
      btn.style.opacity = origOpacity;
      btn.style.pointerEvents = origPointer;
    }
  }

  // ----------- garantir que o botão exista sempre -----------

  function ensureButton() {
    try {
      if (!document.getElementById(BUTTON_ID)) {
        createGradientButton();
      }
      const wavoipBtn = document.getElementById(WAVOIP_BUTTON_ID);
      if (!wavoipBtn) {
        createWavoipButton();
      } else {
        mountWavoipButton(wavoipBtn);
      }
      enforceWavoipWidgetButtonHidden();
    } catch (e) {
      errLog('ensureButton error', e);
    }
  }

  setInterval(ensureButton, CHECK_INTERVAL);
  ensureButton();

  // helpers expostos para debug
  window._zaptosVoipGHL_V2 = {
    resolveTokenFlow,
    fetchToken,
    clearSaved,
    clearWavoipToken,
    requestWavoipToken,
    initWavoipWebphone,
    debug: window._zaptosVoipGHL_debug
  };

  log('ZaptosVoip – Nova UI V2 inicializado');
})();
// ======================= Fim do ZaptosVoip – Nova UI GHL (V2) =======================
