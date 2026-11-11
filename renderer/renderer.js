const elements = {
  instancePicker: document.querySelector('#instance-picker'),
  instanceSelect: document.querySelector('#instance-select'),
  selectionTitle: document.querySelector('#selection-title'),
  unitSelectLabel: document.querySelector('#unit-select-label'),
  checkAppUpdate: document.querySelector('#check-app-update'),
  appUpdateProgress: document.querySelector('#app-update-progress'),
  appUpdateDetails: document.querySelector('#app-update-details'),
  appVersion: document.querySelector('#app-version'),
  openInstanceQr: document.querySelector('#open-instance-qr'),
  appUpdateStatus: document.querySelector('#app-update-status'),
  changeAccount: document.querySelector('#change-account'),
  monitorCard: document.querySelector('#monitor-card'),
  selectedUnitName: document.querySelector('#selected-unit-name'),
  resumeButton: document.querySelector('#resume-button'),
  changeLogin: document.querySelector('#change-login'),
  email: document.querySelector('#email'),
  instanceSlug: document.querySelector('#instance-slug'),
  loadingIndicator: document.querySelector('#loading-indicator'),
  logList: document.querySelector('#log-list'),
  loginButton: document.querySelector('#login-button'),
  loginCard: document.querySelector('#login-card'),
  loginError: document.querySelector('#login-error'),
  loginForm: document.querySelector('#login-form'),
  password: document.querySelector('#password'),
  startButton: document.querySelector('#start-button'),
  statusDescription: document.querySelector('#status-description'),
  statusPill: document.querySelector('#status-pill'),
  statusTitle: document.querySelector('#status-title'),
  stopButton: document.querySelector('#stop-button'),
  unitCard: document.querySelector('#unit-card'),
  unitHelp: document.querySelector('#unit-help'),
  unitSelect: document.querySelector('#unit-select'),
  updateButton: document.querySelector('#update-button'),
};

let units = [];
let selectedUnit = null;
let isLoginLoading = false;
let isRootSession = false;

function setLoginLoading(isLoading) {
  isLoginLoading = isLoading;
  elements.loginButton.disabled = isLoading;
  elements.loginButton.classList.toggle('is-loading', isLoading);
  elements.loginButton.querySelector('.button-label').textContent = isLoading
    ? 'Carregando unidades…'
    : 'Entrar e carregar unidades';
}

function setLoginError(message = '') {
  elements.loginError.textContent = message;
}

function fillUnitOptions() {
  elements.unitSelect.replaceChildren();
  const visibleUnits = isRootSession
    ? units.filter((unit) => unit.instanceSlug === elements.instanceSelect.value)
    : units;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = isRootSession && !elements.instanceSelect.value ? 'Selecione uma instância primeiro' : 'Selecione a unidade';
  elements.unitSelect.append(placeholder);
  visibleUnits.forEach((unit) => {
    const option = document.createElement('option');
    option.value = unit.id;
    option.textContent = unit.code ? `${unit.name} (${unit.code})` : unit.name;
    elements.unitSelect.append(option);
  });
  elements.unitSelect.value = '';
  elements.unitSelect.disabled = isRootSession && !elements.instanceSelect.value;
  elements.startButton.disabled = true;
}

function setLoggedIn(nextUnits, isRoot = false) {
  selectedUnit = null;
  isRootSession = isRoot;
  elements.monitorCard.classList.add('hidden');
  units = nextUnits;
  elements.instancePicker.classList.toggle('hidden', !isRoot);
  elements.selectionTitle.textContent = isRoot ? 'Escolha a instância e a unidade' : 'Escolha a unidade';
  elements.unitSelectLabel.textContent = isRoot ? '2. Unidade' : 'Unidade';
  elements.instanceSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Selecione a instância';
  elements.instanceSelect.append(placeholder);
  const instances = new Map();
  units.forEach((unit) => {
    if (unit.instanceSlug) instances.set(unit.instanceSlug, unit.instanceName || unit.instanceSlug);
  });
  [...instances].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')).forEach(([slug, name]) => {
    const option = document.createElement('option');
    option.value = slug;
    option.textContent = `${name} (${slug})`;
    elements.instanceSelect.append(option);
  });
  elements.instanceSelect.value = '';
  fillUnitOptions();
  elements.password.value = '';
  elements.unitHelp.textContent = 'Atualiza o IP a cada 5 minutos. Ao fechar a janela, continua na bandeja do Windows. Novas versões são instaladas automaticamente.';
  elements.loginCard.classList.add('hidden');
  elements.unitCard.classList.remove('hidden');
  elements.statusTitle.textContent = isRoot ? 'Escolha a instância e a unidade' : 'Escolha a unidade';
  elements.statusDescription.textContent = 'Clique em “Iniciar atualizações” para começar.';
  updateStatusPill('ready');
}

