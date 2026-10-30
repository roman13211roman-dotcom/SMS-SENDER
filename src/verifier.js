/**
 * verifier.js — модуль «Верифікація груп».
 *
 * Для кожної групи відкриває розділ «Twoje materiały» (Мої матеріали) і читає
 * чотири вкладки: Opublikowane / Odrzucone / Usunięte / Oczekujące.
 *
 *  - є хоч один опублікований пост            → група ХОРОША (пости проходять);
 *  - немає опублікованих, є видалені/відхилені → ЧОРНИЙ СПИСОК (назавжди);
 *  - немає опублікованих, є лише на розгляді   → чекаємо (рішення пізніше);
 *  - історія постів порожня (жоден не пройшов) → ЧОРНИЙ СПИСОК (назавжди);
 *  - немає доступу / група недоступна / не вдалося прочитати → нічого не
 *    вирішуємо (НЕ в чорний список), групу можна перевірити пізніше.
 *
 * У чорний список потрапляє лише тоді, коли ВСІ вкладки прочитано впевнено.
 */
import { t } from './i18n.js';
import { sleep, waitWithStop, waitWhilePaused } from './timing.js';
import { launchChrome } from './chromeLauncher.js';
import { assertNotBlocked, BlockedError, detectBlock } from './blockDetect.js';
import { looksLikeLoginPage, detectGroupState, isLoggedOutPage } from './groupJoin.js';
import { groupBaseUrl, groupKey } from './blacklist.js';
import { noopTracer } from './trace.js';
import { access } from 'node:fs/promises';

export const TABS = {
  posted: 'my_posted_content',
  removed: 'my_removed_content',
  declined: 'my_declined_content',
  pending: 'my_pending_content',
};

// Тексти Facebook (PL / EN / UK / RU).
const EMPTY_RE = /(brak post[óo]w do wy[śs]wietlenia|no posts to (show|display)|nothing to show|немає дописів для показу|нема дописів|дописів немає|нет публикаций для показа|нет публикаций)/i;
const ITEMS_RE = /(doda[łl](\(a\)|a)? post w:|posted in\b|додав(\(-ла\)|ла)? допис|добавил(\(а\)|а)? публикацию|опубликовал(\(а\)|а)? в\b)/i;
const TAB_PENDING_RE = /(oczekuj[ąa]ce|pending|очікують|в очікуванні|ожидают|в ожидании)/i;
const TAB_REMOVED_RE = /(usuni[ęe]te|removed|видалені|удалённые|удаленные)/i;
const UNAVAILABLE_RE = /(ta tre[śs][ćc] jest teraz niedost[ęe]pna|this content isn.t available|ця сторінка недоступна|цей вміст зараз недоступний|этот контент сейчас недоступен|ta strona jest niedost[ęe]pna)/i;
const JOIN_RE = /(do[łl][ąa]cz do grupy|join group|приєднатися до групи|вступить в группу)/i;

const clean = (s) => String(s ?? '').replace(/[͏​-‍⁠﻿]/g, '');

/**
 * Чиста функція (тестується без браузера): визначає, що показує сторінка вкладки.
 * 'itemsGuess' — вміст схожий на непорожній, але маркерів мови немає (лише евристика).
 * @returns {'items'|'itemsGuess'|'empty'|'noAccess'|'unavailable'|'loading'}
 */
export function analyzeTabPage({ url, text }) {
  const body = clean(text);
  if (UNAVAILABLE_RE.test(body) && body.length < 1500) return 'unavailable';
  if (!/\/my_(posted|pending|declined|removed)_content/i.test(String(url ?? ''))) return 'noAccess';
  const tabsPresent = TAB_PENDING_RE.test(body) && TAB_REMOVED_RE.test(body);
  if (ITEMS_RE.test(body)) return 'items';
  if (EMPTY_RE.test(body)) return 'empty';
  if (!tabsPresent) return JOIN_RE.test(body) && body.length < 2500 ? 'noAccess' : 'loading';
  // Вкладки є, але маркерів немає (інша мова інтерфейсу): порожня сторінка
  // коротка (≈400 символів), зі вмістом — помітно довша.
  if (body.length > 800) return 'itemsGuess';
  return 'loading';
}

/**
 * Рішення за лічильниками вкладок. counts[tab] ∈ {'items','empty'} або null (не читали/не вдалося).
 * @returns {{status:'good'|'blacklisted'|'pending'|'unknown', reason:string}}
 */
export function decide(counts) {
  if (counts.posted === 'items') return { status: 'good', reason: 'posted' };
  if (counts.removed === 'items') return { status: 'blacklisted', reason: 'removed' };
  if (counts.declined === 'items') return { status: 'blacklisted', reason: 'declined' };
  const all = ['posted', 'removed', 'declined', 'pending'].every((k) => counts[k] === 'empty' || counts[k] === 'items');
  if (!all) return { status: 'unknown', reason: 'unreadable' };
  if (counts.pending === 'items') return { status: 'pending', reason: 'pendingOnly' };
  return { status: 'blacklisted', reason: 'neverPosted' };
}

