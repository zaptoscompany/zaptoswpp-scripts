// Node 24+. Integration uses the adjacent receiver checkout, or ZAPTOS_RECEIVER_SOURCE.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/zaptos-actions-original.js', import.meta.url), 'utf8');
const ui = { URL, window: {}, location: { href: 'https://crm.example/location/test' } };
vm.runInNewContext(source.slice(0, source.lastIndexOf("  document.addEventListener('pointerdown'")) +
  '\nwindow.catalog = getWhatsAppActionCatalog([]);\n})();', ui);
const menu = ui.window.catalog.find((item) => item.id === 'send_menu');
const receiverSource = readFileSync(process.env.ZAPTOS_RECEIVER_SOURCE ||
  new URL('../../zaptoswppSupabase/ghl_in-redis.ts', import.meta.url), 'utf8');
const receiverJS = stripTypeScriptTypes(receiverSource);
const names = ['normalizeOptionalString', 'normalizeBoolean', 'isHttpUrl', 'decodeEscapedString',
  'parseSelectEntries', 'parseUazHashDirectives', 'decodeDirectiveRaw', 'firstDirective',
  'allDirectiveValues', 'applyDirectiveString', 'applyDirectiveNumber', 'applyDirectiveBoolean',
  'buildUazCommandPayload', 'validateUazDirectPayload', 'normalizeStringArray',
  'canonicalizeUazDirectPayload', 'applyCanonicalString', 'applyCanonicalNumber', 'applyUazCommonAliases',
  'normalizeUazMentions', 'officialSendMenu', 'slugifyListRowId', 'ensureUniqueListRowId',
  'buildListSectionsFromChoices', 'buildCarouselCardsFromDirectives', 'splitDirectivePipe',
  'inferCarouselButtonType', 'normalizeCarouselButtonId', 'attachCarouselMedia'];
const receiver = vm.createContext({ URL, console, officialSendMessage: async (_inst, _number, payload) => payload });
const functions = names.map((name) => {
  const match = receiverJS.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(match, name);
  return receiverJS.slice(match.index, receiverJS.indexOf('\n}', match.index) + 2);
}).join('\n');
vm.runInContext(receiverJS.match(/^const UAZ_\w+_TYPES = .*$/gm).join('\n') + '\n' + functions, receiver);
const plain = (value) => JSON.parse(JSON.stringify(value));
function build(items, extra = {}) {
  return menu.build({ type: 'button', title: 'Título', text: 'Olá\nEscolha', footer: 'Rodapé',
    number: '5511999999999', menu_items: JSON.stringify(items), ...extra });
}
function parse(command) {
  const p = receiver.parseUazHashDirectives(command);
  const raw = receiver.buildUazCommandPayload('menu', p.directives, p.entries, p.remaining);
  const payload = receiver.canonicalizeUazDirectPayload('menu', raw, p.remaining);
  assert.equal(receiver.validateUazDirectPayload('menu', payload), null);
  return plain(payload);
}
async function official(payload) {
  return plain(await receiver.officialSendMenu({}, '5511999999999', payload, null));
}

