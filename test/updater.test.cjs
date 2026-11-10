const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness(options = {}) {
  const handlers = new Map();
  const events = new Map();
  const timers = [];
  const logs = [];
  const installs = [];
  const startup = [];
  const openedUrls = [];
  let saved = options.saved ?? {};
  const disk = new Map();
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app: { getPath: () => '/fake', isPackaged: true, requestSingleInstanceLock: () => true,
          whenReady: () => ({ then() {} }), on() {}, setLoginItemSettings: (settings) => startup.push(settings) },
        shell: { openExternal: async (url) => openedUrls.push(url) },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) },
        safeStorage: { isEncryptionAvailable: () => true,
          encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
      };
      if (name === 'electron-updater') return { autoUpdater: {
        on: (name, fn) => events.set(name, fn), setFeedURL() {},
        quitAndInstall: (...args) => installs.push(args), checkForUpdates: async () => {},
      } };
      if (name === 'node:fs/promises') return {
        readFile: async () => JSON.stringify(saved),
        writeFile: async (file, data) => disk.set(file, data),
        rename: async (file) => { saved = JSON.parse(disk.get(file)); },
      };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'), process: { argv: [], platform: 'win32', execPath: 'C:/AuthGate/AuthGate-IP-Agent.exe' },
    Buffer, AbortController, Date, Error, console, URL,
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cancelled = true; },
    setInterval: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearInterval() {},
    fetch: options.fetch ?? (async () => { throw new Error('offline'); }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), context);
  context.testLog = (type, message) => logs.push({ type, message });
  vm.runInContext('log = testLog', context);
  return { context, handlers, events, timers, logs, installs, startup, openedUrls, saved: () => saved,
    run: (code) => vm.runInContext(code, context) };
}
function response(body, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null },
    text: async () => JSON.stringify(body), json: async () => body };
}
function session(h, recordId = 'old') {
  h.context.recordId = recordId;
  h.run(`currentSession = { credentials: { email: 'test', password: 'secret', instanceSlug: 'tenant' }, token: 'token',
    selectedUnit: { id: 'u1', name: 'Usina', ipRecordId: recordId, pendingIds: [] } };
    updaterState.isActive = true;`);
}

test('network failure returns an error and releases the update lock', async () => {
  const h = harness(); session(h);
  const result = await h.run('updateIp()');
  assert.equal(result.success, false);
  assert.match(result.message, /offline/);
  assert.equal(h.run('updaterState.isUpdating'), false);
});

test('partial DELETE failure survives restart, reuses new IP and preserves other records', async () => {
  let failDelete = true; let posts = 0;
  const records = [{ unit_id: 'u1', id: 'old', ip_address: '1.1.1.1' },
    { unit_id: 'u1', id: 'other-network', ip_address: '2.2.2.2' }];
  const fetch = async (url, opts = {}) => {
    if (url.includes('ipify')) return response({ ip: '3.3.3.3' });
    if (opts.method === 'POST') { posts++; records.push({ unit_id: 'u1', id: 'new', ip_address: '3.3.3.3' }); return response({ id: 'new' }); }
    if (opts.method === 'DELETE') {
      assert.ok(url.endsWith('/old'));
      if (failDelete) return response({}, 500);
      records.splice(records.findIndex((r) => r.id === 'old'), 1); return response({});
    }
    return response(records);
  };
  const h = harness({ fetch }); session(h);
  assert.equal((await h.run('updateIp()')).success, false);
  assert.deepEqual(h.saved().managedRecords['tenant/u1'], { recordId: 'new', pendingIds: ['old'], attemptedIp: '' });
  failDelete = false;
  const restarted = harness({ fetch, saved: h.saved() }); session(restarted, 'new');
  restarted.run("currentSession.selectedUnit.pendingIds = ['old']");
  assert.equal((await restarted.run('updateIp()')).success, true);
  assert.equal(posts, 1);
  assert.equal(records.length, 2);
  assert.deepEqual(restarted.saved().managedRecords['tenant/u1'].pendingIds, []);
});

test('401 refreshes credentials and retries only failed request', async () => {
  let creates = 0; let deletes = 0; let logins = 0;
  const h = harness({ fetch: async (url, opts = {}) => {
    if (url.includes('ipify')) return response({ ip: '3.3.3.3' });
    if (url.endsWith('/auth/login')) { logins++; return response({ token: 'refreshed' }); }
    if (opts.method === 'DELETE') return response({}, ++deletes === 1 ? 401 : 200);
    if (opts.method === 'POST') { creates++; return response({ id: 'new' }); }
    return response([{ unit_id: 'u1', id: 'old', ip_address: '1.1.1.1' }]);
  } }); session(h);
  assert.equal((await h.run('updateIp()')).success, true);
  assert.equal(creates, 1); assert.equal(deletes, 2); assert.equal(logins, 1);
});

