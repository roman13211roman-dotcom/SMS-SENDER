/**
 * activity.js — «органічна активність» акаунта: короткі сесії, які
 * імітують звичайного користувача Facebook.
 *
 * Під час сесії акаунт:
 *  - гортає стрічку новин і (за бажанням) сторінки груп зі списку;
 *  - читає пости: зупиняється, інколи гортає назад;
 *  - у випадкові моменти ставить лайки, підписується на людей/сторінки
 *    (кнопка «Стежити») й залишає короткі коментарі з заданого списку;
 *  - інколи відкриває пост і гортає коментарі;
 *  - робить випадкові паузи «відійшов від екрана».
 *
 * Процес повністю автономний: сесії йдуть одна за одною (з випадковою
 * паузою, браузер між ними закривається), доки користувач не натисне «Стоп»
 * або не буде досягнуто добового ліміту дій. Усі кількості й тривалості —
 * випадкові в заданих межах.
 */
import { access } from 'node:fs/promises';
import { t } from './i18n.js';
import { launchChrome } from './chromeLauncher.js';
import { assertNotBlocked, BlockedError, detectBlock } from './blockDetect.js';
import { withDefaultComments } from './defaultComments.js';
import { getWarmup, stageActivity, WARMUP_DAYS } from './warmup.js';
import { formatClock, waitUntilStart, waitWhilePaused, waitWithStop, sleep } from './timing.js';

const FEED_URL = 'https://www.facebook.com/';

// Кнопка «Лайк» ще не поставленого лайка. Вже поставлений лайк має іншу
// назву («Usuń reakcję…», «Remove Like»), тому під цей шаблон не потрапляє.
const LIKE_NAME = /^(lubię to!?|like|подобається|мені подобається|нравится|мне нравится)$/i;

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pause = (min, max) => sleep(rand(min, max));

function looksLikeLoginPage(url) {
  return /\/login|checkpoint|\/two_step_verification|recover/i.test(url);
}

async function viewportSize(page) {
  return page.viewportSize() ?? { width: 1366, height: 768 };
}

/** Плавне «людське» прокручування колесом миші невеликими кроками. */
async function humanScroll(page) {
  const { width, height } = await viewportSize(page);
  await page.mouse.move(rand(width * 0.3, width * 0.7), rand(height * 0.3, height * 0.7), {
    steps: randInt(6, 14),
  });
  const total = rand(260, 820);
  const steps = randInt(3, 7);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps);
    await pause(40, 140);
  }
}

/** Рухає мишею до елемента й клікає, як людина. */
async function humanClick(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width * rand(0.3, 0.7), box.y + box.height * rand(0.3, 0.7), {
    steps: randInt(8, 18),
  });
  await pause(350, 1100);
  await page.mouse.down();
  await pause(40, 120);
  await page.mouse.up();
  return true;
}

/** Ставить лайк під видимим у вікні постом. @returns {Promise<boolean>} */
async function tryLike(page) {
  const { height } = await viewportSize(page);
  const buttons = page.getByRole('button', { name: LIKE_NAME });
  const count = Math.min(await buttons.count(), 25);
  const candidates = [];
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index);
    const box = await button.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.y > 110 && box.y + box.height < height - 60) candidates.push(button);
  }
  if (candidates.length === 0) return false;
  const target = candidates[randInt(0, candidates.length - 1)];
  const clicked = await humanClick(page, target).catch(() => false);
  if (clicked) await pause(1200, 2600);
  return clicked;
}

const FOLLOW_NAME = /^(śledź|obserwuj|follow|стежити|підписатися|підписатись|подписаться|читать)$/i;
const COMMENT_BOX_NAME = /(napisz komentarz|skomentuj jako|write a comment|comment as|напишіть коментар|коментувати як|напишите комментарий|комментировать как)/i;
const COMMENT_BUTTON_NAME = /^(skomentuj|comment|коментар|прокоментувати|комментировать|оставить комментарий)$/i;

async function visibleCandidates(page, locator, limit = 25) {
  const { height } = await viewportSize(page);
  const count = Math.min(await locator.count(), limit);
  const result = [];
  for (let index = 0; index < count; index++) {
    const item = locator.nth(index);
    const box = await item.boundingBox().catch(() => null);
    if (box && box.y > 110 && box.y + box.height < height - 60) result.push(item);
  }
  return result;
}

/** Підписується на людину/сторінку (кнопка «Стежити»). */
async function tryFollow(page) {
  const candidates = await visibleCandidates(page, page.getByRole('button', { name: FOLLOW_NAME }));
  if (candidates.length === 0) return false;
  const target = candidates[randInt(0, candidates.length - 1)];
  const clicked = await humanClick(page, target).catch(() => false);
  if (clicked) await pause(1500, 3000);
  return clicked;
}

