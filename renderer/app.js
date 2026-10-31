/**
 * app.js — логіка renderer-процесу.
 * Працює лише через window.api (наданий preload.cjs) — прямого
 * доступу до Node.js/Playwright тут немає.
 *
 * Примітка: цей файл підключений як звичайний <script> (не ES Module),
 * оскільки Electron завантажує renderer через file://, де ES Module
 * import з локальних файлів має обмеження. i18n.js підключений окремим
 * <script> і надає глобальну функцію getUiText(lang).
 *
 * Програма керує до MAX_ACCOUNTS акаунтів. Кожен акаунт має власну
 * форму (текст, групи, фото, час старту, затримка), власний стан
 * виконання й власний журнал; усі акаунти можуть працювати одночасно.
 */

const el = (id) => document.getElementById(id);

const accountTabsEl = el('accountTabs');
const btnAddAccount = el('btnAddAccount');
const accountLimitEl = el('accountLimit');
const accountNameEl = el('accountName');
const btnDeleteAccount = el('btnDeleteAccount');
const sessionBadgeEl = el('sessionBadge');
const btnLogin = el('btnLogin');
const btnConfirmLogin = el('btnConfirmLogin');
const groupsListEl = el('groupsList');
const postTextEl = el('postText');
const btnSelectImage = el('btnSelectImage');
const btnClearImage = el('btnClearImage');
const imagePathLabel = el('imagePathLabel');
const startTimeEl = el('startTime');
const btnClearTime = el('btnClearTime');
const delayMinEl = el('delayMin');
const delayMaxEl = el('delayMax');
const btnStart = el('btnStart');
const btnPause = el('btnPause');
const btnStop = el('btnStop');
const btnStartAll = el('btnStartAll');
const btnStopAll = el('btnStopAll');
const statusLineEl = el('statusLine');
const progressFillEl = el('progressFill');
const progressLabelEl = el('progressLabel');
const langSelect = el('langSelect');
const logScopeEl = el('logScope');
const logEl = el('log');
const dailyCounterEl = el('dailyCounter');
const modePublishEl = el('modePublish');
const modeActivityEl = el('modeActivity');
const modeJoinEl = el('modeJoin');
const modeFullEl = el('modeFull');
const btnUseWorkEl = el('btnUseWork');
const workRowEl = el('workRow');
const verifyOnlyEl = el('verifyOnly');
const verifyResultsEl = el('verifyResults');
const publishResultsHeadEl = el('publishResultsHead');
const btnImportGroupsEl = el('btnImportGroups');
const btnDropBlackEl = el('btnDropBlack');
const btnRevealBlackEl = el('btnRevealBlack');
const verifyBodyEl = el('verifyBody');
const blackListEl = el('blackList');
const warmupOnlyEl = el('warmupOnly');
const warmCommentTextsEl = el('warmCommentTexts');
const btnResetWarmupEl = el('btnResetWarmup');
const warmupStartLabelEl = el('warmupStartLabel');
const warmupInfoEl = el('warmupInfo');
const blockBoxEl = el('blockBox');
const blockTextEl = el('blockText');
const btnClearBlockEl = el('btnClearBlock');
const textPreviewEl = el('textPreview');
const activityOnlyEl = el('activityOnly');
const delayRowEl = el('delayRow');
const act = {
  followsMin: el('actFollowsMin'),
  followsMax: el('actFollowsMax'),
  commentsMin: el('actCommentsMin'),
  commentsMax: el('actCommentsMax'),
  commentTexts: el('actCommentTexts'),
  dailyLimit: el('actDailyLimit'),
  durMin: el('actDurMin'),
  durMax: el('actDurMax'),
  pauseMin: el('actPauseMin'),
  pauseMax: el('actPauseMax'),
  likesMin: el('actLikesMin'),
  likesMax: el('actLikesMax'),
  visitGroups: el('actVisitGroups'),
  openPosts: el('actOpenPosts'),
};
const DEFAULT_ACTIVITY = {
  followsMin: 1,
  followsMax: 3,
  commentsMin: 0,
  commentsMax: 1,
  commentTexts: '',
  dailyLimit: 0,
  durMin: 10,
  durMax: 20,
  pauseMin: 30,
  pauseMax: 90,
  likesMin: 2,
  likesMax: 6,
  visitGroups: true,
  openPosts: true,
};
const publishOnlyEl = el('publishOnly');
const autoJoinEl = el('autoJoin');
const btnClearResultsEl = el('btnClearResults');
const btnRevealShotsEl = el('btnRevealShots');
const resultsBodyEl = el('resultsBody');
const resultsEmptyEl = el('resultsEmpty');
const waitNoteEl = el('waitNote');
const reasonListEl = el('reasonList');
const resultsBlockEls = [
  el('publishResultsHead'),
  el('publishTiles'),
  waitNoteEl,
  reasonListEl,
  el('publishTable'),
];
const dailyJoinLimitEl = el('dailyJoinLimit');
const autoFormEl = el('autoForm');
const formAnswerEl = el('formAnswer');

const MAX_LOG_LINES = 3000;

let currentLang = 'uk';
let maxAccounts = 10;
let accounts = [];
let activeId = null;
let saveTimer = null;
let stats = { total: 0, perAccount: {} };
let sessions = {};
let verifyData = {}; // accountId -> { [groupKey]: entry }
let workItems = []; // «Групи в роботу» (лише читання)
let blacklistItems = []; // постійний чорний список (лише читання)

