/**
 * publisher.js — публікує пост у списку Facebook-груп.
 *
 * Логіка ідентична оригінальному Publikuj.js — змінено лише:
 *  - require → import (ES Modules)
 *  - хардкод TEKST_POSTA / GRUPY → параметри функції publishToGroups()
 *  - storageState: 'sesja.json' → параметризований cookiesPath
 *  - console.log → callback onLog (журнал у GUI, з перекладом через i18n)
 *  - додано callback onProgress (для індикатора прогресу)
 *  - додано підтримку зупинки через shouldStop() (кнопка "Зупинити")
 *  - додано підтримку паузи через shouldPause() (кнопка "Пауза")
 *  - додано опційне прикріплення зображення (imagePath) перед публікацією:
 *    зображення записується в системний буфер обміну через
 *    prepareImageClipboard() (надається з main.js, бо лише там є доступ
 *    до Electron clipboard/nativeImage), а потім у полі тексту
 *    виконується справжнє натискання Ctrl+V — так само, як робить
 *    людина руками.
 *  - launchChrome() (chromeLauncher.js) замість прямого chromium.launch():
 *    деякі версії Chrome на Windows одразу закриваються через прапорець
 *    --no-startup-window, тому є повторна спроба без нього.
 *  - clickPublishButton() чекає, поки кнопка "Opublikuj" стане не просто
 *    видимою, а АКТИВНОЮ (до 60 сек) — поки триває завантаження фото,
 *    вона залишається заблокованою.
 *
 * Сам алгоритм проходу по групах, кліки, введення тексту, затримки —
 * не змінені.
 */
import { access } from 'node:fs/promises';
import { groupKey } from './blacklist.js';
import { countItems } from './verifier.js';
import { t } from './i18n.js';
import { todayKey } from './warmup.js';
import { noopTracer } from './trace.js';
import { launchChrome } from './chromeLauncher.js';
import { assertNotBlocked, BlockedError, detectBlock } from './blockDetect.js';
import {
  waitForGroupState,
  joinGroupFlow,
  looksLikeLoginPage,
  dismissWelcomeDialog,
  isLoggedOutPage,
} from './groupJoin.js';
import { splitVariants, createPicker } from './textVariants.js';
import {
  randomDelayMs,
  formatClock,
  waitUntilStart,
  waitWhilePaused,
  waitWithStop,
} from './timing.js';

const DEFAULT_MIN_DELAY_SEC = 3;
const DEFAULT_MAX_DELAY_SEC = 5;

/**
 * Czeka, aż Facebook zakończy przesyłanie zdjęcia i odblokuje przycisk
 * publikacji. Przycisk może znajdować się w dialogu albo na poziomie strony,
 * a jego nazwa zależy od języka interfejsu.
 */
