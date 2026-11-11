const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, nativeImage, powerMonitor, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isIPv4 } = require('node:net');

const API_BASE_URL = 'https://authgate.backendtropa.com.br';
const UPDATE_INTERVAL_MS = 5 * 60 * 1000;
const APP_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let appUpdateState = { status: 'idle', lastCheckedAt: null, nextCheckAt: null };
let isCheckingAppUpdate = false;
let automaticUpdatesConfigured = false;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let resumeTimer = null;
let resumeGeneration = 0;
let isResuming = false;
let settingsQueue = Promise.resolve();
let configurationOperations = 0;
let currentSession = null;
let canSelectUnit = false;
let updateTimer = null;
let appUpdateTimer = null;
let isQuittingForAppUpdate = false;
let isAppUpdateReady = false;
let updaterState = {
  isActive: false,
  isUpdating: false,
  nextUpdateAt: null,
  unitName: null,
};

class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function readSavedSettings() {
  try {
    const rawSettings = await fs.readFile(getSettingsPath(), 'utf8');
    const settings = JSON.parse(rawSettings);
    return {
      managedRecords: settings.managedRecords && typeof settings.managedRecords === 'object' ? settings.managedRecords : {},
      autoStart: settings.autoStart === true,
      email: typeof settings.email === 'string' ? settings.email : '',
      encryptedPassword: typeof settings.encryptedPassword === 'string' ? settings.encryptedPassword : '',
      instanceSlug: typeof settings.instanceSlug === 'string' ? settings.instanceSlug : '',
      selectedUnitId: typeof settings.selectedUnitId === 'string' ? settings.selectedUnitId : '',
    };
  } catch {
    return {
      autoStart: false,
      email: '',
      encryptedPassword: '',
      instanceSlug: '',
      selectedUnitId: '',
    };
  }
}