test('link remains menu, has choices and becomes an official CTA URL', async () => {
  const url = 'https://example.com/?items=a,b&name=d\'agua';
  const command = build([{ label: 'Abrir site', action: 'URL', value: url }]);
  assert.match(command, /^#send:menu\n/);
  assert.doesNotMatch(command, /#send:carousel|#card:|#button:/);
  const payload = parse(command);
  assert.deepEqual(payload.choices, [`Abrir site|${url}`]);
  assert.equal(payload.text, 'Título\nOlá\nEscolha');
  assert.equal(payload.footerText, 'Rodapé');
  assert.equal(payload.number, '5511999999999');
  const result = await official(payload);
  assert.equal(result.interactive.type, 'cta_url');
  assert.deepEqual(result.interactive.action, { name: 'cta_url', parameters: { display_text: 'Abrir site', url } });
});

test('nonofficial mixed actions retain destinations, commas, quotes and backslashes', async () => {
  const payload = parse(build([
    { label: 'Sim, aceito', action: 'REPLY', value: 'sim' },
    { label: 'Site', action: 'URL', value: 'https://example.com' },
    { label: 'Ligar', action: 'CALL', value: '+5511999999999' },
    { label: 'Copiar', action: 'COPY', value: 'D\'água "10", C:\\novo' },
  ]));
  assert.deepEqual(payload.choices, ['Sim, aceito|sim', 'Site|https://example.com',
    'Ligar|call:+5511999999999', 'Copiar|copy:D\'água "10", C:\\novo']);
  await assert.rejects(official(payload), /OFFICIAL_MENU_TYPE_NOT_SUPPORTED/);
});

test('reply buttons work officially, with limit enforced', async () => {
  const payload = parse(build([{ label: 'Sim' }, { label: 'Não' }, { label: 'Depois' }]));
  const result = await official(payload);
  assert.equal(result.interactive.type, 'button');
  assert.deepEqual(result.interactive.action.buttons.map((b) => b.reply.id), ['sim', 'nao', 'depois']);
  await assert.rejects(official({ ...payload, choices: [...payload.choices, 'Outro|outro'] }), /LIMIT_EXCEEDED/);
});

test('lists retain sections and descriptions; polls retain question and choices', async () => {
  const list = parse(build([{ label: 'Produto', value: 'produto', section: 'Catálogo', description: 'Novo, hoje' }],
    { type: 'list', listbutton: 'Ver opções' }));
  assert.deepEqual(list.choices, ['[Catálogo]', 'Produto|produto|Novo, hoje']);
  assert.equal((await official(list)).interactive.action.sections[0].rows[0].description, 'Novo, hoje');
  const poll = parse(build([{ label: 'Sim' }, { label: 'Não' }], { type: 'poll', title: 'Concorda?', selectablecount: '1' }));
  assert.equal(poll.text, 'Concorda?');
  assert.deepEqual(poll.choices, ['Sim', 'Não']);
  assert.equal(poll.selectableCount, 1);
});

test('old select directives and numeric choices count remain accepted', () => {
  assert.deepEqual(parse('#send:menu\n#type:button\n#text:Olá\n#choices:2\n#select:Sim|sim\n#select:Não|nao').choices,
    ['Sim|sim', 'Não|nao']);
});

test('missing destinations and malformed choices fail before sending', async () => {
  for (const action of ['URL', 'CALL', 'COPY']) {
    assert.throws(() => build([{ label: 'Ação', action }]), /destino/);
  }
  assert.throws(() => build([{ label: 'Site', action: 'URL', value: 'javascript:alert(1)' }]), /URL completa/);
  assert.throws(() => parse('#send:menu\n#type:button\n#text:Olá\n#choices:[broken'), /choices are required/);
  for (const choice of ['Ligar|call:+5511999999999', 'Copiar|copy:ABC', 'Site|url:invalid']) {
    await assert.rejects(official({ type: 'button', text: 'Olá', choices: [choice] }), /OFFICIAL_MENU/);
  }
});

for (const [action, value, expected] of [
  ['REPLY', 'resposta_1', 'resposta_1'],
  ['URL', 'https://example.com/path', 'https://example.com/path'],
  ['CALL', '+55 (11) 99999-9999', 'call:+5511999999999'],
  ['COPY', 'CUPOM "10", C:\\novo', 'copy:CUPOM "10", C:\\novo'],
]) {
  test(`${action} alone never generates a carousel and retains the correct destination`, () => {
    const command = build([{ label: 'Ação', action, value }]);
    assert.match(command, /^#send:menu\n/);
    assert.doesNotMatch(command, /#card:|#button:|#send:carousel/);
    assert.deepEqual(parse(command).choices, [`Ação|${expected}`]);
  });
}

test('rejects malformed URLs, phones, reserved separators and accidental action IDs', () => {
  for (const [action, value] of [['URL', 'https://'], ['CALL', 'abc11999999999'],
    ['CALL', '1234567890123456'], ['COPY', 'A|B'], ['REPLY', 'call:123456789']]) {
    assert.throws(() => build([{ label: 'Ação', action, value }]));
  }
  assert.throws(() => build([{ label: 'A|B', action: 'COPY', value: 'cupom' }]));
});

test('validates poll counts and menu limits; previews every poll option', () => {
  const options = Array.from({ length: 12 }, (_, i) => ({ label: `Opção ${i + 1}` }));
  for (const count of ['0', '-1', '1.5', '13', 'abc']) {
    assert.throws(() => build(options, { type: 'poll', selectablecount: count }), /quantidade selecionável/);
  }
  assert.equal(parse(build(options, { type: 'poll' })).selectableCount, 1);
  assert.equal(menu.preview({ type: 'poll', menu_items: JSON.stringify(options) }).pollOptions.length, 12);
  assert.throws(() => build(options, { type: 'list', listbutton: 'Ver' }), /máximo/);
  assert.throws(() => build([...options, { label: '13' }], { type: 'poll' }), /máximo/);
  assert.throws(() => build(options, { type: 'unknown' }), /tipo de menu/);
});

test('blank list section after a named section no longer inherits the previous section', async () => {
  const payload = parse(build([{ label: 'A', section: 'Produtos' }, { label: 'B' }],
    { type: 'list', listbutton: 'Ver' }));
  const result = await official(payload);
  assert.deepEqual(result.interactive.action.sections.map((s) => s.title), ['Produtos', 'Opções']);
});

test('explicit carousel supports all actions and preserves backslashes and empty media positions', () => {
  const carousel = ui.window.catalog.find((item) => item.id === 'send_carousel');
  const command = carousel.build({ text: 'Cards', carousel_cards: JSON.stringify([
    { text: 'Sem mídia', mediaType: 'document', filename: 'guia.pdf', buttons: [
      { label: 'Responder', type: 'REPLY', value: 'resposta' },
      { label: 'Site', type: 'URL', value: 'https://example.com' },
      { label: 'Ligar', type: 'CALL', value: '+55 (11) 99999-9999' },
      { label: 'Copiar', type: 'COPY', value: 'C:\\novo\\teste' },
    ] },
    { text: 'Documento', media: 'https://example.com/file', mediaType: 'document', filename: 'guia.pdf',
      buttons: [{ label: 'OK', type: 'REPLY' }] },
  ]) });
  assert.match(command, /^#send:carousel\n/);
  const parsed = receiver.parseUazHashDirectives(command);
  const payload = plain(receiver.buildUazCommandPayload('carousel', parsed.directives, parsed.entries, parsed.remaining));
  assert.equal(receiver.validateUazDirectPayload('carousel', payload), null);
  assert.equal(payload.carousel[0].image, undefined);
  assert.equal(payload.carousel[0].document, undefined);
  assert.deepEqual(payload.carousel[0].buttons.map((b) => [b.type, b.id]), [
    ['REPLY', 'resposta'], ['URL', 'https://example.com'], ['CALL', '+5511999999999'], ['COPY', 'C:\\novo\\teste'],
  ]);
  assert.equal(payload.carousel[1].document, 'https://example.com/file');
  assert.equal(payload.carousel[1].filename, 'guia.pdf');
});