async function clickPublishButton(page, scope, timeoutMs = 60000) {
  const exactName = /^(opublikuj|opublikuj post|post|publish|publish post|опублікувати|опублікувати допис|опубликовать)$/i;
  const candidates = [
    scope.getByRole('button', { name: exactName }),
    scope.locator('[role="button"][aria-label*="Opublikuj" i], button[aria-label*="Opublikuj" i]'),
    page.getByRole('button', { name: exactName }),
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      const count = await candidate.count();
      for (let index = 0; index < count; index++) {
        const button = candidate.nth(index);
        if (await button.isVisible() && await button.isEnabled()) {
          await button.click();
          return;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error('Przycisk publikacji nie został odblokowany w ciągu 60 sekund.');
}

/**
 * Чи є на сторінці групи повідомлення, що ВАШ попередній пост ще чекає
 * схвалення адміністратора («Your pending posts», «Twoje posty oczekujące»,
 * «Ваші дописи на розгляді» тощо). Шукаємо лише в верхній частині сторінки
 * й лише фрази про власні пости — пункт «Pending posts» в меню адміністратора
 * не вважається.
 */
const PENDING_POST_NOTICE =
  /(your pending posts?|your post is pending|your posts? (is|are) (pending|awaiting)|you have \d+ pending posts?|twoje posty oczekuj|twój post oczekuje|twoje posty czekaj|masz \d+ (oczekując|post\w* oczekując)|ваші (дописи|публікації|пости) на розгляді|ваша (публікація|дописи?) (очікує|на розгляді)|у вас є \d+ (публікац|допис)\w* на розгляді|ваши (публикации|посты) на рассмотрении|ваша публикация (ожидает|на рассмотрении))/i;

async function hasPendingPostNotice(page) {
  const matches = page.getByText(PENDING_POST_NOTICE);
  const count = Math.min(await matches.count().catch(() => 0), 6);
  for (let index = 0; index < count; index++) {
    const item = matches.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (box && box.y < 1100) return true;
  }
  return false;
}

/**
 * Знаходить діалогове вікно створення поста (яке відкрилось після кліку
 * на "Napisz coś/Write something"). Facebook рендерить його як
 * [role="dialog"]. Якщо з якоїсь причини роль не знайдена — повертаємось
 * до пошуку по всій сторінці (як було раніше), щоб не зламати публікацію.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<import('playwright').Locator>}
 */
async function getComposerScope(page) {
  const dialogs = page.getByRole('dialog');
  const count = await dialogs.count();
  return count > 0 ? dialogs.last() : page;
}

/**
 * Перевіряє (не блокуючи виконання), чи з'явилось прев'ю завантаженого
 * фото в діалозі. Повертає true/false — сам ніколи не кидає помилку.
 *
 * @param {import('playwright').Locator} scope
 * @param {number} timeout
 */
async function isImagePreviewVisible(scope, timeout = 6000) {
  try {
    const preview = scope.locator('img[referrerpolicy], [aria-label*="Usuń" i], [aria-label*="Remove" i]').first();
    await preview.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Прикріплює зображення до поста: спершу пробує клік по іконці
 * (надійніший, "довірений" спосіб), і лише якщо він не спрацював (не
 * знайдено кнопку/поле, або прев'ю не підтвердилось) — пробує вставку
 * через буфер обміну як резерв. Ніколи не блокує публікацію намертво:
 * якщо жоден спосіб не підтвердився візуально, попереджає в журналі,
 * але дозволяє публікації продовжитись.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} scope - діалог створення поста
 * @param {import('playwright').Locator} textbox - поле тексту поста
 * @param {string} imagePath
 * @param {(msg: string) => void} onLog
 * @param {string} lang
 */
async function attachImage(page, scope, textbox, imagePath, prepareImageClipboard, withClipboardLock, onLog, lang) {
  onLog(t(lang, 'publish.attachingImage'));

  if (typeof prepareImageClipboard !== 'function') {
    throw new Error(t(lang, 'publish.clipboardUnavailable'));
  }

  // Системний буфер обміну спільний для всіх акаунтів, які працюють
  // паралельно, тому «скопіювати фото → Ctrl+V» виконується під
  // блокуванням: у кожен момент лише один акаунт користується буфером.
  await withClipboardLock(async () => {
    onLog(t(lang, 'publish.copyingImageToClipboard'));
    await prepareImageClipboard(imagePath);

    onLog(t(lang, 'publish.pastingImage'));
    await page.bringToFront();
    await textbox.focus().catch(() => {});
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(1500);
  });

  await page.waitForTimeout(3500);
  const confirmed = await isImagePreviewVisible(scope, 10000);
  if (!confirmed) {
    onLog(t(lang, 'publish.imagePreviewNotConfirmed'));
    return;
  }

  onLog(t(lang, 'publish.imagePreviewFound'));
}

const COMPOSER_TRIGGER = /napisz coś|write something|напишіть щось|напишіть що-небудь|напишите что-нибудь/i;

// Повідомлення, що ТІЛЬКИ ЩО надісланий пост чекає схвалення адміна групи
const PENDING_AFTER_POST =
  /(your post (is|was|has been) (pending|submitted|sent)|pending (admin |administrator )?approval|awaiting (admin |administrator )?approval|post (is )?pending|oczekuje na zatwierdzenie|czeka na zatwierdzenie|oczekuje na akceptację|zatwierdzenia przez administratora|очікує (на )?(схвалення|розгляду)|на розгляді (в )?адміністратор|надіслано на розгляд|ожидает (одобрения|рассмотрения)|отправлена на рассмотрение)/i;

// Повідомлення про помилку публікації
const POST_ERROR_NOTICE =
  /(couldn.t (post|publish)|something went wrong|try again later|nie udało się opublikować|coś poszło nie tak|spróbuj ponownie później|не вдалося опублікувати|щось пішло не так|не удалось опубликовать)/i;

async function anyVisible(page, regex, maxY = 1200) {
  const matches = page.getByText(regex);
  const count = Math.min(await matches.count().catch(() => 0), 6);
  for (let index = 0; index < count; index++) {
    const item = matches.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (box && box.y < maxY) return true;
  }
  return false;
}

/** Базова адреса групи (без вкладок «Дискусія», «Учасники» тощо й без параметрів). */
function groupBaseUrl(url) {
  try {
    const u = new URL(url);
    const match = /^\/groups\/([^/]+)/i.exec(u.pathname);
    return match ? `${u.origin}/groups/${match[1]}` : `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return String(url).replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

/** Фрагмент тексту поста для пошуку його на сторінці (перший непорожній рядок). */
function makeSnippet(text) {
  // Емодзі Facebook показує картинками, тож у тексті сторінки їх немає — прибираємо їх зі шматка.
  const clean = (l) =>
    l
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\u20E3]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  const lines = String(text).split('\n').map(clean).filter((l) => /[\p{L}\p{N}]{3}/u.test(l));
  return (lines[0] ?? '').slice(0, 40).trim();
}

/** Чекає, поки на сторінці з'явиться (видимий) фрагмент тексту. */
async function waitForSnippet(page, snippet, timeoutMs, reloadAtMs = 0) {
  const startedAt = Date.now();
  let reloaded = false;
  while (Date.now() - startedAt < timeoutMs) {
    const matches = page.getByText(snippet, { exact: false });
    const count = Math.min(await matches.count().catch(() => 0), 8);
    for (let index = 0; index < count; index++) {
      if (await matches.nth(index).isVisible().catch(() => false)) return true;
    }
    if (reloadAtMs && !reloaded && Date.now() - startedAt >= reloadAtMs) {
      reloaded = true;
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    await page.waitForTimeout(800);
  }
  return false;
}

const PENDING_LABEL =
  /(pending|awaiting|oczekuj|czeka na|zatwierdzeni|очікує|на розгляді|на рассмотрении|ожидает|рассмотрени)/i;
const JUST_NOW = /(just now|\b\d+\s?(m|min|mins|minutes?|minut\w*|s|sec)\b|minuty temu|minutę temu|teraz|przed chwilą|щойно|только что|\d+\s?(хв|хвилин|мин))/i;

/** Чи найновіший допис на сторінці створено лише що (кілька хвилин тому). */
async function newestArticleIsFresh(page) {
  const first = page.locator('[role="article"]').first();
  if (!(await first.isVisible().catch(() => false))) return false;
  const text = ((await first.innerText({ timeout: 2000 }).catch(() => '')) || '').slice(0, 400);
  return JUST_NOW.test(text);
}

/** Скільки дописів (articles) на сторінці містять фрагмент тексту. */
async function countArticlesWith(page, snippet) {
  if (!snippet) return 0;
  return page.locator('[role="article"]').filter({ hasText: snippet }).count().catch(() => 0);
}

/**
 * Визначає результат після натискання «Опублікувати»:
 *  1) у списку «Мої пости на розгляді» є наш пост → pending (найнадійніша ознака);
 *  2) повідомлення «чекає схвалення» біля поста/на сторінці → pending;
 *  3) у стрічці групи з'явився новий допис із нашим текстом без мітки
 *     «на розгляді» → published.
 * Якщо нічого однозначного — unknown (не вгадуємо).
 *
 * @returns {Promise<'published'|'pending'|'verification'|'declined'|'removed'|'unknown'>}
 */
async function confirmPostOutcome(page, { groupUrl, postText, onLog, lang, current, baseline = 0, trace = noopTracer }) {
  trace.event('verify.start', { snippet: makeSnippet(postText), baseline });
  if (await anyVisible(page, PENDING_AFTER_POST)) {
    trace.event('verify.result', { by: 'toast', verdict: 'pending' });
    await trace.snap('pending-toast', page);
    return 'pending';
  }

  const snippet = makeSnippet(postText);
  if (!snippet) {
    onLog(t(lang, 'publish.cannotVerifyImageOnly', { current }));
    return 'published';
  }

  const base = groupBaseUrl(groupUrl);

  // 1) Спершу список «на розгляді»: якщо пост там — він точно не опублікований.
  onLog(t(lang, 'publish.checkingPending', { current }));
  await page.goto(`${base}/my_pending_content`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await assertNotBlocked(page);
  if ((await waitForSnippet(page, snippet, 12000, 6000)) || (await newestArticleIsFresh(page))) {
    trace.event('verify.result', { by: 'pending-list', verdict: 'pending' });
    await trace.snap('pending-list', page);
    return 'pending';
  }
  if (await anyVisible(page, VERIFICATION_PENDING, 1400)) {
    await trace.snap('verification', page);
    return 'verification';
  }

  // 1б) Вкладка «Опубліковані» у «Мої пости» — найточніша ознака публікації.
  await page.goto(`${base}/my_posted_content`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  if ((await waitForSnippet(page, snippet, 7000, 0)) || (await newestArticleIsFresh(page))) {
    trace.event('verify.result', { by: 'posted-list', verdict: 'published' });
    await trace.snap('published-list', page);
    return 'published';
  }

  // 2) Стрічка групи (вкладка «Обговорення»).
  onLog(t(lang, 'publish.checkingFeed', { current }));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await assertNotBlocked(page);
  if (await anyVisible(page, PENDING_POST_NOTICE, 1400)) {
    trace.event('verify.result', { by: 'feed-banner', verdict: 'pending' });
    await trace.snap('pending-banner', page);
    return 'pending';
  }
  if (await waitForSnippet(page, snippet, 16000, 8000)) {
    const articles = page.locator('[role="article"]').filter({ hasText: snippet });
    const count = await articles.count().catch(() => 0);
    const first = count ? await articles.first().innerText().catch(() => '') : '';
    trace.event('verify.feed', { articles: count, baseline, head: first.slice(0, 160) });
    if (PENDING_LABEL.test(first.slice(0, 400)) && !JUST_NOW.test(first.slice(0, 200))) {
      await trace.snap('pending-in-feed', page);
      return 'pending';
    }
    // Такий текст уже був у стрічці раніше — потрібен новий допис або мітка «щойно».
    if (count > baseline || JUST_NOW.test(first.slice(0, 300)) || baseline === 0) {
      await trace.snap('published', page);
      return 'published';
    }
  }

  // 3) Пост могли одразу відхилити або видалити (правила групи / автомодерація Facebook).
  for (const [slug, verdict] of [['my_declined_content', 'declined'], ['my_removed_content', 'removed']]) {
    await page.goto(`${base}/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    if ((await waitForSnippet(page, snippet, 7000, 0)) || (await newestArticleIsFresh(page))) {
      trace.event('verify.result', { by: slug, verdict });
      await trace.snap(verdict, page);
      return verdict;
    }
  }

  trace.event('verify.result', { by: 'none', verdict: 'unknown' });
  await trace.snap('unknown', page);
  return 'unknown';
}

/**
 * Чи є вже НАШ пост на розгляді в цій групі: відкриваємо список
 * «Мої пости на розгляді» й дивимось, чи там є хоч один допис.
 * Це надійніше, ніж шукати банер на сторінці групи.
 */
// «Адміни перевіряють нових учасників, перш ніж їхні пости будуть опубліковані»:
// на сторінці «Мої пости» замість списку показується це повідомлення.
const VERIFICATION_PENDING =
  /(weryfikacja nadal oczekuje|sprawdzaj[ąa] nowych uczestnik|verification is (still )?pending|(admins|administrators) (review|check|approve) new members|перевірка (ще )?очікує|адміністратори перевіряють нових|проверка (еще )?ожидает|администраторы проверяют новых)/i;

const PENDING_ITEM_BUTTON =
  /^(delete|edit|remove|usuń|edytuj|видалити|редагувати|удалить|редактировать)/i;
const PENDING_EMPTY =
  /(no pending|nothing to show|nie masz|brak (oczekując|postów)|немає (дописів|постів|публікацій)|нет (публикаций|записей))/i;

async function pendingListHasItems(page, ms) {
  const articles = page.locator('[role="article"]');
  const buttons = page.getByRole('button', { name: PENDING_ITEM_BUTTON });
  const deadline = Date.now() + ms;
  let emptySeen = 0;
  while (Date.now() < deadline) {
    const n = Math.min(await articles.count().catch(() => 0), 5);
    for (let i = 0; i < n; i++) {
      if (await articles.nth(i).isVisible().catch(() => false)) return 'yes';
    }
    if (await anyVisible(page, VERIFICATION_PENDING, 1400)) return 'verification';
    const b = Math.min(await buttons.count().catch(() => 0), 3);
    for (let i = 0; i < b; i++) {
      if (await buttons.nth(i).isVisible().catch(() => false)) return 'yes';
    }
    if (await anyVisible(page, PENDING_EMPTY, 1400)) {
      if (++emptySeen >= 2) return 'no';
    }
    await page.waitForTimeout(700);
  }
  return 'unknown';
}

/**
 * Чи є вже НАШ пост на розгляді в цій групі (список «Мої пости на розгляді»).
 * Порожню сторінку вважаємо порожньою лише за явним підтвердженням; якщо
 * не вдалося визначити — перезавантажуємо й перевіряємо ще раз, а потім
 * вважаємо, що поста немає (діагностика зберігається у папку diagnostics).
 */
async function hasPendingInList(page, groupUrl, trace) {
  const base = groupBaseUrl(groupUrl);
  await page.goto(`${base}/my_pending_content`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await assertNotBlocked(page);
  let verdict = await pendingListHasItems(page, 10000);
  if (verdict === 'unknown') {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    verdict = await pendingListHasItems(page, 8000);
  }
  if (verdict === 'unknown') await trace.snap('pending-list-unclear', page);
  if (verdict === 'verification') await trace.snap('verification', page);
  await assertNotBlocked(page);
  // 2 і більше постів на розгляді → група підлягає чорному списку (швидко пропускаємо).
  if (verdict === 'yes') {
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const n = countItems(text);
    trace.event('pending.count', { url: groupUrl, n });
    if (n >= 2) verdict = 'many';
  }
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return verdict;
}

/** Чекає, поки вікно створення поста закриється (пост надіслано). */
async function waitForComposerClosed(page, timeoutMs = 25000) {
  const composer = page.getByRole('dialog').filter({ has: page.getByRole('textbox') });
  const deadline = Date.now() + timeoutMs;
  const spinner = /(publikowanie|posting|публікування|публикация|публикуется)/i;
  const hardDeadline = Date.now() + 90000;
  let limit = deadline;
  while (Date.now() < limit) {
    const open = (await composer.count().catch(() => 0)) > 0 && (await composer.last().isVisible().catch(() => false));
    if (!open) return 'closed';
    // Facebook ще публікує («Publikowanie…») — при слабкому інтернеті це може тривати довго.
    if (Date.now() >= limit - 1000 && Date.now() < hardDeadline && (await anyVisible(page, spinner, 900))) limit += 5000;
    await page.waitForTimeout(500);
  }
  return 'open';
}

/**
 * Публікує пост у групі, де акаунт уже є учасником, і перевіряє результат.
 * @returns {Promise<{status:'published'|'pending'|'failed', reason?:string}>}
 */
async function postToGroup({
  page, lang, current, groupUrl, postText, imagePath, prepareImageClipboard, withClipboardLock, onLog, stateWasUnknown, trace = noopTracer, getPendingSince, setPendingSince,
}) {
  await dismissWelcomeDialog(page).catch(() => {});
  onLog(t(lang, 'publish.checkingExisting', { current }));
  const pendingKey = groupBaseUrl(groupUrl);
  const today = todayKey();
  // Пост на розгляді блокує новий протягом 24 годин від надсилання (старі записи — за датою).
  const isRecent = (since) => (typeof since === 'number' ? Date.now() - since < 24 * 3600 * 1000 : Boolean(since && since >= today));
  // Старий пост на розгляді блокує новий лише в день надсилання; з наступного
  // дня (якщо адмін так і не розглянув) публікуємо новий.
  const shouldSkipForPending = async () => {
    const since = await getPendingSince(pendingKey);
    // Немає запису — пост надіслано раніше (до цієї версії), тож він «старий».
    if (isRecent(since)) return true;
    onLog(t(lang, since ? 'publish.pendingOld' : 'publish.pendingOldUnknown', { current, date: since }));
    return false;
  };

  const listVerdict = await hasPendingInList(page, groupUrl, trace);
  if (listVerdict === 'many') {
    onLog(t(lang, 'publish.pendingMany', { current }));
    return { status: 'failed', reason: 'pendingMany' };
  }
  if (listVerdict === 'verification') {
    // Адміни перевіряють нових учасників: пост усе одно можна надіслати — він піде на розгляд.
    const since = await getPendingSince(pendingKey);
    if (isRecent(since)) {
      onLog(t(lang, 'publish.pendingSkip', { current }));
      return { status: 'pending', reason: 'already' };
    }
    onLog(t(lang, 'publish.verificationWait', { current }));
  }
  if (listVerdict === 'yes') {
    if (await shouldSkipForPending()) {
      onLog(t(lang, 'publish.pendingSkip', { current }));
      return { status: 'pending', reason: 'already' };
    }
  }

  const trigger = page.getByText(COMPOSER_TRIGGER).first();
  const visible = await trigger
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) return { status: 'failed', reason: stateWasUnknown ? 'noButton' : 'noComposer' };
  await page.waitForTimeout(1200);
  await dismissWelcomeDialog(page).catch(() => {});
  await assertNotBlocked(page);

  if (await hasPendingPostNotice(page)) {
    if (await shouldSkipForPending()) {
      onLog(t(lang, 'publish.pendingSkip', { current }));
      return { status: 'pending', reason: 'already' };
    }
  }

  const baseline = await countArticlesWith(page, makeSnippet(postText));

  await trigger.click();
  await page.waitForTimeout(1500);

  const composerScope = await getComposerScope(page);
  const textbox = composerScope.getByRole('textbox').first();

  await page.keyboard.type(postText, { delay: 2 });
  await page.waitForTimeout(1000);

  if (imagePath) {
    await attachImage(page, composerScope, textbox, imagePath, prepareImageClipboard, withClipboardLock, onLog, lang);
  }

  trace.event('post.typed', { chars: postText.length, image: Boolean(imagePath) });
  await clickPublishButton(page, composerScope);
  trace.event('post.publishClicked');
  onLog(t(lang, 'publish.verifyingPost', { current }));

  const closed = await waitForComposerClosed(page, 25000);
  trace.event('post.composer', { closed });
  await page.waitForTimeout(2500);
  await assertNotBlocked(page);

  if (await anyVisible(page, POST_ERROR_NOTICE)) {
    await trace.snap('post-error', page);
    return { status: 'failed', reason: 'publishError' };
  }
  if (closed === 'open') await trace.snap('composer-stuck', page);

  const verdict = await confirmPostOutcome(page, { groupUrl, postText, onLog, lang, current, baseline, trace });
  if (verdict === 'pending' || verdict === 'verification') {
    await setPendingSince(pendingKey, Date.now());
    return { status: 'pending', reason: 'posted' };
  }
  if (verdict === 'published') return { status: 'published' };
  if (verdict === 'declined' || verdict === 'removed') return { status: 'failed', reason: verdict };
  return { status: 'failed', reason: 'notConfirmed' };
}

/**
 * Для кожної групи: відкриває її, вступає (якщо акаунт ще не учасник),
 * публікує пост і перевіряє результат.
 *
 * Результат по групі (onResult): published | pending (пост чекає схвалення
 * адміна) | joinPending (заявка на вступ чекає схвалення) | failed + reason.
 *
 * @param {Object} params
 * @param {string} params.text - текст публікації (варіанти через --- та {a|b})
 * @param {string[]} params.groups - список URL груп
 * @param {string} params.cookiesPath - шлях до збереженої сесії
 * @param {string} [params.imagePath]
 * @param {string} [params.lang]
 * @param {boolean} [params.autoJoin] - вступати в групу, якщо ще не учасник
 * @param {boolean} [params.autoForm] - автозаповнення анкети вступу
 * @param {string} [params.formAnswer] - відповідь на текстові запитання анкети
 * @param {number} [params.dailyJoinLimit] - макс. вступів за добу (0 — без ліміту)
 * @param {() => Promise<number>|number} [params.getJoinCount] - скільки вступів уже зроблено сьогодні
 * @param {(kind: 'joined'|'requested') => void|Promise<void>} [params.onJoin]
 * @param {(url: string, outcome: {status: string, reason?: string}) => void|Promise<void>} [params.onResult]
 * @param {() => void|Promise<void>} [params.onSuccess] - лише після опублікованого поста
 */
export async function publishToGroups({
  text,
  groups,
  cookiesPath,
  imagePath = null,
  lang = 'uk',
  autoJoin = true,
  autoForm = true,
  formAnswer = '',
  dailyJoinLimit = 0,
  trace = noopTracer,
  isBlacklisted = () => false,
  onBlacklist = async () => {},
  getPendingSince = () => null,
  setPendingSince = () => {},
  getPostedToday = async () => null,
  getJoinCount = () => 0,
  onJoin = () => {},
  onResult = () => {},
  onLog = () => {},
  onProgress = () => {},
  shouldStop = () => false,
  shouldPause = () => false,
  prepareImageClipboard = null,
  onSuccess = () => {},
  startAt = null,
  delayMinSec = DEFAULT_MIN_DELAY_SEC,
  delayMaxSec = DEFAULT_MAX_DELAY_SEC,
  onStatus = () => {},
  withClipboardLock = (fn) => fn(),
  onBlocked = () => {},
}) {
  try {
    await access(cookiesPath);
  } catch {
    onLog(t(lang, 'publish.needLogin'));
    return;
  }

  if (imagePath) {
    try {
      await access(imagePath);
      onLog(t(lang, 'publish.imageWillBeUsed', { path: imagePath }));
    } catch {
      onLog(t(lang, 'publish.imageNotFound', { path: imagePath }));
      return;
    }
  }

  if (startAt && startAt > Date.now()) {
    onStatus('waiting', { startAt });
    onLog(t(lang, 'publish.waitingStart', { time: formatClock(startAt) }));
    const reached = await waitUntilStart(startAt, shouldStop);
    if (!reached) {
      onLog(t(lang, 'publish.stoppedByUser'));
      return;
    }
  }
  onStatus('running');

  const browser = await launchChrome();

  try {
    const context = await browser.newContext({
      storageState: cookiesPath,
      viewport: { width: 1366, height: 768 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const variants = splitVariants(text);
    const nextText = createPicker(variants);
    if (variants.length > 1) onLog(t(lang, 'publish.variantsCount', { count: variants.length }));

    const counts = { published: 0, pending: 0, joinPending: 0, failed: 0 };

    for (let i = 0; i < groups.length; i++) {
      if (shouldStop()) {
        onLog(t(lang, 'publish.stoppedByUser'));
        break;
      }
      await waitWhilePaused(shouldPause, shouldStop);
      if (shouldStop()) {
        onLog(t(lang, 'publish.stoppedByUser'));
        break;
      }

      const url = groups[i];
      const current = i + 1;

      // Постійний чорний список: такі групи пропускаються без жодних обходів.
      if (isBlacklisted(url)) {
        onLog(t(lang, 'publish.blacklisted', { current }));
        counts.failed++;
        trace.event('group.blacklisted', { n: current, url });
        await onResult(url, { status: 'failed', reason: 'blacklisted' });
        onProgress(current, groups.length);
        continue;
      }
      // Сьогодні в цій групі цей акаунт уже публікував (пост опубліковано або чекає
      // схвалення) — другий пост того ж дня не надсилаємо, навіть сторінку не відкриваємо.
      const prior = await Promise.resolve(getPostedToday(url)).catch(() => null);
      if (prior === 'published' || prior === 'pending') {
        onLog(t(lang, `publish.result.${prior}.alreadyToday`, { current }));
        counts[prior] = (counts[prior] ?? 0) + 1;
        trace.event('group.skippedToday', { n: current, url, prior });
        await onResult(url, { status: prior, reason: 'alreadyToday' });
        onProgress(current, groups.length);
        continue;
      }
      const page = await context.newPage();
      let outcome = { status: 'failed', reason: 'publishError' };
      let acted = false; // чи робили реальні дії (вступ/публікація) — тоді потрібна затримка
      let blocked = false;
      let sessionExpired = false;
      const tick = (sec) => onLog(t(lang, 'subscribe.stillLoading', { current, seconds: sec }));
      const groupStart = Date.now();
      trace.event('group.start', { n: current, total: groups.length, url });

      try {
        await onResult(url, { status: 'working' });
        onLog(t(lang, 'publish.navigating', { current, total: groups.length, url }));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => onLog(t(lang, 'subscribe.slowPage', { current })));
        onLog(t(lang, 'subscribe.loading', { current }));

        let state = await waitForGroupState(page, 45000, tick);
        if (state === 'unknown' && !looksLikeLoginPage(page.url())) {
          // Це може бути група, де ви власник/адмін і кнопок вступу немає — перевіримо поле публікації
          const hasComposer = await page.getByText(COMPOSER_TRIGGER).first().isVisible().catch(() => false);
          if (!hasComposer) {
            onLog(t(lang, 'subscribe.reloading', { current }));
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            state = await waitForGroupState(page, 45000, tick);
          }
        }
        trace.event('group.state', { n: current, state, finalUrl: page.url(), ms: Date.now() - groupStart });
        await assertNotBlocked(page);
        const loggedOut = !looksLikeLoginPage(page.url()) && (await isLoggedOutPage(page));
        if (loggedOut) trace.event('session.loggedOut', { n: current, url: page.url() });

        if (looksLikeLoginPage(page.url()) || loggedOut) {
          sessionExpired = true;
          outcome = { status: 'failed', reason: 'session' };
        } else {
          let canPost = true;
          let joinFallback = null; // статус, якщо поста надіслати не вийде
          if (state === 'pending') {
            onLog(t(lang, 'subscribe.alreadyPending', { current }));
            joinFallback = { status: 'joinPending', reason: 'already' };
            outcome = joinFallback;
          }
          if (state === 'member') {
            onLog(t(lang, 'publish.alreadyMember', { current }));
          } else if (state === 'canJoin') {
            if (!autoJoin) {
              outcome = { status: 'failed', reason: 'autoJoinOff' };
              canPost = false;
            } else if (dailyJoinLimit > 0 && (await getJoinCount()) >= dailyJoinLimit) {
              onLog(t(lang, 'subscribe.limitReached', { limit: dailyJoinLimit }));
              outcome = { status: 'failed', reason: 'joinLimit' };
              canPost = false;
            } else {
              onLog(t(lang, 'publish.joining', { current }));
              const joined = await joinGroupFlow(page, { autoForm, formAnswer, onLog, lang, current });
              acted = true;
              if (joined.result === 'pending') {
                await onJoin('requested');
                onLog(t(lang, 'subscribe.requested', { current }));
                joinFallback = { status: 'joinPending', reason: 'sent' };
                outcome = joinFallback;
              } else if (joined.result === 'failed') {
                outcome = { status: 'failed', reason: joined.reason };
                canPost = false;
              } else {
                await onJoin('joined');
                onLog(t(lang, 'subscribe.joined', { current }));
                await page.waitForTimeout(2000 + Math.random() * 2000);
              }
            }
          }
          if (canPost) {
            outcome = await postToGroup({
              page,
              lang,
              current,
              groupUrl: url,
              postText: nextText(),
              imagePath,
              prepareImageClipboard,
              withClipboardLock,
              onLog,
              stateWasUnknown: state === 'unknown',
              trace,
              getPendingSince,
              setPendingSince,
            });
            if (joinFallback && outcome.status === 'failed' && ['noComposer', 'noButton'].includes(outcome.reason)) {
              onLog(t(lang, 'publish.joinPendingNoPost', { current }));
              outcome = joinFallback;
            }
            if (outcome.status === 'published' || outcome.reason === 'posted') acted = true;
            if (outcome.status === 'published') await onSuccess();
          }
        }
      } catch (err) {
        trace.event('error', { n: current, message: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 6).join(' | ') });
        const reason = err instanceof BlockedError ? err.reason : await detectBlock(page);
        await trace.snap(reason ? `blocked-${reason}` : 'error', page);
        if (reason) {
          blocked = true;
          outcome = { status: 'failed', reason: 'blocked' };
          onBlocked(reason);
        } else {
          outcome = { status: 'failed', reason: 'publishError' };
          onLog(t(lang, 'publish.groupError', { url, message: err.message }));
        }
      }

      if (outcome.reason === 'session') sessionExpired = true;
      counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
      onLog(
        outcome.status === 'failed'
          ? t(lang, 'publish.resultFailed', { current, reason: t(lang, `reason.${outcome.reason}`) })
          : t(lang, `publish.result.${outcome.status}.${outcome.reason ?? 'ok'}`, { current }),
      );
      trace.event('group.end', { n: current, url, status: outcome.status, reason: outcome.reason ?? null, ms: Date.now() - groupStart });
      // Знімок екрана для КОЖНОГО результату (опубліковано / пост на розгляді /
      // вступ на розгляді / не вдалося) — щоб потім можна було все переаналізувати.
      // Пост видалено/відхилено адміністраторами → група назавжди в чорному списку.
      if (outcome.status === 'failed' && ['removed', 'declined', 'pendingMany'].includes(outcome.reason)) {
        await onBlacklist(url, { reason: outcome.reason }).catch(() => {});
      }
      if (outcome.reason !== 'blocked') {
        const groupTag = String(groupKey(url) ?? url).replace(/^groups\//, '').replace(/[^\w.-]+/g, '_').slice(0, 40);
        await trace.snap(`${String(current).padStart(3, '0')}_${outcome.status}-${outcome.reason ?? 'ok'}_${groupTag}`, page);
      }
      await onResult(url, outcome);

      await page.close().catch(() => {});
      onProgress(current, groups.length);
      if (blocked) break;
      if (sessionExpired) {
        onLog(t(lang, 'subscribe.sessionExpired'));
        break;
      }

      if (i < groups.length - 1 && !shouldStop() && acted) {
        const wait = randomDelayMs(delayMinSec, delayMaxSec);
        onLog(t(lang, 'publish.waiting', { seconds: Math.round(wait / 1000) }));
        await waitWithStop(wait, shouldPause, shouldStop);
      }
    }

    onLog(t(lang, 'publish.summary', counts));
    onLog(t(lang, 'publish.done'));
  } finally {
    await browser.close().catch(() => {});
  }
}