test('first IP registration never deletes an empty ID', async () => {
  const methods = [];
  const h = harness({ fetch: async (url, opts = {}) => {
    methods.push(opts.method);
    if (url.includes('ipify')) return response({ ip: '3.3.3.3' });
    if (opts.method === 'POST') return response({ id: 'new' });
    return response([]);
  } }); session(h, '');
  assert.equal((await h.run('updateIp()')).success, true);
  assert.equal(methods.includes('DELETE'), false);
});

test('concurrent IP calls are rejected without another request', async () => {
  let release; let calls = 0;
  const h = harness({ fetch: () => { calls++; return new Promise((resolve) => { release = resolve; }); } }); session(h);
  const first = h.run('updateIp()');
  assert.equal((await h.run('updateIp()')).success, false);
  assert.equal(calls, 1);
  release(response({ ip: '999.1.1.1' }));
  assert.equal((await first).success, false);
});

test('downloaded update waits for IP operation and installs silently with restart', () => {
  const h = harness();
  h.run('configureAutomaticAppUpdates(); updaterState.isUpdating = true');
  h.events.get('update-downloaded')({ version: '1.0.2' });
  assert.equal(h.timers.some((t) => t.ms === 1200), false);
  h.run('updaterState.isUpdating = false; installDownloadedAppUpdateWhenSafe()');
  h.timers.find((t) => t.ms === 1200).fn();
  assert.deepEqual(h.installs, [[true, true]]);
});

test('offline startup schedules retry and stop disables saved resume', async () => {
  const h = harness({ saved: { autoStart: true, email: 'test', instanceSlug: 'tenant', selectedUnitId: 'u1', encryptedPassword: Buffer.from('secret').toString('base64') } });
  await h.run('resumeAutomaticUpdates()');
  const retry = h.timers.find((t) => t.ms === 60000);
  assert.ok(retry);
  assert.equal((await h.handlers.get('updater:stop')()).success, true);
  assert.equal(retry.cancelled, true);
  assert.equal(h.saved().autoStart, false);
  assert.equal(h.saved().encryptedPassword, '');
});

test('ambiguous POST and changed IP cleans the previous attempted record', async () => {
  let ip = '3.3.3.3'; let firstPost = true;
  const records = [{ unit_id: 'u1', id: 'old', ip_address: '1.1.1.1' }];
  const h = harness({ fetch: async (url, opts = {}) => {
    if (url.includes('ipify')) return response({ ip });
    if (opts.method === 'POST') {
      const id = firstPost ? 'uncertain' : 'new';
      records.push({ unit_id: 'u1', id, ip_address: ip });
      if (firstPost) { firstPost = false; throw new Error('connection lost after POST'); }
      return response({ id });
    }
    if (opts.method === 'DELETE') {
      const id = url.split('/').pop();
      records.splice(records.findIndex((r) => r.id === id), 1);
      return response({});
    }
    return response(records);
  } }); session(h);
  assert.equal((await h.run('updateIp()')).success, false);
  assert.equal(h.saved().managedRecords['tenant/u1'].attemptedIp, '3.3.3.3');
  ip = '4.4.4.4';
  assert.equal((await h.run('updateIp()')).success, true);
  assert.deepEqual(records.map((r) => r.id), ['new']);
});

test('manual start stores credentials and resumes without configuration queue deadlock', async () => {
  const h = harness({ fetch: async (url, opts = {}) => {
    if (url.includes('ipify')) return response({ ip: '3.3.3.3' });
    if (opts.method === 'POST') return response({ id: 'new' });
    return response([]);
  } });
  session(h, '');
  h.run('currentSession.units = [currentSession.selectedUnit]');
  assert.equal((await h.handlers.get('updater:start')(null, 'u1')).success, true);
  for (let i = 0; i < 100 && h.run('updaterState.isUpdating'); i++) await new Promise(setImmediate);
  assert.equal(h.run('updaterState.isUpdating'), false);
  assert.equal(h.saved().selectedUnitId, 'u1');
  assert.equal(h.saved().autoStart, true);
  assert.ok(h.saved().encryptedPassword);
  assert.equal(h.saved().managedRecords['tenant/u1'].recordId, 'new');
});