function updateStatusPill(status) {
  elements.statusPill.className = 'status-pill';

  if (status === 'active') {
    elements.statusPill.textContent = 'Atualizações ativas';
    elements.statusPill.classList.add('status-active');
    return;
  }

  if (status === 'error') {
    elements.statusPill.textContent = 'Atenção necessária';
    elements.statusPill.classList.add('status-error');
    return;
  }

  elements.statusPill.textContent = status === 'ready' ? 'Pronto para iniciar' : 'Aguardando acesso';
}

function formatTime(isoDate) {
  if (!isoDate) {
    return '';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(isoDate));
}

function addLog(entry) {
  const emptyLog = elements.logList.querySelector('.empty-log');
  if (emptyLog) {
    emptyLog.remove();
  }

  const row = document.createElement('div');
  row.className = `log-entry ${entry.type}`;
  const time = document.createElement('time');
  const message = document.createElement('span');
  time.textContent = formatTime(entry.timestamp);
  message.textContent = entry.message;
  row.append(time, message);
  elements.logList.prepend(row);

  while (elements.logList.children.length > 30) {
    elements.logList.lastElementChild.remove();
  }
}

function showMonitor(unit) {
  selectedUnit = unit;
  units = [];
  elements.instanceSelect.replaceChildren();
  elements.unitSelect.replaceChildren();
  elements.password.value = '';
  elements.selectedUnitName.textContent = unit.code ? `${unit.name} (${unit.code})` : unit.name;
  elements.loginCard.classList.add('hidden');
  elements.unitCard.classList.add('hidden');
  elements.monitorCard.classList.remove('hidden');
}

async function requestUnitChange() {
  const result = await window.authgateUpdater.changeUnit();
  if (!result.success) {
    addLog({ type: 'error', message: result.message, timestamp: new Date().toISOString() });
    return;
  }
  selectedUnit = null;
  units = [];
  elements.instanceSelect.replaceChildren();
  elements.unitSelect.replaceChildren();
  elements.password.value = '';
  setLoginError();
  elements.monitorCard.classList.add('hidden');
  elements.unitCard.classList.add('hidden');
  elements.loginCard.classList.remove('hidden');
  elements.statusTitle.textContent = 'Entre novamente';
  elements.statusDescription.textContent = 'Informe a senha do administrador para escolher outra unidade.';
  updateStatusPill('idle');
  elements.password.focus();
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isLoginLoading) {
    return;
  }

  setLoginError();
  setLoginLoading(true);
  const result = await window.authgateUpdater.login({
    email: elements.email.value,
    instanceSlug: elements.instanceSlug.value,
    password: elements.password.value,
  });
  setLoginLoading(false);

  if (!result.success) {
    setLoginError(result.message);
    updateStatusPill('error');
    return;
  }

  setLoggedIn(result.units, result.isRoot);
});

elements.instanceSelect.addEventListener('change', fillUnitOptions);
elements.unitSelect.addEventListener('change', () => {
  elements.startButton.disabled = !elements.unitSelect.value;
});

elements.startButton.addEventListener('click', async () => {
  const result = await window.authgateUpdater.start(elements.unitSelect.value);

  if (!result.success) {
    addLog({ type: 'error', message: result.message, timestamp: new Date().toISOString() });
    updateStatusPill('error');
  }
});

elements.stopButton.addEventListener('click', () => {
  void window.authgateUpdater.stop();
});

elements.updateButton.addEventListener('click', async () => {
  const result = await window.authgateUpdater.updateNow();
  if (!result.success) {
    addLog({ type: 'error', message: result.message, timestamp: new Date().toISOString() });
  }
});

elements.changeLogin.addEventListener('click', requestUnitChange);
elements.changeAccount.addEventListener('click', requestUnitChange);
elements.resumeButton.addEventListener('click', async () => {
  if (!selectedUnit) return;
  const result = await window.authgateUpdater.start(selectedUnit.id);
  if (!result.success) addLog({ type: 'error', message: result.message, timestamp: new Date().toISOString() });
});