async function writeSavedSettings(settings) {
  const temporaryPath = `${getSettingsPath()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.rename(temporaryPath, getSettingsPath());
}

async function rememberRecords(session, recordId, pendingIds, attemptedIp = '') {
  const operation = settingsQueue.then(async () => {
    const settings = await readSavedSettings();
    const key = `${session.credentials.instanceSlug}/${session.selectedUnit.id}`;
    await writeSavedSettings({ ...settings, managedRecords: {
      ...settings.managedRecords, [key]: { recordId, pendingIds, attemptedIp },
    } });
  });
  settingsQueue = operation.catch(() => undefined);
  await operation;
}

async function saveLoginHint(credentials) {
  const previousSettings = await readSavedSettings();
  await writeSavedSettings({
    ...previousSettings,
    email: credentials.email,
    instanceSlug: credentials.instanceSlug,
  });
}

async function saveAutomaticStart(credentials, selectedUnitId, autoStart) {
  const previousSettings = await readSavedSettings();
  const nextSettings = {
    ...previousSettings,
    autoStart,
    email: credentials.email,
    instanceSlug: credentials.instanceSlug,
    selectedUnitId,
  };

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('O Windows não disponibilizou o armazenamento seguro da senha. Tente novamente.');
  }
  {
    nextSettings.encryptedPassword = safeStorage.encryptString(credentials.password).toString('base64');
  }

  await writeSavedSettings(nextSettings);
  configureWindowsStartup(autoStart);
}

function configureWindowsStartup(enabled) {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({
    name: 'AuthGate Atualizador de IP',
    path: process.execPath,
    openAtLogin: enabled,
    args: ['--background'],
  });
}

function decryptSavedPassword(settings) {
  if (!settings.encryptedPassword || !safeStorage.isEncryptionAvailable()) {
    return '';
  }

  try {
    return safeStorage.decryptString(Buffer.from(settings.encryptedPassword, 'base64'));
  } catch {
    return '';
  }
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function sendState() {
  send('updater:state', updaterState);
}

function sendAppUpdateState(state) {
  appUpdateState = { ...appUpdateState, ...state };
  send('updater:app-update', appUpdateState);
}

function log(type, message) {
  send('updater:log', {
    type,
    message,
    timestamp: new Date().toISOString(),
  });
}

function setUpdaterState(nextState) {
  updaterState = { ...updaterState, ...nextState };
  sendState();
}

function getPathValue(value, pathValue) {
  return pathValue.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') {
      return null;
    }

    return current[key] ?? null;
  }, value);
}

function getString(value, paths) {
  for (const pathValue of paths) {
    const candidate = getPathValue(value, pathValue);
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function getCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const pathValue of ['data', 'items', 'results', 'data.items', 'data.results']) {
    const candidate = getPathValue(payload, pathValue);
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function extractToken(payload, headers) {
  for (const pathValue of [
    'access_token',
    'accessToken',
    'token',
    'jwt',
    'data.access_token',
    'data.accessToken',
    'data.token',
    'data.jwt',
  ]) {
    const token = getString(payload, [pathValue]);
    if (token) {
      return token.replace(/^Bearer\s+/i, '');
    }
  }

  const headerToken = headers.get('authorization');
  return headerToken ? headerToken.replace(/^Bearer\s+/i, '') : '';
}

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${API_BASE_URL}${pathname}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    });
    const rawBody = await response.text();
    let body = null;

    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    if (!response.ok) {
      const apiMessage = typeof body === 'object' && body
        ? getString(body, ['message', 'error', 'data.message'])
        : '';
      throw new ApiError(apiMessage || `A API retornou erro ${response.status}.`, response.status);
    }

    return { body, headers: response.headers };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ApiError('A conexão demorou demais. Verifique a internet e tente novamente.');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function authenticate(credentials) {
  const response = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const token = extractToken(response.body, response.headers);

  if (!token) {
    throw new ApiError('A conta foi autenticada, mas o AuthGate não enviou o acesso necessário.');
  }

  return token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function normalizeCredentials(input) {
  return {
    email: String(input?.email ?? '').trim(),
    instanceSlug: String(input?.instanceSlug ?? '').trim().toLowerCase(),
    password: String(input?.password ?? ''),
  };
}

function getFriendlyError(error, action) {
  if (error instanceof ApiError && error.status === 401) {
    return 'E-mail ou senha não foram aceitos para esta instância.';
  }

  if (error instanceof ApiError && error.status === 403) {
    return `A conta entrou no AuthGate, mas não tem permissão para ${action}.`;
  }

  return error instanceof Error ? error.message : 'Não foi possível concluir esta etapa.';
}

async function loadUnitRecords(token, instanceSlug) {
  const endpoint = instanceSlug === 'authgate' ? '/unit' : `/instances/${encodeURIComponent(instanceSlug)}/units`;
  const records = [];
  const seen = new Set();
  for (let page = 1; ; page += 1) {
    const response = await request(`${endpoint}?pagination=true&page=${page}&limit=100`, { headers: authHeaders(token) });
    const items = getCollection(response.body);
    const fresh = items.filter((unit) => {
      const id = getString(unit, ['unit_id', 'id']);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    records.push(...fresh);
    if (items.length < 100 || !fresh.length) return records;
  }
}

async function loadUnits(token, instanceSlug) {
  const [unitRecords, ipsResponse, instancesResponse] = await Promise.all([
    loadUnitRecords(token, instanceSlug),
    request('/unit-ip?pagination=false', { headers: authHeaders(token) }),
    instanceSlug === 'authgate' ? request('/instance?pagination=false', { headers: authHeaders(token) }) : Promise.resolve({ body: [] }),
  ]);
  const settings = await readSavedSettings();
  const unitIpsByUnitId = new Map();

  getCollection(ipsResponse.body).forEach((record) => {
    const unitId = getString(record, ['unit_id', 'unit.unit_id', 'unit.id']);
    const unitIpId = getString(record, ['unit_ip_id', 'id']);
    const ipAddress = getString(record, ['ip_address', 'ip']);

    if (unitId && unitIpId && !unitIpsByUnitId.has(unitId)) {
      unitIpsByUnitId.set(unitId, { ipAddress, unitIpId });
    }
  });

  const instances = getCollection(instancesResponse.body);
  return unitRecords
    .map((unit) => {
      const id = getString(unit, ['unit_id', 'id']);
      const code = getString(unit, ['code']);
      const name = getString(unit, ['name', 'unit_name']) || code;
      const instanceId = getString(unit, ['instance_id', 'instance.instance_id', 'instance.id']);
      const instance = instances.find((item) => getString(item, ['instance_id', 'id']) === instanceId);
      const unitInstanceSlug = getString(unit, ['instance.slug', 'instance_slug', 'instanceSlug', 'tenant.slug'])
        || getString(instance, ['slug']) || (instanceSlug === 'authgate' ? '' : instanceSlug);
      const instanceName = getString(unit, ['instance.name']) || getString(instance, ['name']) || unitInstanceSlug;

      return {
        code,
        id,
        instanceSlug: unitInstanceSlug,
        instanceName,
        ipAddress: unitIpsByUnitId.get(id)?.ipAddress ?? '',
        ipRecordId: settings.managedRecords?.[`${instanceSlug}/${id}`]?.recordId ?? unitIpsByUnitId.get(id)?.unitIpId ?? '',
        pendingIds: settings.managedRecords?.[`${instanceSlug}/${id}`]?.pendingIds ?? [],
        attemptedIp: settings.managedRecords?.[`${instanceSlug}/${id}`]?.attemptedIp ?? '',
        name,
      };
    })
    .filter((unit) => unit.id && unit.name)
    .sort((first, second) => first.name.localeCompare(second.name, 'pt-BR'));
}

async function openSession(credentials) {
  const token = await authenticate(credentials);
  const units = await loadUnits(token, credentials.instanceSlug);

  if (!units.length) {
    throw new ApiError('Nenhuma unidade foi encontrada para esta conta.');
  }

  currentSession = { credentials, selectedUnit: null, token, units };
  return currentSession;
}

async function getPublicIp() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    const body = await response.json();
    const ip = typeof body.ip === 'string' ? body.ip.trim() : '';

    if (!response.ok || !isIPv4(ip)) {
      throw new ApiError('Não foi possível identificar o IP desta conexão.');
    }

    return ip;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new ApiError('A identificação do IP demorou demais. Verifique a internet e tente novamente.');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function createUnitIpRecord(token, unitId, ipAddress) {
  const createResponse = await request('/unit-ip', {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ unit_id: unitId, ip_address: ipAddress }),
  });
  const recordId = getString(createResponse.body, ['unit_ip_id', 'id', 'data.unit_ip_id', 'data.id']);

  if (!recordId) {
    throw new ApiError('O AuthGate criou o novo IP, mas não retornou a confirmação necessária.');
  }

  return recordId;
}

async function deleteUnitIpRecord(token, recordId) {
  await request(`/unit-ip/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
}

