/**
 * main.js — головний процес Electron.
 * Відкриває вікно застосунку та з'єднує GUI (renderer) з логікою
 * Playwright (src/login.js, src/publisher.js) через IPC-обробники.
 * Renderer не має прямого доступу до Node.js/Playwright — лише через
 * канали, описані в electron/preload.cjs.
 *
 * Підтримує до MAX_ACCOUNTS акаунтів Facebook. Кожен акаунт має власну
 * збережену сесію, власний браузер і власний стан (старт/пауза/зупинка),
 * тому всі акаунти можуть публікувати одночасно.
 */
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, copyFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { startLogin } from '../src/login.js';
import { publishToGroups } from '../src/publisher.js';
import { runActivity, runWarmup } from '../src/activity.js';
import { getWarmup, WARMUP_DAYS, todayKey } from '../src/warmup.js';
import { previewText } from '../src/textVariants.js';
import { loadConfig, saveConfig, createAccount, MAX_ACCOUNTS } from '../src/storage.js';
import { createFileLogger } from '../src/logger.js';
import { isChromeInstalled, CHROME_DOWNLOAD_URL } from '../src/chromeCheck.js';
import { loadDailyCount, incrementDailyCount } from '../src/stats.js';
import { t } from '../src/i18n.js';
import { createTracer } from '../src/trace.js';
import { createBlacklist, createWorklist, groupKey } from '../src/blacklist.js';
import { verifyGroups } from '../src/verifier.js';
import { waitUntilStart } from '../src/timing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// У встановленій програмі Program Files зазвичай доступний лише для читання,
// тому налаштування/cookies/логи зберігаємо в userData (записувана папка
// Windows: %APPDATA%\FB Group Publisher). У режимі розробки — просто ../data.
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const LEGACY_COOKIES_PATH = path.join(DATA_DIR, 'cookies.json');
const LEGACY_STATS_PATH = path.join(DATA_DIR, 'stats.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const logToFile = createFileLogger(LOGS_DIR);

// Постійний чорний список груп: основний файл + дві резервні копії
// (одна — поза папкою data). Видалення записів не передбачено.
const blacklist = createBlacklist([
  path.join(DATA_DIR, 'blacklist', 'blacklist.json'),
  path.join(DATA_DIR, 'blacklist', 'blacklist.backup.json'),
  path.join(app.getPath('userData'), 'blacklist.mirror.json'),
]);

// «Групи в роботу»: групи, де пости проходять (потрапляють сюди після верифікації).
const worklist = createWorklist([
  path.join(DATA_DIR, 'blacklist', 'worklist.json'),
  path.join(DATA_DIR, 'blacklist', 'worklist.backup.json'),
  path.join(app.getPath('userData'), 'worklist.mirror.json'),
]);

/** Групи в роботі = хороші групи, яких немає в чорному списку. */
function workGroups() {
  return worklist.list().filter((g) => !blacklist.has(g.url));
}

/** Початкові дані (результати верифікації, виконаної раніше): лише додаються, нічого не перезаписують. */
async function importSeed() {
  try {
    const seed = JSON.parse(await readFile(path.join(__dirname, '..', 'src', 'seed', 'groups-seed.json'), 'utf-8'));
    const black = await blacklist.addMany((seed.blacklist ?? []).map((x) => ({ ...x, account: x.account ?? 'seed' })));
    const work = await worklist.addMany((seed.work ?? []).map((x) => ({ ...x, account: x.account ?? 'seed' })));
    logToFile(`Seed imported: blacklist +${black}, work +${work}`);
  } catch (err) {
    if (err?.code !== 'ENOENT') logToFile(`Seed import failed: ${err.message}`);
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** Стан виконання кожного акаунта (в межах одного запуску застосунку). */
const runtimes = new Map(); // id -> { running, stop, pause, loginSession }
let mainWindow = null;

function getRuntime(id) {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = { running: false, stop: false, pause: false, loginSession: null, mode: 'publish' };
    runtimes.set(id, rt);
  }
  return rt;
}

function assertValidId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('Invalid account id');
  }
  return id;
}