window.authgateUpdater.onLog(addLog);
window.authgateUpdater.onSession((session) => {
  showMonitor(session.selectedUnit);
});
function renderAppUpdate(state) {
  elements.checkAppUpdate.disabled = ['checking', 'downloading', 'ready', 'installing'].includes(state.status);
  elements.appUpdateProgress.classList.toggle('hidden', state.status !== 'downloading');
  elements.appUpdateProgress.value = state.progress ?? 0;
  elements.appUpdateDetails.textContent = [
    state.lastCheckedAt ? `Última verificação: ${formatTime(state.lastCheckedAt)}.` : '',
    state.nextCheckAt ? `Próxima verificação: ${formatTime(state.nextCheckAt)}.` : '',
    state.status === 'unavailable' && state.errorCode ? `Código: ${state.errorCode}.` : '',
  ].filter(Boolean).join(' ');
  if (state.status === 'checking') {
    elements.appUpdateStatus.textContent = 'Procurando atualização do aplicativo…';
  } else if (state.status === 'downloading') {
    const progress = Number.isFinite(state.progress) ? ` ${state.progress}%` : '';
    elements.appUpdateStatus.textContent = `Baixando versão ${state.version ?? 'nova'}${progress}… A instalação será automática.`;
  } else if (state.status === 'ready') {
    elements.appUpdateStatus.textContent = 'Atualização pronta. O aplicativo reiniciará depois da atualização de IP.';
  } else if (state.status === 'installing') {
    elements.appUpdateStatus.textContent = 'Instalando atualização e reiniciando…';
  } else if (state.status === 'unavailable') {
    elements.appUpdateStatus.textContent = 'Atualização do aplicativo indisponível. Nova tentativa automática em até 5 minutos.';
  } else if (state.status === 'up-to-date') {
    elements.appUpdateStatus.textContent = 'Aplicativo atualizado. Novas versões serão instaladas automaticamente.';
  }
}
window.authgateUpdater.onAppUpdate(renderAppUpdate);
void window.authgateUpdater.getAppUpdateState().then(renderAppUpdate);
elements.checkAppUpdate.addEventListener('click', async () => {
  elements.checkAppUpdate.disabled = true;
  try {
    const result = await window.authgateUpdater.checkAppUpdate();
    if (!result.success) elements.appUpdateStatus.textContent = result.message;
  } finally {
    renderAppUpdate(await window.authgateUpdater.getAppUpdateState());
  }
});
window.authgateUpdater.onState((state) => {
  const isActive = state.isActive;
  const isUpdating = state.isUpdating;
  elements.resumeButton.classList.toggle('hidden', isActive);
  elements.resumeButton.disabled = isUpdating;
  elements.stopButton.classList.toggle('hidden', !isActive);
  elements.updateButton.classList.toggle('hidden', !isActive);
  elements.unitSelect.disabled = isActive || isUpdating || (isRootSession && !elements.instanceSelect.value);
  elements.instanceSelect.disabled = isActive || isUpdating;
  elements.startButton.disabled = isUpdating || !elements.unitSelect.value;
  elements.changeLogin.disabled = isUpdating;
  elements.changeAccount.disabled = isUpdating;
  elements.loadingIndicator.classList.toggle('hidden', !isUpdating);
  elements.updateButton.disabled = isUpdating;

  if (!isActive) {
    elements.statusTitle.textContent = selectedUnit ? 'Atualizações pausadas' : 'Pronto para começar';
    elements.statusDescription.textContent = selectedUnit
      ? `Unidade: ${selectedUnit.name}. Retome para continuar atualizando esta unidade.`
      : 'Entre com a sua conta para selecionar uma unidade.';
    updateStatusPill(selectedUnit || units.length ? 'ready' : 'idle');
    return;
  }

  elements.statusTitle.textContent = isUpdating ? 'Atualizando o IP agora' : 'Atualizações ativas';
  elements.statusDescription.textContent = isUpdating
    ? `Enviando a atualização para ${state.unitName}.`
    : `Unidade: ${state.unitName}. Próxima atualização às ${formatTime(state.nextUpdateAt)}.`;
  updateStatusPill('active');
});

void window.authgateUpdater.getSavedSettings().then((settings) => {
  elements.appVersion.textContent = settings.version ? `Versão ${settings.version}` : '';
  elements.instanceSlug.value = settings.instanceSlug ?? '';
  elements.email.value = settings.email ?? '';
  elements.password.focus();
});

elements.openInstanceQr.addEventListener('click', async () => {
  elements.openInstanceQr.disabled = true;
  elements.openInstanceQr.textContent = 'Abrindo QR Code…';
  try {
    const result = await window.authgateUpdater.openInstanceQr();
    if (!result.success) addLog({ type: 'error', message: result.message, timestamp: new Date().toISOString() });
  } catch {
    addLog({ type: 'error', message: 'Não foi possível abrir o QR Code. Tente novamente.', timestamp: new Date().toISOString() });
  } finally {
    elements.openInstanceQr.disabled = false;
    elements.openInstanceQr.textContent = 'Abrir QR Code da instância';
  }
});
