/*!
 * Message Actions + Official WABA Templates Script
 * Injeta opções de ação no menu e o seletor de templates oficiais.
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
  const WHATSAPP_ACTIONS_BUTTON_ID = 'zaptos-whatsapp-actions-btn';
  const WHATSAPP_ACTIONS_WRAPPER_ID = 'zaptos-whatsapp-actions-wrapper';
  const TEMPLATE_EDGE_URL =
    window.__ZAPTOS_WABA_TEMPLATES_EDGE_URL__ ||
    'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-waba-templates';
  const TEMPLATE_REQUEST_TIMEOUT_MS = 15000;
  const TEMPLATE_INSTANCE_STORAGE_KEY = 'zaptos_waba_template_instance_by_location';
  const ACTIONS_INSTANCES_EDGE_URL =
    window.__ZAPTOS_SWITCH_EDGE_URL__ ||
    'https://qokrdahiutcpabsxirzx.supabase.co/functions/v1/get-wpp-instances-switch';
  const ADDRESS_SEARCH_URL =
    window.__ZAPTOS_ADDRESS_SEARCH_URL__ || 'https://photon.komoot.io/api/';
  const ADDRESS_COUNTRY_CODE =
    readString(window.__ZAPTOS_ADDRESS_COUNTRY_CODE__ || 'BR').toUpperCase();

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
    activeCreatorClose: null,
    loading: false
  };
  const whatsappActionsState = {
    activeClose: null,
    instances: [],
    locationId: '',
    loadedAt: 0
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
        grid-template-columns: minmax(0, 1fr) auto auto;
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
      .za-template-parameter-box {
        margin: 10px 0;
        padding: 10px;
        border: 1px solid #dbeafe;
        border-radius: 10px;
        background: #eff6ff;
      }
      .za-template-parameter-box > p {
        margin: 0 0 8px;
        color: #1e3a8a;
        font-size: 11px;
        line-height: 1.4;
      }
      .za-template-parameter-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .za-template-parameter-grid .za-label {
        font-size: 10px;
      }
      .za-template-parameter-grid .za-input {
        padding: 8px 9px;
        font-size: 12px;
        background: #ffffff;
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
      .za-whatsapp-list-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: #00a884;
      }
      .za-whatsapp-list-button svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
      }
      .za-whatsapp-poll-instruction {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: 6px 0 9px;
        color: #667781;
        font-size: 11px;
      }
      .za-whatsapp-poll-instruction svg {
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
      }
      .za-whatsapp-poll-option {
        margin: 9px 0 11px;
      }
      .za-whatsapp-poll-option-top {
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr) auto;
        align-items: center;
        gap: 7px;
        color: #1f2937;
        font-size: 12px;
      }
      .za-whatsapp-poll-option-top strong {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .za-whatsapp-poll-radio {
        width: 16px;
        height: 16px;
        border: 2px solid #667781;
        border-radius: 50%;
      }
      .za-whatsapp-poll-progress {
        height: 5px;
        margin: 5px 0 0 25px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(102, 119, 129, .28);
      }
      .za-whatsapp-poll-progress span {
        display: block;
        width: 0;
        height: 100%;
        background: #00a884;
      }
      .za-whatsapp-poll-votes {
        padding: 9px 10px;
        border-top: 1px solid rgba(17, 27, 33, .09);
        background: rgba(255, 255, 255, .42);
        color: #027eb5;
        font-size: 12px;
        font-weight: 600;
        text-align: center;
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
      .za-create-template-modal,
      .za-actions-modal {
        width: min(940px, calc(100vw - 24px));
        height: min(88vh, 760px);
        max-height: calc(100vh - 24px);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .za-create-template-modal .za-modal-body,
      .za-actions-modal .za-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
      .za-create-template-modal .za-modal-footer,
      .za-actions-modal .za-modal-footer {
        flex: 0 0 auto;
        border-top: 1px solid #eef2f6;
      }
      .za-template-editor-grid {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(300px, .85fr);
        gap: 14px;
      }
      .za-template-editor-form,
      .za-template-editor-preview {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 2px;
      }
      .za-form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .za-form-field {
        min-width: 0;
      }
      .za-form-field.full {
        grid-column: 1 / -1;
      }
      .za-form-help {
        margin: 5px 0 0;
        color: #64748b;
        font-size: 11px;
        line-height: 1.4;
      }
      .za-form-error {
        margin: 10px 0 0;
        padding: 9px 10px;
        border-radius: 9px;
        border: 1px solid #fecaca;
        background: #fef2f2;
        color: #b91c1c;
        font-size: 12px;
        line-height: 1.4;
      }
      .za-form-section-title {
        margin: 14px 0 8px;
        color: #334155;
        font-size: 12px;
        font-weight: 700;
      }
      .za-template-example-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .za-auth-preview {
        padding: 10px;
        border-radius: 10px;
        background: #f8fafc;
        color: #475569;
        font-size: 12px;
        line-height: 1.5;
      }
      .za-actions-layout {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-columns: 300px minmax(0, 1fr);
        gap: 14px;
      }
      .za-actions-sidebar,
      .za-actions-editor {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .za-actions-sidebar {
        padding-right: 4px;
      }
      .za-actions-search {
        position: sticky;
        top: 0;
        z-index: 1;
        padding-bottom: 8px;
        background: #ffffff;
      }
      .za-actions-category {
        margin: 12px 0 6px;
        color: #64748b;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .06em;
        text-transform: uppercase;
      }
      .za-action-option {
        width: 100%;
        margin-bottom: 6px;
        padding: 9px 10px;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #ffffff;
        color: #0f172a;
        cursor: pointer;
        text-align: left;
      }
      .za-action-option:hover {
        border-color: #93c5fd;
        background: #f8fbff;
      }
      .za-action-option.selected {
        border-color: #2563eb;
        background: #eff6ff;
      }
      .za-action-option strong {
        display: block;
        font-size: 12px;
        line-height: 1.35;
      }
      .za-action-option span {
        display: block;
        margin-top: 3px;
        color: #64748b;
        font-size: 10px;
        line-height: 1.35;
      }
      .za-actions-editor {
        padding: 2px 4px 2px 2px;
      }
      .za-action-heading {
        margin: 0;
        color: #0f172a;
        font-size: 17px;
      }
      .za-action-description {
        margin: 6px 0 12px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.45;
      }
      .za-action-advanced {
        grid-column: 1 / -1;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 10px;
        background: #f8fafc;
      }
      .za-action-advanced > summary {
        cursor: pointer;
        color: #475569;
        font-size: 12px;
        font-weight: 700;
      }
      .za-action-advanced .za-form-grid {
        margin-top: 10px;
      }
      .za-command-output {
        width: 100%;
        min-height: 90px;
        margin-top: 12px;
        resize: vertical;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        padding: 10px 12px;
        background: #0f172a;
        color: #e2e8f0;
        font: 12px/1.45 Consolas, "Courier New", monospace;
      }
      .za-command-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 9px;
      }
      .za-command-preview {
        margin-top: 14px;
        padding: 12px;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        background: #f8fafc;
      }
      .za-admin-preview {
        padding: 18px;
        border: 1px dashed #cbd5e1;
        border-radius: 10px;
        color: #64748b;
        font-size: 12px;
        line-height: 1.5;
        text-align: center;
      }
      .za-preview-contact,
      .za-preview-location,
      .za-preview-payment {
        padding: 10px;
        border-radius: 9px;
        background: rgba(255,255,255,.52);
        color: #1f2937;
        font-size: 12px;
        line-height: 1.5;
      }
      .za-builder-host {
        grid-column: 1 / -1;
        min-width: 0;
        padding: 10px;
        border: 1px solid #dbe3ef;
        border-radius: 11px;
        background: #f8fafc;
      }
      .za-builder-header {
        margin-bottom: 8px;
        color: #334155;
        font-size: 12px;
        font-weight: 800;
      }
      .za-builder-list {
        display: grid;
        gap: 9px;
      }
      .za-builder-card {
        padding: 10px;
        border: 1px solid #dbe3ef;
        border-radius: 10px;
        background: #ffffff;
      }
      .za-builder-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 9px;
        color: #334155;
        font-size: 12px;
      }
      .za-builder-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .za-builder-add {
        margin-top: 9px;
      }
      .za-builder-remove {
        flex: 0 0 auto;
        padding: 3px 5px;
        border: 0;
        background: transparent;
        color: #dc2626;
        cursor: pointer;
        font-size: 11px;
      }
      .za-builder-remove:disabled {
        opacity: .4;
        cursor: default;
      }
      .za-builder-subsection {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid #e2e8f0;
        color: #334155;
        font-size: 12px;
      }
      .za-builder-button-row {
        margin-top: 8px;
        padding: 9px;
        border-radius: 9px;
        background: #f8fafc;
      }
      .za-builder-button-row > .za-builder-remove {
        display: block;
        margin: 5px 0 0 auto;
      }
      .za-address-results {
        display: grid;
        gap: 6px;
        margin-top: 8px;
      }
      .za-address-result {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #dbe3ef;
        border-radius: 9px;
        background: #ffffff;
        color: #334155;
        cursor: pointer;
        text-align: left;
      }
      .za-address-result:hover {
        border-color: #60a5fa;
        background: #eff6ff;
      }
      .za-address-result strong,
      .za-address-result span {
        display: block;
      }
      .za-address-result strong {
        font-size: 12px;
      }
      .za-address-result span {
        margin-top: 2px;
        color: #64748b;
        font-size: 10px;
        line-height: 1.35;
      }
      .za-address-attribution {
        margin: 7px 0 0;
        color: #94a3b8;
        font-size: 9px;
        text-align: right;
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
        .za-template-editor-grid,
        .za-actions-layout {
          display: block;
          overflow-y: auto;
        }
        .za-template-editor-form,
        .za-template-editor-preview,
        .za-actions-sidebar,
        .za-actions-editor {
          overflow: visible;
        }
        .za-actions-sidebar {
          max-height: 230px;
          overflow-y: auto;
          margin-bottom: 12px;
        }
        .za-form-grid,
        .za-template-example-list,
        .za-template-parameter-grid {
          grid-template-columns: 1fr;
        }
        .za-builder-grid {
          grid-template-columns: 1fr;
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
            : row?.instance_name ??
              row?.instanceName ??
              row?.InstanceName ??
              row?.nome ??
              row?.Nome ??
              row?.name ??
              row?.instance ??
              row?.label ??
              row?.display_name
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

  function normalizeTemplateParameterSchema(row, headerText, bodyText) {
    const source =
      row?.parameter_schema &&
      typeof row.parameter_schema === 'object' &&
      !Array.isArray(row.parameter_schema)
        ? row.parameter_schema
        : null;
    if (!source) {
      const headerCount = getTemplateVariableIndexes(headerText).length;
      const bodyCount = getTemplateVariableIndexes(bodyText).length;
      return {
        supported: row?.can_use === true && !headerCount && !bodyCount,
        headerType: readString(row?.header_format).toUpperCase() || 'NONE',
        headerCount,
        bodyCount,
        buttons: [],
        locationRequired: false,
        hasParameterFields: Boolean(headerCount || bodyCount),
        errorCode: headerCount || bodyCount ? 'SCHEMA_NOT_AVAILABLE' : ''
      };
    }

    const allowedHeaderTypes = new Set([
      'NONE',
      'TEXT',
      'IMAGE',
      'VIDEO',
      'DOCUMENT',
      'LOCATION'
    ]);
    const rawHeaderType = readString(source?.header?.type).toUpperCase();
    const headerType = allowedHeaderTypes.has(rawHeaderType) ? rawHeaderType : 'NONE';
    const safeCount = (value, max) => {
      const count = Number(value);
      return Number.isInteger(count) && count >= 0 && count <= max ? count : 0;
    };
    const headerCount = safeCount(source?.header?.value_count, 50);
    const bodyCount = safeCount(source?.body?.value_count, 50);
    const seenButtonIndexes = new Set();
    const buttons = [];
    for (const rawButton of Array.isArray(source?.buttons) ? source.buttons : []) {
      const index = Number(rawButton?.index);
      const type = readString(rawButton?.type).toUpperCase();
      const valueCount = safeCount(rawButton?.value_count, 10);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index > 9 ||
        seenButtonIndexes.has(index) ||
        !['URL', 'COPY_CODE', 'QUICK_REPLY'].includes(type) ||
        valueCount < 1
      ) {
        continue;
      }
      seenButtonIndexes.add(index);
      buttons.push({
        index,
        type,
        label:
          normalizeTemplatePreviewText(rawButton?.label, 83).trim() || `Botão ${index + 1}`,
        valueCount,
        required: rawButton?.required === true,
        maxValueBytes: type === 'QUICK_REPLY' ? 256 : 2048
      });
    }
    const locationRequired = source?.location_required === true && headerType === 'LOCATION';
    return {
      supported: source?.supported === true,
      headerType,
      headerCount,
      bodyCount,
      buttons,
      locationRequired,
      hasParameterFields: Boolean(
        headerCount || bodyCount || buttons.length || locationRequired
      ),
      errorCode: readString(source?.error_code).replace(/[^A-Z0-9_]/gi, '').slice(0, 80)
    };
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
        const parameterSchema = normalizeTemplateParameterSchema(row, headerText, bodyText);

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
          parameterSchema,
          canUse: row?.can_use === true && parameterSchema.supported
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

  function getTemplateUsageNote(template, parameterResult) {
    if (template.status !== 'APPROVED') {
      return 'Somente templates aprovados podem ser usados.';
    }
    if (!template.parameterSchema?.supported) {
      return 'A estrutura de parâmetros deste template não é compatível com o envio pelo atalho.';
    }
    if (parameterResult && !parameterResult.ok) {
      return parameterResult.error;
    }
    if (template.requiresMedia) {
      const type = template.headerFormat.toLowerCase();
      return `Anexe ${type === 'image' ? 'uma imagem' : type === 'video' ? 'um vídeo' : 'um documento'} antes de enviar.`;
    }
    return '';
  }

  function officialTemplateUtf8Length(value) {
    return new TextEncoder().encode(String(value == null ? '' : value)).byteLength;
  }

  function validateOfficialTemplateValue(value, maxBytes, label) {
    const text = String(value == null ? '' : value);
    if (!text.trim()) return `${label}: preencha o valor.`;
    if (text.includes('\u0000')) return `${label}: remova o caractere inválido.`;
    if (officialTemplateUtf8Length(text) > maxBytes) {
      return `${label}: o valor ultrapassa o limite permitido.`;
    }
    return '';
  }

  function buildOfficialTemplateParameters(template, values) {
    const schema = template?.parameterSchema;
    if (!schema?.supported) {
      return {
        ok: false,
        error: 'A estrutura de parâmetros deste template não é compatível com o envio.'
      };
    }

    const parameters = {};
    let totalParameters = 0;
    const collectValues = (prefix, count, label, maxBytes) => {
      const collected = [];
      for (let index = 1; index <= count; index += 1) {
        const value = String(values?.[`${prefix}:${index}`] ?? '');
        const error = validateOfficialTemplateValue(
          value,
          maxBytes,
          `${label} {{${index}}}`
        );
        if (error) return { ok: false, error };
        collected.push(value);
      }
      return { ok: true, values: collected };
    };

    if (schema.headerCount) {
      const result = collectValues('HEADER', schema.headerCount, 'Cabeçalho', 4096);
      if (!result.ok) return result;
      parameters.header = result.values;
      totalParameters += result.values.length;
    }
    if (schema.bodyCount) {
      const result = collectValues('BODY', schema.bodyCount, 'Mensagem', 4096);
      if (!result.ok) return result;
      parameters.body = result.values;
      totalParameters += result.values.length;
    }

    const buttons = [];
    for (const button of schema.buttons) {
      const prefix = `BUTTON:${button.index}`;
      const rawValues = Array.from({ length: button.valueCount }, (_, position) =>
        String(values?.[`${prefix}:${position + 1}`] ?? '')
      );
      const hasAnyValue = rawValues.some((value) => value.trim());
      if (!button.required && !hasAnyValue) continue;
      const buttonLabel = `Botão “${button.label}”`;
      for (let position = 0; position < rawValues.length; position += 1) {
        const error = validateOfficialTemplateValue(
          rawValues[position],
          button.maxValueBytes,
          rawValues.length > 1 ? `${buttonLabel}, valor ${position + 1}` : buttonLabel
        );
        if (error) return { ok: false, error };
      }
      buttons.push({ index: button.index, values: rawValues });
      totalParameters += rawValues.length;
    }
    if (buttons.length) parameters.buttons = buttons;

    if (schema.locationRequired) {
      const latitudeText = String(values?.['LOCATION:latitude'] ?? '').trim();
      const longitudeText = String(values?.['LOCATION:longitude'] ?? '').trim();
      const latitude = Number(latitudeText.replace(',', '.'));
      const longitude = Number(longitudeText.replace(',', '.'));
      if (!latitudeText || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        return { ok: false, error: 'Informe uma latitude válida entre -90 e 90.' };
      }
      if (
        !longitudeText ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180
      ) {
        return { ok: false, error: 'Informe uma longitude válida entre -180 e 180.' };
      }
      const location = { latitude, longitude };
      const name = String(values?.['LOCATION:name'] ?? '').trim();
      const address = String(values?.['LOCATION:address'] ?? '').trim();
      if (name) {
        const error = validateOfficialTemplateValue(name, 256, 'Nome da localização');
        if (error) return { ok: false, error };
        location.name = name;
      }
      if (address) {
        const error = validateOfficialTemplateValue(address, 512, 'Endereço');
        if (error) return { ok: false, error };
        location.address = address;
      }
      parameters.location = location;
      totalParameters += 1;
    }

    if (totalParameters > 100) {
      return { ok: false, error: 'O template ultrapassa o limite de 100 parâmetros.' };
    }
    return { ok: true, parameters };
  }

  function encodeTemplateParams(params) {
    const bytes = new TextEncoder().encode(JSON.stringify(params));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  async function useOfficialTemplate(instanceName, template, parameters) {
    const safeInstanceName = readString(instanceName)
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const templateName = readString(template?.templateName).toLowerCase();
    if (!safeInstanceName || !/^[a-z0-9_]{1,512}$/.test(templateName)) {
      showToast('Template ou instância inválida.', 'error', 3000);
      return false;
    }

    syncSwitchInstanceSelection(safeInstanceName);
    let command = `#switch:${safeInstanceName}\n#template:${templateName}`;
    if (parameters && Object.keys(parameters).length) {
      const decodedBytes = officialTemplateUtf8Length(JSON.stringify(parameters));
      if (decodedBytes > 12288) {
        showToast('Os parâmetros ultrapassam o limite permitido.', 'error', 3500);
        return false;
      }
      const encoded = encodeTemplateParams(parameters);
      if (!encoded || encoded.length > 16384) {
        showToast('Os parâmetros ultrapassam o limite permitido.', 'error', 3500);
        return false;
      }
      command += `\n#templateparams:${encoded}`;
    }
    return await writeAndSendCommand(command, {
      autoSend: false,
      readyMessage: template.requiresMedia
        ? 'Template pronto. Anexe a mídia solicitada e clique em enviar.'
        : 'Template pronto no campo. Clique em enviar para concluir.'
    });
  }

  function createFormControl(config) {
    const options = config || {};
    const wrapper = document.createElement('div');
    wrapper.className = `za-form-field ${options.full ? 'full' : ''}`;
    const label = document.createElement('label');
    label.className = 'za-label';
    label.textContent = readString(options.label);

    let input;
    if (options.type === 'select') {
      input = document.createElement('select');
      for (const item of options.options || []) {
        const option = document.createElement('option');
        option.value = readString(item.value);
        option.textContent = readString(item.label);
        input.appendChild(option);
      }
    } else if (options.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = Number(options.rows) || 3;
    } else {
      input = document.createElement('input');
      input.type = options.type || 'text';
    }
    input.className = options.type === 'textarea' ? 'za-textarea' : 'za-input';
    input.value = options.value == null ? '' : String(options.value);
    if (options.placeholder) input.placeholder = String(options.placeholder);
    if (options.required) input.required = true;
    if (options.maxLength) input.maxLength = Number(options.maxLength);
    if (options.min != null) input.min = String(options.min);
    if (options.max != null) input.max = String(options.max);
    if (options.step != null) input.step = String(options.step);
    label.htmlFor = `za-field-${Math.random().toString(36).slice(2)}`;
    input.id = label.htmlFor;
    wrapper.append(label, input);

    if (options.help) {
      const help = document.createElement('p');
      help.className = 'za-form-help';
      help.textContent = String(options.help);
      wrapper.appendChild(help);
    }
    return { wrapper, input };
  }

  function getTemplateVariableIndexes(text) {
    return Array.from(
      new Set(
        Array.from(String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)).map(
          (match) => Number(match[1])
        )
      )
    ).sort((a, b) => a - b);
  }

  function applyTemplatePreviewValues(text, values, prefix) {
    let rendered = String(text || '');
    for (const index of getTemplateVariableIndexes(rendered)) {
      const value = readString(values?.[`${prefix}:${index}`]);
      if (value) {
        rendered = rendered.replace(
          new RegExp(`\\{\\{\\s*${index}\\s*\\}\\}`, 'g'),
          value
        );
      }
    }
    return rendered;
  }

  function parseTemplateButtonLines(text) {
    const buttons = [];
    const errors = [];
    for (const [index, rawLine] of String(text || '').split(/\r?\n/).entries()) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split('|').map((part) => part.trim());
      const label = parts[0];
      const type = readString(parts[1]).toUpperCase();
      if (!label || !['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(type)) {
        errors.push(`Botao ${index + 1}: use Texto|QUICK_REPLY, Texto|URL|https://... ou Texto|PHONE_NUMBER|+55...`);
        continue;
      }
      if (type === 'QUICK_REPLY') {
        buttons.push({ type, text: label });
      } else if (type === 'URL') {
        const url = parts[2] || '';
        const example = parts[3] || '';
        if (!/^https:\/\//i.test(url)) {
          errors.push(`Botao ${index + 1}: informe uma URL HTTPS.`);
          continue;
        }
        if (/\{\{\s*1\s*\}\}/.test(url) && !example) {
          errors.push(`Botão ${index + 1}: informe um exemplo para a URL dinâmica.`);
          continue;
        }
        buttons.push({ type, text: label, url, example });
      } else {
        const phoneNumber = parts[2] || '';
        if (!/^\+?\d{8,20}$/.test(phoneNumber.replace(/[^\d+]/g, ''))) {
          errors.push(`Botão ${index + 1}: informe um telefone válido.`);
          continue;
        }
        buttons.push({ type, text: label, phone_number: phoneNumber });
      }
    }
    if (buttons.length > 10) errors.push('Use no máximo 10 botões.');
    return { buttons, errors };
  }

  function renderGenericWhatsAppPreview(container, preview) {
    container.replaceChildren();
    const chat = document.createElement('div');
    chat.className = 'za-whatsapp-preview';
    const bubble = document.createElement('div');
    bubble.className = 'za-whatsapp-bubble';
    const appendTime = (parent) => {
      const time = document.createElement('span');
      time.className = 'za-whatsapp-time';
      time.textContent = `${new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })}  \u2713\u2713`;
      parent.appendChild(time);
    };

    if (preview.kind === 'poll') {
      const content = document.createElement('div');
      content.className = 'za-whatsapp-content za-whatsapp-poll';
      const question = document.createElement('p');
      question.className = 'za-whatsapp-header';
      question.textContent = String(preview.header || 'Pergunta da enquete');
      content.appendChild(question);
      if (preview.body) {
        const body = document.createElement('p');
        body.className = 'za-whatsapp-body';
        body.textContent = String(preview.body);
        content.appendChild(body);
      }

      const instruction = document.createElement('div');
      instruction.className = 'za-whatsapp-poll-instruction';
      instruction.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="3"/><circle cx="17" cy="12" r="3"/><path d="M10 12h4"/></svg>';
      const instructionText = document.createElement('span');
      instructionText.textContent =
        Number(preview.selectableCount) === 1
          ? 'Selecione uma opção'
          : 'Selecione uma ou mais opções';
      instruction.appendChild(instructionText);
      content.appendChild(instruction);

      const pollOptions = Array.isArray(preview.pollOptions)
        ? preview.pollOptions.filter(Boolean)
        : [];
      for (const optionText of pollOptions.length ? pollOptions : ['Opção 1', 'Opção 2']) {
        const option = document.createElement('div');
        option.className = 'za-whatsapp-poll-option';
        const top = document.createElement('div');
        top.className = 'za-whatsapp-poll-option-top';
        const radio = document.createElement('span');
        radio.className = 'za-whatsapp-poll-radio';
        const label = document.createElement('strong');
        label.textContent = String(optionText);
        const votes = document.createElement('span');
        votes.textContent = '0';
        top.append(radio, label, votes);
        const progress = document.createElement('div');
        progress.className = 'za-whatsapp-poll-progress';
        progress.appendChild(document.createElement('span'));
        option.append(top, progress);
        content.appendChild(option);
      }
      appendTime(content);
      bubble.appendChild(content);
      const showVotes = document.createElement('div');
      showVotes.className = 'za-whatsapp-poll-votes';
      showVotes.textContent = 'Mostrar votos';
      bubble.appendChild(showVotes);
      chat.appendChild(bubble);
      container.appendChild(chat);
      return;
    }

    if (preview.mediaLabel) {
      const media = document.createElement('div');
      media.className = 'za-whatsapp-media';
      media.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-4 4 3 3-2 4 3"/></svg>';
      const label = document.createElement('span');
      label.textContent = String(preview.mediaLabel);
      media.appendChild(label);
      bubble.appendChild(media);
    }

    const content = document.createElement('div');
    content.className = 'za-whatsapp-content';
    if (preview.header) {
      const header = document.createElement('p');
      header.className = 'za-whatsapp-header';
      header.textContent = String(preview.header);
      content.appendChild(header);
    }
    if (preview.body) {
      const body = document.createElement('p');
      body.className = 'za-whatsapp-body';
      body.textContent = String(preview.body);
      content.appendChild(body);
    }
    if (preview.detail) {
      const detail = document.createElement('div');
      detail.className = preview.detailClass || 'za-preview-contact';
      detail.textContent = String(preview.detail);
      content.appendChild(detail);
    }
    if (preview.footer) {
      const footer = document.createElement('p');
      footer.className = 'za-whatsapp-footer';
      footer.textContent = String(preview.footer);
      content.appendChild(footer);
    }
    appendTime(content);
    bubble.appendChild(content);

    if (preview.kind === 'list' && preview.listButton) {
      const buttonList = document.createElement('div');
      buttonList.className = 'za-whatsapp-buttons';
      const button = document.createElement('div');
      button.className = 'za-whatsapp-button za-whatsapp-list-button';
      button.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="7" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="17" r="1"/><path d="M9 7h10M9 12h10M9 17h10"/></svg>';
      const label = document.createElement('span');
      label.textContent = String(preview.listButton);
      button.appendChild(label);
      buttonList.appendChild(button);
      bubble.appendChild(buttonList);
    } else {
      const buttons = Array.isArray(preview.buttons) ? preview.buttons : [];
      if (buttons.length) {
        const buttonList = document.createElement('div');
        buttonList.className = 'za-whatsapp-buttons';
        for (const buttonText of buttons) {
          const button = document.createElement('div');
          button.className = 'za-whatsapp-button';
          button.textContent = String(buttonText);
          buttonList.appendChild(button);
        }
        bubble.appendChild(buttonList);
      }
    }
    chat.appendChild(bubble);
    container.appendChild(chat);
  }

  function openOfficialTemplateCreator({ locationId, instanceName, onCreated }) {
    if (typeof templateState.activeCreatorClose === 'function') return;
    const safeInstanceName = readString(instanceName);
    if (!safeInstanceName) {
      showToast('Selecione uma instância oficial antes de criar o template.', 'error', 3000);
      return;
    }

    const frame = createDialogFrame(
      'Novo template da API Oficial',
      `Instância: ${safeInstanceName}. O template será enviado para análise da Meta.`
    );
    frame.card.classList.add('za-create-template-modal');
    const { overlay, body, footer } = frame;
    let closed = false;
    let saving = false;
    const exampleValues = {};

    const grid = document.createElement('div');
    grid.className = 'za-template-editor-grid';
    const form = document.createElement('form');
    form.id = `za-template-create-form-${Date.now().toString(36)}`;
    form.className = 'za-template-editor-form';
    const formGrid = document.createElement('div');
    formGrid.className = 'za-form-grid';
    const previewColumn = document.createElement('aside');
    previewColumn.className = 'za-template-editor-preview';
    const previewTitle = document.createElement('h4');
    previewTitle.className = 'za-template-preview-title';
    previewTitle.textContent = 'Prévia no WhatsApp';
    const previewHost = document.createElement('div');
    previewColumn.append(previewTitle, previewHost);

    const nameField = createFormControl({
      label: 'Nome do template',
      placeholder: 'confirmacao_pedido',
      required: true,
      maxLength: 512
    });
    const languageField = createFormControl({
      label: 'Idioma',
      type: 'select',
      value: 'pt_BR',
      options: [
        { value: 'pt_BR', label: 'Português (Brasil)' },
        { value: 'en_US', label: 'Inglês (EUA)' },
        { value: 'es', label: 'Espanhol' }
      ]
    });
    const categoryField = createFormControl({
      label: 'Categoria',
      type: 'select',
      value: 'UTILITY',
      options: [
        { value: 'UTILITY', label: 'Utilidade' },
        { value: 'MARKETING', label: 'Marketing' },
        { value: 'AUTHENTICATION', label: 'Autenticação' }
      ]
    });
    const headerFormatField = createFormControl({
      label: 'Cabeçalho',
      type: 'select',
      value: 'NONE',
      options: [
        { value: 'NONE', label: 'Sem cabeçalho' },
        { value: 'TEXT', label: 'Texto' }
      ]
    });
    const headerField = createFormControl({
      label: 'Texto do cabeçalho',
      placeholder: 'Pedido confirmado',
      full: true,
      maxLength: 60
    });
    const bodyField = createFormControl({
      label: 'Corpo da mensagem',
      type: 'textarea',
      rows: 5,
      full: true,
      required: true,
      maxLength: 1024,
      placeholder: 'Olá {{1}}, seu pedido {{2}} foi confirmado.'
    });
    const footerField = createFormControl({
      label: 'Rodapé (opcional)',
      full: true,
      maxLength: 60,
      placeholder: 'Equipe de atendimento'
    });
    const buttonsField = createFormControl({
      label: 'Botões (opcional)',
      type: 'textarea',
      rows: 4,
      full: true,
      placeholder:
        'Falar com suporte|QUICK_REPLY\nAcompanhar pedido|URL|https://exemplo.com/pedido\nLigar|PHONE_NUMBER|+5511999999999',
      help: 'Um por linha. URL dinâmica: Texto|URL|https://site.com/{{1}}|exemplo123'
    });
    const authMinutesField = createFormControl({
      label: 'Expiração do código (minutos)',
      type: 'number',
      value: '10',
      full: true
    });
    authMinutesField.input.min = '1';
    authMinutesField.input.max = '90';

    const examplesTitle = document.createElement('h4');
    examplesTitle.className = 'za-form-section-title';
    examplesTitle.textContent = 'Exemplos dos parâmetros';
    const examples = document.createElement('div');
    examples.className = 'za-template-example-list';
    const errorBox = document.createElement('div');
    errorBox.className = 'za-form-error';
    errorBox.hidden = true;

    formGrid.append(
      nameField.wrapper,
      languageField.wrapper,
      categoryField.wrapper,
      headerFormatField.wrapper,
      headerField.wrapper,
      bodyField.wrapper,
      footerField.wrapper,
      buttonsField.wrapper,
      authMinutesField.wrapper
    );
    form.append(formGrid, examplesTitle, examples, errorBox);
    grid.append(form, previewColumn);
    body.appendChild(grid);

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'za-btn';
    cancelButton.textContent = 'Cancelar';
    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'za-btn primary';
    submitButton.textContent = 'Enviar para aprovacao';
    submitButton.setAttribute('form', form.id);
    footer.append(cancelButton, submitButton);

    const showError = (message) => {
      const text = readString(message);
      errorBox.hidden = !text;
      errorBox.textContent = text;
    };

    const renderExamples = () => {
      const previous = { ...exampleValues };
      for (const input of examples.querySelectorAll('input[data-example-key]')) {
        previous[input.dataset.exampleKey] = input.value;
      }
      examples.replaceChildren();
      const isAuth = categoryField.input.value === 'AUTHENTICATION';
      const definitions = isAuth
        ? []
        : [
            ...getTemplateVariableIndexes(
              headerFormatField.input.value === 'TEXT' ? headerField.input.value : ''
            ).map((index) => ({ key: `HEADER:${index}`, label: `Cabeçalho {{${index}}}` })),
            ...getTemplateVariableIndexes(bodyField.input.value).map((index) => ({
              key: `BODY:${index}`,
              label: `Mensagem {{${index}}}`
            }))
          ];
      examplesTitle.hidden = !definitions.length;
      examples.hidden = !definitions.length;
      for (const definition of definitions) {
        const field = createFormControl({
          label: definition.label,
          placeholder: 'Exemplo enviado para a Meta',
          value: previous[definition.key] || ''
        });
        field.input.dataset.exampleKey = definition.key;
        field.input.addEventListener('input', renderPreview);
        examples.appendChild(field.wrapper);
      }
    };

    const currentExamples = () => {
      const result = {};
      for (const input of examples.querySelectorAll('input[data-example-key]')) {
        result[input.dataset.exampleKey] = input.value;
        exampleValues[input.dataset.exampleKey] = input.value;
      }
      return result;
    };

    function renderPreview() {
      const isAuth = categoryField.input.value === 'AUTHENTICATION';
      headerFormatField.wrapper.hidden = isAuth;
      headerField.wrapper.hidden = isAuth || headerFormatField.input.value !== 'TEXT';
      bodyField.wrapper.hidden = isAuth;
      footerField.wrapper.hidden = isAuth;
      buttonsField.wrapper.hidden = isAuth;
      authMinutesField.wrapper.hidden = !isAuth;

      if (isAuth) {
        renderGenericWhatsAppPreview(previewHost, {
          body: '{{1}} é seu código de verificação.',
          footer: `Este código expira em ${readString(authMinutesField.input.value) || '10'} minutos.`,
          buttons: ['Copiar código']
        });
        return;
      }
      const values = currentExamples();
      const parsedButtons = parseTemplateButtonLines(buttonsField.input.value);
      renderGenericWhatsAppPreview(previewHost, {
        header:
          headerFormatField.input.value === 'TEXT'
            ? applyTemplatePreviewValues(headerField.input.value, values, 'HEADER')
            : '',
        body:
          applyTemplatePreviewValues(bodyField.input.value, values, 'BODY') ||
          'Conteúdo do template',
        footer: footerField.input.value,
        buttons: parsedButtons.buttons.map((button) => button.text)
      });
    }

    const buildSubmission = () => {
      const category = categoryField.input.value;
      const isAuthentication = category === 'AUTHENTICATION';
      const examplesMap = currentExamples();
      const headerIndexes = isAuthentication || headerFormatField.input.value !== 'TEXT'
        ? []
        : getTemplateVariableIndexes(headerField.input.value);
      const bodyIndexes = isAuthentication ? [] : getTemplateVariableIndexes(bodyField.input.value);
      const parsedButtons = isAuthentication
        ? { buttons: [], errors: [] }
        : parseTemplateButtonLines(buttonsField.input.value);
      if (parsedButtons.errors.length) throw new Error(parsedButtons.errors[0]);
      if (!/^[a-z0-9_]{1,512}$/.test(readString(nameField.input.value).toLowerCase())) {
        throw new Error('O nome deve usar apenas letras minúsculas, números e sublinhado.');
      }
      if (!isAuthentication && !readString(bodyField.input.value)) {
        throw new Error('Informe o corpo do template.');
      }
      for (const [label, indexes] of [
        ['cabeçalho', headerIndexes],
        ['corpo', bodyIndexes]
      ]) {
        if (indexes.some((index, position) => index !== position + 1)) {
          throw new Error(`Os parâmetros do ${label} devem ser sequenciais: {{1}}, {{2}}, ...`);
        }
      }
      const headerExamples = headerIndexes.map((index) =>
        readString(examplesMap[`HEADER:${index}`])
      );
      const bodyExamples = bodyIndexes.map((index) =>
        readString(examplesMap[`BODY:${index}`])
      );
      if ([...headerExamples, ...bodyExamples].some((value) => !value)) {
        throw new Error('Informe um exemplo para cada parâmetro {{n}}.');
      }
      return {
        name: readString(nameField.input.value).toLowerCase(),
        language: languageField.input.value,
        category,
        header_format: isAuthentication ? 'NONE' : headerFormatField.input.value,
        header_text:
          isAuthentication || headerFormatField.input.value !== 'TEXT'
            ? ''
            : headerField.input.value,
        header_examples: headerExamples,
        body_text: isAuthentication ? '' : bodyField.input.value,
        body_examples: bodyExamples,
        footer_text: isAuthentication ? '' : footerField.input.value,
        buttons: parsedButtons.buttons,
        code_expiration_minutes: Number(authMinutesField.input.value) || 10
      };
    };

    function cleanup() {
      if (closed) return;
      closed = true;
      templateState.activeCreatorClose = null;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    }

    function onKeydown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cleanup();
    }

    const submit = async (event) => {
      event?.preventDefault();
      if (saving) return;
      showError('');
      let template;
      try {
        template = buildSubmission();
      } catch (error) {
        showError(error?.message || 'Revise os dados do template.');
        return;
      }
      saving = true;
      submitButton.disabled = true;
      const confirmed = await showModernConfirm({
        title: 'Enviar template para aprovacao?',
        message: 'Depois do envio, a Meta analisara o nome, a categoria e o conteudo.',
        confirmText: 'Enviar para aprovacao',
        cancelText: 'Revisar'
      });
      if (!confirmed || closed) {
        saving = false;
        submitButton.disabled = false;
        return;
      }

      submitButton.textContent = 'Enviando...';
      try {
        await callTemplateEdge('create_template', {
          location_id: locationId,
          instance_name: safeInstanceName,
          template,
          confirm_submission: true
        });
        cleanup();
        showToast('Template enviado para aprovacao da Meta.', 'success', 3600);
        if (typeof onCreated === 'function') await onCreated();
      } catch (error) {
        showError(error?.message || 'Não foi possível enviar o template.');
      } finally {
        saving = false;
        submitButton.disabled = false;
        submitButton.textContent = 'Enviar para aprovacao';
      }
    };

    for (const input of [
      categoryField.input,
      headerFormatField.input,
      headerField.input,
      bodyField.input,
      footerField.input,
      buttonsField.input,
      authMinutesField.input
    ]) {
      input.addEventListener('input', () => {
        if (input === headerField.input || input === bodyField.input || input === categoryField.input) {
          renderExamples();
        }
        renderPreview();
      });
      input.addEventListener('change', () => {
        renderExamples();
        renderPreview();
      });
    }
    nameField.input.addEventListener('input', () => {
      const cursor = nameField.input.selectionStart;
      nameField.input.value = nameField.input.value
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_');
      try {
        nameField.input.setSelectionRange(cursor, cursor);
      } catch {
        /* ignore */
      }
    });
    form.addEventListener('submit', submit);
    cancelButton.addEventListener('click', cleanup);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup();
    });

    templateState.activeCreatorClose = cleanup;
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    renderExamples();
    renderPreview();
    nameField.input.focus();
  }

  function openOfficialTemplatePicker() {
    if (typeof templateState.activeClose === 'function') return;

    const locationId = getCurrentLocationId();
    if (!locationId) {
      showToast('Não foi possível identificar a subconta atual.', 'error', 3000);
      return;
    }

    const frame = createDialogFrame(
      'Templates da API Oficial',
      'Selecione uma instância, sincronize os templates e escolha qual deseja usar.'
    );
    frame.card.classList.add('za-template-modal');
    const { overlay, body, footer } = frame;
    let closed = false;
    let templates = [];
    let selectedTemplate = null;
    let selectedTemplateParameters = {};
    let parameterAddressSearchCleanup = null;
    let requestVersion = 0;

    const controls = document.createElement('div');
    controls.className = 'za-template-controls';

    const instanceField = document.createElement('div');
    const instanceLabel = document.createElement('label');
    instanceLabel.className = 'za-label';
    instanceLabel.textContent = 'Instância oficial';

    const instanceSelect = document.createElement('select');
    instanceSelect.className = 'za-input';
    instanceSelect.setAttribute('aria-label', 'Instância oficial');
    instanceSelect.disabled = true;
    instanceField.append(instanceLabel, instanceSelect);

    const syncButton = document.createElement('button');
    syncButton.type = 'button';
    syncButton.className = 'za-btn primary';
    syncButton.textContent = 'Sincronizar';
    syncButton.disabled = true;
    const createTemplateButton = document.createElement('button');
    createTemplateButton.type = 'button';
    createTemplateButton.className = 'za-btn';
    createTemplateButton.textContent = 'Novo template';
    createTemplateButton.disabled = true;
    controls.append(instanceField, syncButton, createTemplateButton);

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
    previewPane.setAttribute('aria-label', 'Prévia do template no WhatsApp');

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
      if (typeof parameterAddressSearchCleanup === 'function') {
        parameterAddressSearchCleanup();
        parameterAddressSearchCleanup = null;
      }
      previewPane.replaceChildren();

      const title = document.createElement('h4');
      title.className = 'za-template-preview-title';
      title.textContent = 'Prévia no WhatsApp';
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

      const schema = selectedTemplate.parameterSchema;
      const parameterDefinitions = [];
      for (let index = 1; index <= (schema?.headerCount || 0); index += 1) {
        parameterDefinitions.push({
          key: `HEADER:${index}`,
          label: `Cabeçalho {{${index}}}`,
          placeholder: 'Valor do cabeçalho',
          maxLength: 4096
        });
      }
      for (let index = 1; index <= (schema?.bodyCount || 0); index += 1) {
        parameterDefinitions.push({
          key: `BODY:${index}`,
          label: `Mensagem {{${index}}}`,
          placeholder: 'Valor da mensagem',
          maxLength: 4096
        });
      }
      for (const button of schema?.buttons || []) {
        for (let position = 1; position <= button.valueCount; position += 1) {
          const suffix = button.valueCount > 1 ? ` — valor ${position}` : '';
          const description =
            button.type === 'URL'
              ? 'complemento do link'
              : button.type === 'COPY_CODE'
                ? 'código para copiar'
                : 'identificador da resposta';
          parameterDefinitions.push({
            key: `BUTTON:${button.index}:${position}`,
            label: `Botão “${button.label}” — ${description}${suffix}${
              button.required ? '' : ' (opcional)'
            }`,
            placeholder:
              button.type === 'URL'
                ? 'Parte dinâmica da URL'
                : button.type === 'COPY_CODE'
                  ? 'Código que será copiado'
                  : 'Payload opcional da resposta',
            maxLength: button.maxValueBytes
          });
        }
      }
      let useButton = null;
      let usageNote = null;
      const refreshParameterizedPreview = () => {
        const header = previewPane.querySelector('.za-whatsapp-header');
        const message = previewPane.querySelector('.za-whatsapp-body');
        if (header) {
          header.textContent = applyTemplatePreviewValues(
            selectedTemplate.headerText,
            selectedTemplateParameters,
            'HEADER'
          );
        }
        if (message) {
          message.textContent = applyTemplatePreviewValues(
            selectedTemplate.bodyText,
            selectedTemplateParameters,
            'BODY'
          );
        }
        if (selectedTemplate.headerFormat === 'LOCATION') {
          const locationLabel = previewPane.querySelector('.za-whatsapp-media span');
          if (locationLabel) {
            locationLabel.textContent =
              readString(selectedTemplateParameters['LOCATION:name']) ||
              readString(selectedTemplateParameters['LOCATION:address']) ||
              'Localização';
          }
        }
      };
      const refreshTemplateControls = () => {
        refreshParameterizedPreview();
        const result = buildOfficialTemplateParameters(
          selectedTemplate,
          selectedTemplateParameters
        );
        if (useButton) useButton.disabled = !selectedTemplate.canUse || !result.ok;
        if (usageNote) {
          const noteText = getTemplateUsageNote(selectedTemplate, result);
          usageNote.textContent = noteText;
          usageNote.hidden = !noteText;
        }
        return result;
      };
      if (schema?.hasParameterFields) {
        const parameterBox = document.createElement('section');
        parameterBox.className = 'za-template-parameter-box';
        const parameterInfo = document.createElement('p');
        parameterInfo.textContent =
          'Preencha os parâmetros abaixo. Eles serão incluídos automaticamente no comando do template.';
        const parameterGrid = document.createElement('div');
        parameterGrid.className = 'za-template-parameter-grid';
        for (const definition of parameterDefinitions) {
          const field = createFormControl({
            label: definition.label,
            value: selectedTemplateParameters[definition.key] || '',
            placeholder: definition.placeholder,
            maxLength: definition.maxLength
          });
          field.input.addEventListener('input', () => {
            selectedTemplateParameters[definition.key] = field.input.value;
            refreshTemplateControls();
          });
          parameterGrid.appendChild(field.wrapper);
        }
        if (schema.locationRequired) {
          const locationFields = {
            address: createFormControl({
              label: 'Endereço (opcional)',
              value: selectedTemplateParameters['LOCATION:address'] || '',
              placeholder: 'Digite o endereço para buscar',
              maxLength: 512,
              full: true
            }),
            name: createFormControl({
              label: 'Nome do local (opcional)',
              value: selectedTemplateParameters['LOCATION:name'] || '',
              placeholder: 'Ex.: Loja Centro',
              maxLength: 256
            }),
            latitude: createFormControl({
              label: 'Latitude',
              value: selectedTemplateParameters['LOCATION:latitude'] || '',
              placeholder: '-23.5505'
            }),
            longitude: createFormControl({
              label: 'Longitude',
              value: selectedTemplateParameters['LOCATION:longitude'] || '',
              placeholder: '-46.6333'
            })
          };
          const locationControls = Object.fromEntries(
            Object.entries(locationFields).map(([key, field]) => [key, field.input])
          );
          const syncLocationParameters = () => {
            for (const [key, input] of Object.entries(locationControls)) {
              selectedTemplateParameters[`LOCATION:${key}`] = input.value;
            }
            refreshTemplateControls();
          };
          for (const input of Object.values(locationControls)) {
            input.addEventListener('input', syncLocationParameters);
          }
          parameterGrid.append(
            locationFields.address.wrapper,
            locationFields.name.wrapper,
            locationFields.latitude.wrapper,
            locationFields.longitude.wrapper
          );
          const addressSearchHost = document.createElement('div');
          addressSearchHost.className = 'za-form-field full';
          parameterGrid.appendChild(addressSearchHost);
          parameterAddressSearchCleanup = setupAddressSearch({
            controls: locationControls,
            host: addressSearchHost,
            update: syncLocationParameters
          });
        }
        parameterBox.append(parameterInfo, parameterGrid);
        previewPane.appendChild(parameterBox);
      }

      const chat = document.createElement('div');
      chat.className = 'za-whatsapp-preview';
      const bubble = document.createElement('div');
      bubble.className = 'za-whatsapp-bubble';

      const mediaLabels = {
        IMAGE: 'Imagem do cabeçalho',
        VIDEO: 'Vídeo do cabeçalho',
        DOCUMENT: 'Documento do cabeçalho',
        LOCATION: 'Localização'
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
        header.textContent = applyTemplatePreviewValues(
          selectedTemplate.headerText,
          selectedTemplateParameters,
          'HEADER'
        );
        content.appendChild(header);
      }
      if (selectedTemplate.bodyText) {
        const message = document.createElement('p');
        message.className = 'za-whatsapp-body';
        message.textContent = applyTemplatePreviewValues(
          selectedTemplate.bodyText,
          selectedTemplateParameters,
          'BODY'
        );
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

      usageNote = document.createElement('p');
      usageNote.className = 'za-template-note';
      previewPane.appendChild(usageNote);

      useButton = document.createElement('button');
      useButton.type = 'button';
      useButton.className = 'za-btn primary za-template-use';
      useButton.textContent = 'Usar template';
      useButton.addEventListener('click', async () => {
        const parameterResult = buildOfficialTemplateParameters(
          selectedTemplate,
          selectedTemplateParameters
        );
        if (!parameterResult.ok) {
          showToast(parameterResult.error, 'error', 4000);
          refreshTemplateControls();
          return;
        }
        const selectedInstance = readString(instanceSelect.value);
        const templateToUse = selectedTemplate;
        cleanup();
        await useOfficialTemplate(
          selectedInstance,
          templateToUse,
          parameterResult.parameters
        );
      });
      previewPane.appendChild(useButton);
      refreshTemplateControls();
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
          : 'Nenhum template encontrado para esta instância.';
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
          selectedTemplateParameters = {};
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
      createTemplateButton.disabled = loading || !readString(instanceSelect.value);
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
        selectedTemplateParameters = {};
        searchInput.disabled = true;
        renderTemplates();
        setStatus('Selecione uma instância oficial.', false);
        return;
      }

      const version = ++requestVersion;
      templates = [];
      selectedTemplate = null;
      selectedTemplateParameters = {};
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
        selectedTemplateParameters = {};
        searchInput.disabled = true;
        renderTemplates();
        setStatus(readString(error?.message) || 'Falha ao sincronizar templates.', true);
      } finally {
        if (!closed && version === requestVersion) setLoading(false);
      }
    };

    const loadInstances = async () => {
      setLoading(true);
      setStatus('Buscando instâncias oficiais...', false);
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
          ? 'Selecione uma instância'
          : 'Nenhuma instância oficial';
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
        createTemplateButton.disabled = !readString(instanceSelect.value);
        if (!instances.length) {
          templates = [];
          selectedTemplate = null;
          selectedTemplateParameters = {};
          setStatus('Nenhuma instância da API Oficial encontrada nesta subconta.', true);
          renderTemplates();
          return;
        }

        if (instanceSelect.value) {
          saveTemplateInstance(locationId, instanceSelect.value);
          await loadTemplates();
        } else {
          setStatus('Selecione uma instância oficial.', false);
        }
      } catch (error) {
        if (closed) return;
        instanceSelect.disabled = true;
        syncButton.disabled = true;
        createTemplateButton.disabled = true;
        setStatus(readString(error?.message) || 'Falha ao buscar instâncias oficiais.', true);
      } finally {
        if (!closed) setLoading(false);
      }
    };

    function cleanup() {
      if (closed) return;
      closed = true;
      requestVersion += 1;
      if (typeof parameterAddressSearchCleanup === 'function') {
        parameterAddressSearchCleanup();
        parameterAddressSearchCleanup = null;
      }
      if (typeof templateState.activeCreatorClose === 'function') {
        templateState.activeCreatorClose();
      }
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
    createTemplateButton.addEventListener('click', () => {
      openOfficialTemplateCreator({
        locationId,
        instanceName: instanceSelect.value,
        onCreated: loadTemplates
      });
    });
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

  function cleanActionLine(value) {
    return readString(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function encodeActionDirective(value) {
    return readString(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n');
  }

  function actionDirective(key, value, multiline) {
    const normalized = multiline ? encodeActionDirective(value) : cleanActionLine(value);
    return normalized ? `#${key}:${normalized}` : '';
  }

  function composeActionCommand(...lines) {
    return lines.flat(Infinity).map(readString).filter(Boolean).join('\n');
  }

  function requireActionValue(values, key, label) {
    const value = readString(values?.[key]);
    if (!value) throw new Error(`Informe ${label}.`);
    return value;
  }

  function actionTextLines(value) {
    return String(value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseActionJsonArray(value) {
    try {
      const parsed = JSON.parse(String(value || '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function cleanActionSegment(value) {
    return cleanActionLine(value).replace(/\|/g, ' ');
  }

  function makeActionId(value, fallback) {
    const normalized = readString(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    return normalized || fallback;
  }

  function buildActionDeliveryDirectives(values) {
    return [
      actionDirective('replyid', values.replyid),
      actionDirective('mentions', values.mentions),
      actionDirective('readchat', values.readchat),
      actionDirective('readmessages', values.readmessages),
      actionDirective('forward', values.forward),
      actionDirective('async', values.async),
      actionDirective('delay', values.delivery_delay),
      actionDirective('track_source', values.track_source),
      actionDirective('track_id', values.track_id)
    ];
  }

  function getWhatsAppActionCatalog(instances) {
    const instanceOptions = [
      { value: '', label: instances.length ? 'Selecione uma instância' : 'Nenhuma instância encontrada' },
      ...instances.map((name) => ({ value: name, label: name }))
    ];
    const field = (key, label, options) => ({ key, label, ...(options || {}) });
    const select = (key, label, options, extra) =>
      field(key, label, { type: 'select', options, ...(extra || {}) });
    const instanceField = (key, label) =>
      select(key, label || 'Instância', instanceOptions, { required: true });
    const groupField = () =>
      field('group', 'Número do grupo', {
        placeholder: '5511999999999@g.us',
        required: true,
        full: true
      });
    const adminPreview = (text) => () => ({ admin: text });
    const numberLine = (values) => actionDirective('number', values.number);
    const groupLine = (values) => actionDirective('number', requireActionValue(values, 'group', 'o número do grupo'));
    const optionalBoolean = (key, label) =>
      select(key, label, [
        { value: '', label: 'Padrão' },
        { value: 'true', label: 'Sim' },
        { value: 'false', label: 'Não' }
      ]);
    const advancedDeliveryFields = [
      field('replyid', 'Responder ao ID (opcional)', { placeholder: 'ID da mensagem' }),
      field('mentions', 'Menções (opcional)', { placeholder: '5511999999999, 5511888888888' }),
      optionalBoolean('readchat', 'Marcar conversa como lida'),
      optionalBoolean('readmessages', 'Marcar mensagens como lidas'),
      optionalBoolean('forward', 'Marcar como encaminhada'),
      optionalBoolean('async', 'Envio assíncrono'),
      field('delivery_delay', 'Atraso em ms (opcional)', { type: 'number' }),
      field('track_source', 'Origem de rastreio (opcional)'),
      field('track_id', 'ID de rastreio (opcional)')
    ];

    const items = [
      {
        id: 'contact_instance',
        category: 'Instâncias',
        title: 'Fixar instância no contato',
        description: 'Define qual instância será usada automaticamente para este contato.',
        usage: '#contact_instance:<instancia>',
        fields: [instanceField('instance')],
        build: (values) =>
          `#contact_instance:${cleanActionLine(requireActionValue(values, 'instance', 'a instância'))}`,
        preview: adminPreview('A instância escolhida ficará vinculada a este contato.'),
        confirm: true
      },
      {
        id: 'check_instance',
        category: 'Instâncias',
        title: 'Consultar instância do contato',
        description: 'Retorna qual instância está vinculada ao contato atual.',
        usage: '#check_instance',
        fields: [],
        build: () => '#check_instance',
        preview: adminPreview('O sistema responderá com a instância atualmente vinculada ao contato.')
      },
      {
        id: 'switch',
        category: 'Instâncias',
        title: 'Enviar uma vez por outra instância',
        description: 'Troca a instância somente para a mensagem gerada por este comando.',
        usage: '#switch:<instancia> + mensagem',
        fields: [
          instanceField('instance'),
          field('text', 'Mensagem', { type: 'textarea', rows: 4, required: true, full: true })
        ],
        build: (values) =>
          composeActionCommand(
            `#switch:${cleanActionLine(requireActionValue(values, 'instance', 'a instância'))}`,
            requireActionValue(values, 'text', 'a mensagem')
          ),
        preview: (values) => ({ body: values.text || 'Sua mensagem' })
      },
      {
        id: 'send_text',
        directSend: true,
        category: 'Mensagens',
        title: 'Enviar texto',
        description: 'Envia uma mensagem de texto, com número, resposta e menções opcionais.',
        usage: '#send:text + #text:<mensagem>',
        fields: [
          field('text', 'Mensagem', { type: 'textarea', rows: 4, required: true, full: true }),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999' })
        ],
        build: (values) =>
          composeActionCommand(
            '#send:text',
            numberLine(values),
            actionDirective('text', requireActionValue(values, 'text', 'a mensagem'), true)
          ),
        preview: (values) => ({ body: values.text || 'Sua mensagem' })
      },
      {
        id: 'send_media',
        directSend: true,
        category: 'Mensagens',
        title: 'Enviar mídia ou arquivo',
        description: 'Envia imagem, vídeo, documento, áudio, PTT, PTV ou figurinha por URL.',
        usage: '#send:media + #type:<tipo> + #file:<url>',
        fields: [
          select('type', 'Tipo', [
            { value: 'image', label: 'Imagem' },
            { value: 'video', label: 'Vídeo' },
            { value: 'videoplay', label: 'Vídeo com reprodução' },
            { value: 'document', label: 'Documento' },
            { value: 'audio', label: 'Áudio' },
            { value: 'myaudio', label: 'Áudio enviado' },
            { value: 'ptt', label: 'Áudio PTT' },
            { value: 'ptv', label: 'Vídeo PTV' },
            { value: 'sticker', label: 'Figurinha' }
          ]),
          field('file', 'URL do arquivo', { placeholder: 'https://...', required: true }),
          field('text', 'Legenda (opcional)', { type: 'textarea', rows: 3, full: true }),
          field('docname', 'Nome do arquivo (opcional)', { placeholder: 'arquivo.pdf' }),
          select('viewonce', 'Visualização única', [
            { value: 'false', label: 'Não' },
            { value: 'true', label: 'Sim' }
          ]),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999', full: true })
        ],
        build: (values) =>
          composeActionCommand(
            '#send:media',
            numberLine(values),
            actionDirective('type', values.type),
            actionDirective('file', requireActionValue(values, 'file', 'a URL do arquivo')),
            actionDirective('text', values.text, true),
            actionDirective('docname', values.docname),
            values.viewonce === 'true' ? '#viewonce:true' : ''
          ),
        preview: (values) => ({
          mediaLabel: `${values.type || 'mídia'}: ${values.file || 'URL do arquivo'}`,
          body: values.text || ''
        })
      },
      {
        id: 'send_contact',
        directSend: true,
        category: 'Mensagens',
        title: 'Enviar contato',
        description: 'Compartilha um cartão de contato pelo WhatsApp.',
        usage: '#send:contact + #fullname + #phonenumber',
        fields: [
          field('fullname', 'Nome completo', { required: true }),
          field('phonenumber', 'Telefone', { placeholder: '5511999999999', required: true }),
          field('organization', 'Empresa (opcional)'),
          field('email', 'E-mail (opcional)', { type: 'email' }),
          field('url', 'Site (opcional)', { placeholder: 'https://...' }),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999' })
        ],
        build: (values) =>
          composeActionCommand(
            '#send:contact',
            numberLine(values),
            actionDirective('fullname', requireActionValue(values, 'fullname', 'o nome completo')),
            actionDirective('phonenumber', requireActionValue(values, 'phonenumber', 'o telefone')),
            actionDirective('organization', values.organization),
            actionDirective('email', values.email),
            actionDirective('url', values.url)
          ),
        preview: (values) => ({
          header: values.fullname || 'Nome do contato',
          detail: [values.phonenumber, values.organization, values.email].filter(Boolean).join('\n'),
          detailClass: 'za-preview-contact',
          buttons: ['Enviar mensagem']
        })
      },
      {
        id: 'send_location',
        directSend: true,
        category: 'Mensagens',
        title: 'Enviar localização',
        description: 'Busque um endereço e escolha o resultado para preencher o mapa automaticamente.',
        usage: '#send:location + #latitude + #longitude',
        addressSearch: true,
        fields: [
          field('name', 'Nome do local', { placeholder: 'Escritório' }),
          field('address', 'Endereço', {
            placeholder: 'Rua, número, cidade - UF',
            help: 'Para localizar o número corretamente, inclua também a cidade e o estado.'
          }),
          field('latitude', 'Latitude', { type: 'number', step: 'any', placeholder: '-23.5505', required: true }),
          field('longitude', 'Longitude', { type: 'number', step: 'any', placeholder: '-46.6333', required: true }),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999', full: true })
        ],
        build: (values) =>
          composeActionCommand(
            '#send:location',
            numberLine(values),
            actionDirective('name', values.name),
            actionDirective('address', values.address),
            actionDirective('latitude', requireActionValue(values, 'latitude', 'a latitude')),
            actionDirective('longitude', requireActionValue(values, 'longitude', 'a longitude'))
          ),
        preview: (values) => ({
          mediaLabel: 'Mapa da localização',
          header: values.name || 'Localização',
          detail: [values.address, `${values.latitude || 'latitude'}, ${values.longitude || 'longitude'}`]
            .filter(Boolean)
            .join('\n'),
          detailClass: 'za-preview-location'
        })
      },
      {
        id: 'send_status',
        directSend: true,
        category: 'Mensagens',
        title: 'Publicar status',
        description: 'Publica texto, imagem, vídeo ou áudio no Status do WhatsApp.',
        usage: '#send:status + #type:<tipo>',
        fields: [
          select('type', 'Tipo', [
            { value: 'text', label: 'Texto' },
            { value: 'image', label: 'Imagem' },
            { value: 'video', label: 'Vídeo' },
            { value: 'audio', label: 'Áudio' },
            { value: 'myaudio', label: 'Áudio enviado' },
            { value: 'ptt', label: 'Áudio PTT' }
          ]),
          field('file', 'URL da mídia', { placeholder: 'Obrigatória para status de mídia' }),
          field('text', 'Texto ou legenda', { type: 'textarea', rows: 4, full: true })
        ],
        build: (values) => {
          if (values.type === 'text') requireActionValue(values, 'text', 'o texto do status');
          else requireActionValue(values, 'file', 'a URL da mídia');
          return composeActionCommand(
            '#send:status',
            actionDirective('type', values.type),
            actionDirective('file', values.file),
            actionDirective('text', values.text, true)
          );
        },
        preview: (values) => ({
          mediaLabel: values.type === 'text' ? '' : `Status de ${values.type || 'mídia'}`,
          header: 'Status do WhatsApp',
          body: values.text || ''
        })
      },
      {
        id: 'send_menu',
        directSend: true,
        category: 'Interativos',
        title: 'Enviar menu, lista ou enquete',
        description: 'Cria botões, lista ou enquete com campos que mudam conforme o tipo escolhido.',
        usage: '#send:menu + #type + #select',
        customEditor: 'menu',
        fields: [
          select('type', 'Tipo', [
            { value: 'button', label: 'Botões' },
            { value: 'list', label: 'Lista' },
            { value: 'poll', label: 'Enquete' }
          ]),
          field('title', 'Título (opcional)'),
          field('text', 'Mensagem', { type: 'textarea', rows: 3, required: true, full: true }),
          field('footer', 'Rodapé (opcional)'),
          field('listbutton', 'Texto do botão da lista', { placeholder: 'Ver opções' }),
          field('selectablecount', 'Quantidade selecionável (enquete)', { type: 'number' }),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999' })
        ],
        build: (values) => {
          const choices = parseActionJsonArray(values.menu_items);
          if (!choices.length) throw new Error('Adicione pelo menos uma opção.');
          if (values.type === 'list' && !readString(values.listbutton)) {
            throw new Error('Informe o texto do botão da lista.');
          }
          if (values.type === 'poll' && choices.length < 2) {
            throw new Error('Adicione pelo menos duas opções para a enquete.');
          }
          if (values.type === 'poll') {
            requireActionValue(values, 'title', 'a pergunta da enquete');
          }

          if (values.type === 'button') {
            if (choices.length > 10) throw new Error('Use no máximo 10 botões.');
            const hasCallToAction = choices.some((choice) =>
              ['URL', 'CALL', 'COPY'].includes(readString(choice?.action).toUpperCase())
            );
            if (hasCallToAction) {
              const cardText = cleanActionSegment(
                values.text || values.title || 'Escolha uma opção'
              );
              const buttons = choices.map((choice, index) => {
                const label = cleanActionSegment(choice?.label);
                const type = readString(choice?.action).toUpperCase() || 'REPLY';
                const value = cleanActionSegment(
                  choice?.value || (type === 'REPLY' ? makeActionId(label, `opcao_${index + 1}`) : '')
                );
                if (!label || !value) {
                  throw new Error(`Botão ${index + 1}: preencha o texto e o destino.`);
                }
                if (!['REPLY', 'URL', 'CALL', 'COPY'].includes(type)) {
                  throw new Error(`Botão ${index + 1}: escolha uma ação válida.`);
                }
                if (type === 'URL' && !/^https?:\/\//i.test(value)) {
                  throw new Error(`Botão ${index + 1}: informe uma URL completa.`);
                }
                if (type === 'CALL' && value.replace(/\D/g, '').length < 8) {
                  throw new Error(`Botão ${index + 1}: informe um telefone válido.`);
                }
                return actionDirective('button', [label, value, type].join('|'));
              });
              return composeActionCommand(
                '#send:carousel',
                numberLine(values),
                actionDirective('text', values.title || values.text, true),
                actionDirective('card', `${cardText}|||`),
                buttons
              );
            }
          }

          const choiceDirectives = [];
          for (const [index, choice] of choices.entries()) {
            const label = cleanActionSegment(choice?.label);
            if (!label) throw new Error(`Opção ${index + 1}: informe o texto.`);
            if (values.type === 'list') {
              const id = cleanActionSegment(choice?.value) || makeActionId(label, `opcao_${index + 1}`);
              const description = cleanActionSegment(choice?.description);
              const section = cleanActionSegment(choice?.section);
              if (section && section !== cleanActionSegment(choices[index - 1]?.section)) {
                choiceDirectives.push(actionDirective('select', `[${section}]`));
              }
              choiceDirectives.push(actionDirective('select', [label, id, description].join('|')));
            } else if (values.type === 'button') {
              const id = cleanActionSegment(choice?.value) || makeActionId(label, `opcao_${index + 1}`);
              choiceDirectives.push(actionDirective('select', `${label}|${id}`));
            } else {
              choiceDirectives.push(actionDirective('select', label));
            }
          }
          return composeActionCommand(
            '#send:menu',
            numberLine(values),
            actionDirective('type', values.type),
            actionDirective('title', values.title),
            values.type === 'poll'
              ? ''
              : actionDirective('text', requireActionValue(values, 'text', 'a mensagem'), true),
            choiceDirectives,
            values.type === 'poll' ? '' : actionDirective('footer', values.footer),
            values.type === 'list' ? actionDirective('listbutton', values.listbutton) : '',
            values.type === 'poll' ? actionDirective('selectablecount', values.selectablecount) : ''
          );
        },
        preview: (values) => {
          const type = values.type || 'button';
          const optionLabels = parseActionJsonArray(values.menu_items)
            .map((choice) => readString(choice?.label))
            .filter(Boolean)
            .slice(0, 10);
          if (type === 'list') {
            return {
              kind: 'list',
              header: values.title || '',
              body: values.text || 'Mensagem da lista',
              footer: values.footer || '',
              listButton: values.listbutton || 'Ver opções'
            };
          }
          if (type === 'poll') {
            return {
              kind: 'poll',
              header: values.title || 'Pergunta da enquete',
              body: '',
              pollOptions: optionLabels,
              selectableCount: values.selectablecount
            };
          }
          return {
            kind: 'button',
            header: values.title || '',
            body: values.text || 'Mensagem interativa',
            footer: values.footer || '',
            buttons: optionLabels
          };
        }
      },
      {
        id: 'send_carousel',
        directSend: true,
        category: 'Interativos',
        title: 'Enviar carrossel',
        description: 'Monta cada card e seus botões em campos simples, sem precisar escrever códigos.',
        usage: '#send:carousel + #card + #button',
        customEditor: 'carousel',
        fields: [
          field('text', 'Mensagem principal', { required: true, full: true }),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999', full: true })
        ],
        build: (values) => {
          const cards = parseActionJsonArray(values.carousel_cards);
          if (!cards.length) throw new Error('Adicione pelo menos um card.');
          if (cards.length > 10) throw new Error('Use no máximo 10 cards.');
          const directives = [];
          for (const [index, card] of cards.entries()) {
            const text = cleanActionSegment(card?.text);
            const media = cleanActionSegment(card?.media);
            const mediaType = cleanActionSegment(card?.mediaType);
            const filename = cleanActionSegment(card?.filename);
            const cardButtons = Array.isArray(card?.buttons) ? card.buttons : [];
            if (!text) throw new Error(`Card ${index + 1}: informe o texto.`);
            if (!cardButtons.length) throw new Error(`Card ${index + 1}: adicione um botão.`);
            if (cardButtons.length > 10) throw new Error(`Card ${index + 1}: use no máximo 10 botões.`);
            if (media && !/^https?:\/\//i.test(media)) {
              throw new Error(`Card ${index + 1}: informe uma URL de mídia completa.`);
            }
            directives.push(actionDirective('card', [text, media, mediaType, filename].join('|')));
            for (const [buttonIndex, button] of cardButtons.entries()) {
              const label = cleanActionSegment(button?.label);
              const type = readString(button?.type).toUpperCase() || 'REPLY';
              const value = cleanActionSegment(
                button?.value || (type === 'REPLY' ? makeActionId(label, `botao_${buttonIndex + 1}`) : '')
              );
              if (!label || !value) {
                throw new Error(`Card ${index + 1}, botão ${buttonIndex + 1}: preencha texto e destino.`);
              }
              if (!['REPLY', 'URL', 'CALL', 'COPY'].includes(type)) {
                throw new Error(`Card ${index + 1}, botão ${buttonIndex + 1}: escolha uma ação válida.`);
              }
              if (type === 'URL' && !/^https?:\/\//i.test(value)) {
                throw new Error(`Card ${index + 1}, botão ${buttonIndex + 1}: informe uma URL completa.`);
              }
              if (type === 'CALL' && value.replace(/\D/g, '').length < 8) {
                throw new Error(`Card ${index + 1}, botão ${buttonIndex + 1}: informe um telefone válido.`);
              }
              directives.push(actionDirective('button', [label, value, type].join('|')));
            }
          }
          return composeActionCommand(
            '#send:carousel',
            numberLine(values),
            actionDirective('text', requireActionValue(values, 'text', 'a mensagem principal'), true),
            directives
          );
        },
        preview: (values) => {
          const first = parseActionJsonArray(values.carousel_cards)[0] || {};
          return {
            mediaLabel: first.media ? 'Mídia do primeiro card' : '',
            header: values.text || 'Carrossel',
            body: first.text || 'Texto do primeiro card',
            buttons: (Array.isArray(first.buttons) ? first.buttons : [])
              .map((button) => readString(button?.label))
              .filter(Boolean)
          };
        }
      },
      {
        id: 'request_location',
        directSend: true,
        category: 'Interativos',
        title: 'Solicitar localização',
        description: 'Envia um botão para o cliente compartilhar a localização.',
        usage: '#send:location-button + #text',
        fields: [
          field('text', 'Mensagem', { value: 'Compartilhe sua localização.', required: true, full: true }),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999', full: true })
        ],
        build: (values) =>
          composeActionCommand(
            '#send:location-button',
            numberLine(values),
            actionDirective('text', requireActionValue(values, 'text', 'a mensagem'), true)
          ),
        preview: (values) => ({ body: values.text || 'Compartilhe sua localização.', buttons: ['Enviar localização'] })
      },
      {
        id: 'request_payment',
        directSend: true,
        category: 'Interativos',
        title: 'Solicitar pagamento',
        description: 'Envia uma cobrança com valor e dados opcionais de PIX, boleto ou link.',
        usage: '#send:request-payment + #amount:<valor>',
        fields: [
          field('title', 'Título', { placeholder: 'Pagamento do pedido' }),
          field('amount', 'Valor', { type: 'number', placeholder: '99.90', required: true }),
          field('text', 'Mensagem', { type: 'textarea', rows: 3, full: true }),
          field('itemname', 'Item (opcional)'),
          field('invoicenumber', 'Número da fatura (opcional)'),
          field('footer', 'Rodapé (opcional)'),
          select('pixtype', 'Tipo da chave PIX', [
            { value: '', label: 'Sem PIX' },
            { value: 'CPF', label: 'CPF' },
            { value: 'CNPJ', label: 'CNPJ' },
            { value: 'PHONE', label: 'Telefone' },
            { value: 'EMAIL', label: 'E-mail' },
            { value: 'EVP', label: 'Aleatória' }
          ]),
          field('pixkey', 'Chave PIX (opcional)'),
          field('paymentlink', 'Link de pagamento (opcional)', { placeholder: 'https://...' }),
          field('boletocode', 'Código do boleto (opcional)'),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999', full: true })
        ],
        build: (values) => {
          const amount = Number(String(requireActionValue(values, 'amount', 'o valor')).replace(',', '.'));
          if (!Number.isFinite(amount) || amount <= 0) throw new Error('Informe um valor maior que zero.');
          return composeActionCommand(
            '#send:request-payment',
            numberLine(values),
            actionDirective('title', values.title),
            actionDirective('text', values.text, true),
            actionDirective('itemname', values.itemname),
            actionDirective('invoicenumber', values.invoicenumber),
            actionDirective('amount', amount),
            actionDirective('pixtype', values.pixtype),
            actionDirective('pixkey', values.pixkey),
            actionDirective('paymentlink', values.paymentlink),
            actionDirective('boletocode', values.boletocode),
            actionDirective('footer', values.footer)
          );
        },
        preview: (values) => ({
          header: values.title || 'Solicitação de pagamento',
          body: values.text || values.itemname || 'Pagamento',
          detail: `Valor: R$ ${values.amount || '0,00'}`,
          detailClass: 'za-preview-payment',
          footer: values.footer || '',
          buttons: [values.paymentlink ? 'Abrir pagamento' : values.pixkey ? 'Copiar PIX' : 'Ver pagamento']
        })
      },
      {
        id: 'pix_button',
        directSend: true,
        category: 'Interativos',
        title: 'Enviar botão PIX',
        description: 'Envia um botão para copiar uma chave PIX.',
        usage: '#send:pix-button + #pixtype + #pixkey',
        fields: [
          select('pixtype', 'Tipo da chave', [
            { value: 'CPF', label: 'CPF' },
            { value: 'CNPJ', label: 'CNPJ' },
            { value: 'PHONE', label: 'Telefone' },
            { value: 'EMAIL', label: 'E-mail' },
            { value: 'EVP', label: 'Aleatória' }
          ]),
          field('pixkey', 'Chave PIX', { required: true }),
          field('pixname', 'Nome do recebedor (opcional)'),
          field('number', 'Número de destino (opcional)', { placeholder: '5511999999999' })
        ],
        build: (values) =>
          composeActionCommand(
            '#send:pix-button',
            numberLine(values),
            actionDirective('pixtype', values.pixtype),
            actionDirective('pixkey', requireActionValue(values, 'pixkey', 'a chave PIX')),
            actionDirective('pixname', values.pixname)
          ),
        preview: (values) => ({
          header: values.pixname || 'Pagamento via PIX',
          detail: `${values.pixtype || 'PIX'}: ${values.pixkey || 'chave'}`,
          detailClass: 'za-preview-payment',
          buttons: ['Copiar chave PIX']
        })
      },
      {
        id: 'presence',
        category: 'Mensagens',
        title: 'Alterar presença',
        description: 'Exibe digitando, gravando ou pausa por um intervalo.',
        usage: '#send:presence + #presence:<estado>',
        fields: [
          select('presence', 'Estado', [
            { value: 'composing', label: 'Digitando' },
            { value: 'recording', label: 'Gravando áudio' },
            { value: 'paused', label: 'Pausado' }
          ]),
          field('delay', 'Duração/atraso em ms (opcional)', { type: 'number', value: '3000' })
        ],
        build: (values) =>
          composeActionCommand(
            '#send:presence',
            actionDirective('presence', values.presence),
            actionDirective('delay', values.delay)
          ),
        preview: adminPreview('Esta ação altera temporariamente o indicador de presença; ela não envia uma bolha de mensagem.')
      },
      {
        id: 'sync_contact',
        category: 'Contato',
        title: 'Atualizar dados do contato',
        description: 'Sincroniza os dados disponíveis do contato atual.',
        usage: '#attcontact',
        fields: [],
        build: () => '#attcontact',
        preview: adminPreview('Os dados do contato atual serão sincronizados.'),
        confirm: true
      },
      {
        id: 'sync_contact_picture',
        category: 'Contato',
        title: 'Atualizar foto do contato',
        description: 'Sincroniza a foto de perfil do contato atual.',
        usage: '#attpic',
        fields: [],
        build: () => '#attpic',
        preview: adminPreview('A foto de perfil do contato atual será sincronizada.'),
        confirm: true
      },
      {
        id: 'create_group',
        category: 'Grupos',
        title: 'Criar grupo',
        description: 'Cria um grupo com nome e participantes informados.',
        usage: '#creategroup + #name + #participants',
        fields: [
          field('name', 'Nome do grupo', { required: true, full: true }),
          field('participants', 'Participantes', {
            type: 'textarea',
            rows: 4,
            required: true,
            full: true,
            placeholder: '5511999999999\n5511888888888',
            help: 'Um número por linha ou separados por vírgula.'
          })
        ],
        build: (values) =>
          composeActionCommand(
            '#creategroup',
            actionDirective('name', requireActionValue(values, 'name', 'o nome do grupo')),
            actionDirective(
              'participants',
              requireActionValue(values, 'participants', 'os participantes').replace(/[\s;]+/g, ',')
            )
          ),
        preview: adminPreview('Um novo grupo será criado com os participantes informados.'),
        confirm: true
      },
      {
        id: 'group_description',
        category: 'Grupos',
        title: 'Alterar descrição do grupo',
        description: 'Atualiza a descrição de um grupo.',
        usage: '#attdescription + #number + #description',
        fields: [
          groupField(),
          field('description', 'Nova descrição', { type: 'textarea', rows: 4, required: true, full: true })
        ],
        build: (values) =>
          composeActionCommand(
            '#attdescription',
            groupLine(values),
            actionDirective('description', requireActionValue(values, 'description', 'a descrição'), true)
          ),
        preview: adminPreview('A descrição do grupo será atualizada.'),
        confirm: true
      },
      {
        id: 'group_name',
        category: 'Grupos',
        title: 'Alterar nome do grupo',
        description: 'Atualiza o nome de um grupo.',
        usage: '#attgroupname + #number + #name',
        fields: [groupField(), field('name', 'Novo nome', { required: true, full: true })],
        build: (values) =>
          composeActionCommand(
            '#attgroupname',
            groupLine(values),
            actionDirective('name', requireActionValue(values, 'name', 'o novo nome'))
          ),
        preview: adminPreview('O nome do grupo será atualizado.'),
        confirm: true
      },
      {
        id: 'group_invite_link',
        category: 'Grupos',
        title: 'Obter link de convite',
        description: 'Obtém o link do grupo e, opcionalmente, envia para outro número.',
        usage: '#groupinvitelink + #number + #send',
        fields: [groupField(), field('send', 'Enviar link para (opcional)', { placeholder: '5511999999999', full: true })],
        build: (values) =>
          composeActionCommand('#groupinvitelink', groupLine(values), actionDirective('send', values.send)),
        preview: adminPreview('O sistema retornará o link de convite do grupo informado.')
      },
      {
        id: 'reset_group_invite_link',
        category: 'Grupos',
        title: 'Redefinir link de convite',
        description: 'Invalida o link atual e gera um novo link para o grupo.',
        usage: '#resetgroupinvitelink + #number + #send',
        fields: [groupField(), field('send', 'Enviar novo link para (opcional)', { placeholder: '5511999999999', full: true })],
        build: (values) =>
          composeActionCommand('#resetgroupinvitelink', groupLine(values), actionDirective('send', values.send)),
        preview: adminPreview('O link atual será invalidado e substituído por um novo.'),
        confirm: true,
        danger: true
      },
      {
        id: 'group_permissions',
        category: 'Grupos',
        title: 'Permissões de edição do grupo',
        description: 'Define se apenas administradores podem alterar as configurações do grupo.',
        usage: '#attgrouppermissions:true|false + #number',
        fields: [
          groupField(),
          select('locked', 'Quem altera configurações', [
            { value: 'true', label: 'Somente administradores' },
            { value: 'false', label: 'Todos os participantes' }
          ], { full: true })
        ],
        build: (values) =>
          composeActionCommand(`#attgrouppermissions:${values.locked}`, groupLine(values)),
        preview: adminPreview('As permissões de edição das configurações do grupo serão atualizadas.'),
        confirm: true
      },
      {
        id: 'group_send_messages',
        category: 'Grupos',
        title: 'Permissão para enviar mensagens',
        description: 'Define se somente administradores ou todos podem enviar mensagens.',
        usage: '#attgroupsendmessages:true|false + #number',
        fields: [
          groupField(),
          select('announce', 'Quem pode enviar', [
            { value: 'true', label: 'Somente administradores' },
            { value: 'false', label: 'Todos os participantes' }
          ], { full: true })
        ],
        build: (values) =>
          composeActionCommand(`#attgroupsendmessages:${values.announce}`, groupLine(values)),
        preview: adminPreview('A permissão para enviar mensagens no grupo será atualizada.'),
        confirm: true
      },
      {
        id: 'group_participants',
        category: 'Grupos',
        title: 'Gerenciar participantes',
        description: 'Adiciona, remove, promove, rebaixa, aprova ou rejeita participantes.',
        usage: '#attgroupparticipants + #action + #participants',
        fields: [
          groupField(),
          select('action', 'Ação', [
            { value: 'add', label: 'Adicionar' },
            { value: 'remove', label: 'Remover' },
            { value: 'promote', label: 'Promover a administrador' },
            { value: 'demote', label: 'Remover de administrador' },
            { value: 'approve', label: 'Aprovar entrada' },
            { value: 'reject', label: 'Rejeitar entrada' }
          ], { full: true }),
          field('participants', 'Participantes', {
            type: 'textarea',
            rows: 4,
            required: true,
            full: true,
            placeholder: '5511999999999\n5511888888888'
          })
        ],
        build: (values) =>
          composeActionCommand(
            '#attgroupparticipants',
            groupLine(values),
            actionDirective('action', values.action),
            actionDirective(
              'participants',
              requireActionValue(values, 'participants', 'os participantes').replace(/[\s;]+/g, ',')
            )
          ),
        preview: adminPreview('A ação selecionada será aplicada aos participantes informados.'),
        confirm: true
      },
      {
        id: 'group_info',
        category: 'Grupos',
        title: 'Consultar dados do grupo',
        description: 'Retorna as informações do grupo informado.',
        usage: '#getgroupinfo + #number',
        fields: [groupField()],
        build: (values) => composeActionCommand('#getgroupinfo', groupLine(values)),
        preview: adminPreview('O sistema retornará as informações do grupo.')
      },
      {
        id: 'group_invite_info',
        category: 'Grupos',
        title: 'Consultar convite de grupo',
        description: 'Consulta os dados de um link ou código de convite.',
        usage: '#getgroupinviteinfo:<link ou codigo>',
        fields: [field('invite', 'Link ou código do convite', { required: true, full: true })],
        build: (values) =>
          `#getgroupinviteinfo:${cleanActionLine(requireActionValue(values, 'invite', 'o convite'))}`,
        preview: adminPreview('O sistema retornará os dados públicos do convite informado.')
      },
      {
        id: 'group_join',
        category: 'Grupos',
        title: 'Entrar em grupo',
        description: 'Faz a instância entrar em um grupo usando um convite.',
        usage: '#groupjoin:<link ou codigo>',
        fields: [field('invite', 'Link ou código do convite', { required: true, full: true })],
        build: (values) => `#groupjoin:${cleanActionLine(requireActionValue(values, 'invite', 'o convite'))}`,
        preview: adminPreview('A instância entrará no grupo vinculado ao convite.'),
        confirm: true
      },
      {
        id: 'group_leave',
        category: 'Grupos',
        title: 'Sair do grupo',
        description: 'Remove a instância do grupo informado.',
        usage: '#groupleave + #number',
        fields: [groupField()],
        build: (values) => composeActionCommand('#groupleave', groupLine(values)),
        preview: adminPreview('A instância sairá do grupo informado.'),
        confirm: true,
        danger: true
      },
      {
        id: 'group_picture',
        category: 'Grupos',
        title: 'Alterar foto do grupo',
        description: 'Atualiza a foto do grupo usando uma URL pública de imagem.',
        usage: '#attpicgroup + #number + #url',
        fields: [
          groupField(),
          field('url', 'URL da imagem', { placeholder: 'https://...', required: true, full: true })
        ],
        build: (values) =>
          composeActionCommand(
            '#attpicgroup',
            groupLine(values),
            actionDirective('url', requireActionValue(values, 'url', 'a URL da imagem'))
          ),
        preview: adminPreview('A foto do grupo será substituída pela imagem informada.'),
        confirm: true
      }
    ];
    return items.map((item) =>
      item.directSend ? { ...item, advancedFields: advancedDeliveryFields } : item
    );
  }

  async function fetchWhatsAppActionInstances(locationId, force) {
    if (
      !force &&
      whatsappActionsState.locationId === locationId &&
      Date.now() - whatsappActionsState.loadedAt < 20_000
    ) {
      return whatsappActionsState.instances.slice();
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), TEMPLATE_REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(ACTIONS_INSTANCES_EDGE_URL);
      url.searchParams.set('location_id', locationId);
      const response = await fetch(url.toString(), {
        method: 'GET',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'x-wavoip-location-id': locationId
        }
      });
      const raw = await response.text().catch(() => '');
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
      if (!response.ok || !payload?.ok) {
        throw new Error(readString(payload?.error) || `Falha ao buscar instâncias (HTTP ${response.status}).`);
      }
      const instances = normalizeOfficialInstanceNames(payload);
      whatsappActionsState.instances = instances;
      whatsappActionsState.locationId = locationId;
      whatsappActionsState.loadedAt = Date.now();
      return instances.slice();
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async function copyActionCommand(command) {
    const text = readString(command);
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Comando copiado.', 'success', 2200);
      return true;
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand('copy');
      helper.remove();
      showToast(copied ? 'Comando copiado.' : 'Não foi possível copiar o comando.', copied ? 'success' : 'error', 2400);
      return copied;
    }
  }

  function setActionFieldVisible(wrappers, key, visible) {
    const wrapper = wrappers?.[key];
    if (wrapper instanceof HTMLElement) wrapper.hidden = !visible;
  }

  function normalizeAddressPart(value) {
    return readString(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/^av\b/, 'avenida')
      .replace(/^r\b/, 'rua')
      .replace(/^rod\b/, 'rodovia')
      .replace(/^(?:tv|trav)\b/, 'travessa')
      .replace(/^estr\b/, 'estrada')
      .trim();
  }

  function parseAddressQuery(value) {
    const query = normalizeWhitespace(value);
    const patterns = [
      /^(.+?),\s*(?:n(?:[º°o])?\.?\s*)?(\d{1,6}[a-z]?(?:[-/]\d{1,4})?)(?:\s*[,;-]\s*(.+))?$/i,
      /^(.+?)\s+(?:n(?:[º°o])?\.?\s*)?(\d{1,6}[a-z]?(?:[-/]\d{1,4})?)\s*[,;-]\s*(.+)$/i,
      /^(.+?)\s+(?:n(?:[º°o])?\.?\s*)?(\d{1,6}[a-z]?(?:[-/]\d{1,4})?)$/i,
      /^(.+)\s+(?:n(?:[º°o])?\.?\s*)?(\d{1,6}[a-z]?(?:[-/]\d{1,4})?)\s+(.+)$/i
    ];
    let match = null;
    for (const pattern of patterns) {
      match = query.match(pattern);
      if (match) break;
    }
    if (!match) return { query, street: '', houseNumber: '', city: '', state: '' };

    const street = normalizeWhitespace(match[1]).replace(/[,;-]+$/g, '').trim();
    const houseNumber = readString(match[2]);
    const locality = normalizeWhitespace(match[3]);
    const localityParts = locality
      .split(/\s*[,;]\s*|\s+-\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    let state = '';
    if (localityParts.length) {
      const lastPart = localityParts[localityParts.length - 1];
      const stateMatch = lastPart.match(/(?:^|\s)([a-z]{2})$/i);
      if (stateMatch) {
        state = stateMatch[1].toUpperCase();
        const withoutState = lastPart.slice(0, stateMatch.index).trim();
        if (withoutState) localityParts[localityParts.length - 1] = withoutState;
        else localityParts.pop();
      }
    }
    return {
      query,
      street,
      houseNumber,
      city: localityParts[localityParts.length - 1] || '',
      state
    };
  }

  function scoreAddressFeature(properties, expected, source) {
    const data = properties || {};
    const expectedStreet = normalizeAddressPart(expected?.street);
    const expectedNumber = normalizeAddressPart(expected?.houseNumber);
    const expectedCity = normalizeAddressPart(expected?.city);
    const street = normalizeAddressPart(data.street || data.name);
    const combinedStreet = normalizeAddressPart([data.street, data.name].filter(Boolean).join(' '));
    const houseNumber = normalizeAddressPart(data.housenumber);
    const nameTokens = normalizeAddressPart(data.name).split(/\s+/).filter(Boolean);
    const exactHouseNumber = Boolean(
      expectedNumber && (houseNumber === expectedNumber || nameTokens.includes(expectedNumber))
    );
    const exactStreet = Boolean(
      expectedStreet &&
        street &&
        (street === expectedStreet ||
          (combinedStreet && combinedStreet.startsWith(expectedStreet)) ||
          expectedStreet.startsWith(street))
    );
    const relatedStreet = Boolean(
      expectedStreet &&
        street &&
        (exactStreet ||
          (combinedStreet && combinedStreet.includes(expectedStreet)) ||
          expectedStreet.includes(street))
    );
    const city = normalizeAddressPart(data.city || data.town || data.village);
    let score = source === 'structured' ? 4 : 0;
    if (exactHouseNumber) score += 120;
    else if (expectedNumber && houseNumber) score -= 15;
    if (exactStreet) score += 80;
    else if (relatedStreet) score += 35;
    else if (expectedStreet) score -= 25;
    if (expectedCity && city === expectedCity) score += 45;
    else if (expectedCity && (city.includes(expectedCity) || expectedCity.includes(city))) score += 20;
    if (
      ADDRESS_COUNTRY_CODE &&
      readString(data.countrycode).toUpperCase() === ADDRESS_COUNTRY_CODE
    ) {
      score += 10;
    }
    return { score, exactHouseNumber, exactStreet, relatedStreet };
  }

  function formatAddressResult(properties, expected, exactHouseNumber) {
    const data = properties || {};
    const displayNumber =
      exactHouseNumber && readString(expected?.houseNumber)
        ? readString(expected.houseNumber)
        : readString(data.housenumber);
    const street = [data.street, displayNumber].map(readString).filter(Boolean).join(', ');
    const primary = readString(data.name) || street || readString(data.district || data.city);
    const locality = [data.district, data.city || data.town || data.village, data.state]
      .map(readString)
      .filter(Boolean)
      .join(', ');
    const country = [data.postcode, data.country].map(readString).filter(Boolean).join(' - ');
    const parts = [];
    const seen = new Set();
    for (const part of [primary, street, locality, country]) {
      const text = readString(part);
      const key = normalizeAddressPart(text);
      if (!text || !key || seen.has(key)) continue;
      seen.add(key);
      parts.push(text);
    }
    return {
      name: primary,
      address: parts.join(' - ')
    };
  }

  function setupAddressSearch({ controls, host, update }) {
    const addressInput = controls.address;
    if (!(addressInput instanceof HTMLInputElement)) return () => {};

    const title = document.createElement('div');
    title.className = 'za-builder-header';
    title.textContent = 'Sugestões de endereço';
    const status = document.createElement('p');
    status.className = 'za-form-help za-builder-status';
    status.textContent = 'Digite pelo menos 4 caracteres no campo Endereço.';
    const resultsHost = document.createElement('div');
    resultsHost.className = 'za-address-results';
    const attribution = document.createElement('p');
    attribution.className = 'za-address-attribution';
    attribution.textContent = 'Resultados: OpenStreetMap / Photon';
    host.append(title, status, resultsHost, attribution);

    const cache = new Map();
    let timer = null;
    let controller = null;
    let active = true;

    const renderResults = (results) => {
      resultsHost.replaceChildren();
      for (const result of results) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'za-address-result';
        const strong = document.createElement('strong');
        strong.textContent = result.name || 'Endereço encontrado';
        const detail = document.createElement('span');
        detail.textContent = result.address;
        button.append(strong, detail);
        button.addEventListener('click', () => {
          addressInput.value = result.address;
          if (controls.name instanceof HTMLInputElement && !readString(controls.name.value)) {
            controls.name.value = result.name;
          }
          if (controls.latitude instanceof HTMLInputElement) {
            controls.latitude.value = String(result.latitude);
          }
          if (controls.longitude instanceof HTMLInputElement) {
            controls.longitude.value = String(result.longitude);
          }
          resultsHost.replaceChildren();
          status.textContent = 'Endereço selecionado. Latitude e longitude preenchidas automaticamente.';
          update();
        });
        resultsHost.appendChild(button);
      }
    };

    const search = async () => {
      const query = normalizeWhitespace(addressInput.value);
      const parsedQuery = parseAddressQuery(query);
      const resultStatus = (results) => {
        if (!results.length) {
          return 'Nenhum endereço encontrado. Tente incluir cidade e estado.';
        }
        if (
          parsedQuery.houseNumber &&
          !results.some((result) => result.exactHouseNumber)
        ) {
          return 'Não encontramos o número exato. Inclua cidade e estado ou confira as sugestões próximas.';
        }
        return 'Selecione um endereço abaixo e confirme o número.';
      };
      if (query.length < 4) {
        resultsHost.replaceChildren();
        status.textContent = 'Digite pelo menos 4 caracteres no campo Endereço.';
        return;
      }
      if (cache.has(query.toLowerCase())) {
        const cached = cache.get(query.toLowerCase());
        renderResults(cached);
        status.textContent = resultStatus(cached);
        return;
      }

      controller?.abort();
      controller = new AbortController();
      status.textContent = 'Buscando endereços...';
      try {
        const freeSearchUrl = new URL(ADDRESS_SEARCH_URL);
        freeSearchUrl.searchParams.set('q', query);
        freeSearchUrl.searchParams.set('limit', '10');
        freeSearchUrl.searchParams.set('dedupe', '0');
        if (ADDRESS_COUNTRY_CODE) {
          freeSearchUrl.searchParams.set('countrycode', ADDRESS_COUNTRY_CODE);
        }
        if (parsedQuery.houseNumber) {
          freeSearchUrl.searchParams.set('layer', 'house');
        }

        const searches = [{ url: freeSearchUrl, source: 'free' }];
        if (parsedQuery.street && parsedQuery.houseNumber) {
          const structuredUrl = new URL(ADDRESS_SEARCH_URL);
          structuredUrl.pathname = structuredUrl.pathname.replace(/\/api\/?$/i, '/structured');
          structuredUrl.search = '';
          structuredUrl.searchParams.set('street', parsedQuery.street);
          structuredUrl.searchParams.set('housenumber', parsedQuery.houseNumber);
          structuredUrl.searchParams.set('limit', '10');
          structuredUrl.searchParams.set('dedupe', '0');
          if (parsedQuery.city) structuredUrl.searchParams.set('city', parsedQuery.city);
          if (parsedQuery.state) structuredUrl.searchParams.set('state', parsedQuery.state);
          if (ADDRESS_COUNTRY_CODE) {
            structuredUrl.searchParams.set('countrycode', ADDRESS_COUNTRY_CODE);
          }
          searches.push({ url: structuredUrl, source: 'structured' });
        }

        const payloads = await Promise.all(
          searches.map(async (searchRequest) => {
            try {
              const response = await fetch(searchRequest.url.toString(), {
                method: 'GET',
                credentials: 'omit',
                signal: controller.signal,
                headers: { Accept: 'application/geo+json, application/json' }
              });
              if (!response.ok) return null;
              return {
                source: searchRequest.source,
                payload: await response.json()
              };
            } catch (error) {
              if (error?.name === 'AbortError') throw error;
              return null;
            }
          })
        );
        if (!active) return;
        if (!payloads.some(Boolean)) throw new Error('ADDRESS_SEARCH_UNAVAILABLE');

        let results = payloads
          .filter(Boolean)
          .flatMap(({ payload, source }) =>
            (Array.isArray(payload?.features) ? payload.features : []).map((feature) => ({
              feature,
              source
            }))
          )
          .map(({ feature, source }) => {
            const coordinates = Array.isArray(feature?.geometry?.coordinates)
              ? feature.geometry.coordinates
              : [];
            const scoreData = scoreAddressFeature(feature?.properties, parsedQuery, source);
            const formatted = formatAddressResult(
              feature?.properties,
              parsedQuery,
              scoreData.exactHouseNumber
            );
            const longitude = Number(coordinates[0]);
            const latitude = Number(coordinates[1]);
            if (!formatted.address || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
              return null;
            }
            return {
              ...formatted,
              ...scoreData,
              latitude,
              longitude,
              resultKey: [
                readString(feature?.properties?.osm_type),
                readString(feature?.properties?.osm_id),
                longitude.toFixed(6),
                latitude.toFixed(6)
              ].join(':')
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);

        if (parsedQuery.street) {
          const related = results.filter((result) => result.relatedStreet);
          if (related.length) results = related;
        }
        const seenResults = new Set();
        results = results
          .filter((result) => {
            if (seenResults.has(result.resultKey)) return false;
            seenResults.add(result.resultKey);
            return true;
          })
          .slice(0, 5);
        cache.set(query.toLowerCase(), results);
        renderResults(results);
        status.textContent = resultStatus(results);
      } catch (error) {
        if (error?.name === 'AbortError' || !active) return;
        resultsHost.replaceChildren();
        status.textContent = 'Não foi possível buscar endereços agora. Você ainda pode preencher as coordenadas.';
      }
    };

    const onInput = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void search(), 750);
    };
    addressInput.addEventListener('input', onInput);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller?.abort();
      addressInput.removeEventListener('input', onInput);
    };
  }

  function setupMenuActionEditor({ controls, wrappers, host, update }) {
    const typeSelect = controls.type;
    if (!(typeSelect instanceof HTMLSelectElement)) return () => {};
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    controls.menu_items = hidden;
    host.appendChild(hidden);

    const states = {
      button: [{ label: '', action: 'REPLY', value: '' }],
      list: [{ label: '', value: '', description: '', section: '' }],
      poll: [{ label: '' }, { label: '' }]
    };
    const heading = document.createElement('div');
    heading.className = 'za-builder-header';
    const list = document.createElement('div');
    list.className = 'za-builder-list';
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'za-btn za-builder-add';
    host.append(heading, list, addButton);

    const sync = () => {
      hidden.value = JSON.stringify(states[typeSelect.value] || []);
      update();
    };

    const render = () => {
      const type = typeSelect.value || 'button';
      const items = states[type] || [];
      setActionFieldVisible(wrappers, 'title', true);
      setActionFieldVisible(wrappers, 'text', type !== 'poll');
      setActionFieldVisible(wrappers, 'footer', type !== 'poll');
      setActionFieldVisible(wrappers, 'listbutton', type === 'list');
      setActionFieldVisible(wrappers, 'selectablecount', type === 'poll');
      const titleLabel = wrappers.title?.querySelector('.za-label');
      if (titleLabel) titleLabel.textContent = type === 'poll' ? 'Pergunta da enquete' : 'Título (opcional)';
      if (controls.title) controls.title.required = type === 'poll';
      if (controls.text) controls.text.required = type !== 'poll';
      heading.textContent = type === 'button' ? 'Botões' : type === 'list' ? 'Itens da lista' : 'Opções da enquete';
      addButton.textContent = type === 'button' ? 'Adicionar botão' : type === 'list' ? 'Adicionar item' : 'Adicionar opção';
      addButton.disabled = items.length >= (type === 'button' ? 10 : type === 'list' ? 10 : 12);
      list.replaceChildren();

      items.forEach((item, index) => {
        const card = document.createElement('section');
        card.className = 'za-builder-card';
        const cardHead = document.createElement('div');
        cardHead.className = 'za-builder-card-head';
        const cardTitle = document.createElement('strong');
        cardTitle.textContent = `${type === 'button' ? 'Botão' : type === 'list' ? 'Item' : 'Opção'} ${index + 1}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'za-builder-remove';
        remove.textContent = 'Remover';
        remove.disabled = items.length <= (type === 'poll' ? 2 : 1);
        remove.addEventListener('click', () => {
          items.splice(index, 1);
          render();
        });
        cardHead.append(cardTitle, remove);
        const grid = document.createElement('div');
        grid.className = 'za-builder-grid';

        const addField = (key, label, options) => {
          const control = createFormControl({ label, value: item[key] || '', ...(options || {}) });
          control.input.addEventListener('input', () => {
            item[key] = control.input.value;
            sync();
          });
          control.input.addEventListener('change', () => {
            item[key] = control.input.value;
            if (key === 'action') render();
            else sync();
          });
          grid.appendChild(control.wrapper);
        };

        if (type === 'button') {
          addField('label', 'Texto do botão', { placeholder: 'Saiba mais', required: true });
          addField('action', 'Ao clicar', {
            type: 'select',
            options: [
              { value: 'REPLY', label: 'Enviar uma resposta' },
              { value: 'URL', label: 'Abrir um link' },
              { value: 'CALL', label: 'Ligar para um telefone' },
              { value: 'COPY', label: 'Copiar um código' }
            ],
            help: 'Até 10 botões. Links, ligações e cópia usam carrossel; na API Oficial, respostas simples continuam limitadas a 3 pelo WhatsApp.'
          });
          const labels = {
            REPLY: ['ID da resposta (opcional)', 'saiba_mais'],
            URL: ['Link completo', 'https://...'],
            CALL: ['Telefone', '+5511999999999'],
            COPY: ['Texto para copiar', 'CUPOM10']
          };
          const valueConfig = labels[item.action || 'REPLY'];
          addField('value', valueConfig[0], { placeholder: valueConfig[1], full: true });
        } else if (type === 'list') {
          addField('label', 'Título do item', { required: true });
          addField('value', 'ID da resposta (opcional)', { placeholder: 'opcao_1' });
          addField('description', 'Descrição (opcional)', { full: true });
          addField('section', 'Seção (opcional)', { placeholder: 'Produtos', full: true });
        } else {
          addField('label', 'Texto da opção', { required: true, full: true });
        }
        card.append(cardHead, grid);
        list.appendChild(card);
      });
      sync();
    };

    const onTypeChange = () => render();
    typeSelect.addEventListener('change', onTypeChange);
    addButton.addEventListener('click', () => {
      const type = typeSelect.value || 'button';
      const items = states[type];
      if (type === 'button' && items.length < 10) items.push({ label: '', action: 'REPLY', value: '' });
      if (type === 'list' && items.length < 10) items.push({ label: '', value: '', description: '', section: '' });
      if (type === 'poll' && items.length < 12) items.push({ label: '' });
      render();
    });
    render();
    return () => typeSelect.removeEventListener('change', onTypeChange);
  }

  function setupCarouselActionEditor({ controls, host, update }) {
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    controls.carousel_cards = hidden;
    const heading = document.createElement('div');
    heading.className = 'za-builder-header';
    heading.textContent = 'Cards do carrossel';
    const list = document.createElement('div');
    list.className = 'za-builder-list';
    const addCard = document.createElement('button');
    addCard.type = 'button';
    addCard.className = 'za-btn za-builder-add';
    addCard.textContent = 'Adicionar card';
    host.append(hidden, heading, list, addCard);

    const cards = [
      {
        text: '',
        media: '',
        mediaType: 'image',
        filename: '',
        buttons: [{ label: '', type: 'REPLY', value: '' }]
      }
    ];
    const sync = () => {
      hidden.value = JSON.stringify(cards);
      addCard.disabled = cards.length >= 10;
      update();
    };

    const render = () => {
      list.replaceChildren();
      cards.forEach((cardData, cardIndex) => {
        const card = document.createElement('section');
        card.className = 'za-builder-card za-carousel-builder-card';
        const head = document.createElement('div');
        head.className = 'za-builder-card-head';
        const title = document.createElement('strong');
        title.textContent = `Card ${cardIndex + 1}`;
        const removeCard = document.createElement('button');
        removeCard.type = 'button';
        removeCard.className = 'za-builder-remove';
        removeCard.textContent = 'Remover card';
        removeCard.disabled = cards.length === 1;
        removeCard.addEventListener('click', () => {
          cards.splice(cardIndex, 1);
          render();
        });
        head.append(title, removeCard);

        const grid = document.createElement('div');
        grid.className = 'za-builder-grid';
        const addCardField = (key, label, options) => {
          const control = createFormControl({ label, value: cardData[key] || '', ...(options || {}) });
          const save = () => {
            cardData[key] = control.input.value;
            sync();
          };
          control.input.addEventListener('input', save);
          control.input.addEventListener('change', save);
          grid.appendChild(control.wrapper);
        };
        addCardField('text', 'Texto do card', { type: 'textarea', rows: 2, required: true, full: true });
        addCardField('media', 'URL da mídia (opcional)', { placeholder: 'https://...', full: true });
        addCardField('mediaType', 'Tipo da mídia', {
          type: 'select',
          options: [
            { value: 'image', label: 'Imagem' },
            { value: 'video', label: 'Vídeo' },
            { value: 'document', label: 'Documento' }
          ]
        });
        addCardField('filename', 'Nome do arquivo (opcional)', { placeholder: 'imagem.jpg' });

        const buttonArea = document.createElement('div');
        buttonArea.className = 'za-builder-subsection';
        const buttonTitle = document.createElement('strong');
        buttonTitle.textContent = 'Botões deste card';
        buttonArea.appendChild(buttonTitle);
        cardData.buttons.forEach((buttonData, buttonIndex) => {
          const row = document.createElement('div');
          row.className = 'za-builder-button-row';
          const buttonGrid = document.createElement('div');
          buttonGrid.className = 'za-builder-grid';
          const addButtonField = (key, label, options) => {
            const control = createFormControl({ label, value: buttonData[key] || '', ...(options || {}) });
            control.input.addEventListener('input', () => {
              buttonData[key] = control.input.value;
              sync();
            });
            control.input.addEventListener('change', () => {
              buttonData[key] = control.input.value;
              if (key === 'type') render();
              else sync();
            });
            buttonGrid.appendChild(control.wrapper);
          };
          addButtonField('label', 'Texto do botão', { required: true });
          addButtonField('type', 'Ação', {
            type: 'select',
            options: [
              { value: 'REPLY', label: 'Enviar uma resposta' },
              { value: 'URL', label: 'Abrir um link' },
              { value: 'CALL', label: 'Ligar para um telefone' },
              { value: 'COPY', label: 'Copiar um código' }
            ]
          });
          const labels = {
            REPLY: ['ID da resposta (opcional)', 'opcao_1'],
            URL: ['Link completo', 'https://...'],
            CALL: ['Telefone', '+5511999999999'],
            COPY: ['Texto para copiar', 'CUPOM10']
          };
          const valueConfig = labels[buttonData.type || 'REPLY'];
          addButtonField('value', valueConfig[0], { placeholder: valueConfig[1], full: true });
          const removeButton = document.createElement('button');
          removeButton.type = 'button';
          removeButton.className = 'za-builder-remove';
          removeButton.textContent = 'Remover botão';
          removeButton.disabled = cardData.buttons.length === 1;
          removeButton.addEventListener('click', () => {
            cardData.buttons.splice(buttonIndex, 1);
            render();
          });
          row.append(buttonGrid, removeButton);
          buttonArea.appendChild(row);
        });
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'za-btn za-builder-add';
        addButton.textContent = 'Adicionar botão ao card';
        addButton.disabled = cardData.buttons.length >= 10;
        addButton.addEventListener('click', () => {
          if (cardData.buttons.length < 10) {
            cardData.buttons.push({ label: '', type: 'REPLY', value: '' });
            render();
          }
        });
        buttonArea.appendChild(addButton);
        card.append(head, grid, buttonArea);
        list.appendChild(card);
      });
      sync();
    };

    addCard.addEventListener('click', () => {
      if (cards.length >= 10) return;
      cards.push({
        text: '',
        media: '',
        mediaType: 'image',
        filename: '',
        buttons: [{ label: '', type: 'REPLY', value: '' }]
      });
      render();
    });
    render();
    return () => {};
  }

  function openWhatsAppActionsModal() {
    if (typeof whatsappActionsState.activeClose === 'function') return;
    const locationId = getCurrentLocationId();
    if (!locationId) {
      showToast('Não foi possível identificar a subconta atual.', 'error', 3000);
      return;
    }

    const frame = createDialogFrame(
      'A\u00e7\u00f5es WhatsApp',
      'Escolha uma ação, preencha os dados e confira o comando antes de usar.'
    );
    frame.card.classList.add('za-actions-modal');
    const { overlay, body, footer } = frame;
    let closed = false;
    let instances =
      whatsappActionsState.locationId === locationId ? whatsappActionsState.instances.slice() : [];
    let catalog = getWhatsAppActionCatalog(instances);
    let selectedId = catalog[0]?.id || '';
    let editorCleanup = null;

    const layout = document.createElement('div');
    layout.className = 'za-actions-layout';
    const sidebar = document.createElement('aside');
    sidebar.className = 'za-actions-sidebar';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'za-actions-search';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'za-input';
    search.placeholder = 'Buscar ação ou comando...';
    search.setAttribute('aria-label', 'Buscar ação do WhatsApp');
    const instanceStatus = document.createElement('p');
    instanceStatus.className = 'za-form-help';
    instanceStatus.textContent = instances.length
      ? `${instances.length} ${instances.length === 1 ? 'instância disponível' : 'instâncias disponíveis'}.`
      : 'Carregando instâncias...';
    searchWrap.append(search, instanceStatus);
    const optionsHost = document.createElement('div');
    sidebar.append(searchWrap, optionsHost);
    const editor = document.createElement('section');
    editor.className = 'za-actions-editor';
    layout.append(sidebar, editor);
    body.appendChild(layout);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'za-btn';
    closeButton.textContent = 'Fechar';
    footer.appendChild(closeButton);

    const renderOptions = () => {
      optionsHost.replaceChildren();
      const query = normalizeWhitespace(search.value).toLowerCase();
      const filtered = catalog.filter((item) =>
        [item.title, item.description, item.usage, item.category].join(' ').toLowerCase().includes(query)
      );
      let lastCategory = '';
      for (const item of filtered) {
        if (item.category !== lastCategory) {
          lastCategory = item.category;
          const category = document.createElement('h4');
          category.className = 'za-actions-category';
          category.textContent = lastCategory;
          optionsHost.appendChild(category);
        }
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `za-action-option ${item.id === selectedId ? 'selected' : ''}`;
        const title = document.createElement('strong');
        title.textContent = item.title;
        const summary = document.createElement('span');
        summary.textContent = item.usage;
        option.append(title, summary);
        option.addEventListener('click', () => {
          selectedId = item.id;
          renderOptions();
          renderEditor();
        });
        optionsHost.appendChild(option);
      }
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'za-template-empty';
        empty.textContent = 'Nenhuma ação corresponde à busca.';
        optionsHost.appendChild(empty);
      }
    };

    const renderEditor = () => {
      if (typeof editorCleanup === 'function') editorCleanup();
      editorCleanup = null;
      editor.replaceChildren();
      const item = catalog.find((entry) => entry.id === selectedId) || catalog[0];
      if (!item) return;
      selectedId = item.id;

      const heading = document.createElement('h3');
      heading.className = 'za-action-heading';
      heading.textContent = item.title;
      const description = document.createElement('p');
      description.className = 'za-action-description';
      description.textContent = item.description;
      const usage = document.createElement('div');
      usage.className = 'za-template-meta';
      usage.textContent = `Formato: ${item.usage}`;
      const form = document.createElement('div');
      form.className = 'za-form-grid';
      const controls = {};
      const wrappers = {};
      for (const definition of item.fields || []) {
        const control = createFormControl(definition);
        controls[definition.key] = control.input;
        wrappers[definition.key] = control.wrapper;
        form.appendChild(control.wrapper);
      }
      let customEditorHost = null;
      if (item.customEditor || item.addressSearch) {
        customEditorHost = document.createElement('section');
        customEditorHost.className = 'za-builder-host';
        form.appendChild(customEditorHost);
      }
      if (item.advancedFields?.length) {
        const advanced = document.createElement('details');
        advanced.className = 'za-action-advanced';
        const advancedTitle = document.createElement('summary');
        advancedTitle.textContent = 'Opções avançadas de envio';
        const advancedGrid = document.createElement('div');
        advancedGrid.className = 'za-form-grid';
        for (const definition of item.advancedFields) {
          const control = createFormControl(definition);
          controls[definition.key] = control.input;
          wrappers[definition.key] = control.wrapper;
          advancedGrid.appendChild(control.wrapper);
        }
        advanced.append(advancedTitle, advancedGrid);
        form.appendChild(advanced);
      }

      const errorBox = document.createElement('div');
      errorBox.className = 'za-form-error';
      errorBox.hidden = true;
      const commandOutput = document.createElement('textarea');
      commandOutput.className = 'za-command-output';
      commandOutput.readOnly = true;
      commandOutput.setAttribute('aria-label', 'Comando gerado');
      const buttons = document.createElement('div');
      buttons.className = 'za-command-actions';
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'za-btn';
      copyButton.textContent = 'Copiar';
      const insertButton = document.createElement('button');
      insertButton.type = 'button';
      insertButton.className = 'za-btn';
      insertButton.textContent = 'Inserir no campo';
      const sendButton = document.createElement('button');
      sendButton.type = 'button';
      sendButton.className = `za-btn ${item.danger ? 'danger' : 'primary'}`;
      sendButton.textContent = 'Enviar agora';
      buttons.append(copyButton, insertButton, sendButton);
      const previewSection = document.createElement('section');
      previewSection.className = 'za-command-preview';
      const previewTitle = document.createElement('h4');
      previewTitle.className = 'za-template-preview-title';
      previewTitle.textContent = 'Prévia';
      const previewHost = document.createElement('div');
      previewSection.append(previewTitle, previewHost);
      editor.append(heading, description, usage, form, errorBox, commandOutput, buttons, previewSection);

      const readValues = () =>
        Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value]));
      const update = () => {
        const values = readValues();
        let command = '';
        let error = '';
        try {
          command = item.build(values);
          if (item.directSend) {
            command = composeActionCommand(command, buildActionDeliveryDirectives(values));
          }
        } catch (caught) {
          error = readString(caught?.message) || 'Revise os dados da ação.';
        }
        commandOutput.value = command;
        errorBox.hidden = !error;
        errorBox.textContent = error;
        copyButton.disabled = !command;
        insertButton.disabled = !command;
        sendButton.disabled = !command;
        previewHost.replaceChildren();
        const preview = item.preview ? item.preview(values) : null;
        if (preview?.admin) {
          const admin = document.createElement('div');
          admin.className = 'za-admin-preview';
          admin.textContent = preview.admin;
          previewHost.appendChild(admin);
        } else if (preview) {
          renderGenericWhatsAppPreview(previewHost, preview);
        }
      };

      const editorCleanups = [];
      if (item.addressSearch && customEditorHost) {
        editorCleanups.push(
          setupAddressSearch({ controls, host: customEditorHost, update })
        );
      }
      if (item.customEditor === 'menu' && customEditorHost) {
        editorCleanups.push(
          setupMenuActionEditor({ controls, wrappers, host: customEditorHost, update })
        );
      }
      if (item.customEditor === 'carousel' && customEditorHost) {
        editorCleanups.push(
          setupCarouselActionEditor({ controls, host: customEditorHost, update })
        );
      }
      editorCleanup = () => {
        for (const dispose of editorCleanups) {
          if (typeof dispose === 'function') dispose();
        }
      };

      for (const input of Object.values(controls)) {
        input.addEventListener('input', update);
        input.addEventListener('change', update);
      }
      copyButton.addEventListener('click', () => void copyActionCommand(commandOutput.value));
      insertButton.addEventListener('click', async () => {
        const command = commandOutput.value;
        if (!command) return;
        cleanup();
        await writeAndSendCommand(command, {
          autoSend: false,
          readyMessage: 'Comando pronto no campo. Revise e clique em enviar.'
        });
      });
      sendButton.addEventListener('click', async () => {
        const command = commandOutput.value;
        if (!command) return;
        const confirmed = await showModernConfirm({
          title: `Enviar: ${item.title}?`,
          message: item.confirm
            ? 'Esta ação altera dados ou configurações no WhatsApp. Confirme para continuar.'
            : 'O comando será enviado agora na conversa atual.',
          confirmText: 'Enviar agora',
          cancelText: 'Cancelar',
          danger: item.danger === true
        });
        if (!confirmed || closed) return;
        cleanup();
        await writeAndSendCommand(command, { autoSend: true });
      });
      update();
    };

    function cleanup() {
      if (closed) return;
      closed = true;
      if (typeof editorCleanup === 'function') editorCleanup();
      editorCleanup = null;
      whatsappActionsState.activeClose = null;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    }

    function onKeydown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cleanup();
    }

    search.addEventListener('input', renderOptions);
    closeButton.addEventListener('click', cleanup);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup();
    });
    whatsappActionsState.activeClose = cleanup;
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeydown, true);
    renderOptions();
    renderEditor();

    void fetchWhatsAppActionInstances(locationId)
      .then((rows) => {
        if (closed) return;
        instances = rows;
        catalog = getWhatsAppActionCatalog(instances);
        instanceStatus.textContent = instances.length
          ? `${instances.length} ${instances.length === 1 ? 'instância disponível' : 'instâncias disponíveis'}.`
          : 'Nenhuma instância encontrada nesta subconta.';
        renderOptions();
        renderEditor();
      })
      .catch((error) => {
        if (closed) return;
        instanceStatus.textContent =
          error?.name === 'AbortError'
            ? 'Tempo esgotado ao buscar instâncias.'
            : readString(error?.message) || 'Falha ao buscar instâncias.';
      });
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

  function ensureWhatsAppActionsButton() {
    const locationId = getCurrentLocationId();
    const existingWrapper = document.getElementById(WHATSAPP_ACTIONS_WRAPPER_ID);

    if (!locationId) {
      if (existingWrapper) existingWrapper.remove();
      if (typeof whatsappActionsState.activeClose === 'function') {
        whatsappActionsState.activeClose();
      }
      return;
    }

    const target = findTemplateToolbar();
    if (!target?.toolbar) return;
    const templateWrapper = document.getElementById(TEMPLATE_BUTTON_WRAPPER_ID);

    if (existingWrapper instanceof HTMLElement) {
      if (templateWrapper?.parentElement === target.toolbar) {
        if (templateWrapper.nextElementSibling !== existingWrapper) {
          templateWrapper.insertAdjacentElement('afterend', existingWrapper);
        }
      } else if (existingWrapper.parentElement !== target.toolbar) {
        target.toolbar.prepend(existingWrapper);
      }
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = WHATSAPP_ACTIONS_WRAPPER_ID;
    Object.assign(wrapper.style, {
      display: 'inline-flex',
      alignItems: 'center',
      marginLeft: '2px',
      marginRight: '2px'
    });

    const button = document.createElement('button');
    button.id = WHATSAPP_ACTIONS_BUTTON_ID;
    button.type = 'button';
    button.title = 'A\u00e7\u00f5es WhatsApp';
    button.setAttribute('aria-label', 'A\u00e7\u00f5es WhatsApp');
    button.innerHTML = `
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6h2M10 6h10M4 12h9M17 12h3M4 18h4M12 18h8" />
        <circle cx="8" cy="6" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="10" cy="18" r="2" />
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
      openWhatsAppActionsModal();
    });

    wrapper.appendChild(button);
    if (templateWrapper?.parentElement === target.toolbar) {
      templateWrapper.insertAdjacentElement('afterend', wrapper);
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
      subtitle: 'Não foi possível identificar o ID automaticamente.',
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
          message: 'Já existe texto no campo. Deseja substituir pelo comando da ação?',
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

      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 80));
        const sendButton = findSendButtonNearInput(composer);
        const disabled =
          sendButton?.hasAttribute('disabled') ||
          readString(sendButton?.getAttribute('aria-disabled')).toLowerCase() === 'true';
        if (sendButton instanceof HTMLElement && !disabled) {
          sendButton.click();
          showToast('Comando enviado.', 'success', 2200);
          return true;
        }
      }

      showToast('Não encontrei o botão de envio. O comando ficou pronto no campo.', 'error', 3200);
      return true;
    };

    const composer = resolveComposerInput();
    if (!composer) {
      showToast('Não encontrei o campo de mensagem para inserir o comando.', 'error', 3000);
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
          void fillComposer(expanded, shouldAutoSend);
          return;
        }
        if (attempts < maxAttempts) {
          setTimeout(tryFillExpanded, 120);
          return;
        }
        showToast('Não foi possível abrir o campo de mensagem para inserir o comando.', 'error', 3200);
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
        log('Erro ao executar ação', error);
        showToast('Falha ao executar a ação da mensagem.', 'error', 3000);
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
        if (typeof whatsappActionsState.activeClose === 'function') {
          whatsappActionsState.activeClose();
        }
      }
      injectMenuActions();
      ensureTemplateButton();
      ensureWhatsAppActionsButton();
    } catch (error) {
      log('Tick error', error);
    }
  }

  document.addEventListener('pointerdown', onPointerCapture, true);
  document.addEventListener('click', onPointerCapture, true);

  const observer = new MutationObserver(() => {
    injectMenuActions();
    ensureTemplateButton();
    ensureWhatsAppActionsButton();
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
    openWhatsAppActionsModal,
    resolveMessageContext: () => resolveMessageContext(document.getElementById(DETAILS_ACTION_ID)),
    buildCommand
  };
})();