function cookiesPathFor(id) {
  return path.join(ACCOUNTS_DIR, id, 'cookies.json');
}

function statsPathFor(id) {
  return path.join(ACCOUNTS_DIR, id, 'stats.json');
}

function joinStatsPathFor(id) {
  return path.join(ACCOUNTS_DIR, id, 'join-stats.json');
}

function pendingSincePathFor(id) {
  return path.join(ACCOUNTS_DIR, id, 'pending-since.json');
}

async function readPendingSince(id) {
  try { return JSON.parse(await readFile(pendingSincePathFor(id), 'utf8')) ?? {}; } catch { return {}; }
}

function verifyPathFor(id) {
  return path.join(ACCOUNTS_DIR, id, 'verification.json');
}

const verifyCache = new Map(); // id -> { [groupKey]: entry }

async function loadVerify(id) {
  if (verifyCache.has(id)) return verifyCache.get(id);
  let data = {};
  try {
    data = JSON.parse(await readFile(verifyPathFor(id), 'utf-8')).groups ?? {};
  } catch {
    // файлу ще немає
  }
  verifyCache.set(id, data);
  return data;
}

async function saveVerify(id, url, entry) {
  const key = groupKey(url);
  if (!key) return;
  const data = await loadVerify(id);
  data[key] = { ...entry, url };
  if (entry.status !== 'working') {
    await mkdir(path.dirname(verifyPathFor(id)), { recursive: true });
    const persistent = Object.fromEntries(Object.entries(data).filter(([, v]) => v.status !== 'working'));
    await writeFile(verifyPathFor(id), JSON.stringify({ groups: persistent }, null, 2), 'utf-8');
  }
  broadcast('verify:update', id, url, data[key]);
}

function resultsPathFor(id) {
  return path.join(ACCOUNTS_DIR, id, 'results.json');
}

function activityStatsPathFor(id) {
  return path.join(ACCOUNTS_DIR, id, 'activity-stats.json');
}

/** Результати публікації по групах (остання відома дія для кожного посилання). */
const resultsCache = new Map(); // id -> { [url]: { status, reason, at } }

async function loadResults(id) {
  if (resultsCache.has(id)) return resultsCache.get(id);
  let groups = {};
  try {
    groups = JSON.parse(await readFile(resultsPathFor(id), 'utf-8')).groups ?? {};
  } catch {
    // файлу ще немає
  }
  resultsCache.set(id, groups);
  return groups;
}