/** Ключ групи (дзеркало src/blacklist.js groupKey). */
function groupKeyOf(url) {
  const m = /facebook\.com\/groups\/([^/?#\s]+)/i.exec(String(url ?? ''));
  if (!m) return null;
  try { return `groups/${decodeURIComponent(m[1]).toLowerCase()}`; } catch { return `groups/${m[1].toLowerCase()}`; }
}
/** Групи, з якими працює режим «Публікація»: або «Групи в роботу», або вставлений список. */
function effectiveGroups(account) {
  if (account && ['publish', 'full'].includes(account.mode ?? 'publish') && account.useWorklist) {
    return workItems.map((g) => g.url).filter((u) => !isBlacklistedUrl(u));
  }
  return account?.groups ?? [];
}
function isBlacklistedUrl(url) {
  const key = groupKeyOf(url);
  return key ? blacklistItems.some((b) => b.key === key) : false;
}
const runtime = {}; // id -> { status, startAt, done, total, loginOpen }
const logLines = []; // { id, time, msg, error }

function rt(id) {
  if (!runtime[id]) runtime[id] = { status: 'idle', startAt: null, done: 0, total: 0, loginOpen: false };
  return runtime[id];
}

function activeAccount() {
  return accounts.find((a) => a.id === activeId) ?? null;
}

function accountName(id) {
  return accounts.find((a) => a.id === id)?.name ?? id;
}

function isBusy(id) {
  const s = rt(id).status;
  return s === 'running' || s === 'waiting' || s === 'paused';
}

function newAccountId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function newAccountObject() {
  const ui = getUiText(currentLang);
  let n = 1;
  while (accounts.some((a) => a.name === ui.defaultAccountName(n))) n++;
  return {
    id: newAccountId(),
    name: ui.defaultAccountName(n),
    text: '',
    groups: [],
    imagePath: '',
    startTime: '',
    delayMinSec: 3,
    delayMaxSec: 5,
    mode: 'publish',
    dailyJoinLimit: 20,
    autoJoin: true,
    autoForm: true,
    formAnswer: '',
    activity: { ...DEFAULT_ACTIVITY },
    warmup: { startDate: '', commentTexts: '' },
    blocked: null,
  };
}

// --- Збереження налаштувань (автозбереження) ---

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.saveConfig({ language: currentLang, accounts, activeAccountId: activeId });
  }, 400);
}