/** Друкує текст «як людина» й надсилає коментар. */
async function tryComment(page, text) {
  let boxes = await visibleCandidates(page, page.getByRole('textbox', { name: COMMENT_BOX_NAME }), 10);
  if (boxes.length === 0) {
    const buttons = await visibleCandidates(page, page.getByRole('button', { name: COMMENT_BUTTON_NAME }), 10);
    if (buttons.length === 0) return false;
    await humanClick(page, buttons[randInt(0, buttons.length - 1)]).catch(() => false);
    await pause(1200, 2200);
    boxes = await visibleCandidates(page, page.getByRole('textbox', { name: COMMENT_BOX_NAME }), 10);
    if (boxes.length === 0) return false;
  }
  const box = boxes[randInt(0, boxes.length - 1)];
  if (!(await humanClick(page, box).catch(() => false))) return false;
  await pause(500, 1200);
  await page.keyboard.type(text, { delay: randInt(60, 140) });
  await pause(800, 2000);
  await page.keyboard.press('Enter');
  await pause(2500, 4500);
  return true;
}

/** Відкриває випадковий пост, «читає» його й повертається назад. */
async function tryOpenPost(page, onLog, lang) {
  const { height } = await viewportSize(page);
  const links = page.locator('a[href*="/posts/"], a[href*="/permalink/"]');
  const count = Math.min(await links.count(), 30);
  const candidates = [];
  for (let index = 0; index < count; index++) {
    const link = links.nth(index);
    const box = await link.boundingBox().catch(() => null);
    if (box && box.y > 110 && box.y + box.height < height - 60) candidates.push(link);
  }
  if (candidates.length === 0) return false;

  const before = page.url();
  const target = candidates[randInt(0, candidates.length - 1)];
  if (!(await humanClick(page, target).catch(() => false))) return false;
  await page.waitForTimeout(rand(3000, 5000));
  if (page.url() === before) return false;

  onLog(t(lang, 'activity.postOpened'));
  const reads = randInt(2, 4);
  for (let i = 0; i < reads; i++) {
    await humanScroll(page);
    await pause(2500, 7000);
  }
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(rand(2000, 3500));
  return true;
}

/**
 * Одна сесія активності. Повертає підсумок сесії.
 */
async function runSession({
  page,
  groups,
  durationMs,
  plan, // { likes, follows, comments, posts }
  commentTexts,
  visitGroups,
  lang,
  onLog,
  onAction,
  shouldStop,
  shouldPause,
}) {
  const result = { scrolls: 0, likes: 0, follows: 0, comments: 0, posts: 0, groups: 0, sessionExpired: false };
  const startedAt = Date.now();
  const endAt = startedAt + durationMs;

  // Розклад дій: випадкові моменти по всій сесії.
  const queue = [];
  const addAll = (type, n, from, to) => {
    for (let i = 0; i < n; i++) queue.push({ type, at: startedAt + rand(from, to) * durationMs, tries: 0 });
  };
  addAll('like', plan.likes, 0.08, 0.93);
  addAll('follow', plan.follows, 0.1, 0.9);
  addAll('comment', plan.comments, 0.2, 0.9);
  addAll('post', plan.posts, 0.15, 0.85);
  queue.sort((x, y) => x.at - y.at);

  const usedComments = new Set();
  const pickComment = () => {
    const free = commentTexts.filter((c) => !usedComments.has(c));
    const pool = free.length > 0 ? free : commentTexts;
    const text = pool[randInt(0, pool.length - 1)];
    usedComments.add(text);
    return text;
  };
  let lastGroup = null;

  while (Date.now() < endAt && !shouldStop()) {
    let url = FEED_URL;
    let isGroup = false;
    if (visitGroups && groups.length > 0 && Math.random() < 0.5) {
      const pool = groups.filter((g) => g !== lastGroup);
      const list = pool.length > 0 ? pool : groups;
      url = list[randInt(0, list.length - 1)];
      lastGroup = url;
      isGroup = true;
    }

    onLog(isGroup ? t(lang, 'activity.sceneGroup', { url }) : t(lang, 'activity.sceneFeed'));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      onLog(t(lang, 'activity.navError', { message: err.message }));
      await pause(3000, 6000);
      continue;
    }
    await assertNotBlocked(page);
    if (looksLikeLoginPage(page.url())) {
      result.sessionExpired = true;
      return result;
    }
    if (isGroup) result.groups++;
    await page.waitForTimeout(rand(3000, 5500));

    const sceneEnd = Math.min(endAt, Date.now() + rand(70_000, 190_000));
    while (Date.now() < sceneEnd && !shouldStop()) {
      await waitWhilePaused(shouldPause, shouldStop);
      if (shouldStop()) break;

      await humanScroll(page);
      result.scrolls++;
      await pause(1800, Math.random() < 0.2 ? 11000 : 6000);
      if (Math.random() < 0.12) {
        await page.mouse.wheel(0, -rand(150, 450));
        await pause(1200, 3000);
      }
      if (Math.random() < 0.06) await pause(6000, 16000);

      let dueGuard = 0;
      while (queue.length > 0 && Date.now() >= queue[0].at && dueGuard++ < 3 && !shouldStop()) {
        const job = queue.shift();
        let done = false;
        try {
          if (job.type === 'like') done = await tryLike(page);
          else if (job.type === 'follow') done = await tryFollow(page);
          else if (job.type === 'comment') {
            const text = pickComment();
            done = await tryComment(page, text);
            if (done) onLog(t(lang, 'activity.commentText', { text }));
          } else if (job.type === 'post') {
            if (await tryOpenPost(page, onLog, lang)) result.posts++;
            done = true;
          }
        } catch (err) {
          const reason = err instanceof BlockedError ? err.reason : await detectBlock(page);
          if (reason) throw new BlockedError(reason);
          onLog(t(lang, 'activity.actionError', { message: err.message }));
        }
        await assertNotBlocked(page);
        if (job.type !== 'post') {
          if (done) {
            const key = job.type === 'like' ? 'likes' : job.type === 'follow' ? 'follows' : 'comments';
            result[key]++;
            onLog(t(lang, `activity.did.${job.type}`));
            await onAction(job.type, { ...result });
          } else if (++job.tries < 3) {
            // не знайшлося підходящого елемента — спробуємо пізніше, на іншому місці стрічки
            job.at = Date.now() + rand(20_000, 60_000);
            queue.push(job);
            queue.sort((x, y) => x.at - y.at);
          }
        }
        await pause(1500, 4000);
      }
    }
  }
  return result;
}

