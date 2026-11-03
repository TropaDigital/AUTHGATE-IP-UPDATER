const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('monitor clears unit list and switching returns to an empty-password login', async () => {
  const elements = new Map();
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  function element(classes = '') {
    const flags = new Set(classes.split(' '));
    return { value: '', textContent: '', children: [], events: {},
      classList: { add: (c) => flags.add(c), remove: (c) => flags.delete(c),
        contains: (c) => flags.has(c), toggle: (c, on) => on ? flags.add(c) : flags.delete(c) },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
      addEventListener(name, fn) { this.events[name] = fn; }, focus() {},
      querySelector: () => ({ textContent: '' }),
    };
  }
  for (const match of html.matchAll(/id="([^"]+)"(?: class="([^"]+)")?/g)) elements.set(`#${match[1]}`, element(match[2]));
  const callbacks = {};
  const api = {
    getSavedSettings: async () => ({}),
    login: async () => ({ success: true, units: [{ id: 'u1', name: 'One' }, { id: 'u2', name: 'Two' }] }),
    changeUnit: async () => ({ success: true }),
    onLog: (fn) => { callbacks.log = fn; }, onSession: (fn) => { callbacks.session = fn; },
    onAppUpdate: (fn) => { callbacks.app = fn; }, onState: (fn) => { callbacks.state = fn; },
  };
  const context = vm.createContext({ document: { querySelector: (id) => {
    assert.ok(elements.has(id), `Missing HTML element: ${id}`);
    return elements.get(id);
  }, createElement: () => element() }, window: { authgateUpdater: api }, Intl, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8'), context);
  await elements.get('#login-form').events.submit({ preventDefault() {} });
  assert.equal(elements.get('#unit-select').children.length, 2);
  callbacks.session({ selectedUnit: { id: 'u1', name: 'One' } });
  callbacks.state({ isActive: true, isUpdating: false, unitName: 'One' });
  assert.equal(elements.get('#unit-select').children.length, 0);
  assert.equal(elements.get('#unit-card').classList.contains('hidden'), true);
  assert.equal(elements.get('#monitor-card').classList.contains('hidden'), false);
  callbacks.state({ isActive: false, isUpdating: false });
  assert.equal(elements.get('#unit-card').classList.contains('hidden'), true);
  assert.equal(elements.get('#resume-button').classList.contains('hidden'), false);
  elements.get('#password').value = 'old-password';
  await elements.get('#change-login').events.click();
  assert.equal(elements.get('#password').value, '');
  assert.equal(elements.get('#login-card').classList.contains('hidden'), false);
  assert.equal(elements.get('#monitor-card').classList.contains('hidden'), true);
  assert.equal(elements.get('#unit-select').children.length, 0);
});