function selectionApi(url, opts = {}) {
  if (url.endsWith('/auth/login')) {
    return Promise.resolve(response({ token: 'admin-token' }, JSON.parse(opts.body).password === 'secret' ? 200 : 401));
  }
  if (url.includes('/units?')) return Promise.resolve(response([
    { unit_id: 'u1', name: 'Usina 1' }, { unit_id: 'u2', name: 'Usina 2' },
  ]));
  if (url.includes('ipify')) return Promise.resolve(response({ ip: '3.3.3.3' }));
  if (opts.method === 'POST') return Promise.resolve(response({ id: 'new' }));
  return Promise.resolve(response([]));
}
async function finishUpdate(h) {
  for (let i = 0; i < 100 && h.run('updaterState.isUpdating'); i++) await new Promise(setImmediate);
  assert.equal(h.run('updaterState.isUpdating'), false);
}
const adminLogin = { instanceSlug: 'tenant', email: 'admin@test', password: 'secret' };

test('selection is consumed after start and stopping cannot unlock other units', async () => {
  const h = harness({ fetch: selectionApi });
  assert.equal((await h.handlers.get('updater:login')(null, adminLogin)).units.length, 2);
  assert.equal((await h.handlers.get('updater:start')(null, 'u1')).success, true);
  await finishUpdate(h);
  assert.equal(h.run('currentSession.units.length'), 0);
  assert.equal(h.run('canSelectUnit'), false);
  await h.handlers.get('updater:stop')();
  assert.equal((await h.handlers.get('updater:start')(null, 'u2')).success, false);
  assert.equal((await h.handlers.get('updater:start')(null, 'u1')).success, true);
  await finishUpdate(h);
});

test('changing unit destroys session and requires successful password authentication', async () => {
  const h = harness({ fetch: selectionApi });
  await h.handlers.get('updater:login')(null, adminLogin);
  await h.handlers.get('updater:start')(null, 'u1');
  await finishUpdate(h);
  assert.equal((await h.handlers.get('updater:change-unit')()).success, true);
  assert.equal(h.run('currentSession'), null);
  assert.equal((await h.handlers.get('updater:start')(null, 'u2')).success, false);
  assert.equal((await h.handlers.get('updater:login')(null, { ...adminLogin, password: 'wrong' })).success, false);
  assert.equal((await h.handlers.get('updater:start')(null, 'u2')).success, false);
  assert.equal((await h.handlers.get('updater:login')(null, adminLogin)).success, true);
  assert.equal((await h.handlers.get('updater:start')(null, 'u2')).success, true);
  await finishUpdate(h);
  assert.equal(h.saved().selectedUnitId, 'u2');
});

test('automatic restart exposes only configured unit and never authorizes selection', async () => {
  const h = harness({ fetch: selectionApi, saved: {
    autoStart: true, ...adminLogin, selectedUnitId: 'u1',
    encryptedPassword: Buffer.from('secret').toString('base64'),
  } });
  const sessions = [];
  h.context.captureSession = (channel, payload) => { if (channel === 'updater:session') sessions.push(payload); };
  h.run('send = captureSession');
  await h.run('resumeAutomaticUpdates()');
  await finishUpdate(h);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].selectedUnit.id, 'u1');
  assert.equal(sessions[0].units, undefined);
  assert.equal(h.run('currentSession.units.length'), 0);
  assert.equal((await h.handlers.get('updater:start')(null, 'u2')).success, false);
});


test('Windows startup uses installed executable and is repaired before offline resume', async () => {
  const h = harness({ saved: { autoStart: true, selectedUnitId: 'u1', instanceSlug: 'tenant',
    email: 'admin', encryptedPassword: Buffer.from('secret').toString('base64') } });
  await h.run('resumeAutomaticUpdates()');
  assert.equal(h.startup[0].openAtLogin, true);
  assert.equal(h.startup[0].path, 'C:/AuthGate/AuthGate-IP-Agent.exe');
  assert.equal(h.startup[0].args[0], '--background');
  assert.ok(h.timers.some((timer) => timer.ms === 60000));
});

test('instance QR opens public page with all current codes and no credentials', async () => {
  const h = harness({ fetch: async () => response([{ code: 'B' }, { code: 'A' }, { code: 'A' }]) });
  session(h);
  assert.equal((await h.handlers.get('updater:open-instance-qr')()).success, true);
  const url = new URL(h.openedUrls[0]);
  assert.equal(url.origin, 'https://authgate.com.br');
  assert.equal(url.pathname, '/tenant/public/qr');
  assert.deepEqual(url.searchParams.getAll('unit'), ['A', 'B']);
  assert.equal([...url.searchParams.keys()].every((key) => key === 'unit'), true);
  assert.equal(h.run('canSelectUnit'), false);
});

test('QR requires configured unit and does not launch browser on network failure', async () => {
  const h = harness();
  assert.equal((await h.handlers.get('updater:open-instance-qr')()).success, false);
  session(h);
  assert.equal((await h.handlers.get('updater:open-instance-qr')()).success, false);
  assert.equal(h.openedUrls.length, 0);
});
