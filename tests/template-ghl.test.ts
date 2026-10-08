import assert from 'node:assert/strict';
import vm from 'node:vm';
import { JSDOM } from 'npm:jsdom@26.1.0';

const source = await Deno.readTextFile(new URL('../src/zaptos-actions-original.js', import.meta.url));
const workflowUrl = 'https://app.zaptos.com.br/v2/location/test/automation/workflow/example';
function setup(html = '', url = workflowUrl) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.closest('[hidden]') ? null : this.parentElement; }
  });
  const context = {
    window, document: window.document, location: window.location,
    Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement, Event: window.Event,
    TextEncoder, URL, crypto, btoa, setTimeout, clearTimeout
  };
  vm.runInNewContext(source.slice(0, source.lastIndexOf("  document.addEventListener('pointerdown'")) + `
    window.test = { getWhatsAppActionCatalog, setupMenuActionEditor, createFormControl, serializeTemplateParams, useOfficialTemplate, findWorkflowSmsContext,
      ensureTemplateButton, ensureWhatsAppActionsButton, writeAndSendCommand,
      setWriter: (fn) => { writeAndSendCommand = fn; },
      setConfirm: (fn) => { showModernConfirm = fn; } };
    showToast = () => {};
  })();`, context);
  return { dom, window, document: window.document, api: (window as any).test };
}

function decode(value: string) {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
}

Deno.test('dynamic parameters stay visible for GHL; static parameters retain the legacy format', () => {
  const { api, dom } = setup();
  const parameters = {
    header: ['Olá {{contact.first_name}}'],
    body: ['{{contact.phone}}', '{{contact.first_name}}', 'Fixo "João" 😀\nsegunda linha'],
    buttons: [{ index: 0, values: ['{{ custom_values.calendar_link }}'] }],
    location: { latitude: -23.5, longitude: -46.6, name: '{{contact.city}}' }
  };
  const transport = api.serializeTemplateParams(parameters);
  const [header, ...lines] = transport.split('\n');
  const match = header.match(/^ghl1:([a-f0-9]{32}):([A-Za-z0-9_-]+)$/);
  assert.ok(match);
  const structure = decode(match[2]);
  assert.deepEqual(structure.body, [{ $value: 1 }, { $value: 2 }, { $value: 3 }]);
  assert.equal(structure.location.latitude, -23.5);
  for (const token of ['{{contact.first_name}}', '{{contact.phone}}', '{{ custom_values.calendar_link }}']) {
    assert.ok(transport.includes(token));
  }
  assert.equal(lines.filter((line: string) => line === `--template-${match[1]}--`).length, 6);
  assert.equal(/zaptos/i.test(transport), false);
  const staticParameters = { body: ['Diego', 'João 😀\n"aspas"'] };
  assert.deepEqual(decode(api.serializeTemplateParams(staticParameters)), staticParameters);
  dom.window.close();
});

const sms = (editor = '<textarea id="sms-message"></textarea>') => `
  <aside id="sms-panel"><input id="action-name" value="SMS">
    <section><div id="message-label"><label>Mensagem</label>
      <button id="pg-sms-ai__btn--build-ai">Escreva com AI</button>
    </div><div>${editor}</div></section>
    <button id="save-action">Salvar ação</button>
  </aside><textarea id="unrelated"></textarea>`;