async function updateIp() {
  if (updaterState.isUpdating || isQuittingForAppUpdate) {
    return { success: false, message: 'Já existe uma atualização em andamento.' };
  }
  const session = currentSession;
  if (!session?.selectedUnit) {
    return { success: false, message: 'Escolha uma unidade antes de iniciar a atualização.' };
  }
  const { selectedUnit } = session;
  setUpdaterState({ isUpdating: true });
  log('info', `Atualizando ${selectedUnit.name}…`);

  // Retry the individual request, never the entire create/delete transaction.
  const authorized = async (operation) => {
    try { return await operation(session.token); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      session.token = await authenticate(session.credentials);
      return operation(session.token);
    }
  };

  try {
    const ipAddress = await getPublicIp();
    const response = await authorized((token) => request('/unit-ip?pagination=false', { headers: authHeaders(token) }));
    const records = getCollection(response.body).filter((record) =>
      getString(record, ['unit_id', 'unit.unit_id', 'unit.id']) === selectedUnit.id);
    const previousAttempt = records.find((record) => getString(record, ['ip_address', 'ip']) === selectedUnit.attemptedIp);
    if (previousAttempt) {
      selectedUnit.pendingIds = [...(selectedUnit.pendingIds ?? []), getString(previousAttempt, ['unit_ip_id', 'id'])];
    }
    const matching = records.find((record) => getString(record, ['ip_address', 'ip']) === ipAddress);
    let newRecordId = matching && getString(matching, ['unit_ip_id', 'id']);
    if (!newRecordId) {
      await rememberRecords(session, selectedUnit.ipRecordId, selectedUnit.pendingIds ?? [], ipAddress);
      selectedUnit.attemptedIp = ipAddress;
      newRecordId = await authorized((token) => createUnitIpRecord(token, selectedUnit.id, ipAddress));
    }
    const pendingIds = [...new Set([
      ...(selectedUnit.pendingIds ?? []), selectedUnit.ipRecordId,
    ])].filter((id) => id && id !== newRecordId);
    await rememberRecords(session, newRecordId, pendingIds);
    selectedUnit.ipRecordId = newRecordId;
    selectedUnit.attemptedIp = '';
    selectedUnit.pendingIds = pendingIds;
    for (const oldId of pendingIds) {
      try { await authorized((token) => deleteUnitIpRecord(token, oldId)); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    await rememberRecords(session, newRecordId, []);
    selectedUnit.pendingIds = [];
    selectedUnit.ipAddress = ipAddress;
    selectedUnit.ipRecordId = newRecordId;
    log('success', `IP confirmado no AuthGate: ${ipAddress}.`);
    return { success: true };
  } catch (error) {
    const message = getFriendlyError(error, 'atualizar o IP desta unidade');
    log('error', `${message} Uma nova tentativa será feita automaticamente.`);
    return { success: false, message };
  } finally {
    setUpdaterState({ isUpdating: false });
    installDownloadedAppUpdateWhenSafe();
  }
}

function stopUpdater() {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }

  setUpdaterState({ isActive: false, nextUpdateAt: null, unitName: null });
}

function installDownloadedAppUpdateWhenSafe() {
  if (!isAppUpdateReady || updaterState.isUpdating || isResuming || configurationOperations || isQuittingForAppUpdate) {
    return;
  }

  isQuittingForAppUpdate = true;
  sendAppUpdateState({ status: 'installing' });
  log('info', 'Nova versão pronta. Reiniciando o aplicativo para concluir a atualização…');
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
}

function configureAutomaticAppUpdates() {
  if (!app.isPackaged || automaticUpdatesConfigured) return;
  automaticUpdatesConfigured = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  // The GitHub provider is supplied by electron-builder's app-update.yml.

  autoUpdater.on('checking-for-update', () => {
    sendAppUpdateState({ status: 'checking', lastCheckedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + APP_UPDATE_CHECK_INTERVAL_MS).toISOString() });
  });

  autoUpdater.on('update-available', (info) => {
    sendAppUpdateState({ status: 'downloading', version: info.version, progress: 0 });
    log('info', `Nova versão ${info.version} encontrada. Baixando em segundo plano…`);
  });

  autoUpdater.on('update-not-available', () => {
    sendAppUpdateState({ status: 'up-to-date', version: null, progress: 0 });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendAppUpdateState({
      status: 'downloading',
      progress: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    isAppUpdateReady = true;
    sendAppUpdateState({ status: 'ready', version: info.version });
    log('info', `Versão ${info.version} baixada. A instalação entrará na fila após a atualização de IP.`);
    installDownloadedAppUpdateWhenSafe();
  });

  autoUpdater.on('error', (error) => {
    isQuittingForAppUpdate = false;
    isAppUpdateReady = false;
    log('error', 'Não foi possível atualizar o aplicativo. A busca será repetida automaticamente.');
    sendAppUpdateState({ status: 'unavailable', errorCode: typeof error?.code === 'string' ? error.code : '', nextCheckAt: new Date(Date.now() + APP_UPDATE_CHECK_INTERVAL_MS).toISOString() });
  });

  setTimeout(() => void checkForAppUpdate(), 3000);
  appUpdateTimer = setInterval(() => void checkForAppUpdate(), APP_UPDATE_CHECK_INTERVAL_MS);
}

async function checkForAppUpdate() {
  if (!app.isPackaged) return { success: false, message: 'Disponível no aplicativo instalado.' };
  if (isCheckingAppUpdate || isAppUpdateReady || isQuittingForAppUpdate || appUpdateState.status === 'downloading') {
    return { success: true };
  }
  isCheckingAppUpdate = true;
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch {
    return { success: false, message: 'Não foi possível verificar agora. Nova tentativa automática em até 5 minutos.' };
  } finally {
    isCheckingAppUpdate = false;
  }
}

ipcMain.handle('updater:check-app-update', () => checkForAppUpdate());
ipcMain.handle('updater:get-app-update-state', () => appUpdateState);

function lockUnit(selectedUnit) {
  canSelectUnit = false;
  currentSession.selectedUnit = selectedUnit;
  currentSession.units = [];
  send('updater:session', { selectedUnit: { id: selectedUnit.id, name: selectedUnit.name, code: selectedUnit.code } });
}

function startUpdater(selectedUnit) {
  stopUpdater();
  currentSession.selectedUnit = selectedUnit;
  const nextUpdateAt = new Date(Date.now() + UPDATE_INTERVAL_MS).toISOString();
  setUpdaterState({
    isActive: true,
    nextUpdateAt,
    unitName: selectedUnit.name,
  });
  log('info', `Atualizações iniciadas para ${selectedUnit.name}.`);
  const tick = async () => {
    await updateIp();
    if (!updaterState.isActive || currentSession?.selectedUnit !== selectedUnit) return;
    setUpdaterState({ nextUpdateAt: new Date(Date.now() + UPDATE_INTERVAL_MS).toISOString() });
    updateTimer = setTimeout(tick, UPDATE_INTERVAL_MS);
  };
  void tick();
}

async function resumeAutomaticUpdates() {
  if (isResuming || currentSession || isQuitting) return;
  clearTimeout(resumeTimer);
  const generation = resumeGeneration;
  isResuming = true;
  const savedSettings = await readSavedSettings();
  configureWindowsStartup(savedSettings.autoStart);
  const password = decryptSavedPassword(savedSettings);

  if (!savedSettings.autoStart || !savedSettings.selectedUnitId || !password) {
    isResuming = false;
    if (savedSettings.autoStart && !password) log('error', 'Entre novamente para restaurar o acesso salvo.');
    installDownloadedAppUpdateWhenSafe();
    return;
  }

  try {
    const session = await openSession({
      email: savedSettings.email,
      instanceSlug: savedSettings.instanceSlug,
      password,
    });
    const selectedUnit = session.units.find((unit) => unit.id === savedSettings.selectedUnitId);

    if (generation !== resumeGeneration) { currentSession = null; return; }
    if (!selectedUnit) {
      throw new ApiError('A unidade salva não está disponível para atualização.');
    }

    configureWindowsStartup(true);
    lockUnit(selectedUnit);
    startUpdater(selectedUnit);
    log('info', `Atualizações retomadas para ${selectedUnit.name}.`);
  } catch (error) {
    currentSession = null;
    resumeTimer = setTimeout(() => void resumeAutomaticUpdates(), 60000);
    log('error', `Nova tentativa em 1 minuto. Não foi possível retomar as atualizações automaticamente. ${getFriendlyError(error, 'acessar a unidade')}`);
  } finally {
    isResuming = false;
    installDownloadedAppUpdateWhenSafe();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: !process.argv.includes('--background'),
    width: 820,
    height: 760,
    minWidth: 620,
    minHeight: 640,
    backgroundColor: '#07121d',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && !isQuittingForAppUpdate) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('updater:get-saved-settings', async () => {
  const settings = await readSavedSettings();
  return {
    version: app.getVersion(),
    email: settings.email,
    instanceSlug: settings.instanceSlug,
  };
});

handleConfiguration('updater:login', async (_event, input) => {
  if (updaterState.isUpdating || isResuming) return { success: false, message: 'Aguarde a operação atual terminar.' };
  resumeGeneration += 1;
  clearTimeout(resumeTimer);
  stopUpdater();
  canSelectUnit = false;
  currentSession = null;
  const credentials = normalizeCredentials(input);

  if (!credentials.instanceSlug || !credentials.email || !credentials.password) {
    return { success: false, message: 'Informe a instância, o e-mail e a senha.' };
  }

  try {
    const session = await openSession(credentials);
    await saveLoginHint(credentials);
    canSelectUnit = true;
    return { success: true, units: session.units, isRoot: credentials.instanceSlug === 'authgate' };
  } catch (error) {
    return { success: false, message: getFriendlyError(error, 'carregar as unidades') };
  }
});

handleConfiguration('updater:start', async (_event, unitId) => {
  const selectedUnit = canSelectUnit
    ? currentSession?.units?.find((unit) => unit.id === unitId)
    : currentSession?.selectedUnit?.id === unitId ? currentSession.selectedUnit : null;

  if (!selectedUnit) {
    return { success: false, message: 'Entre novamente antes de iniciar a atualização.' };
  }

  if (updaterState.isUpdating || isQuittingForAppUpdate) return { success: false, message: 'Aguarde a atualização atual terminar.' };

  await saveAutomaticStart(currentSession.credentials, selectedUnit.id, true);
  lockUnit(selectedUnit);
  startUpdater(selectedUnit);
  return { success: true };
});

async function pauseUpdates() {
  resumeGeneration += 1;
  clearTimeout(resumeTimer);
  stopUpdater();
  const settings = await readSavedSettings();
  await writeSavedSettings({ ...settings, autoStart: false, encryptedPassword: '' });
  configureWindowsStartup(false);
  log('info', 'Atualizações interrompidas.');
  return { success: true };
}

handleConfiguration('updater:stop', pauseUpdates);
handleConfiguration('updater:change-unit', async () => {
  if (updaterState.isUpdating || isResuming) return { success: false, message: 'Aguarde a operação atual terminar.' };
  await pauseUpdates();
  canSelectUnit = false;
  currentSession = null;
  return { success: true };
});

ipcMain.handle('updater:open-instance-qr', async () => {
  const session = currentSession;
  if (!session?.selectedUnit) return { success: false, message: 'Configure uma unidade antes de abrir o QR Code.' };
  try {
    const instanceSlug = session.selectedUnit.instanceSlug || (session.credentials.instanceSlug !== 'authgate' ? session.credentials.instanceSlug : '');
    if (!instanceSlug) throw new Error('Não foi possível identificar a instância desta unidade. Entre novamente.');
    const endpoint = `/instances/${encodeURIComponent(instanceSlug)}/units?pagination=false`;
    let result;
    try {
      result = await request(endpoint, { headers: authHeaders(session.token) });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      session.token = await authenticate(session.credentials);
      result = await request(endpoint, { headers: authHeaders(session.token) });
    }
    const codes = [...new Set(getCollection(result.body).map((unit) => getString(unit, ['code']).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    if (!codes.length) throw new Error('Nenhuma unidade disponível para gerar o QR Code.');
    if (currentSession !== session) throw new Error('A configuração foi alterada. Tente novamente.');
    const url = new URL(`https://authgate.com.br/${encodeURIComponent(instanceSlug)}/public/qr`);
    codes.forEach((code) => url.searchParams.append('unit', code));
    await shell.openExternal(url.href);
    return { success: true };
  } catch (error) {
    return { success: false, message: getFriendlyError(error, 'abrir o QR Code da instância') };
  }
});

ipcMain.handle('updater:update-now', async () => {
  if (!updaterState.isActive) {
    return { success: false, message: 'Inicie as atualizações antes de usar esta opção.' };
  }

  return updateIp();
});

// Serialize settings mutations and return actionable IPC errors instead of rejected promises.
function handleConfiguration(channel, handler) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (...args) => {
    if (isQuittingForAppUpdate) return { success: false, message: 'O aplicativo está reiniciando para atualizar.' };
    configurationOperations += 1;
    const operation = settingsQueue.then(() => handler(...args)).finally(() => {
      configurationOperations -= 1;
      installDownloadedAppUpdateWhenSafe();
    });
    settingsQueue = operation.catch(() => undefined);
    return operation.catch((error) => ({ success: false, message: getFriendlyError(error, 'salvar a configuração') }));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    configureAutomaticAppUpdates();
    createWindow();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
    tray.setToolTip('AuthGate — Atualizador de IP');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir AuthGate', click: () => mainWindow.show() },
      { label: 'Sair', click: () => app.quit() },
    ]));
    tray.on('double-click', () => mainWindow.show());
    powerMonitor.on('resume', () => {
      void checkForAppUpdate();
      if (updaterState.isActive) void updateIp();
      else void resumeAutomaticUpdates();
    });
    mainWindow.webContents.once('did-finish-load', () => {
      sendAppUpdateState(appUpdateState);
      void resumeAutomaticUpdates();
    });
  });
}
app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(appUpdateTimer);
  clearTimeout(resumeTimer);
  stopUpdater();
});
