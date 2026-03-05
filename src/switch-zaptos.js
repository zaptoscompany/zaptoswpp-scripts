/*!
 * Zaptos WhatsApp Switch for GHL
 * Adiciona #switch:<instancia> automaticamente no envio da mensagem.
 */
(function () {
  if (window.__ZAPTOS_WPP_SWITCH_V1__) return;
  window.__ZAPTOS_WPP_SWITCH_V1__ = true;

  const DEBUG = false;
  const EDGE_INSTANCES_URL =
    window.__ZAPTOS_SWITCH_EDGE_URL__ ||
    'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-wpp-instances-switch';

  const WRAPPER_ID = 'zaptos-switch-wrapper';
  const CHECKBOX_ID = 'zaptos-switch-enabled';
  const SELECT_ID = 'zaptos-switch-select';
  const REFRESH_ID = 'zaptos-switch-refresh';
  const STATUS_ID = 'zaptos-switch-status';
  const FLOATING_HOST_ID = 'zaptos-switch-floating-host';
  const CHANNEL_HEADER_HOST_ID = 'zaptos-switch-channel-host';
  const CHECK_INTERVAL_MS = 1200;
  const REQUEST_TIMEOUT_MS = 12000;
  const STORAGE_PREFIX = 'zaptos_wpp_switch';
  const ALLOW_FLOATING_FALLBACK =
    window.__ZAPTOS_SWITCH_FLOATING_FALLBACK__ === true;

  const state = {
    locationId: '',
    enabled: false,
    selectedInstance: '',
    instances: [],
    lastFetchAt: 0,
    loading: false,
    uiMode: 'inline',
    listenersBound: false,
    lastHref: location.href
  };

  const log = (...args) => {
    if (DEBUG) console.log('[ZaptosSwitch]', ...args);
  };

  function readString(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  function getLocationId() {
    try {
      const path = location.pathname || '';
      const match =
        path.match(/\/location\/([^/]+)/i) || path.match(/\/locations\/([^/]+)/i);
      return match ? readString(match[1]) : '';
    } catch {
      return '';
    }
  }

  function isVisibleElement(el) {
    return !!(el && el.offsetParent !== null);
  }

  function getScopedStorageKey(key) {
    const scope = readString(state.locationId) || 'global';
    return `${STORAGE_PREFIX}:${scope}:${key}`;
  }

  function loadStateForCurrentLocation() {
    const enabledRaw = localStorage.getItem(getScopedStorageKey('enabled'));
    state.enabled = enabledRaw === '1';
    state.selectedInstance = readString(
      localStorage.getItem(getScopedStorageKey('instance'))
    );
  }

  function saveEnabled(enabled) {
    state.enabled = !!enabled;
    localStorage.setItem(getScopedStorageKey('enabled'), state.enabled ? '1' : '0');
  }

  function saveSelectedInstance(name) {
    state.selectedInstance = readString(name);
    localStorage.setItem(getScopedStorageKey('instance'), state.selectedInstance);
  }

  function isWhatsAppQrLabelText(text) {
    const normalized = readString(text)
      .toLowerCase()
      .replace(/\s+/g, ' ');
    return normalized === 'whatsapp qr' || normalized === 'whats app qr';
  }

  function findWhatsAppQrLabel() {
    const candidates = Array.from(
      document.querySelectorAll('span.text-sm.font-medium.text-gray-700, span')
    ).filter((el) => isVisibleElement(el));

    for (const candidate of candidates) {
      if (!isWhatsAppQrLabelText(candidate.textContent)) continue;

      const row = candidate.closest(
        "div.flex.flex-row.py-1.items-center.justify-end.rounded-t-lg, div[class*='rounded-t-lg'][class*='py-1']"
      );
      if (row && isVisibleElement(row)) return candidate;
    }

    return null;
  }

  function getChannelHeaderHost() {
    const label = findWhatsAppQrLabel();
    if (!label) return null;

    const row = label.closest(
      "div.flex.flex-row.py-1.items-center.justify-end.rounded-t-lg, div[class*='rounded-t-lg'][class*='py-1']"
    );
    if (!row) return null;

    const leftBlock =
      row.querySelector("div.flex.gap-6.items-center.w-full.min-w-0.overflow-hidden") ||
      row.querySelector("div[class*='gap-6'][class*='w-full'][class*='items-center']");

    if (!leftBlock) return null;

    let host = row.querySelector(`#${CHANNEL_HEADER_HOST_ID}`);
    if (host) return host;

    host = document.createElement('div');
    host.id = CHANNEL_HEADER_HOST_ID;
    Object.assign(host.style, {
      display: 'inline-flex',
      alignItems: 'center',
      marginLeft: '8px',
      minWidth: '0',
      flexShrink: '0'
    });

    const titleContainer = label.closest('div');
    if (titleContainer && titleContainer.parentElement === leftBlock) {
      leftBlock.insertBefore(host, titleContainer.nextSibling);
    } else {
      leftBlock.appendChild(host);
    }

    return host;
  }

  function findBottomBar() {
    const list = document.querySelectorAll("div.flex.items-center.h-\\[40px\\]");
    const visible = Array.from(list).filter((el) => isVisibleElement(el));
    return (
      visible.find(
        (el) =>
          el.querySelector("div[class*='flex-row'][class*='min-w-0']") &&
          el.querySelector("div[class*='border-l'][class*='gap-1']")
      ) ||
      visible[0] ||
      null
    );
  }

  function findSendButtonInScope(scope) {
    if (!scope) return null;
    const buttons = Array.from(
      scope.querySelectorAll('button, [role="button"]')
    ).filter((el) => isVisibleElement(el));
    return buttons.find((btn) => isLikelySendButton(btn)) || null;
  }

  function findComposerContainerFromInput() {
    const input = pickMostLikelyInput(getInputCandidates(document));
    if (!input) return null;

    let node = input.parentElement;
    for (let i = 0; i < 12 && node; i += 1) {
      const hasInput = !!pickMostLikelyInput(getInputCandidates(node));
      const sendBtn = findSendButtonInScope(node);
      const visibleButtons = node.querySelectorAll('button, [role="button"]').length;
      if (hasInput && (sendBtn || visibleButtons >= 4)) return node;
      node = node.parentElement;
    }

    return input.parentElement || null;
  }

  function findComposerActionBar(container) {
    if (!container) return null;

    const candidates = [container, ...container.querySelectorAll('div, footer, section')];
    let best = null;
    let bestScore = -1;

    candidates.forEach((node) => {
      if (!isVisibleElement(node)) return;

      const buttons = node.querySelectorAll('button, [role="button"]').length;
      if (buttons < 3) return;

      const rect = node.getBoundingClientRect();
      let score = buttons * 8;

      if (findSendButtonInScope(node)) score += 60;
      if (rect.height >= 20 && rect.height <= 90) score += 20;
      if (rect.top >= window.innerHeight - 320) score += 20;
      score += rect.bottom / 100;

      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    });

    return best;
  }

  function findLeftIconGroup() {
    const bar = findBottomBar();
    if (!bar) return null;
    return (
      bar.querySelector(
        "div[class*='flex-row'][class*='items-center'][class*='pl-2'][class*='min-w-0']"
      ) || null
    );
  }

  function findLegacyToolbar() {
    const container = document.querySelector(
      "div[data-testid*='composer'], div[data-rbd-droppable-id]"
    );
    if (!container) return null;

    let best = null;
    let bestCount = 0;

    let groups = [];
    try {
      groups = Array.from(
        container.querySelectorAll(
          "div[role='group'], div[class*='toolbar'], div:has(button,svg)"
        )
      );
    } catch {
      groups = Array.from(
        container.querySelectorAll("div[role='group'], div[class*='toolbar']")
      );
    }

    groups.forEach((node) => {
      const count = node.querySelectorAll('button,[role="button"],svg').length;
      if (count > bestCount) {
        best = node;
        bestCount = count;
      }
    });

    return best || container;
  }

  function getFloatingHost() {
    let host = document.getElementById(FLOATING_HOST_ID);
    if (host) return host;

    host = document.createElement('div');
    host.id = FLOATING_HOST_ID;
    Object.assign(host.style, {
      position: 'fixed',
      left: '12px',
      bottom: '84px',
      zIndex: '99999'
    });
    document.body.appendChild(host);
    return host;
  }

  function getUiHost() {
    const channelHeaderHost = getChannelHeaderHost();
    if (channelHeaderHost) {
      state.uiMode = 'channel-header';
      return channelHeaderHost;
    }

    const leftIconGroup = findLeftIconGroup();
    if (leftIconGroup) {
      state.uiMode = 'inline';
      return leftIconGroup;
    }

    const legacy = findLegacyToolbar();
    if (legacy) {
      state.uiMode = 'inline';
      return legacy;
    }

    const composerContainer = findComposerContainerFromInput();
    const composerBar = findComposerActionBar(composerContainer);
    if (composerBar) {
      state.uiMode = 'inline';
      return composerBar;
    }

    if (ALLOW_FLOATING_FALLBACK) {
      state.uiMode = 'floating';
      return getFloatingHost();
    }

    state.uiMode = 'inline';
    return null;
  }

  function getInputCandidates(root) {
    const scope = root || document;
    const textareaCandidates = Array.from(
      scope.querySelectorAll(
        "textarea[placeholder*='mensagem'], textarea[placeholder*='message'], textarea"
      )
    ).filter((el) => isVisibleElement(el) && !el.disabled && !el.readOnly);

    const editableCandidates = Array.from(
      scope.querySelectorAll(
        "div[contenteditable='true'][role='textbox'], div[contenteditable='true']"
      )
    ).filter((el) => isVisibleElement(el));

    return [...textareaCandidates, ...editableCandidates];
  }

  function pickMostLikelyInput(candidates) {
    if (!candidates.length) return null;
    const sorted = [...candidates].sort(
      (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom
    );
    return sorted[0] || null;
  }

  function findInputNearButton(button) {
    let node = button;
    for (let i = 0; i < 7 && node; i += 1) {
      const candidate = pickMostLikelyInput(getInputCandidates(node));
      if (candidate) return candidate;
      node = node.parentElement;
    }
    return null;
  }

  function resolveActiveInput() {
    const active = document.activeElement;
    if (!active) return null;

    if (active instanceof HTMLTextAreaElement) {
      if (isVisibleElement(active) && !active.disabled && !active.readOnly) {
        return active;
      }
    }

    if (active instanceof HTMLElement) {
      const editable = active.closest("div[contenteditable='true']");
      if (editable && isVisibleElement(editable)) return editable;
    }

    return null;
  }

  function findComposerInput(preferredButton) {
    if (preferredButton) {
      const near = findInputNearButton(preferredButton);
      if (near) return near;
    }

    const active = resolveActiveInput();
    if (active) return active;

    return pickMostLikelyInput(getInputCandidates(document));
  }

  function getInputText(input) {
    if (!input) return '';
    if (input instanceof HTMLTextAreaElement) return String(input.value || '');
    if (input instanceof HTMLElement) return String(input.innerText || input.textContent || '');
    return '';
  }

  function dispatchInputEvents(input) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setInputText(input, value) {
    if (!input) return;

    if (input instanceof HTMLTextAreaElement) {
      if (input.value === value) return;
      input.value = value;
      dispatchInputEvents(input);
      return;
    }

    if (input instanceof HTMLElement) {
      const current = getInputText(input);
      if (current === value) return;

      input.focus();
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, value);
      } catch {
        input.innerText = value;
      }

      if (getInputText(input) !== value) {
        input.innerText = value;
      }

      dispatchInputEvents(input);
    }
  }

  function buildSwitchMessage(originalMessage, instanceName) {
    const normalized = String(originalMessage || '').replace(/\r\n/g, '\n');
    const prefix = `#switch:${instanceName}`;

    if (/^\s*#switch:/i.test(normalized)) {
      return normalized.replace(/^\s*#switch:[^\n]*\n?/i, `${prefix}\n`);
    }

    return `${prefix}\n${normalized}`;
  }

  function isLikelySendButton(button) {
    if (!button) return false;

    const type = readString(button.getAttribute('type')).toLowerCase();
    const aria = readString(button.getAttribute('aria-label')).toLowerCase();
    const title = readString(button.getAttribute('title')).toLowerCase();
    const text = readString(button.textContent).toLowerCase();
    const dataTestId = readString(button.getAttribute('data-testid')).toLowerCase();
    const id = readString(button.id).toLowerCase();
    const className = readString(button.className).toLowerCase();

    if (type === 'submit') return true;
    if (/send|enviar/.test(aria)) return true;
    if (/send|enviar/.test(title)) return true;
    if (/send|enviar/.test(text)) return true;
    if (/send/.test(dataTestId)) return true;
    if (id.includes('send')) return true;
    if (className.includes('send')) return true;

    return false;
  }

  function updateStatus(message, isError) {
    const statusEl = document.getElementById(STATUS_ID);
    if (!statusEl) return;
    statusEl.textContent = readString(message);
    statusEl.style.color = isError ? '#ef4444' : '#93a1c6';
  }

  function populateSelect(instances) {
    const select = document.getElementById(SELECT_ID);
    if (!select) return;

    const previousValue = state.selectedInstance;
    select.innerHTML = '';

    if (!instances.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = state.loading ? 'Carregando...' : 'Sem instancias';
      select.appendChild(option);
      select.disabled = true;
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecionar instancia';
    select.appendChild(placeholder);

    instances.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

    if (previousValue && instances.includes(previousValue)) {
      select.value = previousValue;
    } else if (instances.length === 1) {
      select.value = instances[0];
      saveSelectedInstance(instances[0]);
    } else {
      select.value = '';
      saveSelectedInstance('');
    }

    select.disabled = false;
  }

  function normalizeInstanceNames(payload) {
    const rows = Array.isArray(payload?.instances)
      ? payload.instances
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

    const names = rows
      .map((row) =>
        readString(
          row?.nome ??
            row?.Nome ??
          row?.InstanceName ??
            row?.instance_name ??
            row?.instanceName ??
            row?.name ??
            row?.instance ??
            row?.label ??
            row?.display_name
        )
      )
      .filter(Boolean);

    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  async function fetchInstances(force) {
    if (state.loading) return;
    if (!state.locationId) {
      state.instances = [];
      populateSelect([]);
      updateStatus('Subconta nao detectada.', true);
      return;
    }

    if (
      !force &&
      state.instances.length &&
      Date.now() - state.lastFetchAt < 20_000
    ) {
      return;
    }

    state.loading = true;
    populateSelect(state.instances);
    updateStatus('Carregando instancias...', false);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore abort error */
      }
    }, REQUEST_TIMEOUT_MS);

    try {
      const url = new URL(EDGE_INSTANCES_URL);
      url.searchParams.set('location_id', state.locationId);

      const response = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'x-wavoip-location-id': state.locationId
        }
      });

      const text = await response.text().catch(() => '');
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.ok) {
        const message =
          readString(payload?.error) ||
          `Falha ao buscar instancias (HTTP ${response.status}).`;
        throw new Error(message);
      }

      state.instances = normalizeInstanceNames(payload);
      state.lastFetchAt = Date.now();
      populateSelect(state.instances);

      if (!state.instances.length) {
        updateStatus('Nenhuma instancia encontrada para esta subconta.', true);
      } else {
        updateStatus(`${state.instances.length} instancia(s) disponivel(is).`, false);
      }
    } catch (error) {
      state.instances = [];
      const message =
        error?.name === 'AbortError'
          ? 'Timeout ao buscar instancias. Clique em R para tentar novamente.'
          : readString(error?.message || error) || 'Erro ao carregar.';
      updateStatus(message, true);
    } finally {
      clearTimeout(timeoutHandle);
      state.loading = false;
      populateSelect(state.instances);
    }
  }

  function createUi() {
    if (document.getElementById(WRAPPER_ID)) return;

    const host = getUiHost();
    if (!host) return;
    const isFloating = state.uiMode === 'floating';
    const isChannelHeader = state.uiMode === 'channel-header';

    const wrapper = document.createElement('div');
    wrapper.id = WRAPPER_ID;
    Object.assign(wrapper.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: isChannelHeader ? '4px' : '6px',
      marginLeft: isFloating || isChannelHeader ? '0' : '8px',
      padding: isChannelHeader ? '2px 8px' : '2px 6px',
      borderRadius: isChannelHeader ? '999px' : '8px',
      background: isFloating
        ? '#ffffff'
        : isChannelHeader
          ? 'linear-gradient(180deg,#f9fbff 0%,#f3f7ff 100%)'
          : 'rgba(15,23,42,0.06)',
      border: isFloating
        ? '1px solid #cbd5e1'
        : isChannelHeader
          ? '1px solid #dbe7ff'
          : 'none',
      boxShadow: isFloating ? '0 8px 20px rgba(15,23,42,0.2)' : 'none',
      maxWidth: isFloating ? '380px' : isChannelHeader ? '420px' : '420px'
    });

    const label = document.createElement('label');
    Object.assign(label.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      fontSize: '11px',
      color: isChannelHeader ? '#1e3a8a' : '#1f2937',
      fontWeight: isChannelHeader ? '600' : '500',
      whiteSpace: 'nowrap',
      userSelect: 'none'
    });

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = CHECKBOX_ID;
    checkbox.checked = !!state.enabled;
    checkbox.title = 'Ativar/desativar #switch automatico';
    checkbox.style.cursor = 'pointer';
    checkbox.style.accentColor = '#2563eb';
    checkbox.style.width = '14px';
    checkbox.style.height = '14px';

    const labelText = document.createElement('span');
    labelText.textContent = 'Switch';
    label.append(checkbox, labelText);

    const select = document.createElement('select');
    select.id = SELECT_ID;
    Object.assign(select.style, {
      height: isChannelHeader ? '24px' : '24px',
      minWidth: isChannelHeader ? '130px' : '150px',
      maxWidth: isChannelHeader ? '150px' : '170px',
      fontSize: '11px',
      borderRadius: '6px',
      border: isChannelHeader ? '1px solid #c7d7fe' : '1px solid #cbd5e1',
      padding: '0 6px',
      background: '#ffffff',
      color: '#0f172a'
    });

    const refreshButton = document.createElement('button');
    refreshButton.id = REFRESH_ID;
    refreshButton.type = 'button';
    refreshButton.title = 'Atualizar instancias';
    refreshButton.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>';
    Object.assign(refreshButton.style, {
      width: isChannelHeader ? '22px' : '24px',
      height: isChannelHeader ? '22px' : '24px',
      borderRadius: '6px',
      border: isChannelHeader ? '1px solid #c7d7fe' : '1px solid #cbd5e1',
      background: isChannelHeader ? '#eef4ff' : '#ffffff',
      color: '#1d4ed8',
      cursor: 'pointer',
      fontSize: '12px',
      lineHeight: '1',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center'
    });

    const status = document.createElement('span');
    status.id = STATUS_ID;
    Object.assign(status.style, {
      fontSize: '10px',
      color: '#93a1c6',
      whiteSpace: 'nowrap',
      maxWidth: '200px',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    });
    if (isChannelHeader) {
      status.style.display = 'none';
    }

    checkbox.addEventListener('change', () => {
      saveEnabled(checkbox.checked);
      updateStatus(
        state.enabled
          ? 'Switch ativo: mensagens serao prefixadas.'
          : 'Switch desativado.',
        false
      );
    });

    select.addEventListener('change', () => {
      saveSelectedInstance(select.value);
      if (state.selectedInstance) {
        updateStatus(`Instancia selecionada: ${state.selectedInstance}`, false);
      }
    });

    refreshButton.addEventListener('click', () => {
      fetchInstances(true);
    });

    wrapper.append(label, select, refreshButton, status);
    const sendButton = findSendButtonInScope(host);
    if (isChannelHeader) {
      host.appendChild(wrapper);
    } else if (!isFloating && sendButton && sendButton.parentElement) {
      sendButton.parentElement.insertBefore(wrapper, sendButton);
    } else if (host.firstChild) {
      host.insertBefore(wrapper, host.firstChild);
    } else {
      host.appendChild(wrapper);
    }

    populateSelect(state.instances);
  }

  function syncWrapperPlacement() {
    const wrapper = document.getElementById(WRAPPER_ID);
    if (!wrapper) return;

    const host = getUiHost();
    if (!host) {
      if (
        !ALLOW_FLOATING_FALLBACK &&
        wrapper.parentElement &&
        wrapper.parentElement.id === FLOATING_HOST_ID
      ) {
        wrapper.remove();
      }
      return;
    }
    const isFloating = state.uiMode === 'floating';
    const isChannelHeader = state.uiMode === 'channel-header';

    wrapper.style.marginLeft = isFloating || isChannelHeader ? '0' : '8px';
    wrapper.style.background = isFloating
      ? '#ffffff'
      : isChannelHeader
        ? 'linear-gradient(180deg,#f9fbff 0%,#f3f7ff 100%)'
        : 'rgba(15,23,42,0.06)';
    wrapper.style.border = isFloating
      ? '1px solid #cbd5e1'
      : isChannelHeader
        ? '1px solid #dbe7ff'
        : 'none';
    wrapper.style.boxShadow = isFloating ? '0 8px 20px rgba(15,23,42,0.2)' : 'none';
    wrapper.style.maxWidth = isFloating ? '380px' : '420px';
    wrapper.style.gap = isChannelHeader ? '4px' : '6px';
    wrapper.style.padding = isChannelHeader ? '2px 8px' : '2px 6px';
    wrapper.style.borderRadius = isChannelHeader ? '999px' : '8px';

    const status = wrapper.querySelector(`#${STATUS_ID}`);
    if (status instanceof HTMLElement) {
      status.style.display = isChannelHeader ? 'none' : 'inline';
    }

    const label = wrapper.querySelector('label');
    if (label instanceof HTMLElement) {
      label.style.color = isChannelHeader ? '#1e3a8a' : '#1f2937';
      label.style.fontWeight = isChannelHeader ? '600' : '500';
    }

    const select = wrapper.querySelector(`#${SELECT_ID}`);
    if (select instanceof HTMLSelectElement) {
      select.style.border = isChannelHeader ? '1px solid #c7d7fe' : '1px solid #cbd5e1';
    }

    const refresh = wrapper.querySelector(`#${REFRESH_ID}`);
    if (refresh instanceof HTMLButtonElement) {
      refresh.style.border = isChannelHeader ? '1px solid #c7d7fe' : '1px solid #cbd5e1';
      refresh.style.background = isChannelHeader ? '#eef4ff' : '#ffffff';
      refresh.style.color = '#1d4ed8';
    }

    const sendButton = findSendButtonInScope(host);
    if (isChannelHeader) {
      if (wrapper.parentElement !== host) host.appendChild(wrapper);
      return;
    }

    if (!isFloating && sendButton && sendButton.parentElement) {
      const parent = sendButton.parentElement;
      if (wrapper.parentElement !== parent || wrapper.nextSibling !== sendButton) {
        parent.insertBefore(wrapper, sendButton);
      }
      return;
    }

    if (wrapper.parentElement !== host) {
      if (host.firstChild) host.insertBefore(wrapper, host.firstChild);
      else host.appendChild(wrapper);
    }

    if (!ALLOW_FLOATING_FALLBACK) {
      const floatingHost = document.getElementById(FLOATING_HOST_ID);
      if (floatingHost && wrapper.parentElement !== floatingHost) {
        floatingHost.remove();
      }
    }
  }

  function syncUiWithState() {
    const checkbox = document.getElementById(CHECKBOX_ID);
    if (checkbox) checkbox.checked = !!state.enabled;

    const select = document.getElementById(SELECT_ID);
    if (select && state.selectedInstance && select.value !== state.selectedInstance) {
      select.value = state.selectedInstance;
    }
  }

  function prepareMessageForSend(preferredButton) {
    if (!state.enabled) return true;

    const input = findComposerInput(preferredButton);
    if (!input) return true;

    const rawMessage = getInputText(input);
    if (!rawMessage || !rawMessage.trim()) return true;

    const instance = readString(state.selectedInstance);
    if (!instance) {
      alert('Selecione a instancia de WhatsApp para usar o switch.');
      return false;
    }

    const finalMessage = buildSwitchMessage(rawMessage, instance);
    if (finalMessage !== rawMessage) {
      setInputText(input, finalMessage);
      log('Prefixo #switch aplicado', { instance });
    }

    return true;
  }

  function onDocumentClickCapture(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest('button, [role="button"]');
    if (!button || !isLikelySendButton(button)) return;

    const ok = prepareMessageForSend(button);
    if (!ok) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onDocumentKeydownCapture(event) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }

    const activeInput = resolveActiveInput();
    if (!activeInput) return;

    const ok = prepareMessageForSend();
    if (!ok) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function bindGlobalListenersOnce() {
    if (state.listenersBound) return;
    state.listenersBound = true;

    document.addEventListener('click', onDocumentClickCapture, true);
    document.addEventListener('keydown', onDocumentKeydownCapture, true);
  }

  function onLocationChanged() {
    const nextLocationId = getLocationId();
    if (nextLocationId === state.locationId) return false;

    state.locationId = nextLocationId;
    state.instances = [];
    state.lastFetchAt = 0;
    loadStateForCurrentLocation();
    syncUiWithState();
    fetchInstances(true);
    return true;
  }

  function ensureUiAndData() {
    createUi();
    syncWrapperPlacement();
    syncUiWithState();

    if (!document.getElementById(WRAPPER_ID)) return;
    if (!state.instances.length && !state.loading) {
      fetchInstances(false);
    }
  }

  function tick() {
    try {
      if (location.href !== state.lastHref) {
        state.lastHref = location.href;
        onLocationChanged();
      }

      if (!state.locationId) {
        onLocationChanged();
      }

      ensureUiAndData();
      bindGlobalListenersOnce();
    } catch (error) {
      log('tick error', error);
    }
  }

  onLocationChanged();
  tick();
  setInterval(tick, CHECK_INTERVAL_MS);

  window._zaptosSwitch = {
    state,
    fetchInstances: (force) => fetchInstances(!!force),
    prepareMessageForSend,
    getUiMode: () => state.uiMode,
    getUiHost
  };
})();
