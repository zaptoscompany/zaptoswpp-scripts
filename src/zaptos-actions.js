/*!
 * Zaptos Message Actions for GHL
 * Injeta opcoes de acao no menu de mensagem.
 */
(function () {
  if (window.__ZAPTOS_MESSAGE_ACTIONS_V1__) return;
  window.__ZAPTOS_MESSAGE_ACTIONS_V1__ = true;

  const DEBUG = false;
  const DETAILS_ACTION_ID = 'conv-message-reply-action-details';
  const MENU_ACTION_CLASS =
    'flex items-center gap-1 px-2 py-1 hover:bg-gray-50 cursor-pointer text-sm text-gray-700';
  const CHECK_INTERVAL_MS = 1000;
  const CONTEXT_TTL_MS = 5000;
  const MENU_MARKER_ATTR = 'data-zaptos-actions-injected';
  const ACTION_ITEM_SELECTOR = '[data-zaptos-action-item]';
  const UI_STYLE_ID = 'zaptos-actions-ui-style';
  const TOAST_HOST_ID = 'zaptos-actions-toast-host';

  const state = {
    lastPointerTarget: null,
    lastPointerAt: 0,
    lastLikelyMenuTrigger: null,
    lastLikelyMenuTriggerAt: 0,
    lastContext: null,
    lastHref: location.href
  };
  const uiState = {
    styleReady: false
  };

  const menuContextCache = new WeakMap();

  const commandBuilders = Object.assign(
    {
      react: (messageId, emoji) => `#reactmessage:${messageId}\n${emoji}`,
      edit: (messageId, text) => `#editmessage:${messageId}\n${text}`,
      delete: (messageId) => `#delmessage:${messageId}`
    },
    window.__ZAPTOS_ACTIONS_COMMANDS__ || {}
  );
  const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🔥'];

  const TOKEN_REGEX = /\b[A-Za-z0-9][A-Za-z0-9_-]{7,80}\b/g;
  const STOP_TOKENS = new Set([
    'message',
    'messages',
    'mensagem',
    'detalhes',
    'details',
    'action',
    'actions',
    'reply',
    'conversation',
    'contact',
    'whatsapp',
    'button',
    'cursor',
    'pointer',
    'false',
    'true',
    'undefined',
    'null',
    'data',
    'class',
    'style',
    'hover',
    'gray',
    'text',
    'font',
    'normal',
    'leading',
    'items',
    'center',
    'flex'
  ]);

  const log = (...args) => {
    if (DEBUG) console.log('[ZaptosActions]', ...args);
  };

  function readString(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  function isVisibleElement(el) {
    return !!(el && el.offsetParent !== null);
  }

  function normalizeWhitespace(text) {
    return readString(text).replace(/\s+/g, ' ');
  }

  function normalizeMessagePayload(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
  }

  function ensureUiStyles() {
    if (uiState.styleReady) return;
    if (document.getElementById(UI_STYLE_ID)) {
      uiState.styleReady = true;
      return;
    }

    const style = document.createElement('style');
    style.id = UI_STYLE_ID;
    style.textContent = `
      .za-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        background: rgba(15, 23, 42, 0.42);
        backdrop-filter: blur(2px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .za-modal {
        width: min(460px, calc(100vw - 24px));
        max-height: min(85vh, 720px);
        overflow: auto;
        border-radius: 14px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.28);
        color: #0f172a;
        font-family: Inter, "Segoe UI", Tahoma, sans-serif;
      }
      .za-modal-header {
        padding: 14px 16px 8px 16px;
      }
      .za-modal-title {
        margin: 0;
        font-size: 16px;
        line-height: 1.25;
        font-weight: 700;
        color: #0f172a;
      }
      .za-modal-subtitle {
        margin: 8px 0 0 0;
        font-size: 13px;
        line-height: 1.45;
        color: #475569;
        white-space: pre-wrap;
      }
      .za-modal-body {
        padding: 6px 16px 0 16px;
      }
      .za-label {
        display: block;
        margin-bottom: 8px;
        font-size: 12px;
        color: #334155;
        font-weight: 600;
      }
      .za-input, .za-textarea {
        width: 100%;
        border-radius: 10px;
        border: 1px solid #cbd5e1;
        padding: 10px 12px;
        font-size: 14px;
        color: #0f172a;
        background: #f8fafc;
        outline: none;
      }
      .za-input:focus, .za-textarea:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
        background: #ffffff;
      }
      .za-textarea {
        min-height: 110px;
        resize: vertical;
      }
      .za-emoji-grid {
        display: grid;
        grid-template-columns: repeat(8, minmax(0, 1fr));
        gap: 8px;
        margin: 6px 0 12px 0;
      }
      .za-emoji-btn {
        border: 1px solid #dbe2ef;
        border-radius: 10px;
        height: 38px;
        background: #f8fafc;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
      }
      .za-emoji-btn:hover {
        border-color: #93c5fd;
        background: #eff6ff;
      }
      .za-modal-footer {
        padding: 14px 16px 16px 16px;
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .za-btn {
        border-radius: 10px;
        border: 1px solid #cbd5e1;
        min-height: 36px;
        padding: 0 14px;
        font-size: 13px;
        font-weight: 600;
        background: #ffffff;
        color: #334155;
        cursor: pointer;
      }
      .za-btn:hover {
        background: #f8fafc;
      }
      .za-btn.primary {
        border-color: #2563eb;
        background: #2563eb;
        color: #ffffff;
      }
      .za-btn.primary:hover {
        border-color: #1d4ed8;
        background: #1d4ed8;
      }
      .za-btn.danger {
        border-color: #dc2626;
        background: #dc2626;
        color: #ffffff;
      }
      .za-btn.danger:hover {
        border-color: #b91c1c;
        background: #b91c1c;
      }
      .za-toast-host {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483001;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: min(92vw, 360px);
      }
      .za-toast {
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 13px;
        line-height: 1.35;
        color: #0f172a;
        border: 1px solid #dbe2ef;
        background: #ffffff;
        box-shadow: 0 8px 20px rgba(15, 23, 42, 0.15);
        transform: translateY(6px);
        opacity: 0;
        transition: all 0.16s ease;
      }
      .za-toast.show {
        transform: translateY(0);
        opacity: 1;
      }
      .za-toast.error {
        border-color: #fecaca;
        background: #fef2f2;
        color: #991b1b;
      }
      .za-toast.success {
        border-color: #bbf7d0;
        background: #f0fdf4;
        color: #166534;
      }
    `;
    document.head.appendChild(style);
    uiState.styleReady = true;
  }

  function getToastHost() {
    ensureUiStyles();
    let host = document.getElementById(TOAST_HOST_ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = TOAST_HOST_ID;
    host.className = 'za-toast-host';
    document.body.appendChild(host);
    return host;
  }

  function showToast(message, type, durationMs) {
    const text = readString(message);
    if (!text) return;
    const host = getToastHost();
    const toast = document.createElement('div');
    toast.className = `za-toast ${readString(type)}`;
    toast.textContent = text;
    host.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const lifetime = Number(durationMs) > 0 ? Number(durationMs) : 2300;
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 180);
    }, lifetime);
  }

  function createDialogFrame(title, subtitle) {
    ensureUiStyles();

    const overlay = document.createElement('div');
    overlay.className = 'za-overlay';

    const card = document.createElement('div');
    card.className = 'za-modal';
    overlay.appendChild(card);

    const header = document.createElement('div');
    header.className = 'za-modal-header';
    card.appendChild(header);

    const titleEl = document.createElement('h3');
    titleEl.className = 'za-modal-title';
    titleEl.textContent = readString(title) || 'Acoes da mensagem';
    header.appendChild(titleEl);

    if (readString(subtitle)) {
      const subtitleEl = document.createElement('p');
      subtitleEl.className = 'za-modal-subtitle';
      subtitleEl.textContent = readString(subtitle);
      header.appendChild(subtitleEl);
    }

    const body = document.createElement('div');
    body.className = 'za-modal-body';
    card.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'za-modal-footer';
    card.appendChild(footer);

    return { overlay, card, body, footer };
  }

  function showModernConfirm({ title, message, confirmText, cancelText, danger }) {
    return new Promise((resolve) => {
      const frame = createDialogFrame(title || 'Confirmacao', message || '');
      const overlay = frame.overlay;
      const footer = frame.footer;

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
        resolve(!!result);
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(false);
        }
      };

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'za-btn';
      cancelBtn.textContent = readString(cancelText) || 'Cancelar';
      cancelBtn.addEventListener('click', () => cleanup(false));

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = `za-btn ${danger ? 'danger' : 'primary'}`;
      confirmBtn.textContent = readString(confirmText) || 'Confirmar';
      confirmBtn.addEventListener('click', () => cleanup(true));

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) cleanup(false);
      });

      footer.append(cancelBtn, confirmBtn);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKeydown, true);
      confirmBtn.focus();
    });
  }

  function showModernPrompt({
    title,
    subtitle,
    label,
    defaultValue,
    placeholder,
    multiline,
    confirmText,
    cancelText
  }) {
    return new Promise((resolve) => {
      const frame = createDialogFrame(title || 'Informacao', subtitle || '');
      const overlay = frame.overlay;
      const body = frame.body;
      const footer = frame.footer;
      const useMultiline = multiline === true;

      const labelEl = document.createElement('label');
      labelEl.className = 'za-label';
      labelEl.textContent = readString(label) || '';
      body.appendChild(labelEl);

      const field = useMultiline
        ? document.createElement('textarea')
        : document.createElement('input');
      field.className = useMultiline ? 'za-textarea' : 'za-input';
      if (!useMultiline) field.type = 'text';
      field.placeholder = readString(placeholder);
      field.value = String(defaultValue == null ? '' : defaultValue);
      body.appendChild(field);

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
        resolve(result);
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(null);
          return;
        }
        if (!useMultiline && event.key === 'Enter') {
          event.preventDefault();
          cleanup(field.value);
          return;
        }
        if (useMultiline && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          cleanup(field.value);
        }
      };

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'za-btn';
      cancelBtn.textContent = readString(cancelText) || 'Cancelar';
      cancelBtn.addEventListener('click', () => cleanup(null));

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'za-btn primary';
      confirmBtn.textContent = readString(confirmText) || 'Salvar';
      confirmBtn.addEventListener('click', () => cleanup(field.value));

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) cleanup(null);
      });

      footer.append(cancelBtn, confirmBtn);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKeydown, true);
      field.focus();
      if (!useMultiline) field.select();
    });
  }

  function showEmojiPickerDialog(options) {
    return new Promise((resolve) => {
      const frame = createDialogFrame(
        'Reagir a mensagem',
        'Escolha um emoji abaixo ou digite um emoji personalizado.'
      );
      const overlay = frame.overlay;
      const body = frame.body;
      const footer = frame.footer;
      const emojis = Array.isArray(options) ? options : [];

      const grid = document.createElement('div');
      grid.className = 'za-emoji-grid';
      body.appendChild(grid);

      const customLabel = document.createElement('label');
      customLabel.className = 'za-label';
      customLabel.textContent = 'Emoji personalizado';
      body.appendChild(customLabel);

      const customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.className = 'za-input';
      customInput.placeholder = 'Ex.: 👍';
      body.appendChild(customInput);

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
        resolve(result);
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(null);
          return;
        }
        if (event.key === 'Enter' && document.activeElement === customInput) {
          event.preventDefault();
          cleanup(customInput.value);
        }
      };

      emojis.forEach((emoji) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'za-emoji-btn';
        btn.textContent = emoji;
        btn.addEventListener('click', () => cleanup(emoji));
        grid.appendChild(btn);
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'za-btn';
      cancelBtn.textContent = 'Cancelar';
      cancelBtn.addEventListener('click', () => cleanup(null));

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'za-btn primary';
      confirmBtn.textContent = 'Usar emoji';
      confirmBtn.addEventListener('click', () => cleanup(customInput.value));

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) cleanup(null);
      });

      footer.append(cancelBtn, confirmBtn);
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKeydown, true);
      customInput.focus();
    });
  }

  function getMenuTriggerFromTarget(target) {
    if (!(target instanceof Element)) return null;
    return (
      target.closest(
        "[id^='message-menu-btn-'], [data-testid='MESSAGE_DETAILS'], [aria-label*='Menu de mensagens'], [aria-label*='message']"
      ) || target
    );
  }

  function extractMessageIdFromMenuButton(menuButton) {
    if (!(menuButton instanceof Element)) return '';

    const idMatch = readString(menuButton.id).match(/^message-menu-btn-([A-Za-z0-9_-]{8,80})$/i);
    if (idMatch) return readString(idMatch[1]);

    for (const attrName of ['data-message-id', 'message-id', 'data-msg-id']) {
      const value = readString(menuButton.getAttribute(attrName));
      if (value) return value;
    }

    return '';
  }

  function escapeCssValue(value) {
    const raw = readString(value);
    if (!raw) return '';

    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(raw);
    }

    return raw.replace(/([^\w-])/g, '\\$1');
  }

  function findMessageItemById(messageId) {
    const id = readString(messageId);
    if (!id) return null;

    const escaped = escapeCssValue(id);
    if (!escaped) return null;

    return document.querySelector(`.message-item[data-message-id="${escaped}"]`);
  }

  function extractMessageTextFromMessageItem(messageItem) {
    if (!(messageItem instanceof Element)) return '';

    const preferred = Array.from(
      messageItem.querySelectorAll(
        ".chat-bubble-outbound .chat-message [class*='text-[14px]'][class*='font-inter'][class*='text-gray-900']"
      )
    );
    for (const node of preferred) {
      const text = normalizeWhitespace(node.innerText || node.textContent);
      if (shouldIgnoreTextCandidate(text)) continue;
      if (isLikelyTimestampText(text)) continue;
      return text;
    }

    const fallback = Array.from(messageItem.querySelectorAll('.chat-bubble-outbound .chat-message'));
    for (const node of fallback) {
      const text = normalizeWhitespace(node.innerText || node.textContent);
      if (shouldIgnoreTextCandidate(text)) continue;
      if (isLikelyTimestampText(text)) continue;
      return text;
    }

    return '';
  }

  function resolveContextFromMenuButton(menuButton) {
    if (!(menuButton instanceof Element)) return null;

    const directId = extractMessageIdFromMenuButton(menuButton);
    let messageItem = menuButton.closest('.message-item');
    if (!(messageItem instanceof Element) && directId) {
      messageItem = findMessageItemById(directId);
    }

    const itemId = readString(messageItem?.getAttribute('data-message-id'));
    const messageId = readString(directId || itemId);
    const messageText = extractMessageTextFromMessageItem(messageItem);

    if (!messageId && !messageText) return null;

    return {
      messageId,
      messageText,
      resolvedAt: Date.now()
    };
  }

  function isLikelyMenuTrigger(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest(`#${DETAILS_ACTION_ID}`)) return false;

    const clickable = getMenuTriggerFromTarget(target);

    if (!(clickable instanceof Element)) return false;

    const info = normalizeWhitespace(
      [
        clickable.id,
        clickable.className,
        clickable.getAttribute('data-testid'),
        clickable.getAttribute('aria-label'),
        clickable.getAttribute('title'),
        clickable.textContent
      ]
        .map((x) => readString(x).toLowerCase())
        .join(' ')
    );

    if (
      /more|mais|menu|opcao|opcoes|ellipsis|kebab|details|detalhes/.test(info) &&
      /message|mensagem|conv|chat|reply/.test(info)
    ) {
      return true;
    }

    if (clickable.textContent && /\u22EE|\u22EF/.test(clickable.textContent)) {
      return true;
    }

    const rect = clickable.getBoundingClientRect();
    if (rect.width > 4 && rect.width < 44 && rect.height > 4 && rect.height < 44) {
      if (/message|mensagem|conv|chat|reply/.test(info)) return true;
    }

    return false;
  }

  function onPointerCapture(event) {
    if (!(event.target instanceof Element)) return;
    state.lastPointerTarget = event.target;
    state.lastPointerAt = Date.now();

    const trigger = getMenuTriggerFromTarget(event.target);
    if (isLikelyMenuTrigger(trigger || event.target)) {
      state.lastLikelyMenuTrigger = trigger || event.target;
      state.lastLikelyMenuTriggerAt = state.lastPointerAt;

      const directContext = resolveContextFromMenuButton(state.lastLikelyMenuTrigger);
      if (directContext && directContext.messageId) {
        state.lastContext = directContext;
      }
    }
  }

  function extractTokenCandidates(raw) {
    const text = readString(raw);
    if (!text) return [];

    const matches = text.match(TOKEN_REGEX) || [];
    const tokens = [];

    for (const rawToken of matches) {
      const token = readString(rawToken);
      if (!token) continue;
      if (token.length > 64) continue;
      if (/^\d+$/.test(token)) continue;
      if ((token.match(/-/g) || []).length >= 2) continue;

      const lower = token.toLowerCase();
      if (STOP_TOKENS.has(lower)) continue;
      if (lower.includes('conv-message')) continue;
      if (lower.includes('message-reply')) continue;
      if (lower.includes('zaptos')) continue;
      if (lower.includes('details')) continue;
      if (lower.includes('cursor')) continue;
      if (lower.includes('items-center')) continue;

      tokens.push(token);
    }

    return tokens;
  }

  function addCandidate(candidateMap, token, score) {
    const id = readString(token);
    if (!id) return;
    const current = candidateMap.get(id) || 0;
    candidateMap.set(id, current + Number(score || 0));
  }

  function addCandidatesFromText(candidateMap, text, baseScore) {
    const normalized = readString(text);
    if (!normalized) return;

    const commandPattern =
      /#(?:delmessage|editmessage|reactmessage|replymessage|messagedetails)\s*:\s*([A-Za-z0-9_-]{8,80})/gi;
    let commandMatch = null;
    while ((commandMatch = commandPattern.exec(normalized))) {
      addCandidate(candidateMap, commandMatch[1], baseScore + 18);
    }

    const tokens = extractTokenCandidates(normalized);
    for (const token of tokens) {
      addCandidate(candidateMap, token, baseScore);
    }
  }

  function collectCandidatesFromElement(element, candidateMap, scoreBase) {
    if (!(element instanceof Element)) return;

    const base = Number(scoreBase || 0);

    if (element.id) {
      addCandidatesFromText(candidateMap, element.id, base + 4);
      if (/message|msg|reply/i.test(element.id)) {
        addCandidatesFromText(candidateMap, element.id, base + 10);
      }
    }

    const dataTestId = element.getAttribute('data-testid');
    if (dataTestId) {
      addCandidatesFromText(candidateMap, dataTestId, base + 3);
      if (/message|msg|reply/i.test(dataTestId)) {
        addCandidatesFromText(candidateMap, dataTestId, base + 10);
      }
    }

    for (const attr of Array.from(element.attributes || [])) {
      const name = readString(attr.name).toLowerCase();
      const value = readString(attr.value);
      if (!value) continue;

      let score = base + 2;
      if (/message|msg|reply/.test(name)) score += 12;
      if (/data-id|id|key/.test(name)) score += 5;
      if (/aria-controls|aria-describedby/.test(name)) score += 3;

      addCandidatesFromText(candidateMap, value, score);
    }

    const datasetValues = Object.values(element.dataset || {});
    for (const dataValue of datasetValues) {
      addCandidatesFromText(candidateMap, dataValue, base + 6);
    }

    const shortText = normalizeWhitespace(element.textContent);
    if (shortText && shortText.length <= 280) {
      addCandidatesFromText(candidateMap, shortText, base + 1);
    }
  }

  function collectCandidatesFromAncestors(node, candidateMap, initialScore) {
    let current = node instanceof Element ? node : null;
    let depth = 0;
    const scoreStart = Number(initialScore || 0);

    while (current && depth < 14) {
      const levelScore = Math.max(1, scoreStart - depth * 2);
      collectCandidatesFromElement(current, candidateMap, levelScore);

      const scopedMatches = current.querySelectorAll(
        "[data-message-id], [message-id], [data-msg-id], [id*='message'], [id*='msg'], [data-testid*='message'], [data-testid*='msg']"
      );
      const maxScan = Math.min(scopedMatches.length, 50);
      for (let i = 0; i < maxScan; i += 1) {
        collectCandidatesFromElement(
          scopedMatches[i],
          candidateMap,
          Math.max(1, levelScore - 2)
        );
      }

      current = current.parentElement;
      depth += 1;
    }
  }

  function pickBestCandidateId(candidateMap) {
    const candidates = Array.from(candidateMap.entries())
      .filter(([id]) => !!readString(id))
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return b[0].length - a[0].length;
      });

    if (!candidates.length) return '';

    const [topId] = candidates[0];
    return readString(topId);
  }

  function isLikelyTimestampText(text) {
    return /^\d{1,2}:\d{2}(\s?(am|pm))?$/i.test(readString(text));
  }

  function shouldIgnoreTextCandidate(text) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return true;
    if (isLikelyTimestampText(normalized)) return true;
    if (/^(detalhes|details|editar|apagar|reagir)$/i.test(normalized)) return true;
    if (normalized.length < 2) return true;
    return false;
  }

  function isLikelyMessageContainer(node) {
    if (!(node instanceof Element)) return false;
    const info = normalizeWhitespace(
      [
        node.id,
        node.className,
        node.getAttribute('data-testid'),
        node.getAttribute('aria-label'),
        node.getAttribute('role')
      ]
        .map((x) => readString(x).toLowerCase())
        .join(' ')
    );

    if (/message|mensagem|conversation|chat|reply|bubble|sms|whatsapp/.test(info)) {
      return true;
    }

    const text = normalizeWhitespace(node.textContent);
    if (!text || text.length > 900) return false;

    const hasTime = /\b\d{1,2}:\d{2}(\s?(am|pm))?\b/i.test(text);
    const hasButtons = node.querySelectorAll("button,[role='button'],svg").length > 0;
    return hasTime && hasButtons;
  }

  function findMessageContainerFromNode(startNode) {
    let current = startNode instanceof Element ? startNode : null;
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (isLikelyMessageContainer(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function extractMessageText(container) {
    if (!(container instanceof Element)) return '';

    const candidates = [];
    const elements = container.querySelectorAll('p, span, div');

    for (const node of Array.from(elements).slice(0, 300)) {
      if (!(node instanceof HTMLElement)) continue;
      if (!isVisibleElement(node)) continue;

      const text = normalizeWhitespace(node.innerText || node.textContent);
      if (shouldIgnoreTextCandidate(text)) continue;
      if (text.length > 700) continue;

      let score = text.length;
      if (/\w/.test(text)) score += 12;
      if (!isLikelyTimestampText(text)) score += 20;
      if (text.includes('#switch:')) score -= 8;

      candidates.push({ text, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].text : '';
  }

  function resolveMessageContext(detailsAction) {
    const now = Date.now();
    const startNodes = [];
    let directContext = null;

    if (detailsAction instanceof Element) {
      startNodes.push(detailsAction);
      if (detailsAction.parentElement) startNodes.push(detailsAction.parentElement);
    }

    if (
      state.lastLikelyMenuTrigger instanceof Element &&
      now - state.lastLikelyMenuTriggerAt <= CONTEXT_TTL_MS
    ) {
      startNodes.push(state.lastLikelyMenuTrigger);
      directContext = resolveContextFromMenuButton(state.lastLikelyMenuTrigger);
    }

    if (
      state.lastPointerTarget instanceof Element &&
      now - state.lastPointerAt <= CONTEXT_TTL_MS
    ) {
      startNodes.push(state.lastPointerTarget);
    }

    if (document.activeElement instanceof Element) {
      startNodes.push(document.activeElement);
    }

    const messageContainers = [];
    for (const node of startNodes) {
      const container = findMessageContainerFromNode(node);
      if (container) messageContainers.push(container);
    }

    const candidateMap = new Map();
    const sources = [...startNodes, ...messageContainers];

    for (let i = 0; i < sources.length; i += 1) {
      collectCandidatesFromAncestors(sources[i], candidateMap, 24 - i * 2);
    }

    const heuristicMessageId = pickBestCandidateId(candidateMap);
    const directMessageId = readString(directContext?.messageId);
    const messageId = readString(
      directMessageId || heuristicMessageId || state.lastContext?.messageId
    );

    let messageText = readString(directContext?.messageText);
    if (!messageText && messageId) {
      messageText = extractMessageTextFromMessageItem(findMessageItemById(messageId));
    }
    if (!messageText && messageContainers.length) {
      messageText = extractMessageText(messageContainers[0]);
    }
    if (!messageText) {
      messageText = readString(state.lastContext?.messageText);
    }

    const context = {
      messageId,
      messageText,
      resolvedAt: now
    };

    state.lastContext = context;
    return context;
  }

  function normalizeManualMessageId(rawInput) {
    const raw = readString(rawInput);
    if (!raw) return '';

    const commandMatch = raw.match(
      /#(?:delmessage|editmessage|reactmessage)\s*:\s*([A-Za-z0-9_-]{8,80})/i
    );
    if (commandMatch) return readString(commandMatch[1]);

    const token = extractTokenCandidates(raw)[0];
    return readString(token);
  }

  async function ensureMessageId(context) {
    const fromContext = normalizeManualMessageId(context?.messageId);
    if (fromContext) return fromContext;
    const fromState = normalizeManualMessageId(state.lastContext?.messageId);
    if (fromState) return fromState;

    const fallback = await showModernPrompt({
      title: 'ID da mensagem',
      subtitle: 'Nao foi possivel identificar o ID automaticamente.',
      label: 'Cole o ID da mensagem',
      defaultValue: '',
      placeholder: 'Ex.: MaDgdiZapbRW90TKFbYZ',
      multiline: false,
      confirmText: 'Continuar',
      cancelText: 'Cancelar'
    });
    return normalizeManualMessageId(fallback);
  }

  function getInputCandidates(root) {
    const scope = root || document;
    const explicitComposerTextarea = document.getElementById(
      'conv-composer-textarea-input'
    );
    const explicitComposerInput = document.querySelector("input[id^='composer-input-']");

    const isMessagePlaceholder = (value) => {
      const normalized = readString(value).toLowerCase();
      if (!normalized) return true;
      return normalized.includes('mensagem') || normalized.includes('message');
    };

    const isComposerMessageInput = (input) => {
      if (!input) return false;
      if (!isVisibleElement(input)) return false;
      if (input.id === 'conv-composer-textarea-input') return true;
      if (input instanceof HTMLInputElement && input.id.startsWith('composer-input-')) {
        return true;
      }

      if (input instanceof HTMLTextAreaElement) {
        const placeholderOk =
          isMessagePlaceholder(input.getAttribute('placeholder')) ||
          isMessagePlaceholder(input.getAttribute('aria-label'));
        if (!placeholderOk) return false;
      }

      if (input instanceof HTMLInputElement) {
        const placeholderOk =
          isMessagePlaceholder(input.getAttribute('placeholder')) ||
          isMessagePlaceholder(input.getAttribute('aria-label')) ||
          isMessagePlaceholder(input.value);
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

    const inputCandidates = Array.from(
      scope.querySelectorAll(
        "input[id^='composer-input-'], input[placeholder*='mensagem'], input[placeholder*='message'], input[type='text']"
      )
    ).filter(
      (el) =>
        isVisibleElement(el) &&
        !el.disabled &&
        !el.readOnly &&
        isComposerMessageInput(el)
    );

    const explicitCandidates =
      explicitComposerTextarea instanceof HTMLTextAreaElement &&
      isVisibleElement(explicitComposerTextarea) &&
      !explicitComposerTextarea.disabled &&
      !explicitComposerTextarea.readOnly
        ? [explicitComposerTextarea]
        : [];

    const explicitInputCandidates =
      explicitComposerInput instanceof HTMLInputElement &&
      isVisibleElement(explicitComposerInput) &&
      !explicitComposerInput.disabled &&
      !explicitComposerInput.readOnly
        ? [explicitComposerInput]
        : [];

    return [
      ...explicitCandidates,
      ...explicitInputCandidates,
      ...textareaCandidates,
      ...inputCandidates,
      ...editableCandidates
    ];
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

    if (active instanceof HTMLInputElement) {
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

  function isComposerLauncherInput(input) {
    return (
      input instanceof HTMLInputElement &&
      readString(input.id).toLowerCase().startsWith('composer-input-')
    );
  }

  function findExpandedComposerInput() {
    const explicit = document.getElementById('conv-composer-textarea-input');
    if (
      explicit instanceof HTMLTextAreaElement &&
      isVisibleElement(explicit) &&
      !explicit.disabled &&
      !explicit.readOnly
    ) {
      return explicit;
    }

    const editable = Array.from(
      document.querySelectorAll(
        "div[contenteditable='true'][role='textbox'], div[contenteditable='true']"
      )
    ).find((el) => isVisibleElement(el));
    if (editable) return editable;

    const textarea = Array.from(
      document.querySelectorAll(
        "textarea[placeholder*='mensagem'], textarea[placeholder*='message'], textarea"
      )
    ).find((el) => isVisibleElement(el) && !el.disabled && !el.readOnly);
    if (textarea) return textarea;

    const textInput = Array.from(
      document.querySelectorAll(
        "input[placeholder*='mensagem'], input[placeholder*='message'], input[type='text']"
      )
    ).find(
      (el) =>
        isVisibleElement(el) &&
        !el.disabled &&
        !el.readOnly &&
        !isComposerLauncherInput(el)
    );
    if (textInput) return textInput;

    return null;
  }

  function resolveComposerInput() {
    const expanded = findExpandedComposerInput();
    if (expanded) return expanded;
    return findComposerInput();
  }

  function getInputText(input) {
    if (!input) return '';
    if (input instanceof HTMLTextAreaElement) return String(input.value || '');
    if (input instanceof HTMLInputElement) return String(input.value || '');
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

    if (input instanceof HTMLInputElement) {
      if (input.value === value) return;
      input.focus();
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
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        document.execCommand('insertText', false, value);
      } catch {
        input.innerText = value;
      }

      if (getInputText(input) !== value) input.innerText = value;
      dispatchInputEvents(input);
    }
  }

  function isLikelySendButton(button) {
    if (!(button instanceof Element)) return false;
    if (!isVisibleElement(button)) return false;

    const id = readString(button.id).toLowerCase();
    const type = readString(button.getAttribute('type')).toLowerCase();
    const text = normalizeWhitespace(button.textContent).toLowerCase();
    const title = readString(button.getAttribute('title')).toLowerCase();
    const aria = readString(button.getAttribute('aria-label')).toLowerCase();
    const dataTestId = readString(button.getAttribute('data-testid')).toLowerCase();
    const className = readString(button.className).toLowerCase();
    const full = `${id} ${type} ${text} ${title} ${aria} ${dataTestId} ${className}`;

    if (
      /clear|limpar|cancel|cancelar|delete|trash|emoji|attach|anexo|microfone|record|tag|dropdown|option/.test(
        full
      )
    ) {
      return false;
    }

    if (id === 'conv-send-button-simple' || id.startsWith('conv-send-button')) return true;
    if (/send|enviar/.test(full)) return true;
    if (type === 'submit' && /send|enviar/.test(full)) return true;
    return false;
  }

  function findSendButtonInScope(scope) {
    if (!(scope instanceof Element) && scope !== document) return null;

    const buttons = Array.from(
      (scope || document).querySelectorAll(
        "#conv-send-button-simple, [id^='conv-send-button'], [data-testid*='send'], button, [role='button']"
      )
    ).filter((node) => isLikelySendButton(node));

    if (!buttons.length) return null;

    return buttons.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      if (rectB.bottom !== rectA.bottom) return rectB.bottom - rectA.bottom;
      return rectB.right - rectA.right;
    })[0];
  }

  function findSendButtonNearInput(input) {
    let node = input instanceof Element ? input : null;
    for (let depth = 0; node && depth < 10; depth += 1) {
      const button = findSendButtonInScope(node);
      if (button) return button;
      node = node.parentElement;
    }
    return findSendButtonInScope(document);
  }

  async function writeAndSendCommand(command) {
    const fillComposer = async (composer, autoSend) => {
      if (!composer) return false;

      const currentValue = normalizeWhitespace(getInputText(composer));
      if (currentValue && currentValue !== normalizeWhitespace(command)) {
        const confirmed = await showModernConfirm({
          title: 'Substituir texto atual?',
          message: 'Ja existe texto no composer. Deseja substituir pelo comando da acao?',
          confirmText: 'Substituir',
          cancelText: 'Manter'
        });
        if (!confirmed) return false;
      }

      setInputText(composer, command);
      composer.focus();

      if (!autoSend) {
        return true;
      }

      const sendButton = findSendButtonNearInput(composer);
      if (sendButton instanceof HTMLElement) {
        sendButton.click();
        return true;
      }

      showToast('Comando pronto no campo. Clique em enviar para concluir.');
      return true;
    };

    const composer = resolveComposerInput();
    if (!composer) {
      showToast('Nao encontrei o campo de mensagem para inserir o comando.', 'error', 3000);
      return false;
    }

    if (isComposerLauncherInput(composer)) {
      try {
        composer.focus();
        composer.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
        );
        composer.dispatchEvent(
          new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
        );
        composer.click();
      } catch {
        /* ignore open composer failure */
      }

      const maxAttempts = 25;
      let attempts = 0;
      const tryFillExpanded = () => {
        attempts += 1;
        const expanded = findExpandedComposerInput();
        if (expanded && !isComposerLauncherInput(expanded)) {
          void fillComposer(expanded, false);
          return;
        }
        if (attempts < maxAttempts) {
          setTimeout(tryFillExpanded, 120);
          return;
        }
        showToast('Nao foi possivel abrir o campo de mensagem para inserir o comando.', 'error', 3200);
      };

      setTimeout(tryFillExpanded, 80);
      return true;
    }

    return await fillComposer(composer, true);
  }

  function buildCommand(type, messageId, payload) {
    const builder = commandBuilders[type];
    if (typeof builder !== 'function') {
      throw new Error(`Builder de comando invalido para: ${type}`);
    }

    if (type === 'delete') return readString(builder(messageId));
    if (type === 'react') return readString(builder(messageId, payload));
    if (type === 'edit') return readString(builder(messageId, payload));
    return '';
  }

  async function runDeleteAction(context) {
    const messageId = await ensureMessageId(context);
    if (!messageId) return;

    const confirmed = await showModernConfirm({
      title: 'Apagar mensagem',
      message: `Confirmar apagar mensagem (${messageId})?`,
      confirmText: 'Apagar',
      cancelText: 'Cancelar',
      danger: true
    });
    if (!confirmed) return;

    const command = buildCommand('delete', messageId);
    if (!command) return;
    await writeAndSendCommand(command);
  }

  async function runReactAction(context) {
    const messageId = await ensureMessageId(context);
    if (!messageId) return;

    const reaction = await showEmojiPickerDialog(REACTION_EMOJIS);
    if (reaction == null) return;

    const emoji = normalizeMessagePayload(reaction);
    if (!emoji) return;

    const command = buildCommand('react', messageId, emoji);
    if (!command) return;
    await writeAndSendCommand(command);
  }

  async function runEditAction(context) {
    const messageId = await ensureMessageId(context);
    if (!messageId) return;

    const defaultText = readString(
      context?.messageText || state.lastContext?.messageText || ''
    );
    const editedText = await showModernPrompt({
      title: 'Editar mensagem',
      subtitle: `ID: ${messageId}`,
      label: 'Digite o novo texto da mensagem',
      defaultValue: defaultText,
      placeholder: 'Novo texto...',
      multiline: true,
      confirmText: 'Aplicar',
      cancelText: 'Cancelar'
    });
    if (editedText == null) return;

    const payload = normalizeMessagePayload(editedText);
    if (!payload) {
      showToast('Texto vazio. Edicao cancelada.', 'error', 2600);
      return;
    }

    const command = buildCommand('edit', messageId, payload);
    if (!command) return;
    await writeAndSendCommand(command);
  }

  function createMenuItemIcon(pathD, color) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'w-[14px] h-[14px]');
    if (color) svg.style.color = color;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }

  function createMenuActionItem({ label, iconPath, action, isDanger }) {
    const row = document.createElement('div');
    row.className = MENU_ACTION_CLASS;
    row.setAttribute('role', 'menuitem');
    row.setAttribute('data-zaptos-action-item', action);

    if (isDanger) {
      row.style.color = '#dc2626';
    }

    const iconWrap = document.createElement('div');
    iconWrap.className = 'flex items-center justify-center w-[14px] h-[14px]';

    const iconColor = isDanger ? '#dc2626' : '#4b5563';
    iconWrap.appendChild(createMenuItemIcon(iconPath, iconColor));

    const labelSpan = document.createElement('span');
    labelSpan.className = 'font-inter text-sm font-normal leading-[18px]';
    labelSpan.textContent = label;
    if (isDanger) labelSpan.style.color = '#dc2626';

    row.append(iconWrap, labelSpan);
    return row;
  }

  function getOrResolveMenuContext(menuRoot, detailsAction) {
    if (!(menuRoot instanceof Element)) return resolveMessageContext(detailsAction);

    const existing = menuContextCache.get(menuRoot);
    if (existing && Date.now() - existing.resolvedAt <= CONTEXT_TTL_MS) {
      return existing;
    }

    const fresh = resolveMessageContext(detailsAction);
    menuContextCache.set(menuRoot, fresh);
    return fresh;
  }

  function closeContextMenu() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
      })
    );
  }

  function bindActionClick(item, handler, menuRoot, detailsAction) {
    item.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        const context = getOrResolveMenuContext(menuRoot, detailsAction);
        closeContextMenu();
        await handler(context);
      } catch (error) {
        log('Erro ao executar acao', error);
        showToast('Falha ao executar a acao da mensagem.', 'error', 3000);
      }
    });
  }

  function injectActionsForDetails(detailsAction) {
    if (!(detailsAction instanceof Element)) return;
    if (!isVisibleElement(detailsAction)) return;

    const parentRow = detailsAction.parentElement;
    if (!(parentRow instanceof Element)) return;

    const menuRoot = detailsAction.closest('.py-1') || parentRow;
    if (!(menuRoot instanceof Element)) return;

    const existingItems = Array.from(parentRow.querySelectorAll(ACTION_ITEM_SELECTOR));
    if (existingItems.length >= 3) {
      return;
    }
    if (existingItems.length) {
      existingItems.forEach((item) => item.remove());
    }

    const context = resolveMessageContext(detailsAction);
    menuContextCache.set(menuRoot, context);

    const reactItem = createMenuActionItem({
      label: 'Reagir a Mensagem',
      iconPath:
        'M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
      action: 'react'
    });

    const editItem = createMenuActionItem({
      label: 'Editar Mensagem',
      iconPath: 'M16.862 4.487a2.25 2.25 0 113.182 3.182L8.3 19.412l-4 1 1-4L16.862 4.487z',
      action: 'edit'
    });

    const deleteItem = createMenuActionItem({
      label: 'Apagar Mensagem',
      iconPath: 'M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 12h6l1-12',
      action: 'delete',
      isDanger: true
    });

    bindActionClick(reactItem, runReactAction, parentRow, detailsAction);
    bindActionClick(editItem, runEditAction, parentRow, detailsAction);
    bindActionClick(deleteItem, runDeleteAction, parentRow, detailsAction);

    const referenceNode = detailsAction.nextSibling;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(reactItem);
    fragment.appendChild(editItem);
    fragment.appendChild(deleteItem);

    if (referenceNode && referenceNode.parentNode === parentRow) {
      parentRow.insertBefore(fragment, referenceNode);
    } else {
      parentRow.appendChild(fragment);
    }

    parentRow.setAttribute(MENU_MARKER_ATTR, '1');
  }

  function injectMenuActions() {
    const detailsActions = Array.from(document.querySelectorAll(`#${DETAILS_ACTION_ID}`));
    if (!detailsActions.length) return;

    for (const detailsAction of detailsActions) {
      injectActionsForDetails(detailsAction);
    }
  }

  function tick() {
    try {
      if (location.href !== state.lastHref) {
        state.lastHref = location.href;
      }
      injectMenuActions();
    } catch (error) {
      log('Tick error', error);
    }
  }

  document.addEventListener('pointerdown', onPointerCapture, true);
  document.addEventListener('click', onPointerCapture, true);

  const observer = new MutationObserver(() => injectMenuActions());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  tick();
  setInterval(tick, CHECK_INTERVAL_MS);

  window._zaptosMessageActions = {
    state,
    injectMenuActions,
    resolveMessageContext: () => resolveMessageContext(document.getElementById(DETAILS_ACTION_ID)),
    buildCommand
  };
})();