function getGroupsArray() {
  return groupsListEl.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function numberOr(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Переносить значення з форми в активний акаунт. */
function readFormIntoAccount() {
  const account = activeAccount();
  if (!account) return;
  account.name = accountNameEl.value.trim() || account.name;
  account.groups = getGroupsArray();
  account.text = postTextEl.value;
  account.startTime = startTimeEl.value || '';
  if (account.mode === 'activity') {
    // затримка між постами в цьому режимі не використовується
  } else {
    account.delayMinSec = numberOr(delayMinEl.value, 3);
    account.delayMaxSec = numberOr(delayMaxEl.value, 5);
  }
  account.dailyJoinLimit = Math.max(0, Math.floor(numberOr(dailyJoinLimitEl.value, 20)));
  account.autoJoin = autoJoinEl.checked;
  account.autoForm = autoFormEl.checked;
  account.formAnswer = formAnswerEl.value;
  account.warmup = { ...(account.warmup ?? { startDate: '' }), commentTexts: warmCommentTextsEl.value };
  account.activity = {
    followsMin: Math.max(0, Math.floor(numberOr(act.followsMin.value, 1))),
    followsMax: Math.max(0, Math.floor(numberOr(act.followsMax.value, 3))),
    commentsMin: Math.max(0, Math.floor(numberOr(act.commentsMin.value, 0))),
    commentsMax: Math.max(0, Math.floor(numberOr(act.commentsMax.value, 1))),
    commentTexts: act.commentTexts.value,
    dailyLimit: Math.max(0, Math.floor(numberOr(act.dailyLimit.value, 0))),
    durMin: numberOr(act.durMin.value, 10),
    durMax: numberOr(act.durMax.value, 20),
    pauseMin: numberOr(act.pauseMin.value, 30),
    pauseMax: numberOr(act.pauseMax.value, 90),
    likesMin: Math.max(0, Math.floor(numberOr(act.likesMin.value, 2))),
    likesMax: Math.max(0, Math.floor(numberOr(act.likesMax.value, 6))),
    visitGroups: act.visitGroups.checked,
    openPosts: act.openPosts.checked,
  };
}

// --- Переклад ---

function applyTranslations() {
  const ui = getUiText(currentLang);
  el('accountNameLabel').textContent = ui.accountNameLabel;
  btnAddAccount.textContent = ui.btnAddAccount;
  btnDeleteAccount.textContent = ui.btnDeleteAccount;
  el('postTextLabel').textContent = ui.postTextLabel;
  postTextEl.placeholder = ui.postTextPlaceholder;
  el('imageLabel').textContent = ui.imageLabel;
  btnSelectImage.textContent = ui.btnSelectImage;
  btnClearImage.textContent = ui.btnClearImage;
  const accountMode = activeAccount()?.mode ?? 'publish';
  el('groupsLabel').textContent =
    accountMode === 'activity' || accountMode === 'warmup' ? ui.groupsLabelActivity : ui.groupsLabel;
  modeActivityEl.textContent = ui.modeActivity;
  modeJoinEl.textContent = ui.modeJoin;
  modeFullEl.textContent = ui.modeFull;
  el('verifyHint').textContent = accountMode === 'join' ? ui.joinHint : accountMode === 'full' ? ui.fullHint : ui.verifyHint;
  btnImportGroupsEl.textContent = ui.btnImportGroups;
  btnDropBlackEl.textContent = ui.btnDropBlack;
  el('verifyTitle').textContent = ui.verifyTitle;
  el('vGoodLabel').textContent = ui.vGood;
  el('vBlackLabel').textContent = ui.vBlack;
  el('vPendingLabel').textContent = ui.vPending;
  el('vOtherLabel').textContent = ui.vOther;
  el('vThGroup').textContent = ui.thGroup;
  el('vThStatus').textContent = ui.thStatus;
  el('verifyEmpty').textContent = ui.verifyEmpty;
  el('blackNote').textContent = ui.blackNote;
  btnRevealBlackEl.textContent = ui.btnRevealBlack;
  el('warmCommentTextsLabel').textContent = ui.warmCommentTextsLabel;
  btnResetWarmupEl.textContent = ui.btnResetWarmup;
  el('warmupHint').textContent = ui.warmupHint;
  el('textVariantsHint').textContent = ui.textVariantsHint;
  refreshWarmupInfo();
  refreshTextPreview();
  el('actFollowsLabel').textContent = ui.actFollowsLabel;
  el('actCommentsLabel').textContent = ui.actCommentsLabel;
  el('actCommentTextsLabel').textContent = ui.actCommentTextsLabel;
  el('actDailyLimitLabel').textContent = ui.actDailyLimitLabel;
  el('actDurLabel').textContent = ui.actDurLabel;
  el('actPauseLabel').textContent = ui.actPauseLabel;
  el('actLikesLabel').textContent = ui.actLikesLabel;
  for (const node of document.querySelectorAll('.act-from')) node.textContent = ui.actFrom;
  for (const node of document.querySelectorAll('.act-to')) node.textContent = ui.actTo;
  for (const node of document.querySelectorAll('.act-min')) node.textContent = ui.actMin;
  el('actVisitGroupsLabel').textContent = ui.actVisitGroupsLabel;
  el('actOpenPostsLabel').textContent = ui.actOpenPostsLabel;
  el('actHint').textContent = ui.actHint;
  groupsListEl.placeholder = ui.groupsPlaceholder;
  modePublishEl.textContent = ui.modePublish;
  el('autoJoinLabel').textContent = ui.autoJoinLabel;
  el('resultsTitle').textContent = ui.resultsTitle;
  btnClearResultsEl.textContent = ui.btnClearResults;
  btnRevealShotsEl.textContent = ui.btnRevealShots;
  el('tilePublishedLabel').textContent = ui.tilePublished;
  el('tilePendingLabel').textContent = ui.tilePending;
  el('tileJoinPendingLabel').textContent = ui.tileJoinPending;
  el('tileFailedLabel').textContent = ui.tileFailed;
  el('thGroup').textContent = ui.thGroup;
  el('thStatus').textContent = ui.thStatus;
  el('resultsEmpty').textContent = ui.resultsEmpty;
  el('dailyLimitLabel').textContent = ui.dailyLimitLabel;
  el('dailyLimitHint').textContent = ui.dailyLimitHint;
  el('autoFormLabel').textContent = ui.autoFormLabel;
  el('formAnswerLabel').textContent = ui.formAnswerLabel;
  formAnswerEl.placeholder = ui.formAnswerPlaceholder;
  el('formAnswerHint').textContent = ui.formAnswerHint;
  el('startTimeLabel').textContent = ui.startTimeLabel;
  btnClearTime.textContent = ui.btnClearTime;
  el('startTimeHint').textContent = ui.startTimeHint;
  el('delayLabel').textContent = ui.delayLabel;
  el('delayFromLabel').textContent = ui.delayFrom;
  el('delayToLabel').textContent = ui.delayTo;
  el('delayUnit').textContent = ui.delayUnit;
  btnLogin.textContent = ui.btnLogin;
  btnConfirmLogin.textContent = ui.btnConfirmLogin;
  btnStart.textContent =
    accountMode === 'join' ? ui.btnStartJoin : accountMode === 'full' ? ui.btnStartFull : accountMode === 'verify' ? ui.btnStartVerify : accountMode === 'warmup' ? ui.btnStartWarmup : accountMode === 'activity' ? ui.btnStartActivity : ui.btnStart;
  btnStartAll.textContent = ui.btnStartAll;
  btnStopAll.textContent = ui.btnStopAll;
  btnStop.textContent = ui.btnStop;
  el('logLabel').textContent = ui.logLabel;
  logScopeEl.options[0].textContent = ui.logScopeCurrent;
  logScopeEl.options[1].textContent = ui.logScopeAll;
  updateImageLabel();
  renderAll();
}

langSelect.addEventListener('change', () => {
  currentLang = langSelect.value;
  applyTranslations();
  scheduleSave();
});

// --- Результати публікації по групах ---

let results = {}; // accountId -> { [url]: { status, reason, at } }

function shortGroup(url) {
  return String(url).replace(/^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i, '').replace(/\/$/, '');
}

function renderResults() {
  const account = activeAccount();
  if (!account) return;
  const ui = getUiText(currentLang);
  const data = results[account.id] ?? {};
  const groups = effectiveGroups(account);

  const counts = { published: 0, pending: 0, joinPending: 0, failed: 0 };
  const reasons = {};
  resultsBodyEl.textContent = '';

  for (const url of groups) {
    const entry = data[url];
    const tr = document.createElement('tr');

    const groupCell = document.createElement('td');
    groupCell.className = 'group-cell';
    groupCell.textContent = shortGroup(url);
    groupCell.title = url;

    const statusCell = document.createElement('td');
    const chip = document.createElement('span');
    const status = entry?.status ?? 'none';
    chip.className = `chip chip-${status}`;
    chip.textContent = ui.statusLabels[status] ?? status;
    statusCell.appendChild(chip);

    if (entry && status !== 'working') {
      if (status in counts) counts[status]++;
      const note = document.createElement('span');
      note.className = 'status-note';
      const time = new Date(entry.at).toLocaleString(currentLang === 'uk' ? 'uk-UA' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const reasonText = ui.reasonLabels[`${status}.${entry.reason}`] ?? ui.reasonLabels[entry.reason] ?? '';
      note.textContent = reasonText ? `${reasonText} · ${time}` : time;
      statusCell.appendChild(note);
      if (status === 'failed') {
        const label = ui.reasonLabels[entry.reason] ?? entry.reason;
        reasons[label] = (reasons[label] ?? 0) + 1;
      }
    }
    tr.append(groupCell, statusCell);
    resultsBodyEl.appendChild(tr);
  }

  el('tilePublished').textContent = counts.published;
  el('tilePending').textContent = counts.pending;
  el('tileJoinPending').textContent = counts.joinPending;
  el('tileFailed').textContent = counts.failed;

  const waiting = counts.pending + counts.joinPending;
  waitNoteEl.textContent = ui.waitNote(waiting, counts.pending, counts.joinPending);
  waitNoteEl.hidden = waiting === 0 || (account.mode ?? 'publish') !== 'publish';

  reasonListEl.textContent = '';
  for (const [label, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    const row = document.createElement('div');
    row.className = 'reason-row';
    const name = document.createElement('span');
    name.textContent = `✖ ${label}`;
    const number = document.createElement('b');
    number.textContent = count;
    row.append(name, number);
    reasonListEl.appendChild(row);
  }

  resultsEmptyEl.hidden = groups.length > 0;
}

// --- Верифікація груп ---

function renderVerify() {
  const account = activeAccount();
  if (!account) return;
  const ui = getUiText(currentLang);
  const data = verifyData[account.id] ?? {};
  const counts = { good: 0, blacklisted: 0, pending: 0, other: 0 };
  verifyBodyEl.textContent = '';
  const groups = account.groups ?? [];
  const seen = new Set();
  for (const url of groups) {
    const key = groupKeyOf(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const black = blacklistItems.find((b) => b.key === key);
    const entry = black ? { status: 'blacklisted', reason: black.reason, at: black.at } : data[key];
    const status = entry?.status ?? 'none';
    const tr = document.createElement('tr');
    const groupCell = document.createElement('td');
    groupCell.className = 'group-cell';
    groupCell.textContent = shortGroup(url);
    groupCell.title = url;
    const statusCell = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = `chip chip-${status === 'good' || status === 'member' ? 'published' : status === 'blacklisted' ? 'failed' : status === 'pending' ? 'pending' : status === 'working' ? 'working' : 'none'}`;
    chip.textContent = ui.verifyStatus[status] ?? status;
    statusCell.appendChild(chip);
    if (entry && status !== 'working') {
      if (status === 'good' || status === 'member') counts.good++;
      else if (status === 'blacklisted') counts.blacklisted++;
      else if (status === 'pending') counts.pending++;
      else if (status !== 'none') counts.other++;
      const note = document.createElement('span');
      note.className = 'status-note';
      const time = entry.at ? new Date(entry.at).toLocaleString(currentLang === 'uk' ? 'uk-UA' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const reason = ui.verifyReason[entry.reason] ?? '';
      note.textContent = [reason, time].filter(Boolean).join(' · ');
      statusCell.appendChild(note);
    }
    tr.append(groupCell, statusCell);
    verifyBodyEl.appendChild(tr);
  }
  el('vGood').textContent = counts.good;
  el('vBlack').textContent = counts.blacklisted;
  el('vPending').textContent = counts.pending;
  el('vOther').textContent = counts.other;
  el('verifyEmpty').hidden = seen.size > 0;

  el('blackSummary').textContent = ui.blackSummary(blacklistItems.length);
  blackListEl.textContent = '';
  for (const item of [...blacklistItems].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    const line = document.createElement('div');
    line.className = 'log-line';
    const when = item.at ? new Date(item.at).toLocaleDateString(currentLang === 'uk' ? 'uk-UA' : 'en-GB') : '';
    line.textContent = `${shortGroup(item.url ?? item.key)} — ${ui.verifyReason[item.reason] ?? item.reason} (${when})`;
    blackListEl.appendChild(line);
  }
}

async function refreshBlacklist() {
  [blacklistItems, workItems] = await Promise.all([window.api.loadBlacklist(activeId), window.api.loadWorklist(activeId)]);
  renderVerify();
  renderResults();
  updateControls();
}

// --- Відображення ---

async function refreshWarmupInfo() {
  const account = activeAccount();
  const ui = getUiText(currentLang);
  if (!account) return;
  if (!account.warmup?.startDate) {
    warmupInfoEl.textContent = ui.warmupNotStarted;
    warmupStartLabelEl.textContent = '';
    return;
  }
  const info = await window.api.getWarmupInfo({ warmup: account.warmup });
  warmupInfoEl.textContent = ui.warmupInfo(info);
  warmupStartLabelEl.textContent = ui.warmupStarted(account.warmup.startDate);
}

let previewTimer = null;
function refreshTextPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const ui = getUiText(currentLang);
    const text = postTextEl.value;
    if (!text.trim()) {
      textPreviewEl.textContent = '';
      return;
    }
    const preview = await window.api.previewText(text);
    textPreviewEl.textContent = ui.textPreview(preview);
  }, 250);
}

function statusText(id) {
  const ui = getUiText(currentLang);
  const state = rt(id);
  const blocked = accounts.find((a) => a.id === id)?.blocked;
  if (blocked && state.status === 'idle') {
    return ui.blockedStatus(ui.blockReasons[blocked.reason] ?? blocked.reason);
  }
  if (state.status === 'waiting') {
    const d = new Date(state.startAt ?? Date.now());
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return ui.statusWaiting(`${hh}:${mm}`);
  }
  if (state.status === 'paused') return ui.statusPaused;
  if (state.status === 'running') return ui.statusRunning;
  return ui.statusIdle;
}

function renderTabs() {
  accountTabsEl.textContent = '';
  for (const account of accounts) {
    const tab = document.createElement('button');
    tab.className =
      'account-tab' + (account.id === activeId ? ' account-tab-active' : '') + (account.blocked ? ' account-tab-blocked' : '');
    tab.dataset.id = account.id;
    tab.title = statusText(account.id);

    const dot = document.createElement('span');
    dot.className = `status-dot status-${account.blocked ? 'blocked' : rt(account.id).status}`;
    const name = document.createElement('span');
    name.className = 'account-tab-name';
    name.textContent = account.name;
    tab.append(dot, name);

    tab.addEventListener('click', () => selectAccount(account.id));
    accountTabsEl.appendChild(tab);
  }
  const ui = getUiText(currentLang);
  accountLimitEl.textContent = ui.accountLimit(accounts.length, maxAccounts);
  btnAddAccount.disabled = accounts.length >= maxAccounts;
  btnAddAccount.title = accounts.length >= maxAccounts ? ui.limitReached(maxAccounts) : '';
}

function updateImageLabel() {
  const ui = getUiText(currentLang);
  const account = activeAccount();
  const imagePath = account?.imagePath ?? '';
  imagePathLabel.textContent = imagePath || ui.imageNotSelected;
  btnClearImage.hidden = !imagePath;
}

function updateProgressView() {
  const state = rt(activeId);
  if (activeAccount()?.mode === 'activity' || activeAccount()?.mode === 'warmup') {
    const c = state.counts;
    const doneActions = c ? c.likes + c.follows + c.comments : 0;
    const percent = c && c.planned > 0 ? Math.min(100, Math.round((doneActions / c.planned) * 100)) : 0;
    progressFillEl.style.width = `${percent}%`;
    progressLabelEl.textContent = getUiText(currentLang).activityCounter(c);
    return;
  }
  const percent = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
  progressFillEl.style.width = `${percent}%`;
  progressLabelEl.textContent = `${state.done} / ${state.total}`;
}

function updateControls() {
  const ui = getUiText(currentLang);
  const account = activeAccount();
  if (!account) return;
  const state = rt(account.id);
  const busy = isBusy(account.id);

  btnStart.disabled = busy;
  btnStop.disabled = !busy;
  btnPause.disabled = !(state.status === 'running' || state.status === 'paused');
  btnPause.textContent = state.status === 'paused' ? ui.btnResume : ui.btnPause;
  btnLogin.disabled = busy;
  btnConfirmLogin.hidden = !state.loginOpen;
  btnLogin.hidden = state.loginOpen;
  btnDeleteAccount.disabled = accounts.length <= 1;
  blockBoxEl.hidden = !account.blocked;
  if (account.blocked) {
    blockTextEl.textContent = ui.blockedStatus(ui.blockReasons[account.blocked.reason] ?? account.blocked.reason);
  }
  btnClearBlockEl.textContent = ui.btnClearBlock;

  const hasSession = Boolean(sessions[account.id]);
  sessionBadgeEl.textContent = hasSession ? ui.sessionSaved : ui.sessionMissing;
  sessionBadgeEl.className = `badge ${hasSession ? 'badge-ok' : 'badge-off'}`;

  const accountMode = account.mode ?? 'publish';
  const count =
    accountMode === 'activity' || accountMode === 'warmup'
      ? (stats.activityPerAccount?.[account.id] ?? 0)
      : (stats.perAccount[account.id] ?? 0);
  const todayText =
    accountMode === 'activity' || accountMode === 'warmup'
      ? ui.accountTodayActivity(count)
      : ui.accountToday(count);
  statusLineEl.textContent = accountMode === 'verify' || accountMode === 'join' ? statusText(account.id) : `${statusText(account.id)} · ${todayText}`;

  for (const [button, value] of [
    [modeJoinEl, 'join'],
    [modePublishEl, 'publish'],
    [modeFullEl, 'full'],
    [modeActivityEl, 'activity'],
  ]) {
    button.disabled = busy;
    button.classList.toggle('mode-btn-active', accountMode === value);
  }
  const publishLike = accountMode === 'publish' || accountMode === 'full';
  const verifyLike = accountMode === 'verify' || accountMode === 'join';
  publishOnlyEl.hidden = !publishLike;
  for (const node of resultsBlockEls) node.hidden = !publishLike;
  activityOnlyEl.hidden = accountMode !== 'activity';
  warmupOnlyEl.hidden = accountMode !== 'warmup';
  verifyOnlyEl.hidden = !(verifyLike || accountMode === 'full');
  el('verifyHint').textContent = accountMode === 'join' ? ui.joinHint : accountMode === 'full' ? ui.fullHint : ui.verifyHint;
  workRowEl.hidden = !publishLike;
  btnUseWorkEl.textContent = ui.btnUseWork(workItems.length);
  btnUseWorkEl.classList.toggle('mode-btn-active', Boolean(account.useWorklist));
  btnUseWorkEl.disabled = busy;
  el('workHint').textContent = account.useWorklist ? ui.workActive(effectiveGroups(account).length) : ui.workHint;
  groupsListEl.disabled = publishLike && Boolean(account.useWorklist);
  verifyResultsEl.hidden = !(verifyLike || accountMode === 'full');
  delayRowEl.hidden = accountMode === 'activity' || accountMode === 'warmup' || verifyLike;
  btnImportGroupsEl.disabled = busy;
  btnDropBlackEl.disabled = busy;

  const anyIdle = accounts.some((a) => !isBusy(a.id));
  const anyBusy = accounts.some((a) => isBusy(a.id));
  btnStartAll.disabled = !anyIdle;
  btnStopAll.disabled = !anyBusy;

  dailyCounterEl.textContent = `${ui.dailyCounter(stats.total)} · ${ui.dailyActivityCounter(stats.activityTotal ?? 0)}`;
}

function loadFormFromAccount() {
  const account = activeAccount();
  if (!account) return;
  accountNameEl.value = account.name;
  groupsListEl.value = (account.groups ?? []).join('\n');
  postTextEl.value = account.text ?? '';
  startTimeEl.value = account.startTime ?? '';
  if (account.mode === 'activity') {
    // поля затримки приховані
  } else {
    delayMinEl.value = account.delayMinSec ?? 3;
    delayMaxEl.value = account.delayMaxSec ?? 5;
  }
  dailyJoinLimitEl.value = account.dailyJoinLimit ?? 20;
  autoJoinEl.checked = account.autoJoin ?? true;
  autoFormEl.checked = account.autoForm ?? true;
  formAnswerEl.value = account.formAnswer ?? '';
  formAnswerEl.disabled = !autoFormEl.checked;
  warmCommentTextsEl.value = account.warmup?.commentTexts ?? '';
  refreshWarmupInfo();
  refreshTextPreview();
  renderResults();
  renderVerify();
  const activity = { ...DEFAULT_ACTIVITY, ...(account.activity ?? {}) };
  act.followsMin.value = activity.followsMin;
  act.followsMax.value = activity.followsMax;
  act.commentsMin.value = activity.commentsMin;
  act.commentsMax.value = activity.commentsMax;
  act.commentTexts.value = activity.commentTexts;
  act.dailyLimit.value = activity.dailyLimit;
  act.durMin.value = activity.durMin;
  act.durMax.value = activity.durMax;
  act.pauseMin.value = activity.pauseMin;
  act.pauseMax.value = activity.pauseMax;
  act.likesMin.value = activity.likesMin;
  act.likesMax.value = activity.likesMax;
  act.visitGroups.checked = activity.visitGroups;
  act.openPosts.checked = activity.openPosts;
  updateImageLabel();
}

function renderAll() {
  renderTabs();
  updateControls();
  updateProgressView();
  renderLog();
}

function selectAccount(id) {
  if (id === activeId) return;
  readFormIntoAccount();
  activeId = id;
  loadFormFromAccount();
  applyTranslations();
  scheduleSave();
  refreshBlacklist();
}

// --- Журнал ---

function formatLogLine(entry, withName) {
  const time = entry.time.toLocaleTimeString(currentLang === 'en' ? 'en-US' : 'uk-UA');
  return withName ? `[${time}] [${accountName(entry.id)}] ${entry.msg}` : `[${time}] ${entry.msg}`;
}

function lineVisible(entry) {
  return logScopeEl.value === 'all' || entry.id === activeId;
}

function appendLogDom(entry) {
  const line = document.createElement('div');
  line.className = entry.error ? 'log-line log-error' : 'log-line';
  line.textContent = formatLogLine(entry, logScopeEl.value === 'all');
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function renderLog() {
  logEl.textContent = '';
  for (const entry of logLines) {
    if (lineVisible(entry)) appendLogDom(entry);
  }
}

function appendLog(id, msg, isError = false) {
  const entry = { id, time: new Date(), msg, error: isError };
  logLines.push(entry);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (lineVisible(entry)) appendLogDom(entry);
}

logScopeEl.addEventListener('change', renderLog);

// --- Редагування полів ---

for (const input of [accountNameEl, groupsListEl, postTextEl, startTimeEl, delayMinEl, delayMaxEl, dailyJoinLimitEl, formAnswerEl, ...Object.values(act)]) {
  input.addEventListener('input', () => {
    readFormIntoAccount();
    if (input === accountNameEl) renderTabs();
    if (input === groupsListEl) { renderResults(); renderVerify(); }
    scheduleSave();
  });
}

btnRevealShotsEl.addEventListener('click', () => window.api.revealShots(activeAccount?.()?.id ?? ''));
btnClearResultsEl.addEventListener('click', async () => {
  const account = activeAccount();
  if (!account) return;
  await window.api.clearResults(account.id);
  results[account.id] = {};
  renderResults();
});

warmCommentTextsEl.addEventListener('input', () => {
  readFormIntoAccount();
  scheduleSave();
});

btnResetWarmupEl.addEventListener('click', async () => {
  const account = activeAccount();
  if (!account || isBusy(account.id)) return;
  account.warmup = { ...account.warmup, startDate: await window.api.getTodayKey() };
  refreshWarmupInfo();
  scheduleSave();
});

postTextEl.addEventListener('input', refreshTextPreview);

btnClearBlockEl.addEventListener('click', () => {
  const account = activeAccount();
  if (!account) return;
  account.blocked = null;
  renderTabs();
  updateControls();
  scheduleSave();
});

btnClearTime.addEventListener('click', () => {
  startTimeEl.value = '';
  readFormIntoAccount();
  scheduleSave();
});

btnSelectImage.addEventListener('click', async () => {
  const { path } = await window.api.selectImage();
  const account = activeAccount();
  if (path && account) {
    account.imagePath = path;
    updateImageLabel();
    scheduleSave();
  }
});

btnClearImage.addEventListener('click', () => {
  const account = activeAccount();
  if (!account) return;
  account.imagePath = '';
  updateImageLabel();
  scheduleSave();
});

autoJoinEl.addEventListener('change', () => {
  readFormIntoAccount();
  scheduleSave();
});

autoFormEl.addEventListener('change', () => {
  formAnswerEl.disabled = !autoFormEl.checked;
  readFormIntoAccount();
  scheduleSave();
});

// --- Режим акаунта: публікація / підписка на групи ---

function setAccountMode(mode) {
  const account = activeAccount();
  if (!account || isBusy(account.id) || account.mode === mode) return;
  readFormIntoAccount(); // зберігаємо затримку поточного режиму
  account.mode = mode;
  loadFormFromAccount(); // показуємо затримку нового режиму
  applyTranslations();
  scheduleSave();
}

modePublishEl.addEventListener('click', () => setAccountMode('publish'));
modeActivityEl.addEventListener('click', () => setAccountMode('activity'));
modeJoinEl.addEventListener('click', () => setAccountMode('join'));
modeFullEl.addEventListener('click', () => setAccountMode('full'));

btnImportGroupsEl.addEventListener('click', async () => {
  const account = activeAccount();
  if (!account || isBusy(account.id)) return;
  const { groups } = await window.api.importGroups();
  if (!groups) return;
  const merged = [...new Set([...getGroupsArray(), ...groups])];
  groupsListEl.value = merged.join('\n');
  readFormIntoAccount();
  renderResults();
  renderVerify();
  scheduleSave();
  appendLog(account.id, getUiText(currentLang).importedGroups(groups.length));
});

// Прибирає чорні групи лише зі СПИСКУ акаунта; сам чорний список не змінюється.
btnDropBlackEl.addEventListener('click', () => {
  const account = activeAccount();
  if (!account || isBusy(account.id)) return;
  const before = getGroupsArray();
  const kept = before.filter((url) => !isBlacklistedUrl(url));
  groupsListEl.value = kept.join('\n');
  readFormIntoAccount();
  renderResults();
  renderVerify();
  scheduleSave();
  appendLog(account.id, getUiText(currentLang).droppedBlack(before.length - kept.length));
});

btnRevealBlackEl.addEventListener('click', () => window.api.revealBlacklist(activeId));

btnUseWorkEl.addEventListener('click', () => {
  const account = activeAccount();
  if (!account || isBusy(account.id)) return;
  readFormIntoAccount();
  account.useWorklist = !account.useWorklist;
  renderResults();
  updateControls();
  scheduleSave();
});

// --- Додавання / видалення акаунтів ---

btnAddAccount.addEventListener('click', () => {
  if (accounts.length >= maxAccounts) return;
  readFormIntoAccount();
  const account = newAccountObject();
  accounts.push(account);
  activeId = account.id;
  refreshBlacklist();
  loadFormFromAccount();
  applyTranslations();
  scheduleSave();
});

btnDeleteAccount.addEventListener('click', async () => {
  const ui = getUiText(currentLang);
  const account = activeAccount();
  if (!account || accounts.length <= 1) return;
  if (isBusy(account.id)) {
    appendLog(account.id, ui.cannotDeleteRunning, true);
    return;
  }
  if (!window.confirm(ui.confirmDeleteAccount(account.name))) return;

  const result = await window.api.deleteAccount(account.id);
  if (!result.ok) {
    appendLog(account.id, ui.cannotDeleteRunning, true);
    return;
  }
  const index = accounts.findIndex((a) => a.id === account.id);
  accounts.splice(index, 1);
  delete runtime[account.id];
  delete sessions[account.id];
  activeId = accounts[Math.min(index, accounts.length - 1)].id;
  refreshBlacklist();
  loadFormFromAccount();
  applyTranslations();
  scheduleSave();
});

// --- Логін (окремо для кожного акаунта) ---

btnLogin.addEventListener('click', async () => {
  const account = activeAccount();
  if (!account) return;
  const id = account.id;
  const state = rt(id);
  state.loginOpen = true;
  updateControls();
  appendLog(id, getUiText(currentLang).openingBrowserLog);
  try {
    await window.api.startLogin(id);
  } catch (err) {
    state.loginOpen = false;
    appendLog(id, err.message, true);
    updateControls();
  }
});

btnConfirmLogin.addEventListener('click', async () => {
  const account = activeAccount();
  if (!account) return;
  const id = account.id;
  btnConfirmLogin.disabled = true;
  try {
    await window.api.confirmLogin(id);
  } catch (err) {
    appendLog(id, err.message, true);
  }
  rt(id).loginOpen = false;
  btnConfirmLogin.disabled = false;
  sessions = await window.api.loadSessions();
  updateControls();
});

// --- Публікація ---

/**
 * Перевіряє налаштування акаунта й запускає публікацію.
 * @returns {Promise<boolean>} true, якщо запуск прийнято
 */
async function startAccount(id) {
  const ui = getUiText(currentLang);
  const account = accounts.find((a) => a.id === id);
  if (!account || isBusy(id)) return false;

  if (id === activeId) readFormIntoAccount();

  if (account.blocked) {
    appendLog(id, ui.errBlocked, true);
    return false;
  }
  const accountMode = account.mode ?? 'publish';
  const activityMode = accountMode === 'activity';
  const warmupMode = accountMode === 'warmup';
  const verifyMode = accountMode === 'verify' || accountMode === 'join';
  const text = (account.text ?? '').trim();
  const groups = effectiveGroups(account);
  const useWorklist = Boolean(account.useWorklist) && (accountMode === 'publish' || accountMode === 'full');
  const imagePath = account.imagePath || null;
  const delayMinSec = Number(account.delayMinSec);
  const delayMaxSec = Number(account.delayMaxSec);

  if (!sessions[id]) {
    appendLog(id, ui.errNoSession, true);
    return false;
  }
  if (verifyMode) {
    if (groups.filter((g) => groupKeyOf(g)).length === 0) {
      appendLog(id, ui.errVerifyNoGroups, true);
      return false;
    }
    const black = groups.filter(isBlacklistedUrl).length;
    if (!window.confirm(ui.confirmVerify(groups.length, black))) return false;
  }
  if ((accountMode === 'publish' || accountMode === 'full') && !text && !imagePath) {
    appendLog(id, ui.errNoContent, true);
    return false;
  }
  if (!activityMode && !warmupMode && !verifyMode && groups.length === 0) {
    appendLog(id, useWorklist ? ui.errWorkEmpty : ui.errNoGroups, true);
    return false;
  }
  if (activityMode) {
    const a = account.activity;
    if (a.durMax < a.durMin || a.pauseMax < a.pauseMin || a.likesMax < a.likesMin || a.followsMax < a.followsMin || a.commentsMax < a.commentsMin || a.durMin < 1) {
      appendLog(id, ui.errBadActivity, true);
      return false;
    }
  }
  if (!activityMode && !warmupMode && !verifyMode && (!Number.isFinite(delayMinSec) || !Number.isFinite(delayMaxSec) || delayMinSec < 0 || delayMaxSec < delayMinSec)) {
    appendLog(id, ui.errBadDelay, true);
    return false;
  }
  if (account.startTime && !/^\d{1,2}:\d{2}$/.test(account.startTime)) {
    appendLog(id, ui.errBadTime, true);
    return false;
  }

  if (warmupMode && !account.warmup.startDate) {
    account.warmup.startDate = await window.api.getTodayKey();
    refreshWarmupInfo();
    scheduleSave();
  }

  const state = rt(id);
  state.done = 0;
  state.total = activityMode || warmupMode ? 0 : groups.length;
  state.counts = null;
  state.status = account.startTime ? 'waiting' : 'running';
  if (id === activeId) updateProgressView();
  renderTabs();
  updateControls();

  if (activityMode || warmupMode) {
    appendLog(id, account.startTime ? ui.scheduledActivityLog(account.startTime) : ui.startingActivityLog());
  } else {
    appendLog(id, account.startTime ? ui.scheduledLog(account.startTime, groups.length) : ui.startingLog(groups.length));
  }

  const result = await window.api.startPublish({
    id,
    mode: accountMode,
    activity: account.activity,
    warmup: account.warmup,
    dailyJoinLimit: account.dailyJoinLimit ?? 20,
    autoJoin: account.autoJoin !== false,
    autoForm: account.autoForm !== false,
    formAnswer: account.formAnswer ?? '',
    text,
    groups,
    useWorklist,
    imagePath,
    startTime: account.startTime || '',
    delayMinSec,
    delayMaxSec,
  });
  if (!result.ok) {
    state.status = 'idle';
    renderTabs();
    updateControls();
    return false;
  }
  return true;
}

btnStart.addEventListener('click', () => {
  if (activeId) startAccount(activeId);
});

btnPause.addEventListener('click', async () => {
  const id = activeId;
  if (!id) return;
  if (rt(id).status === 'paused') {
    await window.api.resumePublish(id);
  } else {
    await window.api.pausePublish(id);
  }
});

btnStop.addEventListener('click', async () => {
  if (!activeId) return;
  btnStop.disabled = true;
  await window.api.stopPublish(activeId);
});

btnStartAll.addEventListener('click', async () => {
  const ui = getUiText(currentLang);
  let started = 0;
  for (const account of [...accounts]) {
    if (isBusy(account.id)) continue;
    if (await startAccount(account.id)) started++;
  }
  if (started === 0) appendLog(activeId, ui.noAccountsToStart, true);
});

btnStopAll.addEventListener('click', async () => {
  for (const account of accounts) {
    if (isBusy(account.id)) await window.api.stopPublish(account.id);
  }
});

// --- Події з main process ---

window.api.onLog((id, msg) => appendLog(id, msg));

window.api.onProgress((id, done, total) => {
  const state = rt(id);
  state.done = done;
  state.total = total;
  if (id === activeId) updateProgressView();
});

window.api.onResultUpdate((id, url, entry) => {
  (results[id] ??= {})[url] = entry;
  if (id === activeId) renderResults();
});

window.api.onVerifyUpdate((id, url, entry) => {
  const key = groupKeyOf(url);
  if (!key) return;
  (verifyData[id] ??= {})[key] = entry;
  if (id !== activeId) return;
  if (entry.status === 'blacklisted' || entry.status === 'good') refreshBlacklist();
  else renderVerify();
});

window.api.onAccountBlocked((id, reason) => {
  const account = accounts.find((a) => a.id === id);
  if (!account) return;
  account.blocked = { reason, at: Date.now() };
  appendLog(id, getUiText(currentLang).blockedLog(getUiText(currentLang).blockReasons[reason] ?? reason), true);
  renderTabs();
  updateControls();
  scheduleSave();
});

window.api.onActivityCounts((id, counts) => {
  rt(id).counts = counts;
  if (id === activeId) updateProgressView();
});

window.api.onStatus((id, status, extra) => {
  const state = rt(id);
  state.status = status;
  state.startAt = extra?.startAt ?? state.startAt;
  renderTabs();
  updateControls();
});

window.api.onPublishFinished((id) => {
  refreshBlacklist();
  const state = rt(id);
  state.status = 'idle';
  state.startAt = null;
  renderTabs();
  updateControls();
});

window.api.onStatsUpdate((next) => {
  stats = next;
  updateControls();
});

// --- Ініціалізація ---

async function init() {
  const [config, limits, loadedStats, loadedSessions, loadedResults] = await Promise.all([
    window.api.loadConfig(),
    window.api.getLimits(),
    window.api.loadStats(),
    window.api.loadSessions(),
    window.api.loadResults(),
  ]);
  results = loadedResults ?? {};
  verifyData = (await window.api.loadVerify()) ?? {};
  blacklistItems = (await window.api.loadBlacklist(activeId)) ?? [];
  workItems = (await window.api.loadWorklist(activeId)) ?? [];
  maxAccounts = limits.maxAccounts;
  stats = loadedStats;
  sessions = loadedSessions;
  currentLang = config.language ?? 'uk';
  langSelect.value = currentLang;

  accounts = (Array.isArray(config.accounts) ? config.accounts : []).map((account) => ({
    text: '',
    groups: [],
    imagePath: '',
    startTime: '',
    delayMinSec: 3,
    delayMaxSec: 5,
    mode: 'publish',
    dailyJoinLimit: 20,
    autoJoin: true,
    autoForm: true,
    formAnswer: '',
    ...account,
  })).map((account) => ({ ...account, mode: ['subscribe', 'verify', 'warmup'].includes(account.mode) ? 'publish' : account.mode, activity: { ...DEFAULT_ACTIVITY, ...(account.activity ?? {}) }, warmup: { startDate: '', commentTexts: '', ...(account.warmup ?? {}) }, blocked: account.blocked ?? null }));
  if (accounts.length === 0) accounts.push(newAccountObject());
  activeId = accounts.some((a) => a.id === config.activeAccountId) ? config.activeAccountId : accounts[0].id;

  loadFormFromAccount();
  applyTranslations();
  refreshBlacklist();
}

init();
