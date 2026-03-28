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

  const state = {
    lastPointerTarget: null,
    lastPointerAt: 0,
    lastLikelyMenuTrigger: null,
    lastLikelyMenuTriggerAt: 0,
    lastContext: null,
    lastHref: location.href
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

  function ensureMessageId(context) {
    const fromContext = normalizeManualMessageId(context?.messageId);
    if (fromContext) return fromContext;
    const fromState = normalizeManualMessageId(state.lastContext?.messageId);
    if (fromState) return fromState;

    const fallback = window.prompt(
      'Nao consegui identificar automaticamente o ID da mensagem. Cole o ID:',
      ''
    );
    return normalizeManualMessageId(fallback);
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

  function resolveComposerInput() {
    return findComposerInput();
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

  function writeAndSendCommand(command) {
    const composer = resolveComposerInput();
    if (!composer) {
      alert('Nao encontrei o campo de mensagem para enviar o comando.');
      return false;
    }

    const currentValue = normalizeWhitespace(getInputText(composer));
    if (currentValue && currentValue !== normalizeWhitespace(command)) {
      const confirmed = window.confirm(
        'Ja existe texto no composer. Deseja substituir esse texto pelo comando da acao?'
      );
      if (!confirmed) return false;
    }

    setInputText(composer, command);

    const sendButton = findSendButtonNearInput(composer);
    if (sendButton instanceof HTMLElement) {
      sendButton.click();
      return true;
    }

    alert('Comando pronto no campo. Clique em enviar para concluir.');
    return true;
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

  function runDeleteAction(context) {
    const messageId = ensureMessageId(context);
    if (!messageId) return;

    const confirmed = window.confirm(`Confirmar apagar mensagem (${messageId})?`);
    if (!confirmed) return;

    const command = buildCommand('delete', messageId);
    if (!command) return;
    writeAndSendCommand(command);
  }

  function runReactAction(context) {
    const messageId = ensureMessageId(context);
    if (!messageId) return;

    const optionsText = REACTION_EMOJIS.map((emoji, idx) => `${idx + 1}=${emoji}`).join('  ');
    const reaction = window.prompt(
      `Escolha uma reacao (${optionsText})\nDigite o numero ou o emoji:`,
      REACTION_EMOJIS[0]
    );
    if (reaction == null) return;

    const pickedIndex = Number(reaction);
    const fromIndex =
      Number.isInteger(pickedIndex) &&
      pickedIndex >= 1 &&
      pickedIndex <= REACTION_EMOJIS.length
        ? REACTION_EMOJIS[pickedIndex - 1]
        : reaction;

    const emoji = normalizeMessagePayload(fromIndex);
    if (!emoji) return;

    const command = buildCommand('react', messageId, emoji);
    if (!command) return;
    writeAndSendCommand(command);
  }

  function runEditAction(context) {
    const messageId = ensureMessageId(context);
    if (!messageId) return;

    const defaultText = readString(
      context?.messageText || state.lastContext?.messageText || ''
    );
    const editedText = window.prompt('Digite o novo texto da mensagem:', defaultText);
    if (editedText == null) return;

    const payload = normalizeMessagePayload(editedText);
    if (!payload) {
      alert('Texto vazio. Edicao cancelada.');
      return;
    }

    const command = buildCommand('edit', messageId, payload);
    if (!command) return;
    writeAndSendCommand(command);
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
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        const context = getOrResolveMenuContext(menuRoot, detailsAction);
        handler(context);
      } catch (error) {
        log('Erro ao executar acao', error);
        alert('Falha ao executar a acao da mensagem.');
      } finally {
        closeContextMenu();
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