// Estrutura relevante do HTML fornecido pelo usuário; omite SVGs e estilos inline.
const workflowSmsPanel = `
  <div class="sidebar-container"><div data-test-id="aside-section">
    <div id="action-configuration-panel" data-action-type="sms"><fieldset><div><form>
      <div class="px-6"><input data-testid="sms-action-name-input" value="SMS">
        <div><div class="w-full mt-4 text-left"><div class="mt-1 relative rounded-md shadow-sm">
          <div class="flex items-center justify-between mb-2"><label>Mensagem</label>
            <button id="pg-sms-ai__btn--build-ai">Escreva com AI</button>
          </div><div class="flex gap-3"><div class="flex-1">
            <div class="hr-wrapper-container workflow-frontend" id="content"><div class="hr-config-provider">
              <div class="ghl-workflow-text-style-editor"></div>
              <div class="editor-container ghl-workflow-text-editor"><div class="editor-wrapper">
                <div class="tiptap ProseMirror editor-class-override" contenteditable="true" tabindex="0"><p>Mensagem atual</p></div>
              </div></div>
            </div></div>
          </div></div>
        </div></div></div>
        <input id="sms-media-upload-dropdown-file-input" type="file" hidden>
        <div id="sms-urlAttachment"><div class="tiptap ProseMirror cv-tiptap-input__prosemirror" contenteditable="true" tabindex="0"><p>https://example.test/file.pdf</p></div></div>
        <input id="sms-test-phone" type="tel"><button id="sms-send-test">Enviar SMS de teste</button>
      </div>
    </form></div></fieldset></div>
    <button id="pg-actions__btn--save-action-sms">Salvar ação</button>
  </div></div>`;

Deno.test('supplied SMS panel targets the message TipTap, preserves attachment URL and dispatches editor input', async () => {
  const { api, document, dom } = setup(workflowSmsPanel);
  api.ensureTemplateButton();
  const context = api.findWorkflowSmsContext();
  const editor = document.querySelector('.ghl-workflow-text-editor .tiptap');
  const attachment = document.querySelector('#sms-urlAttachment .tiptap');
  assert.equal(context.composer, editor);
  attachment.focus();
  let inputEvents = 0;
  editor.addEventListener('input', () => inputEvents++);
  for (const button of document.querySelectorAll('#sms-send-test, #pg-actions__btn--save-action-sms')) {
    button.addEventListener('click', () => { throw new Error('must not save or send'); });
  }
  // jsdom não implementa execCommand. Emula apenas a inserção nativa na seleção.
  document.execCommand = (_command: string, _ui: boolean, value: string) => {
    const range = dom.window.getSelection().getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(value));
    return true;
  };
  api.setConfirm(() => true);
  assert.equal(await api.useOfficialTemplate('Oficial', { templateName: 'teste' }, { body: ['{{contact.first_name}}'] }, null, context), true);
  assert.match(editor.textContent, /#template:teste\n#templateparams:ghl1:/);
  assert.ok(editor.textContent.includes('{{contact.first_name}}'));
  assert.equal(/zaptos/i.test(editor.textContent), false);
  assert.equal(attachment.textContent, 'https://example.test/file.pdf');
  assert.equal(inputEvents, 1);
  editor.remove();
  api.ensureTemplateButton();
  assert.ok(document.getElementById('zaptos-waba-template-btn'));
  assert.equal(api.findWorkflowSmsContext(), null);
  dom.window.close();
});

Deno.test('SMS button sits beside AI, is unique across rerenders and disappears outside the SMS node', () => {
  const { api, document, window, dom } = setup(sms());
  assert.equal(api.findWorkflowSmsContext().composer.id, 'sms-message');
  api.ensureTemplateButton();
  api.ensureTemplateButton();
  api.ensureWhatsAppActionsButton();
  assert.equal(document.querySelectorAll('#zaptos-waba-template-btn').length, 1);
  assert.equal(document.getElementById('pg-sms-ai__btn--build-ai')!.previousElementSibling!.id, 'zaptos-waba-template-wrapper');
  assert.match(document.getElementById('zaptos-waba-template-btn')!.textContent!, /Templates/);
  assert.equal(document.getElementById('zaptos-whatsapp-actions-btn'), null);
  document.getElementById('sms-panel')!.remove();
  api.ensureTemplateButton();
  assert.equal(api.findWorkflowSmsContext(), null);
  document.body.insertAdjacentHTML('afterbegin', sms('<textarea id="new-message"></textarea>'));
  api.ensureTemplateButton();
  assert.equal(api.findWorkflowSmsContext().composer.id, 'new-message');
  assert.equal(document.querySelectorAll('#zaptos-waba-template-btn').length, 1);
  window.history.pushState({}, '', '/v2/location/test/contacts');
  api.ensureTemplateButton();
  assert.equal(api.findWorkflowSmsContext(), null);
  assert.equal(document.getElementById('zaptos-waba-template-btn'), null);
  dom.window.close();
});

