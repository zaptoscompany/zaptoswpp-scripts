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
  const SHOW_STATUS_TEXT = false;
  const FLOATING_HOST_ID = 'zaptos-switch-floating-host';
  const CHANNEL_HEADER_HOST_ID = 'zaptos-switch-channel-host';
  const CHANNEL_ROW_SELECTOR =
    "div.flex.flex-row.py-1.items-center.justify-end.rounded-t-lg, div[class*='rounded-t-lg'][class*='py-1'], div[class*='rounded-t-lg'][class*='items-center'][class*='py-1']";
  const CHANNEL_LEFT_BLOCK_SELECTOR =
    "div.flex.gap-6.items-center.w-full.min-w-0.overflow-hidden, div.flex.gap-6.items-center.flex-1.min-w-0.overflow-hidden, div[class*='gap-6'][class*='items-center'][class*='min-w-0'][class*='overflow-hidden'][class*='w-full'], div[class*='gap-6'][class*='items-center'][class*='min-w-0'][class*='overflow-hidden'][class*='flex-1']";
  const CHECK_INTERVAL_MS = 1200;
  const REQUEST_TIMEOUT_MS = 12000;
  const STORAGE_PREFIX = 'zaptos_wpp_switch';
  const CHANNEL_LABEL_KEYWORDS = [
    'whatsapp qr',
    'whats app qr',
    'whatsapp',
    'instagram',
    'ig',
    'pagina',
    'pagina:',
    'page',
    'page:',
    'messenger',
    'facebook',
    'sms',
    'comentario interno',
    'comentário interno',
    'internal comment'
  ];
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
    replayLockUntil: 0,
    statusFlashTimer: 0,
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

  function normalizeLabelText(text) {
    return readString(text)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
  }

  function isKnownChannelLabelText(text) {
    const normalized = normalizeLabelText(text);
    return CHANNEL_LABEL_KEYWORDS.includes(normalized);
  }

  function isLikelyChannelLabelText(text) {
    const normalized = normalizeLabelText(text);
    if (!normalized) return false;
    if (isKnownChannelLabelText(normalized)) return true;

    // Fallback defensivo: evita usar spans aleatorios do sistema.
    if (normalized.length > 40) return false;
    return /^[a-z0-9 :\-\u00c0-\u017f]+$/i.test(normalized);
  }

  function findChannelLabelInLeftBlock(leftBlock) {
    if (!leftBlock) return null;

    const labels = Array.from(
      leftBlock.querySelectorAll('span.text-sm.font-medium.text-gray-700, span')
    ).filter((el) => isVisibleElement(el));
    if (!labels.length) return null;

    const preferred = labels.find((label) =>
      isKnownChannelLabelText(label.textContent)
    );
    if (preferred) return preferred;

    return labels.find((label) => isLikelyChannelLabelText(label.textContent)) || null;
  }

  function findComposerChannelLabel() {
    const input = pickMostLikelyInput(getInputCandidates(document));
    if (input) {
      const inputRect = input.getBoundingClientRect();
      const scopedBlocks = Array.from(document.querySelectorAll(CHANNEL_LEFT_BLOCK_SELECTOR))
        .filter((el) => isVisibleElement(el))
        .map((leftBlock) => {
          const label = findChannelLabelInLeftBlock(leftBlock);
          if (!label) return null;

          const labelText = normalizeLabelText(label.textContent);
          const rect = leftBlock.getBoundingClientRect();
          const verticalDelta = Math.abs(rect.bottom - inputRect.top);
          if (verticalDelta > 380) return null;

          const overlapX = Math.max(
            0,
            Math.min(rect.right, inputRect.right) - Math.max(rect.left, inputRect.left)
          );
          const overlapRatio =
            overlapX / Math.max(1, Math.min(rect.width || 1, inputRect.width || 1));

          let score = 0;
          if (rect.bottom <= inputRect.top + 120) score += 140;
          if (rect.bottom >= inputRect.top - 280) score += 110;
          if (rect.top <= inputRect.top + 40) score += 40;
          score += Math.max(0, 140 - verticalDelta);
          score += Math.round(overlapRatio * 100);
          if (labelText === 'sms') score += 80;
          if (isKnownChannelLabelText(labelText)) score += 40;

          return { label, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      if (scopedBlocks.length && scopedBlocks[0].score >= 140) {
        return scopedBlocks[0].label;
      }
    }

    const rows = Array.from(document.querySelectorAll(CHANNEL_ROW_SELECTOR))
      .filter((el) => isVisibleElement(el))
      .sort(
        (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top
      );

    for (const row of rows) {
      const leftBlock =
        row.querySelector(CHANNEL_LEFT_BLOCK_SELECTOR) ||
        row.querySelector(
          "div[class*='gap-6'][class*='items-center'][class*='min-w-0'][class*='overflow-hidden']"
        );
      if (!leftBlock) continue;

      const label = findChannelLabelInLeftBlock(leftBlock);
      if (label) return label;
    }

    const fallbackBlocks = Array.from(
      document.querySelectorAll(CHANNEL_LEFT_BLOCK_SELECTOR)
    )
      .filter((el) => isVisibleElement(el))
      .sort(
        (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top
      );

    for (const leftBlock of fallbackBlocks) {
      const label = findChannelLabelInLeftBlock(leftBlock);
      if (label) return label;
    }

    return null;
  }

  function getChannelHeaderHost() {
    const label = findComposerChannelLabel();
    if (!label) return null;

    const row = label.closest(CHANNEL_ROW_SELECTOR);
    const leftBlock =
      label.closest(CHANNEL_LEFT_BLOCK_SELECTOR) ||
      row?.querySelector(CHANNEL_LEFT_BLOCK_SELECTOR) ||
      row?.querySelector(
        "div[class*='gap-6'][class*='items-center'][class*='min-w-0'][class*='overflow-hidden']"
      );

    if (!leftBlock) return null;

    let host = document.getElementById(CHANNEL_HEADER_HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = CHANNEL_HEADER_HOST_ID;
      Object.assign(host.style, {
        display: 'inline-flex',
        alignItems: 'center',
        marginLeft: '8px',
        minWidth: '0',
        flexShrink: '0'
      });
    }

    const titleContainer = label.closest('div');
    const shouldBeAfterTitle =
      titleContainer &&
      titleContainer.parentElement === leftBlock &&
      host.previousSibling !== titleContainer;

    if (host.parentElement !== leftBlock || shouldBeAfterTitle) {
      if (titleContainer && titleContainer.parentElement === leftBlock) {
        leftBlock.insertBefore(host, titleContainer.nextSibling);
      } else {
        leftBlock.appendChild(host);
      }
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
      scope.querySelectorAll(
        "#conv-send-button-simple, [id^='conv-send-button'], button, [role='button'], [data-testid*='send']"
      )
    ).filter((el) => isVisibleElement(el) && !el.closest(`#${WRAPPER_ID}`));

    const candidates = buttons.filter((btn) => isLikelySendButton(btn));
    if (!candidates.length) return null;

    const scoreButton = (btn) => {
      const id = readString(btn.id).toLowerCase();
      const aria = readString(btn.getAttribute('aria-label')).toLowerCase();
      const title = readString(btn.getAttribute('title')).toLowerCase();
      const text = readString(btn.textContent).toLowerCase();
      const dataTestId = readString(btn.getAttribute('data-testid')).toLowerCase();
      const rect = btn.getBoundingClientRect();

      let score = 0;
      if (id === 'conv-send-button-simple') score += 1200;
      if (id.startsWith('conv-send-button')) score += 1000;
      if (/send|enviar/.test(aria)) score += 300;
      if (/send|enviar/.test(title)) score += 200;
      if (/send|enviar/.test(text)) score += 120;
      if (/send/.test(dataTestId)) score += 100;
      if (rect.bottom >= window.innerHeight - 240) score += 80;
      if (rect.right >= window.innerWidth - 280) score += 80;
      score += Math.round(rect.right / 10);
      score += Math.round(rect.bottom / 20);

      return score;
    };

    return [...candidates].sort((a, b) => scoreButton(b) - scoreButton(a))[0] || null;
  }

  function findClearButtonInScope(scope) {
    if (!scope) return null;
    const buttons = Array.from(scope.querySelectorAll('button')).filter((el) =>
      isVisibleElement(el)
    );
    return (
      buttons.find((btn) => {
        const text = readString(btn.textContent).toLowerCase();
        return text === 'clear' || text === 'limpar';
      }) || null
    );
  }

  function findVoiceRecordAnchor(scope) {
    if (!scope) return null;

    const local =
      scope.querySelector('#zaptos-rec-wrapper') ||
      scope.querySelector('#zaptos-rec-btn');
    if (local) return local.id === 'zaptos-rec-btn' ? local.parentElement : local;

    const global =
      document.getElementById('zaptos-rec-wrapper') ||
      document.getElementById('zaptos-rec-btn');
    if (!global) return null;

    const anchor = global.id === 'zaptos-rec-btn' ? global.parentElement : global;
    if (!anchor) return null;
    if (scope === anchor || scope.contains(anchor) || anchor.parentElement === scope) {
      return anchor;
    }

    return null;
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

  function isTemplatesContext() {
    const path = readString(location.pathname).toLowerCase();
    return path.includes('/conversations/templates');
  }

  function teardownSwitchUi() {
    const wrapper = document.getElementById(WRAPPER_ID);
    if (wrapper) wrapper.remove();

    const channelHost = document.getElementById(CHANNEL_HEADER_HOST_ID);
    if (channelHost) channelHost.remove();

    const floatingHost = document.getElementById(FLOATING_HOST_ID);
    if (floatingHost) floatingHost.remove();
  }

  function getUiHost() {
    if (isTemplatesContext()) {
      state.uiMode = 'inline';
      return null;
    }

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

  function placeSwitchWrapper(wrapper, host) {
    if (!wrapper || !host) return;

    const isFloating = state.uiMode === 'floating';
    const isChannelHeader = state.uiMode === 'channel-header';

    if (isChannelHeader) {
      if (wrapper.parentElement !== host) host.appendChild(wrapper);
      return;
    }

    if (!isFloating) {
      const voiceAnchor = findVoiceRecordAnchor(host);
      if (voiceAnchor && voiceAnchor.parentElement) {
        const parent = voiceAnchor.parentElement;
        if (wrapper.parentElement !== parent || wrapper.nextSibling !== voiceAnchor) {
          parent.insertBefore(wrapper, voiceAnchor);
        }
        return;
      }

      const clearButton = findClearButtonInScope(host);
      if (clearButton && clearButton.parentElement) {
        const parent = clearButton.parentElement;
        if (wrapper.parentElement !== parent || wrapper.nextSibling !== clearButton) {
          parent.insertBefore(wrapper, clearButton);
        }
        return;
      }

      const sendButton = findSendButtonInScope(host);
      if (sendButton && sendButton.parentElement) {
        const parent = sendButton.parentElement;
        if (wrapper.parentElement !== parent || wrapper.nextSibling !== sendButton) {
          parent.insertBefore(wrapper, sendButton);
        }
        return;
      }
    }

    if (wrapper.parentElement !== host) {
      if (host.firstChild) host.insertBefore(wrapper, host.firstChild);
      else host.appendChild(wrapper);
    }
  }

  function getInputCandidates(root) {
    const scope = root || document;
    const explicitComposerTextarea = document.getElementById(
      'conv-composer-textarea-input'
    );

    const isMessagePlaceholder = (value) => {
      const normalized = readString(value).toLowerCase();
      if (!normalized) return true;
      return normalized.includes('mensagem') || normalized.includes('message');
    };

    const isComposerMessageInput = (input) => {
      if (!input) return false;
      if (!isVisibleElement(input)) return false;
      if (input.closest(`#${WRAPPER_ID}`)) return false;
      if (input.id === 'conv-composer-textarea-input') return true;

      if (input instanceof HTMLTextAreaElement) {
        const placeholderOk =
          isMessagePlaceholder(input.getAttribute('placeholder')) ||
          isMessagePlaceholder(input.getAttribute('aria-label'));
        if (!placeholderOk) return false;
      }

      let node = input.parentElement;
      for (let i = 0; i < 12 && node; i += 1) {
        const explicitSend =
          node.querySelector('#conv-send-button-simple') ||
          node.querySelector("[id^='conv-send-button']");
        if (explicitSend && isVisibleElement(explicitSend)) {
          return true;
        }

        const sendButton = findSendButtonInScope(node);
        if (sendButton) return true;

        node = node.parentElement;
      }

      return false;
    };

    const textareaCandidates = Array.from(
      scope.querySelectorAll(
        "textarea[placeholder*='mensagem'], textarea[placeholder*='message'], textarea"
      )
    ).filter(
      (el) =>
        isVisibleElement(el) &&
        !el.disabled &&
        !el.readOnly &&
        isComposerMessageInput(el)
    );

    const editableCandidates = Array.from(
      scope.querySelectorAll(
        "div[contenteditable='true'][role='textbox'], div[contenteditable='true']"
      )
    ).filter((el) => isVisibleElement(el) && isComposerMessageInput(el));

    const explicitCandidates =
      explicitComposerTextarea instanceof HTMLTextAreaElement &&
      isVisibleElement(explicitComposerTextarea) &&
      !explicitComposerTextarea.disabled &&
      !explicitComposerTextarea.readOnly
        ? [explicitComposerTextarea]
        : [];

    return [...explicitCandidates, ...textareaCandidates, ...editableCandidates];
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
      if (candidate) {
        return candidate;
      }
      node = node.parentElement;
    }
    return null;
  }

  function resolveActiveInput() {
    const active = document.activeElement;
    if (!active) return null;
    const candidates = getInputCandidates(document);

    if (active instanceof HTMLTextAreaElement) {
      if (
        isVisibleElement(active) &&
        !active.disabled &&
        !active.readOnly &&
        candidates.includes(active)
      ) {
        return active;
      }
    }

    if (active instanceof HTMLElement) {
      const editable = active.closest("div[contenteditable='true']");
      if (editable && isVisibleElement(editable) && candidates.includes(editable)) {
        return editable;
      }
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

  function syncStateFromUiControls() {
    const checkbox = document.getElementById(CHECKBOX_ID);
    if (checkbox instanceof HTMLInputElement) {
      state.enabled = !!checkbox.checked;
    }

    const select = document.getElementById(SELECT_ID);
    if (select instanceof HTMLSelectElement) {
      state.selectedInstance = readString(select.value || state.selectedInstance);
    }
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
    const hasContent = !!normalized.trim();

    if (!hasContent) {
      return prefix;
    }

    if (/^\s*#switch:/i.test(normalized)) {
      const replaced = normalized.replace(/^\s*#switch:[^\n]*\n?/i, `${prefix}\n`);
      return replaced.trim() === prefix ? prefix : replaced;
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
    const denyHints = `${aria} ${title} ${text} ${dataTestId} ${id} ${className}`;

    if (
      /clear|limpar|delete|trash|tag|emoji|attach|anexo|microfone|record|dropdown|option|options|arrow|seta|cancelar|cancel|salvar|save/.test(
        denyHints
      )
    ) {
      return false;
    }

    if (id === 'conv-send-button-simple' || id.startsWith('conv-send-button')) {
      return true;
    }
    // Evita capturar submits de outros formulários (ex.: Salvar/Cancelar em painéis laterais).
    if (type === 'submit' && !/send|enviar/.test(denyHints)) return false;
    if (/send|enviar/.test(aria)) return true;
    if (/send|enviar/.test(title)) return true;
    if (/send|enviar/.test(text)) return true;
    if (/send/.test(dataTestId)) return true;
    if (id.includes('send')) return true;

    return false;
  }

  function hasPaperPlanePath(node) {
    if (!(node instanceof Element)) return false;

    const path =
      node.matches('path')
        ? node
        : node.querySelector('path');

    if (!(path instanceof SVGPathElement)) return false;

    const d = readString(path.getAttribute('d'));
    if (!d) return false;

    // Icone de envio (paper plane) usado no composer do GHL.
    return d.includes('M10.5 13.5L21 3') || d.includes('10.627 13.828');
  }

  function findInteractiveAncestor(start, stopAt) {
    let node = start instanceof Element ? start : null;
    const limit = stopAt instanceof Element ? stopAt : null;

    for (let i = 0; i < 12 && node; i += 1) {
      if (node.closest(`#${WRAPPER_ID}`)) return null;

      const role = readString(node.getAttribute('role')).toLowerCase();
      const id = readString(node.id).toLowerCase();
      const className = readString(node.className).toLowerCase();
      const hasOnclick = node.hasAttribute('onclick');
      const rawTabIndex = node.getAttribute('tabindex');
      const tabIndex = rawTabIndex == null ? null : Number(rawTabIndex);
      const styleCursor =
        node instanceof HTMLElement ? readString(node.style?.cursor).toLowerCase() : '';

      if (node instanceof HTMLButtonElement) return node;
      if (role === 'button') return node;
      if (id.includes('send')) return node;
      if (className.includes('send')) return node;
      if (className.includes('cursor-pointer')) return node;
      if (hasOnclick) return node;
      if (tabIndex != null && !Number.isNaN(tabIndex) && tabIndex >= 0) return node;
      if (styleCursor === 'pointer') return node;

      if (limit && node === limit) break;
      node = node.parentElement;
    }

    return null;
  }

  function isTargetInsideElement(target, element) {
    if (!(target instanceof Element)) return false;
    if (!(element instanceof Element)) return false;
    return target === element || element.contains(target) || target.contains(element);
  }

  function isLikelyComposerSendButton(button) {
    if (!button || !(button instanceof Element)) return false;
    if (button.closest(`#${WRAPPER_ID}`)) return false;
    const aria = readString(button.getAttribute('aria-label')).toLowerCase();
    const title = readString(button.getAttribute('title')).toLowerCase();
    const text = readString(button.textContent).toLowerCase();
    const dataTestId = readString(button.getAttribute('data-testid')).toLowerCase();
    const id = readString(button.id).toLowerCase();
    const className = readString(button.className).toLowerCase();
    if (/dropdown|option|options|arrow|seta/.test(`${id} ${className}`)) {
      return false;
    }
    const hasSendSemantics =
      id === 'conv-send-button-simple' ||
      id.startsWith('conv-send-button') ||
      /send|enviar/.test(`${aria} ${title} ${text} ${dataTestId} ${id} ${className}`) ||
      hasPaperPlanePath(button);
    if (!hasSendSemantics) return false;

    const rect = button.getBoundingClientRect();
    if (rect.width < 18 || rect.height < 18) return false;
    if (rect.bottom < window.innerHeight - 220) return false;
    if (rect.right < window.innerWidth - 260) return false;

    const composer = findComposerContainerFromInput();
    if (composer && !composer.contains(button)) return false;

    let node = button.parentElement;
    for (let i = 0; i < 8 && node; i += 1) {
      const buttons = Array.from(
        node.querySelectorAll('button, [role="button"]')
      ).filter((el) => isVisibleElement(el) && !el.closest(`#${WRAPPER_ID}`));

      if (buttons.length >= 2) {
        const sorted = [...buttons].sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.right - rb.right;
        });

        const candidateIndex = sorted.findIndex(
          (el) => el === button || el.contains(button) || button.contains(el)
        );

        if (candidateIndex >= Math.max(0, sorted.length - 2)) {
          return true;
        }
      }

      node = node.parentElement;
    }

    return false;
  }

  function resolveSendButtonFromEventTarget(target) {
    if (!(target instanceof Element)) return null;
    if (target.closest(`#${WRAPPER_ID}`)) return null;

    const composer = findComposerContainerFromInput();
    if (!composer) return null;

    const actionBar = findComposerActionBar(composer);
    const searchScope = actionBar || composer;
    const canonicalSendButton = findSendButtonInScope(searchScope);
    if (!canonicalSendButton) return null;
    if (actionBar && !actionBar.contains(canonicalSendButton)) return null;

    if (isTargetInsideElement(target, canonicalSendButton)) {
      return canonicalSendButton;
    }

    // Clique direto no SVG/PATH do aviao de envio.
    const svgOrPath = target.closest('svg, path');
    if (
      svgOrPath &&
      hasPaperPlanePath(svgOrPath) &&
      isTargetInsideElement(svgOrPath, canonicalSendButton)
    ) {
      const interactive = findInteractiveAncestor(svgOrPath, actionBar || composer);
      if (
        interactive &&
        isTargetInsideElement(interactive, canonicalSendButton) &&
        (isLikelySendButton(interactive) || isLikelyComposerSendButton(interactive))
      ) {
        return canonicalSendButton;
      }
    }

    return null;
  }

  function replaySend(button) {
    state.replayLockUntil = Date.now() + 800;

    setTimeout(() => {
      try {
        let target = null;
        if (button instanceof Element && document.contains(button)) {
          target = button;
        } else {
          const composer = findComposerContainerFromInput();
          target = findSendButtonInScope(composer) || findSendButtonInScope(document);
        }

        if (target instanceof HTMLElement) {
          target.click();
        }
      } catch (error) {
        log('Falha no replay do envio', error);
      }
    }, 35);
  }

  function updateStatus(message, isError) {
    if (state.statusFlashTimer) {
      clearTimeout(state.statusFlashTimer);
      state.statusFlashTimer = 0;
    }

    const statusEl = document.getElementById(STATUS_ID);
    if (!statusEl) return;
    statusEl.textContent = readString(message);
    statusEl.style.color = isError ? '#ef4444' : '#93a1c6';
  }

  function getDefaultStatus() {
    if (!state.locationId) {
      return { message: 'Subconta nao detectada.', isError: true };
    }
    if (state.loading) {
      return { message: 'Carregando instancias...', isError: false };
    }
    if (!state.instances.length) {
      return {
        message: 'Nenhuma instancia encontrada para esta subconta.',
        isError: true
      };
    }
    return {
      message: `${state.instances.length} instancia(s) disponivel(is).`,
      isError: false
    };
  }

  function flashStatus(message, isError, durationMs) {
    const timeout = Number(durationMs) > 0 ? Number(durationMs) : 1600;
    updateStatus(message, isError);

    state.statusFlashTimer = setTimeout(() => {
      state.statusFlashTimer = 0;
      const fallback = getDefaultStatus();
      updateStatus(fallback.message, fallback.isError);
    }, timeout);
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
    if (isTemplatesContext()) return;

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
    if (!SHOW_STATUS_TEXT || isChannelHeader) {
      status.style.display = 'none';
    }

    checkbox.addEventListener('change', () => {
      saveEnabled(checkbox.checked);
      flashStatus(
        state.enabled
          ? 'Switch ativo: mensagens serao prefixadas.'
          : 'Switch desativado.',
        false,
        1800
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

    wrapper.append(label, select, refreshButton);
    if (SHOW_STATUS_TEXT) {
      wrapper.append(status);
    }
    placeSwitchWrapper(wrapper, host);

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
      status.style.display = !SHOW_STATUS_TEXT || isChannelHeader ? 'none' : 'inline';
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

    placeSwitchWrapper(wrapper, host);

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
    if (isTemplatesContext()) return true;

    syncStateFromUiControls();
    if (!state.enabled) return true;

    const input = findComposerInput(preferredButton);
    if (!input) {
      alert('Nao foi possivel inserir o comando #switch antes do envio.');
      return false;
    }

    const rawMessage = getInputText(input);

    const instance = readString(state.selectedInstance);
    if (!instance) {
      alert('Selecione a instancia de WhatsApp para usar o switch.');
      return false;
    }

    const finalMessage = buildSwitchMessage(rawMessage, instance);
    if (finalMessage !== rawMessage) {
      setInputText(input, finalMessage);
      log('Prefixo #switch aplicado', { instance });
      return { ok: true, changed: true };
    }

    return { ok: true, changed: false };
  }

  function onDocumentClickCapture(event) {
    if (Date.now() < state.replayLockUntil) return;
    if (isTemplatesContext()) return;
    if (event.target instanceof Element && event.target.closest(`#${WRAPPER_ID}`)) return;

    const button = resolveSendButtonFromEventTarget(event.target);
    if (!button) return;

    const result = prepareMessageForSend(button);
    if (!result || result.ok === false) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (result.changed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      replaySend(button);
    }
  }

  function onDocumentPointerDownCapture(event) {
    if (Date.now() < state.replayLockUntil) return;
    if (isTemplatesContext()) return;
    if (event.target instanceof Element && event.target.closest(`#${WRAPPER_ID}`)) return;

    const button = resolveSendButtonFromEventTarget(event.target);
    if (!button) return;

    const result = prepareMessageForSend(button);
    if (!result || result.ok === false) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (result.changed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      replaySend(button);
    }
  }

  function onDocumentKeydownCapture(event) {
    if (Date.now() < state.replayLockUntil) return;
    if (isTemplatesContext()) return;

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
    if (activeInput instanceof Element && activeInput.closest(`#${WRAPPER_ID}`)) return;

    const result = prepareMessageForSend();
    if (!result || result.ok === false) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (result.changed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      replaySend();
    }
  }

  function onDocumentSubmitCapture(event) {
    if (Date.now() < state.replayLockUntil) return;
    if (isTemplatesContext()) return;

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const composerInput = pickMostLikelyInput(getInputCandidates(form));
    if (!composerInput) return;

    const sendButtonInForm = findSendButtonInScope(form);
    if (!sendButtonInForm) return;

    const result = prepareMessageForSend();
    if (!result || result.ok === false) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (result.changed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      replaySend();
    }
  }

  function bindGlobalListenersOnce() {
    if (state.listenersBound) return;
    state.listenersBound = true;

    document.addEventListener('pointerdown', onDocumentPointerDownCapture, true);
    document.addEventListener('click', onDocumentClickCapture, true);
    document.addEventListener('keydown', onDocumentKeydownCapture, true);
    document.addEventListener('submit', onDocumentSubmitCapture, true);
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
    if (isTemplatesContext()) {
      teardownSwitchUi();
      return;
    }

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
