/*!
 * Message Actions + Official WABA Templates Script
 * Injeta opcoes de acao no menu e o seletor de templates oficiais.
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
  const TEMPLATE_BUTTON_ID = 'zaptos-waba-template-btn';
  const TEMPLATE_BUTTON_WRAPPER_ID = 'zaptos-waba-template-wrapper';
  const TEMPLATE_EDGE_URL =
    window.__ZAPTOS_WABA_TEMPLATES_EDGE_URL__ ||
    'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-waba-templates';
  const TEMPLATE_REQUEST_TIMEOUT_MS = 15000;
  const TEMPLATE_INSTANCE_STORAGE_KEY = 'zaptos_waba_template_instance_by_location';

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
  const templateState = {
    activeClose: null,
    loading: false
  };

  const menuContextCache = new WeakMap();

  const commandBuilders = Object.assign(
    {
      reply: (messageId, text) => `#replymessage:${messageId}\n${text}`,
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
    if (DEBUG) console.log('[PlatformActions]', ...args);
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

  function normalizeMessageForEdit(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  function stripTrailingInstanceSource(text) {
    const sourceRemoved = String(text == null ? '' : text).replace(
      /\n?\s*Instance Source\s*:\s*[^\n\r]*\s*$/i,
      ''
    );
    return normalizeMessageForEdit(sourceRemoved);
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
      .za-template-modal {
        width: min(860px, calc(100vw - 24px));
        height: min(84vh, 700px);
        max-height: calc(100vh - 24px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .za-template-modal .za-modal-header,
      .za-template-modal .za-modal-footer {
        flex: 0 0 auto;
      }
      .za-template-modal .za-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .za-template-modal .za-modal-footer {
        border-top: 1px solid #eef2f6;
        background: #ffffff;
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
      .za-template-controls {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: end;
      }
      .za-template-controls > .za-btn {
        height: 46px;
        align-self: end;
      }
      .za-template-search {
        margin-top: 10px;
      }
      .za-template-status {
        min-height: 20px;
        margin-top: 10px;
        font-size: 12px;
        line-height: 1.4;
        color: #64748b;
      }
      .za-template-status.error {
        color: #b91c1c;
      }
      .za-template-workspace {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(250px, 0.86fr) minmax(320px, 1.14fr);
        gap: 12px;
        overflow: hidden;
      }
      .za-template-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 2px 2px 4px 2px;
      }
      .za-template-card {
        flex: 0 0 auto;
        width: 100%;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        padding: 12px;
        background: #ffffff;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
      }
      .za-template-card:hover {
        border-color: #93c5fd;
        background: #f8fbff;
      }
      .za-template-card.selected {
        border-color: #2563eb;
        background: #eff6ff;
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
      }
      .za-template-card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }
      .za-template-name {
        margin: 0;
        color: #0f172a;
        font-size: 13px;
        line-height: 1.35;
        font-weight: 700;
        overflow-wrap: anywhere;
      }
      .za-template-meta {
        margin-top: 4px;
        color: #64748b;
        font-size: 11px;
        line-height: 1.35;
      }
      .za-template-note {
        margin: 8px 0 0 0;
        color: #92400e;
        font-size: 11px;
        line-height: 1.4;
      }
      .za-template-badge {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 3px 7px;
        background: #f1f5f9;
        color: #475569;
        font-size: 10px;
        line-height: 1.2;
        font-weight: 700;
      }
      .za-template-badge.approved {
        background: #dcfce7;
        color: #166534;
      }
      .za-template-use {
        width: 100%;
        margin-top: 12px;
      }
      .za-template-empty {
        flex: 0 0 auto;
        padding: 24px 12px;
        border: 1px dashed #cbd5e1;
        border-radius: 12px;
        color: #64748b;
        font-size: 13px;
        text-align: center;
      }
      .za-template-preview-pane {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        background: #f8fafc;
        padding: 12px;
      }
      .za-template-preview-title {
        margin: 0 0 10px 0;
        color: #334155;
        font-size: 12px;
        font-weight: 700;
      }
      .za-whatsapp-preview {
        min-height: 230px;
        border-radius: 12px;
        padding: 18px 14px;
        background-color: #efeae2;
        background-image:
          radial-gradient(circle at 18% 22%, rgba(134, 118, 94, .08) 0 2px, transparent 2px),
          radial-gradient(circle at 76% 64%, rgba(134, 118, 94, .07) 0 2px, transparent 2px);
        background-size: 34px 34px, 42px 42px;
      }
      .za-whatsapp-bubble {
        width: min(92%, 390px);
        margin-left: auto;
        overflow: hidden;
        border-radius: 10px 4px 10px 10px;
        background: #d9fdd3;
        box-shadow: 0 1px 1px rgba(11, 20, 26, .13);
        color: #111b21;
      }
      .za-whatsapp-media {
        min-height: 116px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        background: #cbd5d8;
        color: #52636c;
        font-size: 12px;
        font-weight: 600;
      }
      .za-whatsapp-media svg {
        width: 28px;
        height: 28px;
      }
      .za-whatsapp-content {
        padding: 8px 9px 6px 9px;
      }
      .za-whatsapp-header {
        margin: 0 0 5px 0;
        font-size: 13px;
        line-height: 1.4;
        font-weight: 700;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .za-whatsapp-body {
        margin: 0;
        font-size: 13px;
        line-height: 1.42;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .za-whatsapp-footer {
        margin: 6px 0 0 0;
        color: #667781;
        font-size: 11px;
        line-height: 1.35;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .za-whatsapp-time {
        display: block;
        margin-top: 3px;
        color: #667781;
        font-size: 10px;
        line-height: 1;
        text-align: right;
      }
      .za-whatsapp-buttons {
        border-top: 1px solid rgba(17, 27, 33, .09);
        background: rgba(255, 255, 255, .42);
      }
      .za-whatsapp-button {
        padding: 8px 10px;
        color: #027eb5;
        font-size: 12px;
        font-weight: 600;
        text-align: center;
      }
      .za-whatsapp-button + .za-whatsapp-button {
        border-top: 1px solid rgba(17, 27, 33, .09);
      }
      .za-template-preview-empty {
        min-height: 230px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        border: 1px dashed #cbd5e1;
        border-radius: 12px;
        color: #64748b;
        font-size: 13px;
        line-height: 1.45;
        text-align: center;
      }
      @media (max-width: 720px) {
        .za-template-modal {
          height: min(90vh, 760px);
        }
        .za-template-controls {
          grid-template-columns: 1fr;
        }
        .za-template-controls .za-btn {
          width: 100%;
        }
        .za-template-workspace {
          display: block;
          overflow-y: auto;
        }
        .za-template-list {
          overflow: visible;
          margin-bottom: 12px;
        }
        .za-template-preview-pane {
          overflow: visible;
        }
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
      .za-btn:disabled {
        cursor: not-allowed;
        opacity: 0.55;
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

  function getCurrentLocationId() {
    try {
      const path = location.pathname || '';
      const match =
        path.match(/\/location\/([^/]+)/i) || path.match(/\/locations\/([^/]+)/i);
      return match ? readString(match[1]) : '';
    } catch {
      return '';
    }
  }

  function parseJsonSafe(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function callTemplateEdge(action, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEMPLATE_REQUEST_TIMEOUT_MS);
    const locationId = readString(payload?.location_id || getCurrentLocationId());

    try {
      const response = await fetch(TEMPLATE_EDGE_URL, {
        method: 'POST',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-zaptos-location-id': locationId
        },
        body: JSON.stringify({ action, ...(payload || {}), location_id: locationId })
      });
      const raw = await response.text().catch(() => '');
      const data = parseJsonSafe(raw);

      if (!response.ok || !data || data.ok === false) {
        throw new Error(
          readString(data?.error || data?.message) ||
            `Falha ao consultar templates (${response.status}).`
        );
      }

      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('A consulta de templates excedeu o tempo limite.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeOfficialInstanceNames(payload) {
    const rows = Array.isArray(payload?.instances) ? payload.instances : [];
    const names = rows
      .map((row) =>
        readString(
          typeof row === 'string'
            ? row
            : row?.instance_name ?? row?.instanceName ?? row?.name
        )
      )
      .map((name) => name.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function normalizeTemplatePreviewText(value, maxLength) {
    return String(value == null ? '' : value)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .slice(0, maxLength);
  }

  function normalizeOfficialTemplates(payload) {
    const rows = Array.isArray(payload?.templates) ? payload.templates : [];
    return rows
      .map((row) => {
        const templateName = readString(row?.template_name ?? row?.name).toLowerCase();
        if (!/^[a-z0-9_]{1,512}$/.test(templateName)) return null;

        const preview = normalizeTemplatePreviewText(row?.preview, 2203);
        const headerText = normalizeTemplatePreviewText(row?.header_text, 503);
        const bodyText = normalizeTemplatePreviewText(row?.body_text, 1503);
        const footerText = normalizeTemplatePreviewText(row?.footer_text, 303);
        const buttons = (Array.isArray(row?.buttons) ? row.buttons : [])
          .map((button) =>
            normalizeTemplatePreviewText(
              typeof button === 'string' ? button : button?.text,
              83
            ).trim()
          )
          .filter(Boolean)
          .slice(0, 10);

        return {
          templateName,
          language: readString(row?.language),
          category: readString(row?.category).toUpperCase(),
          status: readString(row?.status).toUpperCase() || 'UNKNOWN',
          preview,
          headerText,
          bodyText:
            bodyText || (!headerText && !footerText && !buttons.length ? preview : ''),
          footerText,
          buttons,
          headerFormat: readString(row?.header_format).toUpperCase(),
          requiresMedia: row?.requires_media === true,
          hasVariables: row?.has_variables === true,
          canUse: row?.can_use === true
        };
      })
      .filter(Boolean);
  }

  function loadSavedTemplateInstance(locationId) {
    try {
      const parsed = JSON.parse(localStorage.getItem(TEMPLATE_INSTANCE_STORAGE_KEY) || '{}');
      return readString(parsed?.[locationId]);
    } catch {
      return '';
    }
  }

  function saveTemplateInstance(locationId, instanceName) {
    try {
      const parsed = JSON.parse(localStorage.getItem(TEMPLATE_INSTANCE_STORAGE_KEY) || '{}');
      const map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      map[locationId] = readString(instanceName);
      localStorage.setItem(TEMPLATE_INSTANCE_STORAGE_KEY, JSON.stringify(map));
    } catch {
      /* ignore storage failures */
    }
  }

  function syncSwitchInstanceSelection(instanceName) {
    const name = readString(instanceName);
    if (!name) return;

    const switchSelect = document.getElementById('zaptos-switch-select');
    if (switchSelect instanceof HTMLSelectElement) {
      let option = Array.from(switchSelect.options).find((item) => item.value === name);
      if (!option) {
        option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        switchSelect.appendChild(option);
      }
      switchSelect.value = name;
      switchSelect.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (window._zaptosSwitch?.state) {
      window._zaptosSwitch.state.selectedInstance = name;
    }
  }

  function getTemplateUsageNote(template) {
    if (template.status !== 'APPROVED') {
      return 'Somente templates aprovados podem ser usados.';
    }
    if (template.hasVariables) {
      return 'Este template exige parametros e ainda nao pode ser enviado por este atalho.';
    }
    if (template.headerFormat === 'LOCATION') {
      return 'Este template exige uma localizacao e ainda nao pode ser enviado por este atalho.';
    }
    if (template.requiresMedia) {
      const type = template.headerFormat.toLowerCase();
      return `Anexe ${type === 'image' ? 'uma imagem' : type === 'video' ? 'um video' : 'um documento'} antes de enviar.`;
    }
    return '';
  }

  async function useOfficialTemplate(instanceName, template) {
    const safeInstanceName = readString(instanceName)
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const templateName = readString(template?.templateName).toLowerCase();
    if (!safeInstanceName || !/^[a-z0-9_]{1,512}$/.test(templateName)) {
      showToast('Template ou instancia invalida.', 'error', 3000);
      return false;
    }

    syncSwitchInstanceSelection(safeInstanceName);
    const command = `#switch:${safeInstanceName}\n#template:${templateName}`;
    return await writeAndSendCommand(command, {
      autoSend: false,
      readyMessage: template.requiresMedia
        ? 'Template pronto. Anexe a midia solicitada e clique em enviar.'
        : 'Template pronto no campo. Clique em enviar para concluir.'
    });
  }

  function openOfficialTemplatePicker() {
    if (typeof templateState.activeClose === 'function') return;

    const locationId = getCurrentLocationId();
    if (!locationId) {
      showToast('Nao foi possivel identificar a subconta atual.', 'error', 3000);
      return;
    }

    const frame = createDialogFrame(
      'Templates da API Oficial',
      'Selecione uma instancia, sincronize os templates e escolha qual deseja usar.'
    );
    frame.card.classList.add('za-template-modal');
    const { overlay, body, footer } = frame;
    let closed = false;
    let templates = [];
    let selectedTemplate = null;
    let requestVersion = 0;

    const controls = document.createElement('div');
    controls.className = 'za-template-controls';

    const instanceField = document.createElement('div');
    const instanceLabel = document.createElement('label');
    instanceLabel.className = 'za-label';
    instanceLabel.textContent = 'Instancia oficial';

    const instanceSelect = document.createElement('select');
    instanceSelect.className = 'za-input';
    instanceSelect.setAttribute('aria-label', 'Instancia oficial');
    instanceSelect.disabled = true;
    instanceField.append(instanceLabel, instanceSelect);

    const syncButton = document.createElement('button');
    syncButton.type = 'button';
    syncButton.className = 'za-btn primary';
    syncButton.textContent = 'Sincronizar';
    syncButton.disabled = true;
    controls.append(instanceField, syncButton);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'za-input za-template-search';
    searchInput.placeholder = 'Buscar template...';
    searchInput.setAttribute('aria-label', 'Buscar template');
    searchInput.disabled = true;

    const status = document.createElement('div');
    status.className = 'za-template-status';
    status.setAttribute('role', 'status');

    const list = document.createElement('div');
    list.className = 'za-template-list';

    const previewPane = document.createElement('aside');
    previewPane.className = 'za-template-preview-pane';
    previewPane.setAttribute('aria-label', 'Previa do template no WhatsApp');

    const workspace = document.createElement('div');
    workspace.className = 'za-template-workspace';
    workspace.append(list, previewPane);

    body.append(controls, searchInput, status, workspace);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'za-btn';
    closeButton.textContent = 'Fechar';
    footer.appendChild(closeButton);

    const setStatus = (message, isError) => {
      status.textContent = readString(message);
      status.classList.toggle('error', isError === true);
    };

    const renderTemplatePreview = () => {
      previewPane.replaceChildren();

      const title = document.createElement('h4');
      title.className = 'za-template-preview-title';
      title.textContent = 'Previa no WhatsApp';
      previewPane.appendChild(title);

      if (!selectedTemplate) {
        const empty = document.createElement('div');
        empty.className = 'za-template-preview-empty';
        empty.textContent = 'Selecione um template na lista para visualizar a mensagem.';
        previewPane.appendChild(empty);
        return;
      }

      const selectedMeta = document.createElement('div');
      selectedMeta.className = 'za-template-meta';
      selectedMeta.textContent = [
        selectedTemplate.templateName,
        selectedTemplate.language,
        selectedTemplate.category
      ]
        .filter(Boolean)
        .join(' - ');
      selectedMeta.style.margin = '-5px 0 10px 0';
      previewPane.appendChild(selectedMeta);

      const chat = document.createElement('div');
      chat.className = 'za-whatsapp-preview';
      const bubble = document.createElement('div');
      bubble.className = 'za-whatsapp-bubble';

      const mediaLabels = {
        IMAGE: 'Imagem do cabecalho',
        VIDEO: 'Video do cabecalho',
        DOCUMENT: 'Documento do cabecalho',
        LOCATION: 'Localizacao'
      };
      const mediaIcons = {
        IMAGE:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-4 4 3 3-2 4 3"/></svg>',
        VIDEO:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/><path d="m9 9 4 3-4 3z"/></svg>',
        DOCUMENT:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h5"/></svg>',
        LOCATION:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></svg>'
      };
      if (['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(selectedTemplate.headerFormat)) {
        const media = document.createElement('div');
        media.className = 'za-whatsapp-media';
        media.innerHTML = mediaIcons[selectedTemplate.headerFormat];
        const mediaLabel = document.createElement('span');
        mediaLabel.textContent = mediaLabels[selectedTemplate.headerFormat];
        media.appendChild(mediaLabel);
        bubble.appendChild(media);
      }

      const content = document.createElement('div');
      content.className = 'za-whatsapp-content';
      if (selectedTemplate.headerText) {
        const header = document.createElement('p');
        header.className = 'za-whatsapp-header';
        header.textContent = selectedTemplate.headerText;
        content.appendChild(header);
      }
      if (selectedTemplate.bodyText) {
        const message = document.createElement('p');
        message.className = 'za-whatsapp-body';
        message.textContent = selectedTemplate.bodyText;
        content.appendChild(message);
      }
      if (selectedTemplate.footerText) {
        const messageFooter = document.createElement('p');
        messageFooter.className = 'za-whatsapp-footer';
        messageFooter.textContent = selectedTemplate.footerText;
        content.appendChild(messageFooter);
      }
      const time = document.createElement('span');
      time.className = 'za-whatsapp-time';
      time.textContent = `${new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })}  ✓✓`;
      content.appendChild(time);
      bubble.appendChild(content);

      if (selectedTemplate.buttons.length) {
        const buttonList = document.createElement('div');
        buttonList.className = 'za-whatsapp-buttons';
        for (const label of selectedTemplate.buttons) {
          const previewButton = document.createElement('div');
          previewButton.className = 'za-whatsapp-button';
          previewButton.textContent = label;
          buttonList.appendChild(previewButton);
        }
        bubble.appendChild(buttonList);
      }

      chat.appendChild(bubble);
      previewPane.appendChild(chat);

      const noteText = getTemplateUsageNote(selectedTemplate);
      if (noteText) {
        const note = document.createElement('p');
        note.className = 'za-template-note';
        note.textContent = noteText;
        previewPane.appendChild(note);
      }

      const useButton = document.createElement('button');
      useButton.type = 'button';
      useButton.className = 'za-btn primary za-template-use';
      useButton.textContent = 'Usar template';
      useButton.disabled = !selectedTemplate.canUse;
      useButton.addEventListener('click', async () => {
        const selectedInstance = readString(instanceSelect.value);
        const templateToUse = selectedTemplate;
        cleanup();
        await useOfficialTemplate(selectedInstance, templateToUse);
      });
      previewPane.appendChild(useButton);
    };

    const renderTemplates = () => {
      list.replaceChildren();
      const search = normalizeWhitespace(searchInput.value).toLowerCase();
      const filtered = templates.filter((template) => {
        if (!search) return true;
        return [
          template.templateName,
          template.language,
          template.category,
          template.status,
          template.preview
        ]
          .join(' ')
          .toLowerCase()
          .includes(search);
      });

      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'za-template-empty';
        empty.textContent = templates.length
          ? 'Nenhum template corresponde a busca.'
          : 'Nenhum template encontrado para esta instancia.';
        list.appendChild(empty);
        renderTemplatePreview();
        return;
      }

      for (const template of filtered) {
        const card = document.createElement('article');
        card.className = `za-template-card ${
          selectedTemplate === template ? 'selected' : ''
        }`;
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-pressed', selectedTemplate === template ? 'true' : 'false');

        const selectCard = () => {
          const scrollPosition = list.scrollTop;
          selectedTemplate = template;
          renderTemplates();
          list.scrollTop = scrollPosition;
        };
        card.addEventListener('click', selectCard);
        card.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          selectCard();
        });

        const head = document.createElement('div');
        head.className = 'za-template-card-head';
        const identity = document.createElement('div');
        const name = document.createElement('h4');
        name.className = 'za-template-name';
        name.textContent = template.templateName;
        const meta = document.createElement('div');
        meta.className = 'za-template-meta';
        meta.textContent = [template.language, template.category].filter(Boolean).join(' - ');
        identity.append(name, meta);

        const badge = document.createElement('span');
        badge.className = `za-template-badge ${
          template.status === 'APPROVED' ? 'approved' : ''
        }`;
        badge.textContent = template.status;
        head.append(identity, badge);
        card.appendChild(head);
        list.appendChild(card);
      }

      renderTemplatePreview();
    };

    const setLoading = (loading) => {
      templateState.loading = !!loading;
      syncButton.disabled = loading || !readString(instanceSelect.value);
      instanceSelect.disabled =
        loading ||
        (instanceSelect.options.length <= 1 && !readString(instanceSelect.value));
      syncButton.textContent = loading ? 'Sincronizando...' : 'Sincronizar';
    };

    const loadTemplates = async () => {
      const instanceName = readString(instanceSelect.value);
      if (!instanceName) {
        templates = [];
        selectedTemplate = null;
        searchInput.disabled = true;
        renderTemplates();
        setStatus('Selecione uma instancia oficial.', false);
        return;
      }

      const version = ++requestVersion;
      templates = [];
      selectedTemplate = null;
      renderTemplates();
      setLoading(true);
      setStatus('Sincronizando templates...', false);
      try {
        const payload = await callTemplateEdge('sync_templates', {
          location_id: locationId,
          instance_name: instanceName
        });
        if (closed || version !== requestVersion) return;
        templates = normalizeOfficialTemplates(payload);
        selectedTemplate = templates.find((template) => template.canUse) || templates[0] || null;
        searchInput.disabled = false;
        renderTemplates();
        setStatus(
          `${templates.length} template${templates.length === 1 ? '' : 's'} sincronizado${
            templates.length === 1 ? '' : 's'
          }.`,
          false
        );
      } catch (error) {
        if (closed || version !== requestVersion) return;
        templates = [];
        selectedTemplate = null;
        searchInput.disabled = true;
        renderTemplates();
        setStatus(readString(error?.message) || 'Falha ao sincronizar templates.', true);
      } finally {
        if (!closed && version === requestVersion) setLoading(false);
      }
    };

    const loadInstances = async () => {
      setLoading(true);
      setStatus('Buscando instancias oficiais...', false);
      try {
        const payload = await callTemplateEdge('list_instances', {
          location_id: locationId
        });
        if (closed) return;
        const instances = normalizeOfficialInstanceNames(payload);
        instanceSelect.replaceChildren();

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = instances.length
          ? 'Selecione uma instancia'
          : 'Nenhuma instancia oficial';
        instanceSelect.appendChild(placeholder);

        for (const instanceName of instances) {
          const option = document.createElement('option');
          option.value = instanceName;
          option.textContent = instanceName;
          instanceSelect.appendChild(option);
        }

        const saved = loadSavedTemplateInstance(locationId);
        if (saved && instances.includes(saved)) {
          instanceSelect.value = saved;
        } else if (instances.length === 1) {
          instanceSelect.value = instances[0];
        }

        instanceSelect.disabled = false;
        syncButton.disabled = !readString(instanceSelect.value);
        if (!instances.length) {
          templates = [];
          selectedTemplate = null;
          setStatus('Nenhuma instancia da API Oficial encontrada nesta subconta.', true);
          renderTemplates();
          return;
        }

        if (instanceSelect.value) {
          saveTemplateInstance(locationId, instanceSelect.value);
          await loadTemplates();
        } else {
          setStatus('Selecione uma instancia oficial.', false);
        }
      } catch (error) {
        if (closed) return;
        instanceSelect.disabled = true;
        syncButton.disabled = true;
        setStatus(readString(error?.message) || 'Falha ao buscar instancias oficiais.', true);
      } finally {
        if (!closed) setLoading(false);
      }
    };

    function cleanup() {
      if (closed) return;
      closed = true;
      requestVersion += 1;
      templateState.loading = false;
      templateState.activeClose = null;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    }

    function onKeydown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cleanup();
    }

    instanceSelect.addEventListener('change', () => {
      const instanceName = readString(instanceSelect.value);
      if (instanceName) saveTemplateInstance(locationId, instanceName);
      void loadTemplates();
    });
    syncButton.addEventListener('click', () => void loadTemplates());
    searchInput.addEventListener('input', renderTemplates);
    closeButton.addEventListener('click', cleanup);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup();
    });

    templateState.activeClose = cleanup;
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    void loadInstances();
  }

  function findTemplateBottomBar() {
    const bars = Array.from(
      document.querySelectorAll("div.flex.items-center.h-\\[40px\\]")
    ).filter((element) => isVisibleElement(element));

    return (
      bars.find(
        (element) =>
          element.querySelector("div[class*='flex-row'][class*='min-w-0']") &&
          element.querySelector("div[class*='border-l'][class*='gap-1']")
      ) ||
      bars[0] ||
      null
    );
  }

  function findTemplateToolbar() {
    const recorderWrapper = document.getElementById('zaptos-rec-wrapper');
    if (recorderWrapper?.parentElement && isVisibleElement(recorderWrapper.parentElement)) {
      return { toolbar: recorderWrapper.parentElement, recorderWrapper };
    }

    const bar = findTemplateBottomBar();
    const leftGroup = bar?.querySelector(
      "div[class*='flex-row'][class*='items-center'][class*='pl-2'][class*='min-w-0']"
    );
    if (leftGroup instanceof Element) {
      return { toolbar: leftGroup, recorderWrapper: null };
    }

    const composer = document.querySelector(
      "div[data-testid*='composer'], div[data-rbd-droppable-id]"
    );
    if (!(composer instanceof Element)) return null;

    let best = null;
    let bestCount = 0;
    const candidates = composer.querySelectorAll("div[role='group'], div[class*='toolbar'], div");
    for (const candidate of Array.from(candidates).slice(0, 300)) {
      const count = candidate.querySelectorAll('button,[role="button"],svg').length;
      if (count > bestCount) {
        best = candidate;
        bestCount = count;
      }
    }

    return { toolbar: best || composer, recorderWrapper: null };
  }

  function ensureTemplateButton() {
    const locationId = getCurrentLocationId();
    const existingWrapper = document.getElementById(TEMPLATE_BUTTON_WRAPPER_ID);

    if (!locationId) {
      if (existingWrapper) existingWrapper.remove();
      if (typeof templateState.activeClose === 'function') templateState.activeClose();
      return;
    }

    const target = findTemplateToolbar();
    if (!target?.toolbar) return;

    if (existingWrapper instanceof HTMLElement) {
      if (target.recorderWrapper?.parentElement === target.toolbar) {
        if (target.recorderWrapper.nextElementSibling !== existingWrapper) {
          target.recorderWrapper.insertAdjacentElement('afterend', existingWrapper);
        }
      } else if (existingWrapper.parentElement !== target.toolbar) {
        target.toolbar.prepend(existingWrapper);
      }
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = TEMPLATE_BUTTON_WRAPPER_ID;
    Object.assign(wrapper.style, {
      display: 'inline-flex',
      alignItems: 'center',
      marginLeft: '2px',
      marginRight: '2px'
    });

    const button = document.createElement('button');
    button.id = TEMPLATE_BUTTON_ID;
    button.type = 'button';
    button.title = 'Templates da API Oficial';
    button.setAttribute('aria-label', 'Templates da API Oficial');
    button.innerHTML = `
      <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"
           aria-hidden="true">
        <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973.064.28.153.568.265.86.104.27.228.525.371.761.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325.183.3 2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843.34-.286.61-.61.81-.973.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303Zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98l.211-.327c1.12-1.667 2.118-2.602 3.358-2.602Zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533.33-.18.692-.285 1.088-.285Z" />
      </svg>
    `;
    Object.assign(button.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      padding: '0',
      borderRadius: '8px',
      background: 'transparent',
      color: '#475467',
      border: '1px solid transparent',
      cursor: 'pointer',
      transition: 'all .16s ease'
    });

    button.addEventListener('mouseenter', () => {
      button.style.background = '#f2f4f7';
      button.style.borderColor = '#e4e7ec';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'transparent';
      button.style.borderColor = 'transparent';
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOfficialTemplatePicker();
    });

    wrapper.appendChild(button);
    if (target.recorderWrapper?.parentElement === target.toolbar) {
      target.recorderWrapper.insertAdjacentElement('afterend', wrapper);
    } else {
      target.toolbar.prepend(wrapper);
    }
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
      const text = normalizeMessageForEdit(node.innerText || node.textContent);
      if (shouldIgnoreTextCandidate(text)) continue;
      if (isLikelyTimestampText(text)) continue;
      return text;
    }

    const fallback = Array.from(messageItem.querySelectorAll('.chat-bubble-outbound .chat-message'));
    for (const node of fallback) {
      const text = normalizeMessageForEdit(node.innerText || node.textContent);
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

      const text = normalizeMessageForEdit(node.innerText || node.textContent);
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
      /#(?:delmessage|editmessage|reactmessage|replymessage)\s*:\s*([A-Za-z0-9_-]{8,80})/i
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

  async function writeAndSendCommand(command, options) {
    const opts = options || {};
    const shouldAutoSend = opts.autoSend !== false;
    const readyMessage = readString(opts.readyMessage);

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
        if (readyMessage) showToast(readyMessage, 'success', 3600);
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

    return await fillComposer(composer, shouldAutoSend);
  }

  function buildCommand(type, messageId, payload) {
    const builder = commandBuilders[type];
    if (typeof builder !== 'function') {
      throw new Error(`Builder de comando invalido para: ${type}`);
    }

    if (type === 'delete') return readString(builder(messageId));
    if (type === 'reply') return readString(builder(messageId, payload));
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

  async function runReplyAction(context) {
    const messageId = await ensureMessageId(context);
    if (!messageId) return;

    const replyText = await showModernPrompt({
      title: 'Responder mensagem',
      subtitle: `ID: ${messageId}`,
      label: 'Digite a resposta',
      defaultValue: '',
      placeholder: 'Sua resposta...',
      multiline: true,
      confirmText: 'Enviar',
      cancelText: 'Cancelar'
    });
    if (replyText == null) return;

    const payload = normalizeMessageForEdit(replyText);
    if (!payload.trim()) {
      showToast('Resposta vazia. Envio cancelado.', 'error', 2600);
      return;
    }

    const command = buildCommand('reply', messageId, payload);
    if (!command) return;
    await writeAndSendCommand(command);
  }

  async function runEditAction(context) {
    const messageId = await ensureMessageId(context);
    if (!messageId) return;

    const defaultText = stripTrailingInstanceSource(
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

    const payload = normalizeMessageForEdit(editedText);
    if (!payload.trim()) {
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
    labelSpan.style.whiteSpace = 'nowrap';
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
    if (existingItems.length >= 4) {
      return;
    }
    if (existingItems.length) {
      existingItems.forEach((item) => item.remove());
    }

    const context = resolveMessageContext(detailsAction);
    menuContextCache.set(menuRoot, context);

    const replyItem = createMenuActionItem({
      label: 'Responder Mensagem',
      iconPath: 'M9 17l-5-5 5-5m-5 5h10a6 6 0 016 6v1',
      action: 'reply'
    });

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

    bindActionClick(replyItem, runReplyAction, parentRow, detailsAction);
    bindActionClick(reactItem, runReactAction, parentRow, detailsAction);
    bindActionClick(editItem, runEditAction, parentRow, detailsAction);
    bindActionClick(deleteItem, runDeleteAction, parentRow, detailsAction);

    const referenceNode = detailsAction.nextSibling;
    const fragment = document.createDocumentFragment();
    fragment.appendChild(replyItem);
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
        if (typeof templateState.activeClose === 'function') {
          templateState.activeClose();
        }
      }
      injectMenuActions();
      ensureTemplateButton();
    } catch (error) {
      log('Tick error', error);
    }
  }

  document.addEventListener('pointerdown', onPointerCapture, true);
  document.addEventListener('click', onPointerCapture, true);

  const observer = new MutationObserver(() => {
    injectMenuActions();
    ensureTemplateButton();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  tick();
  setInterval(tick, CHECK_INTERVAL_MS);

  window._zaptosMessageActions = {
    state,
    injectMenuActions,
    openOfficialTemplatePicker,
    resolveMessageContext: () => resolveMessageContext(document.getElementById(DETAILS_ACTION_ID)),
    buildCommand
  };
})();