Deno.test('workflow writes the SMS, dispatches events and never clicks Save or Send', async () => {
  const { api, document, dom } = setup(sms());
  const context = api.findWorkflowSmsContext();
  const events: string[] = [];
  context.composer.addEventListener('input', () => events.push('input'));
  context.composer.addEventListener('change', () => events.push('change'));
  document.getElementById('save-action')!.addEventListener('click', () => { throw new Error('must not save'); });
  document.getElementById('unrelated')!.focus();
  const template = { templateName: 'agendamento_confirmado' };
  assert.equal(await api.useOfficialTemplate('Oficial', template, { body: Array(4).fill('{{contact.first_name}}') }, null, context), true);
  assert.match(context.composer.value, /^#switch:Oficial\n#template:agendamento_confirmado\n#templateparams:ghl1:/);
  assert.equal(context.composer.value.split('{{contact.first_name}}').length - 1, 4);
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(document.getElementById('action-name').value, 'SMS');
  assert.equal(document.getElementById('unrelated').value, '');
  document.getElementById('sms-panel')!.remove();
  assert.equal(await api.useOfficialTemplate('Oficial', template, {}, null, context), false);
  dom.window.close();
});

Deno.test('SMS shortcut appears before the editor mounts and never selects an unrelated field', () => {
  const { api, document, dom } = setup(sms('<div id="editor-loading"></div>'));
  document.getElementById('unrelated').remove();
  api.ensureTemplateButton();
  assert.equal(document.getElementById('zaptos-waba-template-wrapper').parentElement.id, 'message-label');
  assert.equal(api.findWorkflowSmsContext(), null);
  document.getElementById('editor-loading').innerHTML = '<textarea id="sms-loaded"></textarea>';
  api.ensureTemplateButton();
  assert.equal(api.findWorkflowSmsContext().composer.id, 'sms-loaded');
  assert.equal(document.querySelectorAll('#zaptos-waba-template-btn').length, 1);
  dom.window.close();
});

Deno.test('hidden duplicate SMS panel does not hide the shortcut on the active node', () => {
  const { api, document, dom } = setup('<div hidden>' + sms() + '</div>' + sms('<textarea id="active-message"></textarea>'));
  api.ensureTemplateButton();
  assert.equal(api.findWorkflowSmsContext().composer.id, 'active-message');
  assert.equal(document.getElementById('zaptos-waba-template-wrapper').closest('[hidden]'), null);
  dom.window.close();
});

Deno.test('rich editor is selected over hidden textarea; changing nodes during confirmation cancels insertion', async () => {
  const { api, document, dom } = setup(sms('<textarea hidden></textarea><div id="rich" contenteditable="true"><p>Atual</p></div>'));
  const context = api.findWorkflowSmsContext();
  assert.equal(context.composer.id, 'rich');
  api.setConfirm(() => { document.getElementById('sms-panel')!.remove(); return true; });
  assert.equal(await api.useOfficialTemplate('Oficial', { templateName: 'teste' }, {}, null, context), false);
  assert.equal(context.composer.textContent, 'Atual');
  dom.window.close();
});

Deno.test('conversation toolbar retains its icon after workflow navigation', () => {
  const { api, document, window, dom } = setup(sms());
  api.ensureTemplateButton();
  window.history.pushState({}, '', '/v2/location/test/conversations');
  document.body.insertAdjacentHTML('beforeend', '<div id="conversation-tools"><div id="zaptos-rec-wrapper"></div></div>');
  api.ensureTemplateButton();
  api.ensureWhatsAppActionsButton();
  const wrapper = document.getElementById('zaptos-waba-template-wrapper');
  assert.equal(wrapper.parentElement.id, 'conversation-tools');
  assert.equal(wrapper.previousElementSibling.id, 'zaptos-rec-wrapper');
  assert.equal(wrapper.nextElementSibling.id, 'zaptos-whatsapp-actions-wrapper');
  assert.equal(wrapper.querySelector('span'), null);
  assert.equal(wrapper.querySelector('button').style.width, '28px');
  dom.window.close();
});

Deno.test('all published distributions initialize the supplied SMS panel with the same version', async () => {
  for (const file of ['zaptos-actions-original.js', 'zaptos-actions-Criptografado.min.js', 'zaptos-actions-Criptografado.js', 'zaptos-actions.js']) {
    const dom = new JSDOM(workflowSmsPanel, { url: workflowUrl, runScripts: 'outside-only' });
    const { window } = dom;
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return this.parentElement; } });
    window.setInterval = () => 0;
    const observers: any[] = [];
    const errors: unknown[] = [];
    window.addEventListener('error', (event: any) => errors.push(event.error));
    window.MutationObserver = class extends window.MutationObserver {
      constructor(callback: any) { super(callback); observers.push(this); }
    };
    try {
      window.eval(await Deno.readTextFile(new URL(`../src/${file}`, import.meta.url)));
      await Promise.resolve();
      assert.equal(window.document.querySelectorAll('#zaptos-waba-template-btn').length, 1, file);
      assert.equal(window.document.getElementById('pg-sms-ai__btn--build-ai').previousElementSibling.id, 'zaptos-waba-template-wrapper', file);
      assert.equal(typeof (window as any)._zaptosMessageActions.openOfficialTemplatePicker, 'function', file);
      assert.equal((window as any)._zaptosMessageActions.version, '2026.10.08.1', file);
      assert.deepEqual(errors, [], file);
    } finally {
      observers.forEach((observer) => observer.disconnect());
      window.close();
    }
  }
});

