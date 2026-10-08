import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/zaptos-actions-original.js', import.meta.url), 'utf8');
const context = { URL, window: {}, location: { href: 'https://crm.example/' } };
vm.runInNewContext(source.slice(0, source.lastIndexOf("  document.addEventListener('pointerdown'")) +
  '\nwindow.build = buildTemplateButtons;\n})();', context);
const build = (items) => JSON.parse(JSON.stringify(context.window.build(items)));

test('selected button actions produce the submission contract without text delimiters', () => {
  assert.deepEqual(build([
    { type: 'QUICK_REPLY', text: 'Sim | quero' },
    { type: 'URL', text: 'Ver pedido', url: 'https://loja.com/pedido/', dynamic: true, example: 'pedido123' },
    { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+55 (11) 99999-9999' }
  ]), { errors: [], buttons: [
    { type: 'QUICK_REPLY', text: 'Sim | quero' },
    { type: 'URL', text: 'Ver pedido', url: 'https://loja.com/pedido/{{1}}', example: 'pedido123' },
    { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5511999999999' }
  ] });
});

test('static links omit saved dynamic examples and other action fields', () => {
  assert.deepEqual(build([{ type: 'URL', text: 'Site', url: 'https://loja.com', dynamic: false,
    example: 'old', phone_number: '+5511999999999' }]).buttons,
  [{ type: 'URL', text: 'Site', url: 'https://loja.com' }]);
  assert.deepEqual(build([]), { buttons: [], errors: [] });
});

test('invalid or unfinished cards return readable errors before submission', () => {
  for (const item of [
    { type: 'QUICK_REPLY', text: '' },
    { type: 'QUICK_REPLY', text: 'x'.repeat(26) },
    { type: 'URL', text: 'Site', url: 'http://loja.com' },
    { type: 'URL', text: 'Site', url: 'https://' },
    { type: 'URL', text: 'Site', url: 'https://loja.com/{{1}}' },
    { type: 'URL', text: 'Site', url: 'https://loja.com/', dynamic: true, example: '' },
    { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '123' },
    { type: 'invalid', text: 'Teste' }
  ]) assert.match(build([item]).errors[0], /^Botão 1:/);
  assert.equal(build(Array.from({ length: 11 }, () => ({ type: 'QUICK_REPLY', text: 'Sim' }))).errors[0],
    'Use no máximo 10 botões.');
});