async function snapshot(page) {
  return page
    .evaluate(() => ({ url: location.href, text: document.body?.innerText ?? '', ready: document.readyState }))
    .catch(() => ({ url: page.url(), text: '', ready: 'loading' }));
}

/**
 * Відкриває одну вкладку «Twoje materiały» і чекає, поки стане ясно, що на ній.
 * @returns {Promise<'items'|'empty'|'noAccess'|'unavailable'|'unknown'>}
 */
export async function readTab(page, base, tab, { timeoutMs = 22000, trace = noopTracer } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = `${base}/${TABS[tab]}`;
    if (attempt === 0) {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
    const end = Date.now() + timeoutMs;
    let noAccessHits = 0;
    let last = 'loading';
    while (Date.now() < end) {
      const snap = await snapshot(page);
      const state = analyzeTabPage(snap);
      last = state;
      if (state === 'items' || state === 'empty') return state;
      if (state === 'itemsGuess') {
        // Евристика не годиться для рішення про чорний список: для вкладок
        // «видалені/відхилені» вважаємо результат нечитабельним.
        return tab === 'removed' || tab === 'declined' ? 'unknown' : 'items';
      }
      if (state === 'unavailable') return state;
      if (state === 'noAccess') {
        // Потрібне стабільне підтвердження (редірект може ще тривати).
        if (snap.ready === 'complete' && ++noAccessHits >= 3) return 'noAccess';
      } else {
        noAccessHits = 0;
      }
      await sleep(600);
    }
    trace.event('verify.tabTimeout', { tab, attempt, last, url: page.url() });
  }
  return 'unknown';
}

/**
 * Чи акаунт — учасник групи. Сторінка «Twoje materiały» для НЕучасників теж
 * показує «Brak postów», тому членство перевіряємо окремо — на головній
 * сторінці групи (кнопка «Dołączono» / «Dołącz do grupy» / «Anuluj prośbę»).
 * @returns {Promise<'member'|'pending'|'canJoin'|'unknown'>}
 */
export async function readMembership(page, base, { timeoutMs = 25000, trace = noopTracer } = {}) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const end = Date.now() + timeoutMs;
  let joinHits = 0;
  while (Date.now() < end) {
    const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (UNAVAILABLE_RE.test(clean(body)) && body.length < 1500) return 'unknown';
    const state = await detectGroupState(page).catch(() => 'unknown');
    if (state === 'member' || state === 'pending') return state;
    // «Dołącz do grupy» може бути й у картках сусідніх груп, поки шапка ще
    // вантажиться — тому потрібне кілька стабільних підтверджень.
    if (state === 'canJoin') {
      if (++joinHits >= 4) return 'canJoin';
    } else {
      joinHits = 0;
    }
    await sleep(700);
  }
  trace.event('verify.membershipTimeout', { url: page.url() });
  return 'unknown';
}

/**
 * Перевіряє одну групу. Повертає { status, reason, counts }.
 * Кидає BlockedError, якщо Facebook показав блокування.
 */
export async function verifyOneGroup(page, url, { trace = noopTracer, shouldStop = () => false, tabTimeoutMs = 22000 } = {}) {
  const base = groupBaseUrl(url);
  const counts = { posted: null, removed: null, declined: null, pending: null };
  if (!base) return { status: 'unknown', reason: 'badUrl', counts };

  // Спершу членство: не учасник → історії немає, у чорний список НЕ додаємо.
  const membership = await readMembership(page, base, { trace });
  await assertNotBlocked(page);
  if (looksLikeLoginPage(page.url()) || (await isLoggedOutPage(page))) return { status: 'unknown', reason: 'session', counts };
  if (membership === 'canJoin') return { status: 'noAccess', reason: 'notMember', counts };
  if (membership === 'pending') return { status: 'noAccess', reason: 'joinPending', counts };
  if (membership !== 'member') return { status: 'unknown', reason: 'membershipUnclear', counts };

  for (const tab of ['posted', 'removed', 'declined', 'pending']) {
    if (shouldStop()) return { status: 'unknown', reason: 'stopped', counts };
    const state = await readTab(page, base, tab, { trace, timeoutMs: tabTimeoutMs });
    await assertNotBlocked(page);
    if (looksLikeLoginPage(page.url())) return { status: 'unknown', reason: 'session', counts };
    if (state === 'noAccess' || state === 'unavailable') {
      return { status: state, reason: state, counts };
    }
    counts[tab] = state === 'items' || state === 'empty' ? state : null;
    // Рання зупинка: далі читати немає сенсу.
    if (tab === 'posted' && state === 'items') break;
    if ((tab === 'removed' || tab === 'declined') && state === 'items') break;
    if (state === 'unknown') break;
    await sleep(400 + Math.random() * 600);
  }
  const verdict = decide(counts);
  return { ...verdict, counts };
}

/**
 * Перевірка списку груп.
 */