Deno.test('menu editor switches all button actions without changing the selected menu type', () => {
  const { api, dom, document, window } = setup();
  const menu = api.getWhatsAppActionCatalog([]).find((item: any) => item.id === 'send_menu');
  const controls: Record<string, any> = {};
  const wrappers: Record<string, any> = {};
  for (const field of menu.fields) {
    const control = api.createFormControl(field);
    controls[field.key] = control.input;
    wrappers[field.key] = control.wrapper;
    document.body.append(control.wrapper);
  }
  const host = document.createElement('div');
  document.body.append(host);
  controls.type.value = 'button';
  const cleanup = api.setupMenuActionEditor({ controls, wrappers, host, update: () => {} });
  try {
    for (const [action, value, expected] of [
      ['URL', 'https://example.com', 'https://example.com'],
      ['CALL', '+55 (11) 99999-9999', 'call:+5511999999999'],
      ['COPY', 'CUPOM10', 'copy:CUPOM10'],
      ['REPLY', 'sim', 'sim'],
    ]) {
      const select = host.querySelector('select')!;
      select.value = action;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const inputs = host.querySelectorAll('.za-builder-grid input');
      (inputs[0] as any).value = 'Ação';
      inputs[0].dispatchEvent(new window.Event('input', { bubbles: true }));
      (inputs[1] as any).value = value;
      inputs[1].dispatchEvent(new window.Event('input', { bubbles: true }));
      assert.equal(controls.type.value, 'button');
      const command = menu.build({ menu_api: 'unofficial', type: controls.type.value, text: 'Escolha', menu_items: controls.menu_items.value });
      assert.match(command, /^#send:menu\n/);
      const choices = JSON.parse(command.split('\n').find((line: string) => line.startsWith('#choices:')).slice(9));
      assert.deepEqual(choices, [`Ação|${expected}`]);
    }
    controls.type.value = 'list';
    controls.type.dispatchEvent(new window.Event('change'));
    controls.type.value = 'button';
    controls.type.dispatchEvent(new window.Event('change'));
    assert.equal(JSON.parse(controls.menu_items.value)[0].value, 'sim');
  } finally {
    cleanup();
    dom.window.close();
  }
});
