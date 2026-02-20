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
  const VOIP_DIALOG_STYLE_ID = 'zaptos-voip-dialog-style-v2';
  const EDGE_ACTIONS = {
    sessionStart: 'session_start',
    getInstances: 'get_instances',
    getContact: 'get_contact',
    prepareCall: 'prepare_call'
  };
  const EDGE_SESSION_REFRESH_MARGIN_MS = 20 * 1000;

  let wavoipScriptPromise = null;
  let wavoipReadyPromise = null;
  let wavoipRendered = false;
  let wavoipActiveToken = null;
  let wavoipActiveTokens = [];
  let wavoipActiveInstances = [];
  let wavoipConnectedLocationId = null;
  let wavoipConnectedInstanceIds = [];
  let activeVoipDialogClose = null;
  let edgeSession = {
    token: '',
    locationId: '',
    expiresAt: 0
  };

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

  function makeEdgeNonce() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch {
      /* ignore */
    }
    return (
      'zv-' +
      Date.now() +
      '-' +
      Math.random().toString(16).slice(2) +
      '-' +
      Math.random().toString(16).slice(2)
    );
  }

  function parseIsoTimeMs(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function clearEdgeSession(reason) {
    edgeSession = {
      token: '',
      locationId: '',
      expiresAt: 0
    };
    log('edge session cleared', reason || 'manual');
  }

  function isEdgeSessionExpiredForLocation(locationId) {
    const now = Date.now();
    const sessionExpiresAt = Number(edgeSession.expiresAt || 0);
    if (!edgeSession.token) return true;
    if (!edgeSession.locationId) return true;
    if (edgeSession.locationId !== String(locationId || '').trim()) return true;
    if (!sessionExpiresAt) return true;
    return now >= sessionExpiresAt - EDGE_SESSION_REFRESH_MARGIN_MS;
  }

  async function startEdgeSession(locationId) {
    const normalizedLocation = String(locationId || '').trim();
    if (!normalizedLocation) {
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

    const text = await response.text().catch(() => null);
    const json = parseJsonSafe(text);

    window._zaptosVoipGHL_debug.edgeCalls =
      window._zaptosVoipGHL_debug.edgeCalls || [];
    window._zaptosVoipGHL_debug.edgeCalls.push({
      action: EDGE_ACTIONS.sessionStart,
      status: response.status,
      ok: response.ok,
      text,
      json
    });

    if (!response.ok || !json || json.ok === false) {
      const message = String(
        (json && (json.error || json.message || json.code)) ||
          'Falha ao iniciar sessao segura.'
      ).trim();
      throw new Error(message);
    }

    const token = String(
      (json && (json.session_token || (json.data && json.data.session_token))) ||
        ''
    ).trim();
    if (!token) {
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

  async function ensureEdgeSession(locationId, forceRenew) {
    const normalizedLocation = String(locationId || '').trim();
    if (!normalizedLocation) {
      throw new Error('Subconta invalida para autenticar requisicao.');
    }

    if (forceRenew || isEdgeSessionExpiredForLocation(normalizedLocation)) {
      return await startEdgeSession(normalizedLocation);
    }

    return edgeSession.token;
  }

  async function callEdgeAction(action, payload, options) {
    const opts = options || {};
    const attempt = Number(opts.attempt || 0);
    const requireSession = opts.requireSession !== false;
    const bodyPayload =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : {};

    const locationId = String(
      bodyPayload.location_id || getLocationId() || ''
    ).trim();

    const headers = { 'Content-Type': 'application/json' };
    if (requireSession) {
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
    const text = await response.text().catch(() => null);
    const json = parseJsonSafe(text);

    if (requireSession && response.status === 401 && attempt < 1) {
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

  function ensureVoipDialogStyle() {
    if (document.getElementById(VOIP_DIALOG_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = VOIP_DIALOG_STYLE_ID;
    style.textContent = `
      .zv-dialog-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(8, 12, 24, 0.58);
        backdrop-filter: blur(2px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .zv-dialog-card {
        width: min(440px, calc(100vw - 32px));
        max-height: min(80vh, 720px);
        background: linear-gradient(180deg, #22314a 0%, #1a253a 100%);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
        color: #e9eefb;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      }
      .zv-dialog-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 10px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .zv-dialog-title-wrap {
        min-width: 0;
      }
      .zv-dialog-title {
        margin: 0;
        font-size: 20px;
        line-height: 1.15;
        font-weight: 700;
        letter-spacing: 0.01em;
        color: #f3f6ff;
      }
      .zv-dialog-subtitle {
        margin: 6px 0 0 0;
        font-size: 12px;
        color: #aeb9cf;
      }
      .zv-dialog-close {
        border: none;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        cursor: pointer;
        color: #d4ddf1;
        background: rgba(255, 255, 255, 0.08);
        font-size: 20px;
        line-height: 1;
      }
      .zv-dialog-close:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      .zv-dialog-body {
        overflow: auto;
        padding: 12px 14px 4px 14px;
      }
      .zv-dialog-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .zv-option {
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 10px;
        background: #2d3b55;
        color: inherit;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        padding: 12px 12px;
        text-align: left;
      }
      .zv-option:hover {
        border-color: rgba(103, 173, 255, 0.5);
      }
      .zv-option.is-selected {
        border-color: #46b26e;
        box-shadow: inset 0 0 0 1px rgba(70, 178, 110, 0.35);
      }
      .zv-option.is-disabled {
        cursor: not-allowed;
        opacity: 0.62;
      }
      .zv-option-main {
        min-width: 0;
        flex: 1;
      }
      .zv-option-label {
        font-size: 18px;
        font-weight: 700;
        line-height: 1.2;
        color: #f2f6ff;
        word-break: break-word;
      }
      .zv-option-subtitle {
        margin-top: 3px;
        font-size: 14px;
        color: #b7c4de;
        word-break: break-word;
      }
      .zv-option-right {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .zv-badge {
        font-size: 12px;
        line-height: 1;
        border-radius: 7px;
        padding: 6px 8px;
        white-space: nowrap;
        border: 1px solid transparent;
      }
      .zv-badge.connected {
        color: #c8ffe0;
        background: rgba(37, 168, 83, 0.22);
        border-color: rgba(91, 217, 138, 0.35);
      }
      .zv-badge.connecting {
        color: #ffe4b2;
        background: rgba(180, 107, 32, 0.3);
        border-color: rgba(255, 179, 83, 0.35);
      }
      .zv-badge.disconnected {
        color: #ffd4d4;
        background: rgba(171, 55, 55, 0.26);
        border-color: rgba(255, 114, 114, 0.34);
      }
      .zv-badge.muted {
        color: #d4dcec;
        background: rgba(104, 118, 148, 0.22);
        border-color: rgba(164, 177, 208, 0.26);
      }
      .zv-select-marker {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 2px solid rgba(240, 244, 255, 0.58);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
      }
      .zv-select-marker::after {
        content: "";
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #5cf08f;
        transform: scale(0);
        transition: transform 0.13s ease;
      }
      .zv-option.is-selected .zv-select-marker::after {
        transform: scale(1);
      }
      .zv-toggle-marker {
        width: 38px;
        height: 22px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.22);
        position: relative;
      }
      .zv-toggle-marker::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 999px;
        background: #f7f8ff;
        transition: transform 0.15s ease;
      }
      .zv-option.is-selected .zv-toggle-marker {
        background: #38c768;
      }
      .zv-option.is-selected .zv-toggle-marker::after {
        transform: translateX(16px);
      }
      .zv-dialog-feedback {
        margin: 10px 14px 2px 14px;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid rgba(255, 126, 126, 0.33);
        color: #ffd6d6;
        font-size: 12px;
        background: rgba(120, 39, 39, 0.25);
        display: none;
      }
      .zv-dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 14px 14px 14px;
      }
      .zv-btn {
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        min-height: 34px;
        padding: 0 14px;
        color: #ebf0fd;
        background: rgba(255, 255, 255, 0.08);
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
      }
      .zv-btn:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      .zv-btn.primary {
        background: #2b8ef9;
        border-color: #2b8ef9;
        color: #fff;
      }
      .zv-btn.primary:hover {
        background: #197adf;
        border-color: #197adf;
      }
      .zv-btn:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .zv-message {
        font-size: 14px;
        line-height: 1.5;
        color: #e6ecff;
        padding: 8px 0 6px;
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  }

  function resolveStatusBadge(status, canCall, hasToken) {
    if (!hasToken) return { text: 'Sem token', tone: 'muted' };
    const normalized = String(status || '').trim().toLowerCase();
    if (canCall || normalized === 'open') {
      return { text: 'Connected', tone: 'connected' };
    }
    if (normalized === 'connecting') {
      return { text: 'Connecting', tone: 'connecting' };
    }
    if (normalized) {
      return { text: 'Disconnected', tone: 'disconnected' };
    }
    return { text: 'Status desconhecido', tone: 'muted' };
  }

  function mountVoipDialog(title, subtitle, onCancel) {
    ensureVoipDialogStyle();

    if (typeof activeVoipDialogClose === 'function') {
      try {
        activeVoipDialogClose();
      } catch {
        /* ignore */
      }
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
    if (subtitle) {
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

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown, true);
      if (activeVoipDialogClose === close) {
        activeVoipDialogClose = null;
      }
    };

    const cancel = () => {
      close();
      if (typeof onCancel === 'function') {
        onCancel();
      }
    };

    const onKeydown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    };

    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) {
        cancel();
      }
    });
    closeBtn.addEventListener('click', cancel);

    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
    activeVoipDialogClose = close;

    return {
      overlay,
      card,
      body,
      footer,
      feedback,
      close,
      cancel
    };
  }

  async function showVoipNotice(message, opts) {
    const options = opts || {};
    const title = String(options.title || 'VOIP').trim() || 'VOIP';
    return new Promise((resolve) => {
      const dlg = mountVoipDialog(title, '', () => resolve(false));
      const msg = document.createElement('div');
      msg.className = 'zv-message';
      msg.textContent = String(message || '').trim();
      dlg.body.appendChild(msg);

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'zv-btn primary';
      okBtn.textContent = 'OK';
      okBtn.addEventListener('click', () => {
        dlg.close();
        resolve(true);
      });
      dlg.footer.appendChild(okBtn);
      okBtn.focus();
    });
  }

  async function showVoipSingleSelectDialog(config) {
    const cfg = config || {};
    const options = Array.isArray(cfg.options) ? cfg.options : [];
    if (!options.length) return null;

    let selectedIndex =
      Number.isFinite(cfg.defaultIndex) && cfg.defaultIndex >= 0
        ? cfg.defaultIndex
        : -1;
    if (selectedIndex >= options.length || (options[selectedIndex] && options[selectedIndex].disabled)) {
      selectedIndex = options.findIndex((item) => !item.disabled);
    }

    return new Promise((resolve) => {
      const dlg = mountVoipDialog(
        String(cfg.title || 'Selecione').trim(),
        String(cfg.subtitle || '').trim(),
        () => resolve(null)
      );

      const list = document.createElement('div');
      list.className = 'zv-dialog-list';
      dlg.body.appendChild(list);

      const rows = [];
      const render = () => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          row.classList.toggle('is-selected', i === selectedIndex);
        }
        confirmBtn.disabled =
          selectedIndex < 0 ||
          selectedIndex >= options.length ||
          !!(options[selectedIndex] && options[selectedIndex].disabled);
      };

      for (let i = 0; i < options.length; i++) {
        const option = options[i] || {};
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'zv-option';
        if (option.disabled) row.classList.add('is-disabled');

        const main = document.createElement('div');
        main.className = 'zv-option-main';
        const label = document.createElement('div');
        label.className = 'zv-option-label';
        label.textContent = String(option.label || `Opcao ${i + 1}`);
        main.appendChild(label);
        if (option.subtitle) {
          const subtitle = document.createElement('div');
          subtitle.className = 'zv-option-subtitle';
          subtitle.textContent = String(option.subtitle);
          main.appendChild(subtitle);
        }

        const right = document.createElement('div');
        right.className = 'zv-option-right';
        if (option.statusText) {
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
        row.addEventListener('click', () => {
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
      cancelBtn.addEventListener('click', () => {
        dlg.close();
        resolve(null);
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'zv-btn primary';
      confirmBtn.textContent = String(cfg.confirmText || 'Selecionar');
      confirmBtn.addEventListener('click', () => {
        if (selectedIndex < 0 || selectedIndex >= options.length) {
          dlg.feedback.textContent = 'Selecione uma opcao para continuar.';
          dlg.feedback.style.display = 'block';
          return;
        }
        if (options[selectedIndex] && options[selectedIndex].disabled) {
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

  async function showVoipMultiSelectDialog(config) {
    const cfg = config || {};
    const options = Array.isArray(cfg.options) ? cfg.options : [];
    if (!options.length) return null;

    const defaults = Array.isArray(cfg.defaultIndexes) ? cfg.defaultIndexes : [];
    const selected = new Set(
      defaults
        .filter((idx) => Number.isFinite(idx) && idx >= 0 && idx < options.length)
        .filter((idx) => !(options[idx] && options[idx].disabled))
    );

    return new Promise((resolve) => {
      const dlg = mountVoipDialog(
        String(cfg.title || 'Selecione').trim(),
        String(cfg.subtitle || '').trim(),
        () => resolve(null)
      );

      const list = document.createElement('div');
      list.className = 'zv-dialog-list';
      dlg.body.appendChild(list);

      const rows = [];
      const render = () => {
        for (let i = 0; i < rows.length; i++) {
          rows[i].classList.toggle('is-selected', selected.has(i));
        }
      };

      for (let i = 0; i < options.length; i++) {
        const option = options[i] || {};
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'zv-option';
        if (option.disabled) row.classList.add('is-disabled');

        const main = document.createElement('div');
        main.className = 'zv-option-main';
        const label = document.createElement('div');
        label.className = 'zv-option-label';
        label.textContent = String(option.label || `Opcao ${i + 1}`);
        main.appendChild(label);
        if (option.subtitle) {
          const subtitle = document.createElement('div');
          subtitle.className = 'zv-option-subtitle';
          subtitle.textContent = String(option.subtitle);
          main.appendChild(subtitle);
        }

        const right = document.createElement('div');
        right.className = 'zv-option-right';
        if (option.statusText) {
          const badge = document.createElement('span');
          badge.className = `zv-badge ${option.statusTone || 'muted'}`;
          badge.textContent = String(option.statusText);
          right.appendChild(badge);
        }
        const marker = document.createElement('span');
        marker.className = 'zv-toggle-marker';
        right.appendChild(marker);

        row.appendChild(main);
        row.appendChild(right);
        row.addEventListener('click', () => {
          if (option.disabled) return;
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
          render();
        });

        rows.push(row);
        list.appendChild(row);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'zv-btn';
      cancelBtn.textContent = String(cfg.cancelText || 'Cancelar');
      cancelBtn.addEventListener('click', () => {
        dlg.close();
        resolve(null);
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'zv-btn primary';
      confirmBtn.textContent = String(cfg.confirmText || 'Salvar');
      confirmBtn.addEventListener('click', () => {
        const result = Array.from(selected).sort((a, b) => a - b);
        if (!result.length) {
          dlg.feedback.textContent = 'Selecione ao menos uma opcao.';
          dlg.feedback.style.display = 'block';
          return;
        }
        dlg.close();
        resolve(result);
      });

      dlg.footer.appendChild(cancelBtn);
      dlg.footer.appendChild(confirmBtn);
      render();
    });
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

  function firstNonEmptyString(values) {
    if (!Array.isArray(values)) return '';
    for (const value of values) {
      const s = String(value || '').trim();
      if (s) return s;
    }
    return '';
  }

  function collectPhonesFromKnownList(target, values) {
    if (!Array.isArray(values) || !Array.isArray(target)) return;

    for (const value of values) {
      if (!value) continue;

      if (Array.isArray(value)) {
        collectPhonesFromKnownList(target, value);
        continue;
      }

      if (typeof value === 'string' || typeof value === 'number') {
        const normalized = normalizePhone(String(value));
        if (normalized && !target.includes(normalized)) {
          target.push(normalized);
        }
        continue;
      }

      if (typeof value === 'object') {
        const objValue =
          value.phone ||
          value.number ||
          value.value ||
          value.phoneNumber ||
          value.whatsapp ||
          '';
        if (objValue) {
          const normalized = normalizePhone(String(objValue));
          if (normalized && !target.includes(normalized)) {
            target.push(normalized);
          }
        }
      }
    }
  }

  function collectPhonesByKeyHint(value, keyHint, out, seen, depth) {
    if (value == null) return;
    if (depth > 6) return;

    if (typeof value === 'string' || typeof value === 'number') {
      if (/phone|telefone|whatsapp|celular|mobile/i.test(String(keyHint || ''))) {
        const normalized = normalizePhone(String(value));
        if (normalized && !out.includes(normalized)) {
          out.push(normalized);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectPhonesByKeyHint(item, keyHint, out, seen, depth + 1);
      }
      return;
    }

    if (typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      for (const [k, v] of Object.entries(value)) {
        collectPhonesByKeyHint(v, k, out, seen, depth + 1);
      }
    }
  }

  function extractContactDataFromEdgePayload(payload) {
    const contact =
      (payload && payload.contact) ||
      (payload && payload.data && payload.data.contact) ||
      null;

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

    if (contact && Array.isArray(contact.customFields)) {
      for (const field of contact.customFields) {
        if (!field || typeof field !== 'object') continue;
        const key = String(
          field.key || field.name || field.field || field.label || field.id || ''
        );
        if (!/phone|telefone|whatsapp|celular|mobile/i.test(key)) continue;
        collectPhonesFromKnownList(phones, [field.value]);
      }
    }

    if (contact && typeof contact === 'object') {
      collectPhonesByKeyHint(contact, 'contact', phones, new Set(), 0);
    }

    const firstName = firstNonEmptyString([
      contact && contact.firstName,
      contact && contact.first_name
    ]);
    const lastName = firstNonEmptyString([
      contact && contact.lastName,
      contact && contact.last_name
    ]);
    const composedName = [firstName, lastName].filter(Boolean).join(' ').trim();

    const name = firstNonEmptyString([
      contact && contact.name,
      composedName,
      payload && payload.name
    ]);

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

    return {
      phones,
      name: name || null,
      photo: photo || null,
      contact: contact || null
    };
  }

  async function fetchLeadContactByEdge() {
    window._zaptosVoipGHL_debug.contactCalls =
      window._zaptosVoipGHL_debug.contactCalls || [];

    const locationId = getLocationId();
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
    } catch (e) {
      errLog('fetchLeadContactByEdge error', e);
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
      await showVoipNotice(
        'Nenhuma instancia VOIP foi encontrada para esta subconta. Verifique o cadastro da location.'
      );
      return null;
    }

    const savedIds = getSavedSelectedInstanceIds(locationId);
    const defaultIndexes = savedIds
      .map((savedId) =>
        instances.findIndex((item) => getInstanceIdentity(item) === savedId)
      )
      .filter((index) => index >= 0);

    const options = instances.map((item) => {
      const hasToken = !!String(item && item.token).trim();
      const statusMeta = resolveStatusBadge(
        item && item.wavoip_status,
        item && item.can_call,
        hasToken
      );
      return {
        label: String((item && item.instance_name) || 'Instancia'),
        subtitle: hasToken
          ? String((item && item.token) || '').trim()
          : 'Sem token configurado',
        statusText: statusMeta.text,
        statusTone: statusMeta.tone,
        disabled: !hasToken
      };
    });

    while (true) {
      const selectedIndexes = await showVoipMultiSelectDialog({
        title: 'Voip Manager',
        subtitle: 'Selecione as instancias ativas desta subconta',
        options,
        defaultIndexes,
        confirmText: 'Salvar instancias',
        cancelText: 'Cancelar'
      });

      if (selectedIndexes == null) return null;

      if (!selectedIndexes.length) {
        await showVoipNotice('Selecao invalida. Escolha ao menos uma instancia.');
        continue;
      }

      const selectedInstances = selectedIndexes.map((idx) => instances[idx]);
      const withoutToken = selectedInstances.filter(
        (item) => !String((item && item.token) || '').trim()
      );
      if (withoutToken.length) {
        const names = withoutToken.map((item) => item.instance_name).join(', ');
        await showVoipNotice(
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
      await showVoipNotice('Nao foi encontrado token valido nas instancias selecionadas.');
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
    clearEdgeSession(reason || 'disconnect');
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

    hideWavoipSettingsButton();
  }

  function findWavoipDialerRootForHeaderActions() {
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
      if (buttons.length >= 4) return current;
    }
    return null;
  }

  function hideWavoipSettingsButtonByApi() {
    try {
      if (!window.wavoip || !window.wavoip.settings) return;
      const settingsApi = window.wavoip.settings;
      const candidates = [
        'setShowSettingsButton',
        'setShowWidgetSettingsButton',
        'setShowWidgetSettings',
        'setShowSettings'
      ];

      for (const fnName of candidates) {
        const fn = settingsApi[fnName];
        if (typeof fn !== 'function') continue;
        try {
          fn.call(settingsApi, false);
        } catch (e) {
          log(`${fnName}(false) failed`, e);
        }
      }
    } catch (e) {
      log('hideWavoipSettingsButtonByApi failed', e);
    }
  }

  function hideWavoipSettingsButtonByDom() {
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
      for (const selector of targetedSelectors) {
        const matches = root.querySelectorAll(selector);
        for (const node of matches) {
          node.style.display = 'none';
          node.style.visibility = 'hidden';
          hiddenAny = true;
        }
      }

      if (hiddenAny) return;

      const rootRect = root.getBoundingClientRect();
      const topButtons = Array.from(
        root.querySelectorAll('button, [role="button"]')
      )
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          if (!rect || rect.width < 14 || rect.height < 14) return false;
          if (rect.top > rootRect.top + 64) return false;
          if (rect.right < rootRect.right - 180) return false;
          return true;
        })
        .sort(
          (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
        );

      if (topButtons.length >= 3) {
        const settingsBtn = topButtons[topButtons.length - 2];
        settingsBtn.style.display = 'none';
        settingsBtn.style.visibility = 'hidden';
      }
    } catch (e) {
      log('hideWavoipSettingsButtonByDom failed', e);
    }
  }

  function hideWavoipSettingsButton() {
    hideWavoipSettingsButtonByApi();
    hideWavoipSettingsButtonByDom();
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

    const choiceOptions = options.map((item) => {
      const statusMeta = resolveStatusBadge(
        item && item.wavoip_status,
        item && item.can_call,
        !!String((item && item.token) || '').trim()
      );
      return {
        label: String((item && item.name) || 'Instancia'),
        subtitle: String((item && item.token) || '').trim(),
        statusText: statusMeta.text,
        statusTone: statusMeta.tone,
        disabled: false
      };
    });

    while (true) {
      const selectedIndex = await showVoipSingleSelectDialog({
        title: 'Escolher instancia',
        subtitle: 'Selecione a instancia para originar a ligacao',
        options: choiceOptions,
        defaultIndex: 0,
        confirmText: 'Usar instancia',
        cancelText: 'Cancelar'
      });

      if (selectedIndex == null) return null;

      const selected = options[selectedIndex];
      const validated = await verifyOutgoingCallSelection(selected);
      if (!validated.ok) {
        const reason =
          validated.reason ||
          `A instancia "${selected.name}" nao esta com status open para ligacao.`;
        await showVoipNotice(reason);
        continue;
      }

      return validated.token || selected.token;
    }
  }

  function getUniqueTrimmedTokens(list) {
    return Array.from(
      new Set((list || []).map((v) => String(v || '').trim()).filter(Boolean))
    );
  }

  async function isolateOutgoingTokenForCall(selectedToken) {
    const target = String(selectedToken || '').trim();
    if (!target) return async () => {};

    const deviceApi = window.wavoip && window.wavoip.device ? window.wavoip.device : null;
    if (!deviceApi || typeof deviceApi.add !== 'function') {
      return async () => {};
    }

    const previousTokens = getUniqueTrimmedTokens(wavoipActiveTokens);
    if (!previousTokens.length || previousTokens.length === 1) {
      return async () => {};
    }

    let isolated = false;

    if (typeof deviceApi.removeAll === 'function') {
      try {
        deviceApi.removeAll();
        deviceApi.add(target);
        isolated = true;
      } catch (e) {
        log('removeAll isolation failed', e);
      }
    } else if (typeof deviceApi.remove === 'function') {
      try {
        for (const token of previousTokens) {
          if (token === target) continue;
          try {
            deviceApi.remove(token);
          } catch (removeErr) {
            log('remove token for isolation failed', token, removeErr);
          }
        }
        deviceApi.add(target);
        isolated = true;
      } catch (e) {
        log('remove isolation failed', e);
      }
    }

    if (!isolated) {
      return async () => {};
    }

    return async () => {
      try {
        for (const token of previousTokens) {
          try {
            deviceApi.add(token);
          } catch (addErr) {
            log('restore token after call start failed', token, addErr);
          }
        }
      } catch (e) {
        log('restore isolated tokens failed', e);
      }
    };
  }

  async function chooseCallInstanceForClickToCall(locationId) {
    const instances = await fetchVoipInstances(locationId);
    if (!instances.length) {
      await showVoipNotice(
        'Nenhuma instancia VOIP foi encontrada para esta subconta. Verifique o cadastro da location.'
      );
      return null;
    }

    const withToken = instances.filter((item) =>
      !!String((item && item.token) || '').trim()
    );

    if (!withToken.length) {
      await showVoipNotice(
        'As instancias desta subconta nao possuem token VOIP para iniciar a ligacao.'
      );
      return null;
    }

    if (withToken.length === 1) {
      const selected = withToken[0];
      const validated = await verifyOutgoingCallSelection(selected);
      if (!validated.ok) {
        await showVoipNotice(
          validated.reason ||
            'A instancia selecionada nao esta pronta/conectada para ligacao.'
        );
        return null;
      }
      return {
        ...selected,
        token: String(validated.token || selected.token || '').trim()
      };
    }

    const choiceOptions = withToken.map((item) => {
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

    while (true) {
      const selectedIndex = await showVoipSingleSelectDialog({
        title: 'Escolher instancia',
        subtitle: 'Selecione de qual instancia deseja ligar',
        options: choiceOptions,
        defaultIndex: 0,
        confirmText: 'Continuar',
        cancelText: 'Cancelar'
      });

      if (selectedIndex == null) return null;

      const selected = withToken[selectedIndex];
      const validated = await verifyOutgoingCallSelection(selected);
      if (!validated.ok) {
        await showVoipNotice(
          validated.reason ||
            `A instancia "${selected.instance_name}" nao esta pronta/conectada para ligacao.`
        );
        continue;
      }

      return {
        ...selected,
        token: String(validated.token || selected.token || '').trim()
      };
    }
  }

  async function choosePhoneForClickToCall(phones) {
    const normalizedPhones = Array.from(
      new Set(
        (phones || [])
          .map((phone) => normalizePhone(phone))
          .filter(Boolean)
      )
    );

    if (!normalizedPhones.length) return null;
    if (normalizedPhones.length === 1) return normalizedPhones[0];

    const choiceOptions = normalizedPhones.map((phone) => ({
      label: phone,
      subtitle: 'Numero do contato',
      statusText: 'Telefone',
      statusTone: 'muted',
      disabled: false
    }));

    const selectedIndex = await showVoipSingleSelectDialog({
      title: 'Escolher numero',
      subtitle: 'Este contato possui mais de um telefone',
      options: choiceOptions,
      defaultIndex: 0,
      confirmText: 'Usar numero',
      cancelText: 'Cancelar'
    });

    if (selectedIndex == null) return null;
    return normalizedPhones[selectedIndex] || null;
  }

  function openClickToCallWindow(data) {
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
              log('set preferred token failed', e1 || e2 || e3);
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

    const callAttempts = [];
    if (selectedToken) {
      const options = { fromTokens: [selectedToken], fromToken: selectedToken };
      if (startCallFn) {
        callAttempts.push(() => startCallFn(phone, options));
        callAttempts.push(() => startCallFn(phone, { fromTokens: [selectedToken] }));
        callAttempts.push(() => startCallFn(phone, { fromToken: selectedToken }));
      }
      if (startFn) {
        callAttempts.push(() => startFn(phone, options));
        callAttempts.push(() => startFn(phone, { fromTokens: [selectedToken] }));
        callAttempts.push(() => startFn(phone, { fromToken: selectedToken }));
      }
      callAttempts.push(() =>
        startPrimary({ to: phone, fromTokens: [selectedToken], fromToken: selectedToken })
      );
      callAttempts.push(() =>
        startPrimary({ to: phone, fromTokens: [selectedToken] })
      );
      callAttempts.push(() =>
        startPrimary({ to: phone, fromToken: selectedToken })
      );
    }
    callAttempts.push(() => startPrimary({ to: phone }));
    if (startCallFn) {
      callAttempts.push(() => startCallFn(phone));
    } else if (startFn) {
      callAttempts.push(() => startFn(phone));
    }

    // A conexao websocket de voz pode levar alguns segundos para estabilizar.
    const maxAttempts = 22;
    const retryDelayMs = 1000;
    let lastReason = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const invoke of callAttempts) {
        try {
          const result = await invoke();
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

  async function startVoipLeadCall(phone, preferredToken) {
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

    const requestedToken = String(preferredToken || '').trim();
    const selectedToken = requestedToken || (await chooseOutgoingCallToken());
    if (selectedToken == null) {
      return { ok: false, started: false, reason: 'user-cancel' };
    }

    if (
      requestedToken &&
      !locationInstances.some(
        (item) => String((item && item.token) || '').trim() === requestedToken
      )
    ) {
      throw new Error(
        'A instancia selecionada nao esta disponivel nesta subconta para realizar a ligacao.'
      );
    }

    if (typeof window.wavoip.call.setInput === 'function') {
      window.wavoip.call.setInput(phone);
    }

    const restoreOutgoingIsolation = await isolateOutgoingTokenForCall(selectedToken);

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

    enforceWavoipWidgetButtonHidden();

    if (typeof window.wavoip.call.setInput === 'function') {
      window.wavoip.call.setInput(phone);
    }

    // Pequeno atraso para o widget/API interna ficarem prontas apos abrir.
    await wait(650);

    try {
      const trigger = await triggerVoipCall(phone, selectedToken);
      if (!trigger.ok) {
        throw new Error(trigger.reason || 'Falha ao iniciar chamada no VOIP.');
      }
    } finally {
      await restoreOutgoingIsolation();
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
      await showVoipNotice(message);
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
      await showVoipNotice('Erro ao abrir Webphone VOIP: ' + msg);
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
      await showVoipNotice('Instancia VOIP atualizada para esta subconta.');
    } catch (e) {
      if (e && /cancelada/i.test(String(e.message || e))) return;
      errLog('onContextMenuWavoipButton error', e);
      await showVoipNotice('Nao foi possivel atualizar a instancia do VOIP.');
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
      const locationId = getLocationId();
      if (!locationId) return;

      const selectedInstance = await chooseCallInstanceForClickToCall(locationId);
      if (!selectedInstance) return;

      const edgeContact = await fetchLeadContactByEdge();
      const extracted = extractContactInfoNewUI();

      const phones = [];
      if (edgeContact && Array.isArray(edgeContact.phones)) {
        phones.push(...edgeContact.phones);
      }
      if (extracted && extracted.phone) {
        phones.push(extracted.phone);
      }

      const finalPhone = await choosePhoneForClickToCall(phones);
      if (!finalPhone) {
        await showVoipNotice('Nao foi possivel identificar o numero do contato para ligar.');
        return;
      }

      const callResult = await startVoipLeadCall(finalPhone, selectedInstance.token);
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
      await showVoipNotice('Erro ao iniciar chamada: ' + msg);
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