export async function verifyGroups({
  groups,
  lang = 'uk',
  cookiesPath,
  accountId = '',
  blacklist,
  worklist = null,
  getKnown = () => null,
  trace = noopTracer,
  onLog = () => {},
  onProgress = () => {},
  onResult = () => {},
  onStatus = () => {},
  onBlocked = () => {},
  shouldStop = () => false,
  shouldPause = () => false,
  startAt = null,
  waitUntilStart = null,
  createBrowser = launchChrome,
  tabTimeoutMs = 22000,
  pauseScale = 1,
}) {
  try {
    await access(cookiesPath);
  } catch {
    onLog(t(lang, 'publish.needLogin'));
    return;
  }

  if (startAt && startAt > Date.now() && waitUntilStart) {
    onStatus('waiting', { startAt });
    const reached = await waitUntilStart(startAt, shouldStop);
    if (!reached) {
      onLog(t(lang, 'publish.stoppedByUser'));
      return;
    }
  }
  onStatus('running');

  // Унікальні групи з валідним посиланням.
  const seen = new Set();
  const list = [];
  for (const url of groups) {
    const key = groupKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(url);
  }
  const total = list.length;
  const counters = { good: 0, blacklisted: 0, pending: 0, other: 0, skipped: 0 };
  const blackAlready = list.filter((u) => blacklist.has(u)).length;
  onLog(t(lang, 'verify.start', { total, black: blackAlready }));

  const browser = await createBrowser();
  try {
    const context = await browser.newContext({ storageState: cookiesPath, viewport: { width: 1366, height: 768 } });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    let sinceBreak = 0;

    for (let i = 0; i < list.length; i++) {
      if (shouldStop()) {
        onLog(t(lang, 'publish.stoppedByUser'));
        break;
      }
      await waitWhilePaused(shouldPause, shouldStop);
      if (shouldStop()) {
        onLog(t(lang, 'publish.stoppedByUser'));
        break;
      }
      const url = list[i];
      const current = i + 1;

      // Чорний список — назавжди: таку групу не перевіряємо й не обходимо.
      if (blacklist.has(url)) {
        const known = blacklist.get(url);
        counters.blacklisted++;
        counters.skipped++;
        onLog(t(lang, 'verify.skipBlack', { current }));
        await onResult(url, { status: 'blacklisted', reason: known?.reason ?? 'already', counts: known?.counts ?? null, at: known?.at ?? Date.now(), already: true });
        onProgress(current, total);
        continue;
      }
      const prev = getKnown(url);
      if (prev?.status === 'good') {
        counters.good++;
        counters.skipped++;
        onLog(t(lang, 'verify.skipGood', { current }));
        onProgress(current, total);
        continue;
      }

      trace.event('verify.start', { n: current, total, url });
      onLog(t(lang, 'verify.checking', { current, total, url }));
      let verdict;
      try {
        await onResult(url, { status: 'working' });
        verdict = await verifyOneGroup(page, url, { trace, shouldStop, tabTimeoutMs });
      } catch (err) {
        const reason = err instanceof BlockedError ? err.reason : await detectBlock(page);
        trace.event('verify.error', { n: current, message: String(err?.message ?? err) });
        await trace.snap(reason ? `blocked-${reason}` : 'verify-error', page);
        if (reason) {
          onBlocked(reason);
          await onResult(url, { status: 'unknown', reason: 'blocked', counts: null, at: Date.now() });
          break;
        }
        verdict = { status: 'unknown', reason: 'error', counts: null };
        onLog(t(lang, 'publish.groupError', { url, message: err.message }));
      }

      if (verdict.reason === 'stopped') {
        await onResult(url, { status: 'unknown', reason: 'stopped', counts: verdict.counts, at: Date.now() });
        break;
      }
      if (verdict.reason === 'session') {
        onLog(t(lang, 'subscribe.sessionExpired'));
        await onResult(url, { status: 'unknown', reason: 'session', counts: verdict.counts, at: Date.now() });
        break;
      }

      const entry = { status: verdict.status, reason: verdict.reason, counts: verdict.counts, at: Date.now() };
      if (verdict.status === 'blacklisted') {
        await blacklist.add(url, { reason: verdict.reason, account: accountId, counts: verdict.counts });
        counters.blacklisted++;
      } else if (verdict.status === 'good') {
        await worklist?.add(url, { reason: verdict.reason, account: accountId, counts: verdict.counts });
        counters.good++;
      }
      else if (verdict.status === 'pending') counters.pending++;
      else counters.other++;

      trace.event('verify.end', { n: current, url, ...entry });
      onLog(t(lang, `verify.result.${entry.status}`, { current, reason: t(lang, `verify.reason.${entry.reason}`) }));
      await onResult(url, entry);
      onProgress(current, total);

      sinceBreak++;
      if (i < list.length - 1 && !shouldStop()) {
        let wait = (1500 + Math.random() * 2500) * pauseScale;
        if (sinceBreak >= 30) {
          sinceBreak = 0;
          wait = 20000 + Math.random() * 20000;
          onLog(t(lang, 'verify.longPause', { seconds: Math.round(wait / 1000) }));
        }
        await waitWithStop(wait, shouldPause, shouldStop);
      }
    }

    onLog(t(lang, 'verify.summary', counters));
    onLog(t(lang, 'publish.done'));
  } finally {
    await browser.close().catch(() => {});
  }
}