/**
 * @param {Object} params
 * @param {string[]} params.groups - посилання на групи (необов'язково)
 * @param {string} params.cookiesPath
 * @param {string} [params.lang]
 * @param {number|null} [params.startAt]
 * @param {{durMin:number, durMax:number, pauseMin:number, pauseMax:number,
 *          likesMin:number, likesMax:number, followsMin:number, followsMax:number,
 *          commentsMin:number, commentsMax:number, commentTexts:string[],
 *          dailyLimit:number, visitGroups:boolean, openPosts:boolean}} params.activity
 * @param {() => Promise<number>} [params.getTodayCount] - дій за сьогодні (для добового ліміту)
 * @param {(type: string, counts: object) => void|Promise<void>} [params.onAction] - після кожної дії
 * @param {(counts: object|null) => void} [params.onCounts] - лічильник дій поточної сесії
 * @param {(msg: string) => void} [params.onLog]
 * @param {(state: string, extra?: object) => void} [params.onStatus]
 * @param {() => boolean} [params.shouldStop]
 * @param {() => boolean} [params.shouldPause]
 */
export async function runActivity({
  groups = [],
  cookiesPath,
  lang = 'uk',
  startAt = null,
  activity,
  getTodayCount = async () => 0,
  onAction = () => {},
  onCounts = () => {},
  onLog = () => {},
  onStatus = () => {},
  onBlocked = () => {},
  shouldStop = () => false,
  shouldPause = () => false,
}) {
  const summary = { sessions: 0, scrolls: 0, likes: 0, follows: 0, comments: 0, posts: 0, groups: 0, reason: 'stop' };

  try {
    await access(cookiesPath);
  } catch {
    onLog(t(lang, 'publish.needLogin'));
    summary.reason = 'nologin';
    return summary;
  }

  if (startAt && startAt > Date.now()) {
    onStatus('waiting', { startAt });
    onLog(t(lang, 'activity.waitingStart', { time: formatClock(startAt) }));
    if (!(await waitUntilStart(startAt, shouldStop))) {
      onLog(t(lang, 'publish.stoppedByUser'));
      return summary;
    }
  }
  onStatus('running');
  onLog(t(lang, 'activity.autoStarted'));

  const commentTexts = withDefaultComments(activity.commentTexts);
  let sessionNo = 0;

  while (!shouldStop()) {
    if (activity.dailyLimit > 0 && (await getTodayCount()) >= activity.dailyLimit) {
      onLog(t(lang, 'activity.dailyLimitReached', { limit: activity.dailyLimit }));
      summary.reason = 'limit';
      break;
    }

    sessionNo++;
    const durationMs = rand(activity.durMin, activity.durMax) * 60_000;
    const plan = {
      likes: randInt(activity.likesMin, activity.likesMax),
      follows: randInt(activity.followsMin, activity.followsMax),
      comments: randInt(activity.commentsMin, activity.commentsMax),
      posts: activity.openPosts ? randInt(1, 3) : 0,
    };
    onLog(
      t(lang, 'activity.sessionStart', {
        current: sessionNo,
        minutes: Math.round(durationMs / 60_000),
        likes: plan.likes,
        follows: plan.follows,
        comments: plan.comments,
      }),
    );
    onCounts({ session: sessionNo, likes: 0, follows: 0, comments: 0, planned: plan.likes + plan.follows + plan.comments });

    const browser = await launchChrome();
    let result;
    let blockedNow = false;
    try {
      const context = await browser.newContext({
        storageState: cookiesPath,
        viewport: { width: 1366, height: 768 },
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      const page = await context.newPage();
      result = await runSession({
        page,
        groups,
        durationMs,
        plan,
        commentTexts,
        visitGroups: activity.visitGroups,
        lang,
        onLog,
        onAction: async (type, counts) => {
          onCounts({
            session: sessionNo,
            likes: counts.likes,
            follows: counts.follows,
            comments: counts.comments,
            planned: plan.likes + plan.follows + plan.comments,
          });
          await onAction(type, counts);
        },
        shouldStop,
        shouldPause,
      });
    } catch (err) {
      if (err instanceof BlockedError) {
        onBlocked(err.reason);
        blockedNow = true;
      } else {
        onLog(t(lang, 'activity.sessionError', { message: err.message }));
      }
      result = { scrolls: 0, likes: 0, follows: 0, comments: 0, posts: 0, groups: 0, sessionExpired: false };
    } finally {
      await browser.close().catch(() => {});
    }

    summary.sessions++;
    for (const key of ['scrolls', 'likes', 'follows', 'comments', 'posts', 'groups']) summary[key] += result[key];
    onLog(
      t(lang, 'activity.sessionDone', {
        current: sessionNo,
        actions: result.likes + result.follows + result.comments,
        likes: result.likes,
        follows: result.follows,
        comments: result.comments,
        posts: result.posts,
      }),
    );

    if (blockedNow) {
      onCounts(null);
      summary.reason = 'blocked';
      break;
    }
    if (result.sessionExpired) {
      onLog(t(lang, 'subscribe.sessionExpired'));
      summary.reason = 'expired';
      break;
    }
    if (shouldStop()) break;

    const gapMs = rand(activity.pauseMin, activity.pauseMax) * 60_000;
    onLog(t(lang, 'activity.betweenSessions', { minutes: Math.round(gapMs / 60_000) }));
    await waitWithStop(gapMs, shouldPause, shouldStop);
  }

  if (shouldStop()) onLog(t(lang, 'publish.stoppedByUser'));
  onLog(
    t(lang, 'activity.summary', {
      sessions: summary.sessions,
      actions: summary.likes + summary.follows + summary.comments,
      likes: summary.likes,
      follows: summary.follows,
      comments: summary.comments,
    }),
  );
  onLog(t(lang, 'activity.done'));
  return summary;
}

function nextMorning(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);
  return next.getTime() + rand(0, 180) * 60_000;
}

/**
 * Режим «Прогрів»: щодня виконує автономну активність з лімітами поточного
 * дня прогріву; коли добову норму виконано — чекає до наступного ранку.
 * Завершується сам після останнього дня прогріву.
 */
export async function runWarmup({
  groups = [],
  cookiesPath,
  lang = 'uk',
  startAt = null,
  startDate,
  commentTexts = [],
  getTodayCount,
  onAction,
  onCounts,
  onLog = () => {},
  onStatus = () => {},
  onBlocked,
  shouldStop = () => false,
  shouldPause = () => false,
}) {
  let first = true;
  let last = { reason: 'stop' };
  while (!shouldStop()) {
    const warm = getWarmup(startDate);
    if (!warm) return last;
    if (warm.done) {
      onLog(t(lang, 'warmup.finished'));
      return last;
    }
    onLog(
      t(lang, 'warmup.stage', {
        day: warm.day,
        total: WARMUP_DAYS,
        likes: warm.likes[1],
        follows: warm.follows[1],
        comments: warm.comments[1],
        actions: warm.actionsPerDay,
      }),
    );
    last = await runActivity({
      groups,
      cookiesPath,
      lang,
      startAt: first ? startAt : null,
      activity: stageActivity(warm, commentTexts),
      getTodayCount,
      onAction,
      onCounts,
      onLog,
      onStatus,
      onBlocked,
      shouldStop,
      shouldPause,
    });
    first = false;
    if (last.reason !== 'limit') return last;

    const next = nextMorning();
    onLog(t(lang, 'warmup.dayDone', { day: warm.day, time: formatClock(next) }));
    onStatus('waiting', { startAt: next });
    const reached = await waitUntilStart(next, shouldStop);
    if (!reached) break;
    onStatus('running');
  }
  return last;
}