async function saveResult(id, url, outcome) {
  const groups = await loadResults(id);
  const entry = { status: outcome.status, reason: outcome.reason ?? '', at: Date.now() };
  groups[url] = entry;
  if (outcome.status !== 'working') {
    await mkdir(path.dirname(resultsPathFor(id)), { recursive: true });
    const persistent = Object.fromEntries(Object.entries(groups).filter(([, v]) => v.status !== 'working'));
    await writeFile(resultsPathFor(id), JSON.stringify({ groups: persistent }, null, 2), 'utf-8');
  }
  broadcast('results:update', id, url, entry);
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Читає поточну мову інтерфейсу з налаштувань (за замовчуванням 'uk').
 * Читається заново перед кожною дією, щоб перемикання мови в GUI
 * одразу відображалось у нових повідомленнях журналу.
 */
async function getCurrentLang() {
  const config = await loadConfig(CONFIG_PATH);
  return config.language ?? 'uk';
}

/**
 * Міграція зі старих версій (1.0.x), де був один акаунт: переносить текст,
 * групи, зображення, збережену сесію та лічильник у «Акаунт 1».
 */
async function migrateLegacyData() {
  const config = await loadConfig(CONFIG_PATH);
  if (Array.isArray(config.accounts) && config.accounts.length > 0) return;

  const account = createAccount('main', config.language === 'en' ? 'Account 1' : 'Акаунт 1');
  account.text = config.text ?? '';
  account.groups = Array.isArray(config.groups) ? config.groups : [];
  account.imagePath = config.imagePath ?? '';

  if (await fileExists(LEGACY_COOKIES_PATH)) {
    await mkdir(path.dirname(cookiesPathFor(account.id)), { recursive: true });
    await copyFile(LEGACY_COOKIES_PATH, cookiesPathFor(account.id));
  }
  if (await fileExists(LEGACY_STATS_PATH)) {
    await mkdir(path.dirname(statsPathFor(account.id)), { recursive: true });
    await copyFile(LEGACY_STATS_PATH, statsPathFor(account.id));
  }

  await saveConfig(CONFIG_PATH, { accounts: [account], activeAccountId: account.id });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.setTitle('FB Group Publisher');
  return win;
}

app.whenReady().then(async () => {
  await migrateLegacyData().catch((err) => logToFile(`Migration failed: ${err.message}`));
  await blacklist.load().catch((err) => logToFile(`Blacklist load failed: ${err.message}`));
  await worklist.load().catch((err) => logToFile(`Worklist load failed: ${err.message}`));
  await importSeed();
  mainWindow = createWindow();

  const chromeFound = await isChromeInstalled();
  if (!chromeFound) {
    const lang = await getCurrentLang();
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: t(lang, 'chrome.title'),
      message: t(lang, 'chrome.message'),
      detail: t(lang, 'chrome.detail'),
      buttons: [t(lang, 'chrome.btnDownload'), t(lang, 'chrome.btnClose')],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) {
      shell.openExternal(CHROME_DOWNLOAD_URL);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function broadcast(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...args);
}

function sendLog(id, msg) {
  broadcast('log', id, msg);
  logToFile(`[${id}] ${msg}`);
}

/** Лічильники за поточну добу: по кожному акаунту та загальний. */
async function collectStats() {
  const config = await loadConfig(CONFIG_PATH);
  const perAccount = {};
  const joinPerAccount = {};
  const activityPerAccount = {};
  let total = 0;
  let joinTotal = 0;
  let activityTotal = 0;
  for (const account of config.accounts ?? []) {
    if (!ID_PATTERN.test(account.id)) continue;
    const count = await loadDailyCount(statsPathFor(account.id));
    perAccount[account.id] = count;
    total += count;
    const joinCount = await loadDailyCount(joinStatsPathFor(account.id));
    joinPerAccount[account.id] = joinCount;
    joinTotal += joinCount;
    const activityCount = await loadDailyCount(activityStatsPathFor(account.id));
    activityPerAccount[account.id] = activityCount;
    activityTotal += activityCount;
  }
  return { total, perAccount, joinTotal, joinPerAccount, activityTotal, activityPerAccount };
}

async function sendStats() {
  broadcast('stats:update', await collectStats());
}

// Раз на хвилину перевіряємо, чи не настала нова доба (00:00) — якщо так,
// loadDailyCount поверне 0, і лічильник у GUI сам скинеться навіть якщо
// користувач нічого не публікував рівно опівночі.
setInterval(() => {
  sendStats().catch(() => {});
}, 60000);

async function prepareImageClipboard(imagePath) {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) {
    throw new Error(`Nie udało się odczytać obrazu: ${imagePath}`);
  }
  clipboard.writeImage(image);
}

// Системний буфер обміну один на всі акаунти — доступ до нього послідовний.
let clipboardChain = Promise.resolve();
function withClipboardLock(fn) {
  const run = clipboardChain.then(fn, fn);
  clipboardChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Перетворює "HH:MM" на timestamp сьогоднішнього дня.
 * @returns {{ startAt: number|null, passedTime: string|null }}
 *  startAt — момент старту в майбутньому; passedTime — "HH:MM", якщо
 *  заданий час уже минув (тоді стартуємо одразу).
 */
function resolveStartTime(startTime) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(startTime ?? '').trim());
  if (!match) return { startAt: null, passedTime: null };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { startAt: null, passedTime: null };

  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  const label = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  if (target.getTime() <= Date.now()) return { startAt: null, passedTime: label };
  return { startAt: target.getTime(), passedTime: null };
}

// --- Налаштування ---

ipcMain.handle('config:load', async () => {
  return loadConfig(CONFIG_PATH);
});

ipcMain.handle('config:save', async (_event, config) => {
  await saveConfig(CONFIG_PATH, config);
  return { ok: true };
});

ipcMain.handle('meta:limits', async () => ({ maxAccounts: MAX_ACCOUNTS }));

// --- Статистика ---

ipcMain.handle('results:load', async () => {
  const config = await loadConfig(CONFIG_PATH);
  const all = {};
  for (const account of config.accounts ?? []) {
    if (!ID_PATTERN.test(account.id)) continue;
    const groups = await loadResults(account.id);
    all[account.id] = Object.fromEntries(Object.entries(groups).filter(([, v]) => v.status !== 'working'));
  }
  return all;
});

ipcMain.handle('results:clear', async (_event, id) => {
  assertValidId(id);
  resultsCache.set(id, {});
  await rm(resultsPathFor(id), { force: true });
  return { ok: true };
});

ipcMain.handle('stats:load', async () => collectStats());

// --- Верифікація груп і чорний список (лише читання: видалення немає) ---

ipcMain.handle('blacklist:list', async () => blacklist.list());
ipcMain.handle('worklist:list', async () => workGroups());

ipcMain.handle('blacklist:reveal', async () => {
  shell.showItemInFolder(blacklist.files[0]);
  return { ok: true };
});

ipcMain.handle('trace:reveal', async (_e, accountId) => {
  const base = path.join(DATA_DIR, 'trace');
  const dir = ID_PATTERN.test(String(accountId ?? '')) ? path.join(base, String(accountId), 'shots') : base;
  await mkdir(dir, { recursive: true }).catch(() => {});
  await shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('verify:load', async () => {
  const config = await loadConfig(CONFIG_PATH);
  const all = {};
  for (const account of config.accounts ?? []) {
    if (!ID_PATTERN.test(account.id)) continue;
    all[account.id] = await loadVerify(account.id);
  }
  return all;
});

ipcMain.handle('groups:import', async (event) => {
  const callerWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(callerWindow, {
    title: 'Оберіть файл зі списком груп (одне посилання на рядок)',
    properties: ['openFile'],
    filters: [{ name: 'Text', extensions: ['txt', 'csv', 'list'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { groups: null };
  const raw = await readFile(result.filePaths[0], 'utf-8');
  const groups = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => groupKey(line));
  return { groups };
});

// --- Сесії акаунтів ---

ipcMain.handle('accounts:sessions', async () => {
  const config = await loadConfig(CONFIG_PATH);
  const sessions = {};
  for (const account of config.accounts ?? []) {
    if (!ID_PATTERN.test(account.id)) continue;
    sessions[account.id] = await fileExists(cookiesPathFor(account.id));
  }
  return sessions;
});

ipcMain.handle('account:delete', async (_event, id) => {
  assertValidId(id);
  const rt = getRuntime(id);
  if (rt.running) return { ok: false, error: 'running' };
  if (rt.loginSession) {
    await rt.loginSession.cancel().catch(() => {});
    rt.loginSession = null;
  }
  await rm(path.join(ACCOUNTS_DIR, id), { recursive: true, force: true });
  runtimes.delete(id);
  resultsCache.delete(id);
  verifyCache.delete(id);
  await sendStats();
  return { ok: true };
});

// --- Вибір зображення ---

ipcMain.handle('image:select', async (event) => {
  const callerWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(callerWindow, {
    title: 'Оберіть зображення для публікації',
    properties: ['openFile'],
    filters: [{ name: 'Зображення', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { path: null };
  return { path: result.filePaths[0] };
});

// --- Логін ---

ipcMain.handle('login:start', async (_event, id) => {
  assertValidId(id);
  const rt = getRuntime(id);
  if (rt.loginSession) {
    await rt.loginSession.cancel().catch(() => {});
    rt.loginSession = null;
  }
  const lang = await getCurrentLang();
  rt.loginSession = await startLogin(cookiesPathFor(id), (msg) => sendLog(id, msg), lang);
  return { ok: true };
});

ipcMain.handle('login:confirm', async (_event, id) => {
  assertValidId(id);
  const rt = getRuntime(id);
  if (!rt.loginSession) return { ok: false, error: 'Немає активної сесії логіну.' };
  await rt.loginSession.confirmLogin();
  rt.loginSession = null;
  return { ok: true };
});

ipcMain.handle('login:cancel', async (_event, id) => {
  assertValidId(id);
  const rt = getRuntime(id);
  if (!rt.loginSession) return { ok: false };
  await rt.loginSession.cancel();
  rt.loginSession = null;
  return { ok: true };
});

/** Приводить налаштування активності до безпечних меж. */
function sanitizeActivity(raw = {}) {
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
  };
  const durMin = num(raw.durMin, 10, 1, 240);
  const durMax = Math.max(durMin, num(raw.durMax, 20, 1, 240));
  const pauseMin = num(raw.pauseMin, 30, 0, 1440);
  const pauseMax = Math.max(pauseMin, num(raw.pauseMax, 90, 0, 1440));
  const likesMin = Math.floor(num(raw.likesMin, 2, 0, 100));
  const likesMax = Math.max(likesMin, Math.floor(num(raw.likesMax, 6, 0, 100)));
  const followsMin = Math.floor(num(raw.followsMin, 1, 0, 50));
  const followsMax = Math.max(followsMin, Math.floor(num(raw.followsMax, 3, 0, 50)));
  const commentsMin = Math.floor(num(raw.commentsMin, 0, 0, 20));
  const commentsMax = Math.max(commentsMin, Math.floor(num(raw.commentsMax, 1, 0, 20)));
  const commentTexts = (Array.isArray(raw.commentTexts) ? raw.commentTexts : String(raw.commentTexts ?? '').split('\n'))
    .map((x) => String(x).trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 100);
  return {
    durMin,
    durMax,
    pauseMin,
    pauseMax,
    likesMin,
    likesMax,
    followsMin,
    followsMax,
    commentsMin,
    commentsMax,
    commentTexts,
    dailyLimit: Math.floor(num(raw.dailyLimit, 0, 0, 2000)),
    visitGroups: raw.visitGroups !== false,
    openPosts: raw.openPosts !== false,
  };
}

function warmupFor(payload) {
  return getWarmup(payload?.warmup?.startDate);
}

ipcMain.handle('warmup:info', (_event, payload) => {
  const w = warmupFor(payload);
  if (!w) return null;
  return { ...w, total: WARMUP_DAYS };
});

ipcMain.handle('warmup:today', () => todayKey());
ipcMain.handle('text:preview', (_event, text) => previewText(String(text ?? '').slice(0, 20000)));

// --- Публікація / підписка / активність (кожен акаунт — незалежно й одночасно) ---

ipcMain.handle('publish:start', async (_event, payload) => {
  const { id, text, imagePath, startTime, delayMinSec, delayMaxSec } = payload;
  // «Групи в роботу»: список береться з бази програми, вставляти нічого не треба.
  const useWork = payload.useWorklist === true && (payload.mode ?? 'publish') === 'publish';
  const groups = useWork ? workGroups().map((g) => g.url) : payload.groups;
  const mode = ['activity', 'warmup', 'verify'].includes(payload.mode) ? payload.mode : 'publish';
  assertValidId(id);
  if (mode === 'verify') await loadVerify(id);
  const lang = await getCurrentLang();
  const rt = getRuntime(id);

  if (rt.running) {
    sendLog(id, t(lang, 'publish.alreadyRunning'));
    return { ok: false, error: 'running' };
  }

  const minSec = Number(delayMinSec);
  const maxSec = Number(delayMaxSec);
  if (!['activity', 'warmup', 'verify'].includes(mode) && (!Number.isFinite(minSec) || !Number.isFinite(maxSec) || minSec < 0 || maxSec < minSec)) {
    sendLog(id, t(lang, 'publish.badDelay'));
    return { ok: false, error: 'delay' };
  }

  const warm = warmupFor(payload);
  if (mode === 'warmup' && !warm) {
    sendLog(id, t(lang, 'publish.criticalError', { message: 'warm-up start date missing' }));
    return { ok: false, error: 'warmup' };
  }

  const { startAt, passedTime } = resolveStartTime(startTime);
  if (passedTime) sendLog(id, t(lang, 'publish.startTimePassed', { time: passedTime }));

  rt.running = true;
  rt.stop = false;
  rt.pause = false;
  rt.mode = mode;
  rt.blocked = false;
  broadcast('account:status', id, startAt ? 'waiting' : 'running', { startAt });

  const tracer = createTracer({ dir: path.join(DATA_DIR, 'trace'), account: id, mode, version: app.getVersion() });
  tracer.event('run.start', {
    mode,
    groups: groups.length,
    delayMinSec: minSec,
    delayMaxSec: maxSec,
    lang,
    textChars: String(text ?? '').length,
    variants: String(text ?? '').split(/^\s*---\s*$/m).length,
    hasImage: Boolean(payload.imagePath),
    autoJoin: payload.autoJoin !== false,
    dailyJoinLimit: Number(payload.dailyJoinLimit) || 0,
    startAt: startAt ?? null,
  });

  const common = {
    trace: tracer,
    groups,
    lang,
    cookiesPath: cookiesPathFor(id),
    startAt,
    delayMinSec: minSec,
    delayMaxSec: maxSec,
    onLog: (msg) => {
      tracer.event('log', { msg });
      sendLog(id, msg);
    },
    onProgress: (done, total) => broadcast('progress', id, done, total),
    onStatus: (state, extra) => broadcast('account:status', id, state, extra ?? {}),
    shouldStop: () => rt.stop || rt.blocked,
    shouldPause: () => rt.pause,
    onBlocked: (reason) => {
      if (rt.blocked) return;
      rt.blocked = true;
      tracer.event('blocked', { reason });
      sendLog(id, t(lang, 'block.detected', { reason: t(lang, `block.reason.${reason}`) }));
      broadcast('account:blocked', id, reason);
    },
  };

  // Запускаємо у фоні, щоб не блокувати IPC-відповідь
  const task =
    mode === 'verify'
      ? verifyGroups({
          groups,
          lang,
          cookiesPath: cookiesPathFor(id),
          accountId: id,
          blacklist,
          worklist,
          startAt,
          waitUntilStart,
          trace: tracer,
          getKnown: (url) => {
            const key = groupKey(url);
            return key ? (verifyCache.get(id) ?? {})[key] ?? null : null;
          },
          onLog: common.onLog,
          onProgress: common.onProgress,
          onStatus: common.onStatus,
          onBlocked: common.onBlocked,
          shouldStop: common.shouldStop,
          shouldPause: common.shouldPause,
          onResult: (url, entry) => saveVerify(id, url, entry),
        })
      : mode === 'warmup'
      ? runWarmup({
          groups,
          lang,
          cookiesPath: cookiesPathFor(id),
          startAt,
          startDate: payload.warmup.startDate,
          commentTexts: sanitizeActivity({ commentTexts: payload.warmup.commentTexts }).commentTexts,
          onLog: common.onLog,
          onStatus: common.onStatus,
          onBlocked: common.onBlocked,
          shouldStop: common.shouldStop,
          shouldPause: common.shouldPause,
          getTodayCount: () => loadDailyCount(activityStatsPathFor(id)),
          onCounts: (counts) => broadcast('activity:counts', id, counts),
          onAction: async () => {
            await incrementDailyCount(activityStatsPathFor(id));
            await sendStats();
          },
        })
      : mode === 'activity'
      ? runActivity({
          groups,
          lang,
          cookiesPath: cookiesPathFor(id),
          startAt,
          activity: sanitizeActivity(payload.activity),
          onBlocked: common.onBlocked,
          onLog: common.onLog,
          onStatus: common.onStatus,
          shouldStop: common.shouldStop,
          shouldPause: common.shouldPause,
          getTodayCount: () => loadDailyCount(activityStatsPathFor(id)),
          onCounts: (counts) => broadcast('activity:counts', id, counts),
          onAction: async () => {
            await incrementDailyCount(activityStatsPathFor(id));
            await sendStats();
          },
        })
      : publishToGroups({
          ...common,
          isBlacklisted: (url) => blacklist.has(url),
          onBlacklist: (url, info) => blacklist.add(url, { reason: info.reason, account: id, counts: null }),
          autoJoin: payload.autoJoin !== false,
          autoForm: payload.autoForm !== false,
          formAnswer: String(payload.formAnswer ?? '').slice(0, 300),
          dailyJoinLimit: Math.max(0, Math.floor(Number(payload.dailyJoinLimit) || 0)),
          getPendingSince: async (key) => (await readPendingSince(id))[key] ?? null,
          setPendingSince: async (key, date) => {
            const map = await readPendingSince(id);
            map[key] = date;
            await mkdir(path.dirname(pendingSincePathFor(id)), { recursive: true });
            await writeFile(pendingSincePathFor(id), JSON.stringify(map));
          },
          getJoinCount: () => loadDailyCount(joinStatsPathFor(id)),
          onJoin: async () => {
            await incrementDailyCount(joinStatsPathFor(id));
            await sendStats();
          },
          onResult: (url, outcome) => saveResult(id, url, outcome),
          text,
          imagePath: imagePath || null,
          prepareImageClipboard,
          withClipboardLock,
          onSuccess: async () => {
            const count = await incrementDailyCount(statsPathFor(id));
            sendLog(id, `✔ +1 (${count})`);
            await sendStats();
          },
        });

  task
    .catch((err) => {
      tracer.event('run.crash', { message: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 8).join(' | ') });
      sendLog(id, t(lang, 'publish.criticalError', { message: err.message }));
    })
    .finally(() => {
      tracer.event('run.end', { stopped: rt.stop, blocked: rt.blocked });
      tracer.close();
      rt.running = false;
      rt.pause = false;
      rt.stop = false;
      rt.blocked = false;
      if (mode === 'activity' || mode === 'warmup') broadcast('activity:counts', id, null);
      broadcast('publish:finished', id);
      broadcast('account:status', id, 'idle', {});
    });

  return { ok: true };
});

ipcMain.handle('publish:stop', async (_event, id) => {
  assertValidId(id);
  const rt = getRuntime(id);
  rt.stop = true;
  const lang = await getCurrentLang();
  sendLog(id, t(lang, `${rt.mode === 'warmup' ? 'activity' : rt.mode}.stopRequested`));
  return { ok: true };
});

ipcMain.handle('publish:pause', async (_event, id) => {
  assertValidId(id);
  const rt = getRuntime(id);
  rt.pause = true;
  const lang = await getCurrentLang();
  sendLog(id, t(lang, `${rt.mode === 'warmup' ? 'activity' : rt.mode}.paused`));
  broadcast('account:status', id, 'paused', {});
  return { ok: true };
});

ipcMain.handle('publish:resume', async (_event, id) => {
  assertValidId(id);
  const rt = getRuntime(id);
  rt.pause = false;
  const lang = await getCurrentLang();
  sendLog(id, t(lang, `${rt.mode === 'warmup' ? 'activity' : rt.mode}.resumed`));
  broadcast('account:status', id, 'running', {});
  return { ok: true };
});
