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
  let wavoipActiveInstances = [];
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
      contactCalls: [],
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

  function looksLikeGhlId(value) {
    return /^[A-Za-z0-9]{8,}$/.test(String(value || '').trim());
  }

  function readUrlParam(names) {
    try {
      const u = new URL(location.href);
      for (const name of names) {
        const v = String(u.searchParams.get(name) || '').trim();
        if (v) return v;
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  function extractEntityIdsFromUrl() {
    const contactFromQuery = readUrlParam([
      'contactId',
      'contact_id',
      'contactid'
    ]);
    const conversationFromQuery = readUrlParam([
      'conversationId',
      'conversation_id',
      'conversationid'
    ]);

    const segments = String(location.pathname || '')
      .split('/')
      .map((s) => decodeURIComponent(s || '').trim())
      .filter(Boolean);

    const ignored = new Set([
      'v2',
      'location',
      'contacts',
      'conversations',
      'manual_actions',
      'templates',
      'trigger-links',
      'settings',
      'opportunities'
    ]);

    function findIdAfter(keyword) {
      const kw = String(keyword || '').toLowerCase();
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].toLowerCase() !== kw) continue;
        for (let j = i + 1; j < Math.min(i + 4, segments.length); j++) {
          const candidate = segments[j];
          if (!candidate) continue;
          if (ignored.has(candidate.toLowerCase())) continue;
          if (looksLikeGhlId(candidate)) return candidate;
        }
      }
      return '';
    }

    const contactId = contactFromQuery || findIdAfter('contacts');
    const conversationId =
      conversationFromQuery || findIdAfter('conversations');

    return {
      contactId: contactId && looksLikeGhlId(contactId) ? contactId : '',
      conversationId:
        conversationId && looksLikeGhlId(conversationId) ? conversationId : ''
    };
  }

  async function fetchLeadPhoneByEdge() {
    window._zaptosVoipGHL_debug.contactCalls =
      window._zaptosVoipGHL_debug.contactCalls || [];

    const locationId = getLocationId();
    if (!locationId) return null;

    const ids = extractEntityIdsFromUrl();
    if (!ids.contactId && !ids.conversationId) return null;

    try {
      const url = new URL(INSTANCE_PICKER_URL);
      url.searchParams.set('location_id', locationId);
      if (ids.contactId) url.searchParams.set('contact_id', ids.contactId);
      if (ids.conversationId) {
        url.searchParams.set('conversation_id', ids.conversationId);
      }

      const resp = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'omit'
      });
      const text = await resp.text().catch(() => null);
      const json = parseJsonSafe(text);

      window._zaptosVoipGHL_debug.contactCalls.push({
        url: url.toString(),
        status: resp.status,
        ok: resp.ok,
        text,
        json
      });

      if (!resp.ok || !json) return null;

      const phoneRaw =
        json.phone ||
        (json.contact && json.contact.phone) ||
        (json.data && json.data.phone) ||
        null;
      return normalizePhone(phoneRaw);
    } catch (e) {
      errLog('fetchLeadPhoneByEdge error', e);
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
      const wavoipStatus = String(
        (row &&
          (row.wavoip_status ||
            row.status ||
            (row.device && row.device.status) ||
            '')) ||
          ''
      )
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
      const wavoipDeviceId = String(
        (row && (row.wavoip_device_id || row.device_id || '')) || ''
      ).trim();

      normalized.push({
        id,
        instance_id: id,
        instance_name: name,
        token,
        wavoip_status: wavoipStatus || null,
        can_call: canCall,
        call_error: callError || null,
        wavoip_device_id: wavoipDeviceId || null
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

  async function fetchVoipInstancesWithTokenForLocation(locationId) {
    if (!locationId) return [];
    const instances = await fetchVoipInstances(locationId);
    return (instances || []).filter((item) => {
      const token = String((item && item.token) || '').trim();
      return !!token;
    });
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
        const tags = [];
        if (!item.token) tags.push('sem token');
        if (item.wavoip_status) tags.push(`status: ${item.wavoip_status}`);
        return `${index + 1}) ${item.instance_name}${
          tags.length ? ` (${tags.join(', ')})` : ''
        }`;
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

    const instances = selectedInstances.map((item) => ({
      id: getInstanceIdentity(item),
      name: String(item.instance_name || '').trim(),
      token: String(item.token || '').trim(),
      can_call: !!item.can_call,
      wavoip_status: String(item.wavoip_status || '').trim().toLowerCase(),
      call_error: String(item.call_error || '').trim()
    }));

    return {
      tokens,
      token: tokens[0],
      source: 'instances-selected',
      instanceIds,
      instanceNames,
      instances
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
    wavoipActiveInstances = [];
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

  async function initWavoipWebphone(forcePromptToken, options) {
    const opts = options || {};
    const keepCurrentConnections = !!opts.keepCurrentConnections;
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

    // Quando solicitado, preserva as conexoes ativas para nao alterar os numeros
    // que estao recebendo chamadas no webphone geral da subconta.
    if (keepCurrentConnections && wavoipActiveTokens.length) {
      enforceWavoipWidgetButtonHidden();
      return true;
    }

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
    const nextInstances = [];
    const seenInstanceTokens = new Set();
    for (const item of resolved.instances || []) {
      const token = String((item && item.token) || '').trim();
      if (!token || seenInstanceTokens.has(token)) continue;
      seenInstanceTokens.add(token);
      nextInstances.push({
        token,
        id: String((item && item.id) || '').trim(),
        name: String((item && item.name) || '').trim(),
        can_call: !!(item && item.can_call),
        wavoip_status: String((item && item.wavoip_status) || '')
          .trim()
          .toLowerCase(),
        call_error: String((item && item.call_error) || '').trim()
      });
    }
    if (!nextInstances.length) {
      for (let i = 0; i < nextTokens.length; i++) {
        const token = nextTokens[i];
        const name = String((resolved.instanceNames || [])[i] || '').trim();
        nextInstances.push({
          token,
          id: String((nextInstanceIds || [])[i] || '').trim(),
          name,
          can_call: false,
          wavoip_status: '',
          call_error: ''
        });
      }
    }

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

    wavoipActiveInstances = nextInstances;

    enforceWavoipWidgetButtonHidden();
    return true;
  }

  function getActiveCallInstanceOptions() {
    const options = [];
    const seen = new Set();

    for (const item of wavoipActiveInstances || []) {
      const token = String((item && item.token) || '').trim();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      const status = String((item && item.wavoip_status) || '')
        .trim()
        .toLowerCase();
      const canCall =
        item && (item.can_call === true || item.can_call === 'true')
          ? true
          : status === 'open';
      options.push({
        token,
        id: String((item && item.id) || '').trim(),
        name: String((item && item.name) || '').trim(),
        wavoip_status: status || '',
        can_call: canCall,
        call_error: String((item && item.call_error) || '').trim()
      });
    }

    if (!options.length) {
      for (const tokenRaw of wavoipActiveTokens || []) {
        const token = String(tokenRaw || '').trim();
        if (!token || seen.has(token)) continue;
        seen.add(token);
        options.push({
          token,
          id: '',
          name: '',
          wavoip_status: '',
          can_call: false,
          call_error: ''
        });
      }
    }

    for (let i = 0; i < options.length; i++) {
      if (!options[i].name) {
        options[i].name = `Instancia ${i + 1}`;
      }
    }

    return options;
  }

  function isInstanceOpenStatus(value) {
    return String(value || '').trim().toLowerCase() === 'open';
  }

  function hasCanCallFlag(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  async function verifyOutgoingCallSelection(selectedOption) {
    const locationId = getLocationId();
    if (!locationId) {
      return {
        ok: false,
        reason: 'Subconta invalida para verificar a instancia.'
      };
    }

    const latest = await fetchVoipInstances(locationId);
    if (!latest.length) {
      return {
        ok: false,
        reason: 'Nao foi possivel verificar o status da instancia para ligar.'
      };
    }

    const selectedToken = String((selectedOption && selectedOption.token) || '').trim();
    const selectedId = String((selectedOption && selectedOption.id) || '').trim();
    const selectedName = String((selectedOption && selectedOption.name) || '').trim();

    let matched = null;
    if (selectedToken) {
      matched =
        latest.find((item) => String(item.token || '').trim() === selectedToken) ||
        null;
    }
    if (!matched && selectedId) {
      matched =
        latest.find((item) => getInstanceIdentity(item) === selectedId) || null;
    }
    if (!matched && selectedName) {
      matched =
        latest.find(
          (item) =>
            String(item.instance_name || '').trim().toLowerCase() ===
            selectedName.toLowerCase()
        ) || null;
    }

    if (!matched) {
      return {
        ok: false,
        reason: 'Nao foi possivel validar a instancia selecionada para ligacao.'
      };
    }

    const status = String(matched.wavoip_status || matched.status || '')
      .trim()
      .toLowerCase();
    const canCall = hasCanCallFlag(matched.can_call) || isInstanceOpenStatus(status);
    const name = String(matched.instance_name || selectedName || 'Instancia').trim();
    const reason = canCall
      ? ''
      : String(matched.call_error || '').trim() ||
        `A instancia "${name}" nao esta com status open (status atual: ${
          status || 'desconhecido'
        }).`;

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

  async function chooseOutgoingCallToken() {
    const options = getActiveCallInstanceOptions();
    if (!options.length) {
      throw new Error('Nenhuma instancia VOIP ativa para originar a ligacao.');
    }

    if (options.length === 1) {
      const validated = await verifyOutgoingCallSelection(options[0]);
      if (!validated.ok) {
        const reason =
          validated.reason ||
          'A instancia selecionada nao esta com status open para ligacao.';
        throw new Error(reason);
      }
      return validated.token || options[0].token;
    }

    const optionsText = options.map((item, index) => `${index + 1}) ${item.name}`).join('\n');

    while (true) {
      const typed = prompt(
        `Escolha de qual instancia deseja ligar:\n\n${optionsText}\n\nDigite o numero da instancia:`,
        '1'
      );

      if (typed == null) return null;

      const selectedIndex = Number(String(typed).trim());
      if (
        !Number.isFinite(selectedIndex) ||
        selectedIndex < 1 ||
        selectedIndex > options.length
      ) {
        alert('Selecao invalida. Escolha um numero da lista.');
        continue;
      }

      const selected = options[selectedIndex - 1];
      const validated = await verifyOutgoingCallSelection(selected);
      if (!validated.ok) {
        const reason =
          validated.reason ||
          `A instancia "${selected.name}" nao esta com status open para ligacao.`;
        alert(reason);
        continue;
      }

      return validated.token || selected.token;
    }
  }

  function getVoipStartResultError(result) {
    if (!result || typeof result !== 'object') return '';
    if (!result.err) return '';
    return (
      (result.err.devices &&
        result.err.devices[0] &&
        result.err.devices[0].reason) ||
      result.err.message ||
      String(result.err) ||
      ''
    );
  }

  function hasVoipCallInProgress() {
    function isActiveCallShape(callObj) {
      if (!callObj) return false;
      if (Array.isArray(callObj)) {
        return callObj.some((item) => isActiveCallShape(item));
      }
      if (typeof callObj !== 'object') return false;

      if (
        callObj.id ||
        callObj.call_id ||
        callObj.peer ||
        callObj.transport ||
        callObj.startedAt ||
        callObj.createdAt
      ) {
        return true;
      }

      const rawState = String(callObj.status || callObj.state || '')
        .trim()
        .toLowerCase();
      if (!rawState) return false;

      const nonActiveStates = new Set([
        'idle',
        'ended',
        'end',
        'terminated',
        'hangup',
        'disconnected',
        'closed'
      ]);
      return !nonActiveStates.has(rawState);
    }

    try {
      if (!window.wavoip || !window.wavoip.call) return false;
      const outgoing =
        typeof window.wavoip.call.getCallOutgoing === 'function'
          ? window.wavoip.call.getCallOutgoing()
          : null;
      if (isActiveCallShape(outgoing)) return true;

      const active =
        typeof window.wavoip.call.getCallActive === 'function'
          ? window.wavoip.call.getCallActive()
          : null;
      if (isActiveCallShape(active)) return true;
    } catch (e) {
      log('hasVoipCallInProgress check failed', e);
    }
    return false;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForVoipCallStart(timeoutMs) {
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 1800;
    const interval = 150;
    const startAt = Date.now();
    while (Date.now() - startAt < timeout) {
      if (hasVoipCallInProgress()) return true;
      await wait(interval);
    }
    return hasVoipCallInProgress();
  }

  async function triggerVoipCall(phone, selectedToken) {
    const callApi = window.wavoip && window.wavoip.call ? window.wavoip.call : null;
    if (!callApi) {
      return { ok: false, reason: 'Modulo de chamadas VOIP indisponivel.' };
    }

    const startCallFn =
      typeof callApi.startCall === 'function' ? callApi.startCall.bind(callApi) : null;
    const startFn =
      typeof callApi.start === 'function' ? callApi.start.bind(callApi) : null;
    const startPrimary = startCallFn || startFn;

    if (!startPrimary) {
      return { ok: false, reason: 'API de chamada VOIP nao disponivel.' };
    }

    function getRuntimeDeviceList() {
      try {
        if (
          window.wavoip &&
          window.wavoip.device &&
          typeof window.wavoip.device.get === 'function'
        ) {
          const list = window.wavoip.device.get();
          if (Array.isArray(list)) return list;
        }
      } catch (e) {
        log('device.get failed', e);
      }
      try {
        if (
          window.wavoip &&
          window.wavoip.device &&
          typeof window.wavoip.device.getDevices === 'function'
        ) {
          const list = window.wavoip.device.getDevices();
          if (Array.isArray(list)) return list;
        }
      } catch (e) {
        log('device.getDevices failed', e);
      }
      return [];
    }

    function parseRgbChannels(colorValue) {
      const raw = String(colorValue || '').trim();
      const match = raw.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (!match) return null;
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3])
      };
    }

    function isGreenishBackground(colorValue) {
      const channels = parseRgbChannels(colorValue);
      if (!channels) return false;
      return (
        channels.g >= 110 &&
        channels.g > channels.r + 20 &&
        channels.g > channels.b + 20
      );
    }

    function findWavoipDialerRoot() {
      const allNodes = Array.from(document.querySelectorAll('*'));
      const versionNode = allNodes.find((el) => {
        const text = String(el.textContent || '').trim();
        return text && text.length <= 40 && /\bv\s*\d+\.\d+\.\d+/i.test(text);
      });
      if (!versionNode) return null;

      let current = versionNode;
      for (let i = 0; i < 8 && current && current.parentElement; i++) {
        current = current.parentElement;
        const rect = current.getBoundingClientRect();
        if (!rect || rect.width < 220 || rect.height < 300) continue;
        if (rect.left < window.innerWidth * 0.45) continue;

        const buttons = current.querySelectorAll('button, [role="button"]');
        if (buttons.length >= 8) return current;
      }

      return null;
    }

    function clickNode(node) {
      if (!node) return false;
      try {
        const events = [
          'pointerdown',
          'mousedown',
          'pointerup',
          'mouseup',
          'click'
        ];
        for (const type of events) {
          node.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window
            })
          );
        }
        return true;
      } catch (e) {
        log('clickNode failed', e);
        return false;
      }
    }

    function clickWidgetDialButtonFallback() {
      const root = findWavoipDialerRoot();
      if (!root) return false;

      const withPhoneIcon = Array.from(
        root.querySelectorAll('button, [role="button"], div')
      ).filter((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width < 34 || rect.height < 34) return false;
        if (rect.bottom < window.innerHeight * 0.4) return false;

        const path = el.querySelector(
          'svg path[d*="M8.38 8.853"], svg path[d*="14.603"], svg path[d*="call"], svg path[d*="phone"]'
        );
        if (!path) return false;

        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return true;
      });

      if (withPhoneIcon.length) {
        const bestPhoneButton = withPhoneIcon.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const scoreA = ra.width * ra.height + ra.top;
          const scoreB = rb.width * rb.height + rb.top;
          return scoreB - scoreA;
        })[0];
        return clickNode(bestPhoneButton);
      }

      const candidates = Array.from(
        root.querySelectorAll('button, [role="button"]')
      ).filter((el) => {
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

      const best = candidates.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })[0];

      return clickNode(best);
    }

    function findRuntimeDeviceByToken(token) {
      const target = String(token || '').trim();
      if (!target) return null;
      const list = getRuntimeDeviceList();
      return (
        list.find((item) => String(item && item.token || '').trim() === target) ||
        null
      );
    }

    function isRuntimeDeviceReadyStatus(status) {
      const normalized = String(status || '').trim().toLowerCase();
      return (
        normalized === 'open' ||
        normalized === 'connected' ||
        normalized === 'ready'
      );
    }

    async function waitForRuntimeDeviceReady(token, timeoutMs) {
      const target = String(token || '').trim();
      if (!target) return true;

      const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
      const interval = 300;
      const startAt = Date.now();

      while (Date.now() - startAt < timeout) {
        const device = findRuntimeDeviceByToken(target);
        const status = String(device && device.status || '')
          .trim()
          .toLowerCase();
        if (isRuntimeDeviceReadyStatus(status)) return true;
        await wait(interval);
      }

      const last = findRuntimeDeviceByToken(target);
      return isRuntimeDeviceReadyStatus(last && last.status);
    }

    async function setPreferredOutgoingToken(token) {
      const target = String(token || '').trim();
      if (!target || !window.wavoip || !window.wavoip.device) return;

      const deviceApi = window.wavoip.device;
      const methods = [
        deviceApi.enable,
        deviceApi.enableDevice
      ].filter((fn) => typeof fn === 'function');

      for (const fn of methods) {
        try {
          await fn.call(deviceApi, target);
          return;
        } catch (e1) {
          try {
            await fn.call(deviceApi, [target]);
            return;
          } catch (e2) {
            try {
              await fn.call(deviceApi, { token: target });
              return;
            } catch (e3) {
              log('enable token failed', e1 || e2 || e3);
            }
          }
        }
      }
    }

    if (selectedToken) {
      await setPreferredOutgoingToken(selectedToken);
      await waitForRuntimeDeviceReady(selectedToken, 15000);
    }

    // Fluxo principal: simular o clique no mesmo botao verde usado manualmente.
    // Quando existe mais de uma instancia, esse caminho respeita melhor o estado
    // selecionado no widget.
    const clickedFirst = clickWidgetDialButtonFallback();
    if (clickedFirst) {
      const startedAfterFirstClick = await waitForVoipCallStart(2500);
      if (startedAfterFirstClick) {
        return { ok: true };
      }
    }

    const payloads = [];
    if (selectedToken) {
      payloads.push({ to: phone, fromTokens: [selectedToken], fromToken: selectedToken });
      payloads.push({ to: phone, fromTokens: [selectedToken] });
      payloads.push({ to: phone, fromToken: selectedToken });
    }
    payloads.push({ to: phone });

    // A conexao websocket de voz pode levar alguns segundos para estabilizar.
    const maxAttempts = 12;
    const retryDelayMs = 900;
    let lastReason = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const payload of payloads) {
        try {
          const result = await startPrimary(payload);
          const errReason = getVoipStartResultError(result);
          if (errReason) {
            lastReason = errReason;
          } else {
            if (result && result.call) {
              return { ok: true };
            }

            const started = await waitForVoipCallStart(1800);
            if (started) {
              return { ok: true };
            }
          }
        } catch (e) {
          const message = String((e && e.message) || e || '').trim();
          if (message) lastReason = message;
        }
      }

      if (attempt < maxAttempts) {
        await wait(retryDelayMs);
      }
    }

    const clicked = clickWidgetDialButtonFallback();
    if (clicked) {
      const startedAfterClick = await waitForVoipCallStart(2500);
      if (startedAfterClick) {
        return { ok: true };
      }
    }

    return {
      ok: false,
      reason: lastReason || 'Nao foi possivel iniciar a ligacao automaticamente.'
    };
  }

  async function startVoipLeadCall(phone) {
    const locationId = getLocationId();
    const locationInstances = await fetchVoipInstancesWithTokenForLocation(locationId);
    if (!locationInstances.length) {
      disconnectWavoipSession('no-location-instances');
      throw new Error(
        'Nenhuma instancia VOIP com token foi encontrada nesta subconta. A ligacao nao pode ser iniciada.'
      );
    }

    await initWavoipWebphone(false, { keepCurrentConnections: true });

    if (!window.wavoip || !window.wavoip.call) {
      throw new Error('Modulo de chamadas VOIP indisponivel.');
    }

    enforceWavoipWidgetButtonHidden();

    const selectedToken = await chooseOutgoingCallToken();
    if (selectedToken == null) {
      return { ok: false, started: false, reason: 'user-cancel' };
    }

    if (typeof window.wavoip.call.setInput === 'function') {
      window.wavoip.call.setInput(phone);
    }

    if (
      window.wavoip &&
      window.wavoip.device &&
      typeof window.wavoip.device.add === 'function'
    ) {
      try {
        // Reforca o token escolhido sem desconectar os demais.
        window.wavoip.device.add(selectedToken);
      } catch (e) {
        log('device.add selected token failed', selectedToken, e);
      }
    }

    if (
      window.wavoip.widget &&
      typeof window.wavoip.widget.open === 'function'
    ) {
      window.wavoip.widget.open();
    } else if (
      window.wavoip &&
      window.wavoip.widget &&
      typeof window.wavoip.widget.toggle === 'function'
    ) {
      window.wavoip.widget.toggle();
    }

    if (typeof window.wavoip.call.setInput === 'function') {
      window.wavoip.call.setInput(phone);
    }

    const trigger = await triggerVoipCall(phone, selectedToken);
    if (!trigger.ok) {
      throw new Error(trigger.reason || 'Falha ao iniciar chamada no VOIP.');
    }

    return { ok: true, started: true };
  }

  async function openVoipForManualDial(message) {
    await initWavoipWebphone(false, { keepCurrentConnections: true });

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
      let finalPhone = await fetchLeadPhoneByEdge();
      if (!finalPhone) {
        const extracted = extractContactInfoNewUI();
        finalPhone = normalizePhone(extracted && extracted.phone);
      }

      if (!finalPhone) {
        await openVoipForManualDial(
          'Nao foi possivel identificar o numero do contato. O VOIP foi aberto para discagem manual.'
        );
        return;
      }

      const callResult = await startVoipLeadCall(finalPhone);
      if (callResult && callResult.started === false) {
        if (callResult.reason === 'user-cancel') {
          return;
        }
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




