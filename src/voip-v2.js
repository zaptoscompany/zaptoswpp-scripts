// ======================= ZaptosVoip – Nova UI GHL (V2) =======================
(function () {
  if (window.__ZAPTOS_VOIP_GHL_V2__) return;
  window.__ZAPTOS_VOIP_GHL_V2__ = true;

  const DEBUG = false;
  const POPUP_OPTS =
    'width=360,height=640,menubar=0,toolbar=0,location=0,status=0';
  const DEFAULT_COUNTRY = '55';

  // chaves usadas no sessionStorage
  const SESSION_KEYS = {
    token: 'zaptosvoip_token_user_override',
    loc: 'zaptosvoip_location_id',
    instanceId: 'zaptosvoip_instance_id'
  };

  const BUTTON_ID = 'zaptos-voip-button-v2';
  const WAVOIP_BUTTON_ID = 'zaptos-wavoip-button-v2';
  const CHECK_INTERVAL = 1500; // ms
  const CALL_PAGE_URL = 'https://voip.zaptoswpp.com/call/';
  const WAVOIP_SCRIPT_URL =
    'https://cdn.jsdelivr.net/npm/@wavoip/wavoip-webphone/dist/index.umd.min.js';
  const INSTANCE_PICKER_URL =
    'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-voip-instances';
  const SELECTED_INSTANCE_MAP_KEY = 'zaptos_voip_selected_instance_by_location';
  const WAVOIP_HEADER_SLOT_ID = 'whatsAppHeaderSlotShared';

  let wavoipScriptPromise = null;
  let wavoipReadyPromise = null;
  let wavoipRendered = false;
  let wavoipActiveToken = null;
  let wavoipActiveTokens = [];
  let wavoipConnectedLocationId = null;
  let wavoipConnectedInstanceIds = [];

  const log = (...a) => {
    if (DEBUG) console.log('[ZaptosVoip][v2]', ...a);
  };
  const errLog = (...a) => console.error('[ZaptosVoip][v2]', ...a);

  window._zaptosVoipGHL_debug =
    window._zaptosVoipGHL_debug || {
      edgeCalls: [],
      instanceCalls: [],
      lastResolve: null,
      lastScope: null
    };

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
      const m = p.match(/\/location\/([^/]+)/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function isLocationScope() {
    return !!getLocationId();
  }

  function parseJsonSafe(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function getInstanceIdentity(instance) {
    if (!instance) return '';
    const id =
      instance.instance_id ||
      instance.instanceId ||
      instance.id ||
      instance.instance_name ||
      instance.name ||
      '';
    return String(id || '').trim();
  }

  function loadSelectedInstanceMap() {
    try {
      const raw = localStorage.getItem(SELECTED_INSTANCE_MAP_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  }

  function saveSelectedInstanceMap(map) {
    try {
      localStorage.setItem(SELECTED_INSTANCE_MAP_KEY, JSON.stringify(map || {}));
    } catch {
      /* ignore storage failures */
    }
  }

  function getSavedSelectedInstanceIds(locationId) {
    if (!locationId) return [];
    const map = loadSelectedInstanceMap();
    const raw = map[locationId];
    if (!raw || typeof raw !== 'object') return [];

    // backward compatibility: formato antigo { id, name }
    if (raw.id) {
      const oldId = String(raw.id).trim();
      return oldId ? [oldId] : [];
    }

    if (!Array.isArray(raw.ids)) return [];
    return raw.ids
      .map((id) => String(id || '').trim())
      .filter(Boolean);
  }

  function saveSelectedInstances(locationId, instances) {
    if (!locationId || !Array.isArray(instances) || !instances.length) return;

    const ids = instances
      .map((instance) => getInstanceIdentity(instance))
      .map((id) => String(id || '').trim())
      .filter(Boolean);

    if (!ids.length) return;

    const names = instances
      .map((instance) =>
        String(
          instance.instance_name || instance.instanceName || instance.name || ''
        ).trim()
      )
      .filter(Boolean);

    const map = loadSelectedInstanceMap();
    map[locationId] = { ids, names };
    saveSelectedInstanceMap(map);
  }

  function clearSavedSelectedInstances(locationId) {
    if (!locationId) return;
    const map = loadSelectedInstanceMap();
    if (!map[locationId]) return;
    delete map[locationId];
    saveSelectedInstanceMap(map);
  }

  function extractInstanceRows(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.instances)) return payload.instances;
    if (Array.isArray(payload.data)) return payload.data;
    if (payload.data && Array.isArray(payload.data.instances)) {
      return payload.data.instances;
    }
    return [];
  }

  function normalizeInstanceRows(rows) {
    if (!Array.isArray(rows)) return [];
    const normalized = [];
    for (const row of rows) {
      const name = String(
        row &&
          (row.instance_name ||
            row.instanceName ||
            row.name ||
            row.instance ||
            row.label ||
            '')
      ).trim();
      if (!name) continue;

      const id = getInstanceIdentity(row) || name;
      const token = String(
        (row &&
          (row.wavoip_token ||
            row.token ||
            row.access_token ||
            row.webphone_token)) ||
          ''
      ).trim();

      normalized.push({
        id,
        instance_id: id,
        instance_name: name,
        token
      });
    }
    return normalized;
  }

  async function fetchVoipInstances(locationId) {
    window._zaptosVoipGHL_debug.instanceCalls =
      window._zaptosVoipGHL_debug.instanceCalls || [];

    if (!locationId) return [];

    const runFetch = async (requestUrl, init, via) => {
      const response = await fetch(requestUrl, init);
      const text = await response.text().catch(() => null);
      const json = parseJsonSafe(text);

      const record = {
        url: requestUrl,
        status: response.status,
        ok: response.ok,
        text,
        json,
        via
      };
      window._zaptosVoipGHL_debug.instanceCalls.push(record);
      return { response, text, json };
    };

    try {
      const url = new URL(INSTANCE_PICKER_URL);
      url.searchParams.set('location_id', locationId);

      const first = await runFetch(
        url.toString(),
        { method: 'GET', credentials: 'omit' },
        'query'
      );

      let instances = normalizeInstanceRows(extractInstanceRows(first.json));

      if (!instances.length) {
        const fallback = await runFetch(
          INSTANCE_PICKER_URL,
          {
            method: 'GET',
            credentials: 'omit',
            headers: { 'x-wavoip-location-id': locationId }
          },
          'header-location'
        );
        instances = normalizeInstanceRows(extractInstanceRows(fallback.json));
      }

      return instances;
    } catch (e) {
      errLog('fetchVoipInstances error', e);
      return [];
    }
  }

  function parseInstanceSelection(typed, max) {
    const normalized = String(typed || '').trim();
    if (!normalized) return [];

    const selected = new Set();
    const parts = normalized.split(/[\s,;]+/).filter(Boolean);

    for (const part of parts) {
      if (/^\d+-\d+$/.test(part)) {
        const [startRaw, endRaw] = part.split('-');
        const start = Number(startRaw);
        const end = Number(endRaw);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const min = Math.min(start, end);
        const maxRange = Math.max(start, end);
        for (let i = min; i <= maxRange; i++) {
          if (i >= 1 && i <= max) selected.add(i);
        }
        continue;
      }

      const n = Number(part);
      if (!Number.isFinite(n)) continue;
      if (n >= 1 && n <= max) selected.add(n);
    }

    return Array.from(selected).sort((a, b) => a - b);
  }

  function arraysEqualAsSet(a, b) {
    const aa = Array.from(new Set((a || []).map((v) => String(v || '').trim()).filter(Boolean))).sort();
    const bb = Array.from(new Set((b || []).map((v) => String(v || '').trim()).filter(Boolean))).sort();
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== bb[i]) return false;
    }
    return true;
  }

  async function chooseVoipInstancesForLocation(locationId) {
    const instances = await fetchVoipInstances(locationId);

    if (!instances.length) {
      alert(
        'Nenhuma instancia VOIP foi encontrada para esta subconta. Verifique o cadastro da location.'
      );
      return null;
    }

    const savedIds = getSavedSelectedInstanceIds(locationId);
    const defaultIndexes = savedIds
      .map((savedId) =>
        instances.findIndex((item) => getInstanceIdentity(item) === savedId) + 1
      )
      .filter((index) => index > 0);

    const defaultSelection = defaultIndexes.join(',');

    const optionsText = instances
      .map((item, index) => {
        const status = item.token ? '' : ' (sem token)';
        return `${index + 1}) ${item.instance_name}${status}`;
      })
      .join('\n');

    while (true) {
      const typed = prompt(
        `Escolha as instancias VOIP desta subconta (separadas por virgula):\n\n${optionsText}\n\nExemplo: 1,2,4`,
        defaultSelection
      );

      if (typed == null) return null;

      const selectedIndexes = parseInstanceSelection(typed, instances.length);
      if (!selectedIndexes.length) {
        alert('Selecao invalida. Escolha ao menos uma instancia.');
        continue;
      }

      const selectedInstances = selectedIndexes.map((idx) => instances[idx - 1]);
      const withoutToken = selectedInstances.filter((item) => !item.token);
      if (withoutToken.length) {
        const names = withoutToken.map((item) => item.instance_name).join(', ');
        alert(
          `As seguintes instancias nao possuem token e nao podem ser ativadas: ${names}`
        );
        continue;
      }

      saveSelectedInstances(locationId, selectedInstances);
      return selectedInstances;
    }
  }

  async function resolveTokenFlow() {
    window._zaptosVoipGHL_debug.lastResolve = { at: Date.now() };

    const locationId = getLocationId();
    if (!locationId) {
      return { tokens: [], source: 'outside-location' };
    }

    const selectedInstances = await chooseVoipInstancesForLocation(locationId);
    if (!selectedInstances || !selectedInstances.length) {
      return { tokens: [], source: 'user-skip' };
    }

    const tokens = Array.from(
      new Set(
        selectedInstances
          .map((item) => String(item.token || '').trim())
          .filter(Boolean)
      )
    );

    if (!tokens.length) {
      alert('Nao foi encontrado token valido nas instancias selecionadas.');
      return { tokens: [], source: 'instance-without-token' };
    }

    const instanceIds = selectedInstances
      .map((item) => getInstanceIdentity(item))
      .filter(Boolean);

    const instanceNames = selectedInstances
      .map((item) => String(item.instance_name || '').trim())
      .filter(Boolean);

    return {
      tokens,
      token: tokens[0],
      source: 'instances-selected',
      instanceIds,
      instanceNames
    };
  }

  function clearSaved() {
    sessionStorage.removeItem(SESSION_KEYS.loc);
    sessionStorage.removeItem(SESSION_KEYS.token);
    sessionStorage.removeItem(SESSION_KEYS.instanceId);
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

  function disconnectWavoipSession(reason) {
    try {
      if (
        window.wavoip &&
        window.wavoip.widget &&
        typeof window.wavoip.widget.close === 'function'
      ) {
        window.wavoip.widget.close();
      }
    } catch (e) {
      log('widget close failed', e);
    }

    try {
      if (window.wavoip && window.wavoip.device) {
        if (
          wavoipActiveTokens.length &&
          typeof window.wavoip.device.remove === 'function'
        ) {
          for (const token of wavoipActiveTokens) {
            try {
              window.wavoip.device.remove(token);
            } catch (removeErr) {
              log('device.remove token failed', token, removeErr);
            }
          }
        } else if (typeof window.wavoip.device.removeAll === 'function') {
          window.wavoip.device.removeAll();
        }
      }
    } catch (e) {
      log('device disconnect failed', e);
    }

    wavoipActiveToken = null;
    wavoipActiveTokens = [];
    wavoipConnectedLocationId = null;
    wavoipConnectedInstanceIds = [];
    wavoipReadyPromise = null;
    clearSaved();
    log('VOIP desconectado', reason || 'manual');
  }

  function clearWavoipToken(clearSelectionForCurrentLocation) {
    if (clearSelectionForCurrentLocation) {
      const locationId = getLocationId();
      if (locationId) {
        clearSavedSelectedInstances(locationId);
      }
    }
    disconnectWavoipSession('clear');
  }

  async function requestWavoipToken() {
    const resolved = await resolveTokenFlow();
    return resolved && resolved.token ? resolved.token : null;
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
          () => reject(new Error('Falha ao carregar o script do VOIP.')),
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
        reject(new Error('Falha ao carregar o script do VOIP.'));
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
    const currentLocationId = getLocationId();
    if (!currentLocationId) {
      throw new Error(
        'VOIP disponivel apenas dentro de subcontas (URL com /location/...).'
      );
    }

    if (
      wavoipConnectedLocationId &&
      wavoipConnectedLocationId !== currentLocationId
    ) {
      disconnectWavoipSession('location-changed');
    }

    if (!wavoipReadyPromise) {
      wavoipReadyPromise = (async () => {
        await loadWavoipScript();

        if (
          !window.wavoipWebphone ||
          typeof window.wavoipWebphone.render !== 'function'
        ) {
          throw new Error('Biblioteca VOIP indisponivel.');
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
          throw new Error('Webphone VOIP nao inicializou.');
        }

        enforceWavoipWidgetButtonHidden();
        return true;
      })().catch((e) => {
        wavoipReadyPromise = null;
        throw e;
      });
    }

    await wavoipReadyPromise;

    // Sempre abre seletor de instancias a cada clique
    const resolved = await resolveTokenFlow();
    if (!resolved || !resolved.tokens || !resolved.tokens.length) {
      throw new Error('Selecao de instancia cancelada ou sem token disponivel.');
    }

    const nextTokens = Array.from(
      new Set(
        (resolved.tokens || [])
          .map((token) => String(token || '').trim())
          .filter(Boolean)
      )
    );
    const nextInstanceIds = (resolved.instanceIds || [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);

    const shouldReconnect =
      wavoipConnectedLocationId !== currentLocationId ||
      !arraysEqualAsSet(wavoipActiveTokens, nextTokens);

    if (shouldReconnect) {
      const canRemoveOne =
        window.wavoip &&
        window.wavoip.device &&
        typeof window.wavoip.device.remove === 'function';
      const canRemoveAll =
        window.wavoip &&
        window.wavoip.device &&
        typeof window.wavoip.device.removeAll === 'function';

      const currentTokens = Array.from(new Set(wavoipActiveTokens));
      const toRemove = currentTokens.filter((token) => !nextTokens.includes(token));
      const toAdd = nextTokens.filter((token) => !currentTokens.includes(token));

      if (canRemoveOne) {
        for (const token of toRemove) {
          try {
            window.wavoip.device.remove(token);
          } catch (e) {
            log('device.remove previous token failed', token, e);
          }
        }
      } else if (canRemoveAll && toRemove.length) {
        try {
          window.wavoip.device.removeAll();
        } catch (e) {
          log('device.removeAll failed', e);
        }
        for (const token of nextTokens) {
          window.wavoip.device.add(token);
        }
      } else {
        for (const token of toAdd) {
          window.wavoip.device.add(token);
        }
      }

      if (canRemoveOne || (canRemoveAll && !toRemove.length)) {
        for (const token of toAdd) {
          window.wavoip.device.add(token);
        }
      }

      wavoipActiveTokens = nextTokens;
      wavoipActiveToken = nextTokens[0] || null;
      wavoipConnectedLocationId = currentLocationId;
      wavoipConnectedInstanceIds = nextInstanceIds;
    }

    enforceWavoipWidgetButtonHidden();
    return true;
  }

  async function startVoipLeadCall(phone) {
    await initWavoipWebphone(false);

    if (!window.wavoip || !window.wavoip.call) {
      throw new Error('Modulo de chamadas VOIP indisponivel.');
    }

    enforceWavoipWidgetButtonHidden();

    if (typeof window.wavoip.call.setInput === 'function') {
      window.wavoip.call.setInput(phone);
    }

    const startFn =
      (window.wavoip.call &&
        (window.wavoip.call.startCall || window.wavoip.call.start)) ||
      null;

    if (typeof startFn !== 'function') {
      return { ok: true, started: false, reason: 'start-fn-missing' };
    }

    const opts =
      wavoipActiveTokens && wavoipActiveTokens.length
        ? { fromTokens: wavoipActiveTokens }
        : null;
    const startPromise = opts ? startFn(phone, opts) : startFn(phone);

    if (
      window.wavoip.widget &&
      typeof window.wavoip.widget.open === 'function'
    ) {
      window.wavoip.widget.open();
    }

    const result = await startPromise;

    if (result && result.err) {
      const reason =
        (result.err.devices &&
          result.err.devices[0] &&
          result.err.devices[0].reason) ||
        result.err.message ||
        String(result.err);
      throw new Error(reason || 'Falha ao iniciar chamada no VOIP.');
    }

    return { ok: true, started: true };
  }

  async function openVoipForManualDial(message) {
    await initWavoipWebphone(false);

    if (window.wavoip && window.wavoip.widget) {
      if (typeof window.wavoip.widget.open === 'function') {
        window.wavoip.widget.open();
      } else if (typeof window.wavoip.widget.toggle === 'function') {
        window.wavoip.widget.toggle();
      }
    }

    enforceWavoipWidgetButtonHidden();

    if (message) {
      alert(message);
    }
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
      container.style.justifyContent = 'flex-end';
      container.style.marginRight = '4px';
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
    btn.title = 'Abrir Webphone WhatsApp';

    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.gap = '6px';
    btn.style.padding = '0 12px';
    btn.style.height = '34px';
    btn.style.minHeight = '34px';
    btn.style.border = 'none';
    btn.style.outline = 'none';
    btn.style.borderRadius = '999px';
    btn.style.background = '#1C9A43';
    btn.style.color = '#FFFFFF';
    btn.style.fontSize = '12px';
    btn.style.lineHeight = '1';
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
    label.textContent = 'WhatsApp';

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener('click', onClickWavoipButton);
    btn.addEventListener('contextmenu', onContextMenuWavoipButton);

    if (!mountWavoipButton(btn)) {
      return null;
    }

    log('VOIP button inserted');
    return btn;
  }

  async function onClickWavoipButton(ev) {
    ev && ev.preventDefault && ev.preventDefault();
    if (!isLocationScope()) return;
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
        throw new Error('Widget VOIP indisponivel.');
      }

      enforceWavoipWidgetButtonHidden();

      window.wavoip.widget.toggle();
      enforceWavoipWidgetButtonHidden();
    } catch (e) {
      errLog('onClickWavoipButton error', e);
      const msg = String((e && e.message) || e || '');
      if (/cancelada/i.test(msg)) return;
      alert('Erro ao abrir Webphone VOIP: ' + msg);
    } finally {
      btn.dataset.busy = '0';
      btn.style.opacity = origOpacity;
      btn.style.pointerEvents = origPointer;
    }
  }

  async function onContextMenuWavoipButton(ev) {
    ev && ev.preventDefault && ev.preventDefault();
    if (!isLocationScope()) return;
    try {
      await initWavoipWebphone(true);
      alert('Instancia VOIP atualizada para esta subconta.');
    } catch (e) {
      if (e && /cancelada/i.test(String(e.message || e))) return;
      errLog('onContextMenuWavoipButton error', e);
      alert('Nao foi possivel atualizar a instancia do VOIP.');
    }
  }
  async function onClickCallButton(ev) {
    ev && ev.preventDefault && ev.preventDefault();
    if (!isLocationScope()) return;
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
      const { phone } = extractContactInfoNewUI();
      const finalPhone = normalizePhone(phone);

      if (!finalPhone) {
        await openVoipForManualDial(
          'Nao foi possivel identificar o numero do contato. O VOIP foi aberto para discagem manual.'
        );
        return;
      }

      const callResult = await startVoipLeadCall(finalPhone);
      if (callResult && callResult.started === false) {
        await openVoipForManualDial(
          'Nao foi possivel iniciar a ligacao automaticamente. Use o VOIP para discagem manual.'
        );
      }
    } catch (e) {
      errLog('onClickCallButton error', e);
      const msg = String((e && e.message) || e || '');
      if (/cancelada/i.test(msg)) return;
      alert('Erro ao iniciar chamada: ' + msg);
    } finally {
      btn.dataset.busy = '0';
      btn.style.opacity = origOpacity;
      btn.style.pointerEvents = origPointer;
    }
  }

  // ----------- garantir que o botão exista sempre -----------

  function removeInjectedButtons() {
    const callBtn = document.getElementById(BUTTON_ID);
    if (callBtn) callBtn.remove();

    const voipBtn = document.getElementById(WAVOIP_BUTTON_ID);
    if (voipBtn) voipBtn.remove();
  }

  function syncScopeState() {
    const locationId = getLocationId();
    window._zaptosVoipGHL_debug.lastScope = {
      at: Date.now(),
      href: location.href,
      pathname: location.pathname,
      locationId
    };

    if (!locationId) {
      if (wavoipConnectedLocationId || wavoipActiveToken) {
        disconnectWavoipSession('outside-location');
      }
      return { allowed: false, locationId: null };
    }

    if (
      wavoipConnectedLocationId &&
      wavoipConnectedLocationId !== locationId
    ) {
      disconnectWavoipSession('location-changed');
    }

    return { allowed: true, locationId };
  }
  function ensureButton() {
    try {
      const scope = syncScopeState();
      if (!scope.allowed) {
        removeInjectedButtons();
        return;
      }

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
    fetchVoipInstances,
    clearSaved,
    clearWavoipToken,
    disconnectWavoipSession,
    requestWavoipToken,
    initWavoipWebphone,
    startVoipLeadCall,
    debug: window._zaptosVoipGHL_debug
  };

  log('ZaptosVoip – Nova UI V2 inicializado');
})();
// ======================= Fim do ZaptosVoip – Nova UI GHL (V2) =======================




