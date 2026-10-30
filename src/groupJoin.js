/**
 * groupJoin.js — допоміжні функції для роботи зі станом групи Facebook та
 * вступу в неї (використовуються режимом «Публікація»: якщо акаунт ще не
 * учасник групи, бот спершу вступає, а потім публікує).
 *
 * Назви кнопок Facebook залежать від мови інтерфейсу, тому розпізнаються
 * кількома мовами (PL / EN / UK / RU).
 */
import { t } from './i18n.js';

// Лише повні назви кнопки вступу до ГРУПИ. Короткі «Join»/«Dołącz» навмисно
// не використовуються: на сторінці групи в бічній колонці є кнопки вступу в
// інші, рекомендовані групи — їх натискати не можна.
export const JOIN_NAME = /^(dołącz do grupy|join group|join this group|приєднатися до групи|вступить в группу|вступить в эту группу)$/i;
const MEMBER_NAME = /^(dołączono|joined|ви в групі|вы в группе|joined group)$/i;
const PENDING_NAME = /(anuluj prośbę|anuluj prosbę|cancel request|скасувати запит|отменить запрос|prośba wysłana|request sent|запит надіслано|запрос отправлен)/i;

/**
 * Перша видима кнопка з відповідною назвою (у порядку на сторінці — тобто
 * шапка групи йде раніше за бічну колонку).
 */
export async function findVisibleButton(page, nameRe) {
  const candidates = [
    page.getByRole('button', { name: nameRe }),
    page.locator('[role="button"]').filter({ hasText: nameRe }),
  ];
  for (const locator of candidates) {
    const count = await locator.count();
    for (let index = 0; index < Math.min(count, 8); index++) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

/**
 * @returns {Promise<'member'|'pending'|'canJoin'|'unknown'>}
 */
export async function detectGroupState(page) {
  if (await findVisibleButton(page, PENDING_NAME)) return 'pending';
  if (await findVisibleButton(page, MEMBER_NAME)) return 'member';
  if (await findVisibleButton(page, JOIN_NAME)) return 'canJoin';
  return 'unknown';
}

/**
 * Чи це сторінка/вікно для НЕзалогіненого відвідувача (сесія Facebook недійсна).
 * Кнопка «Dołącz do grupy» тоді відкриває вікно входу (e-mail + пароль), яке
 * НЕ можна заповнювати як анкету групи.
 */
export async function isLoggedOutPage(page) {
  try {
    return await page.evaluate(() => {
      const visible = (n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
      const fields = [...document.querySelectorAll('input[type="password"], input[name="email"], input[name="pass"], input[id="email"]')];
      return fields.some(visible);
    });
  } catch {
    return false;
  }
}

/** Чи відкрилось діалогове вікно (запитання до вступників / правила групи). */
export async function isDialogOpen(page) {
  const dialogs = page.getByRole('dialog');
  const count = await dialogs.count();
  for (let index = 0; index < count; index++) {
    if (await dialogs.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

/** Чи є у видимому діалозі справжні поля анкети (радіо, галочки, текст, списки). */
export async function dialogHasControls(page) {
  try {
    return await page.getByRole('dialog').last().evaluate((d) =>
      !!d.querySelector('input[type="radio"], input[type="checkbox"], input[type="text"], textarea, select, [role="radio"], [role="checkbox"], [role="combobox"], [role="textbox"], [contenteditable="true"]'));
  } catch {
    return false;
  }
}

const CLOSE_NAME = /^(zamknij|close|закрити|закрыть)$/i;
const WELCOME_TEXT = /(witamy w grupie|welcome to (the )?group|welcome to |ласкаво просимо|вітаємо|добро пожаловать|приветствуем)/i;
const FORM_HINT = /(odpowiedz|answer|питання|відповід|вопрос|ответ|regulamin|rules|правила|zaakceptuj|agree|погоджу|согласен)/i;

/**
 * Привітальне вікно після вступу («Gage, witamy w grupie…» з кнопкою «Dalej»)
 * — це не анкета, його просто закриваємо (хрестик / Escape).
 * @returns {Promise<boolean>} true, якщо таке вікно було й ми його закрили
 */
export async function dismissWelcomeDialog(page) {
  let closedAny = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const dialogs = page.getByRole('dialog');
    const count = Math.min(await dialogs.count().catch(() => 0), 3);
    let target = null;
    for (let i = 0; i < count; i++) {
      const d = dialogs.nth(i);
      if (!(await d.isVisible().catch(() => false))) continue;
      const text = ((await d.innerText({ timeout: 2000 }).catch(() => '')) || '').slice(0, 600);
      if (WELCOME_TEXT.test(text) && !FORM_HINT.test(text)) { target = d; break; }
    }
    if (!target) return closedAny;
    closedAny = true;
    const x = target.getByRole('button', { name: CLOSE_NAME }).first();
    if (await x.isVisible().catch(() => false)) await x.click({ timeout: 2000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(900);
    if (await isDialogOpen(page)) await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
  }
  return closedAny;
}

export async function closeDialog(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(600);
  if (await isDialogOpen(page)) {
    const closeButton = page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: /^(zamknij|close|закрити|закрыть|anuluj|cancel|скасувати|отмена)$/i })
      .first();
    await closeButton.click({ timeout: 2000 }).catch(() => {});
  }
}


/**
 * Чекає на результат натискання «Приєднатися»: або відкриється анкета
 * (діалог), або стан групи зміниться (запит надіслано / вже в групі).
 * Facebook (особливо при слабкому інтернеті) реагує повільно, тому чекаємо
 * до timeoutMs, а не фіксований час, і щоразу повідомляємо в журналі, що
 * ще чекаємо.
 *
 * @returns {Promise<'dialog'|'pending'|'member'|'timeout'>}
 */
export async function waitForJoinOutcome(page, timeoutMs = 30000, onTick = () => {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextTick = startedAt + 8000;
  while (Date.now() < deadline) {
    if (await isDialogOpen(page)) return 'dialog';
    const state = await detectGroupState(page);
    if (state === 'pending' || state === 'member') return state;
    if (Date.now() >= nextTick) {
      onTick(Math.round((Date.now() - startedAt) / 1000));
      nextTick += 8000;
    }
    await page.waitForTimeout(500);
  }
  return 'timeout';
}

/**
 * Після відправлення анкети чекає, поки Facebook покаже підсумковий стан
 * («Скасувати запит» / «Ви в групі»). Повертає останній визначений стан.
 */
export async function waitForFinalState(page, timeoutMs = 25000, onTick = () => {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextTick = startedAt + 8000;
  let state = 'unknown';
  while (Date.now() < deadline) {
    state = await detectGroupState(page);
    if (state === 'pending' || state === 'member') return state;
    if (Date.now() >= nextTick) {
      onTick(Math.round((Date.now() - startedAt) / 1000));
      nextTick += 8000;
    }
    await page.waitForTimeout(600);
  }
  return state;
}

/**
 * Чекає, поки сторінка групи завантажиться настільки, що видно стан
 * (учасник / запит надіслано / можна вступити). Не здається швидко: при
 * слабкому інтернеті чекає до maxMs і регулярно повідомляє про очікування.
 * Виходить одразу, щойно стан визначено, або якщо Facebook перекинув на
 * сторінку входу/перевірки.
 *
 * @returns {Promise<'member'|'pending'|'canJoin'|'unknown'>}
 */
export async function waitForGroupState(page, maxMs = 45000, onTick = () => {}) {
  const startedAt = Date.now();
  const deadline = startedAt + maxMs;
  let nextTick = startedAt + 8000;
  while (Date.now() < deadline) {
    if (looksLikeLoginPage(page.url())) return 'unknown';
    const state = await detectGroupState(page);
    if (state !== 'unknown') return state;
    if (Date.now() >= nextTick) {
      onTick(Math.round((Date.now() - startedAt) / 1000));
      nextTick += 8000;
    }
    await page.waitForTimeout(700);
  }
  return 'unknown';
}

/**
 * Остаточна перевірка: оновлює сторінку й дивиться, чи стан групи
 * справді змінився (а не лише «намалювався» на екрані до відповіді
 * сервера). Повертає стан після оновлення.
 *
 * @returns {Promise<'member'|'pending'|'canJoin'|'unknown'>}
 */
export async function verifyAfterReload(page, onTick = () => {}) {
  await page.waitForTimeout(2000); // даємо запиту дійти до Facebook
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return waitForGroupState(page, 40000, onTick);
}

const FORM_NEXT_NAME = /^(prześlij|przeslij|wyślij|wyslij|submit|send|надіслати|відправити|отправить|dalej|next|далі|далее|gotowe|done|готово|dołącz|join|приєднатися)$/i;

/**
 * Заповнює анкету вступу автоматично:
 *  - ставить усі галочки (згода з правилами тощо);
 *  - у текстові поля вписує типову відповідь (якщо задана);
 *  - натискає «Надіслати»/«Далі» (форма може мати кілька кроків).
 * Питання з вибором (радіокнопки, списки) — обирає «так», інакше перший
 * варіант; якщо список не відкривається — повертає 'unsupported'.
 *
 * @returns {Promise<{result: 'submitted'|'unsupported'|'needsAnswer'|'stuck', checks: number, texts: number}>}
 */
export async function fillJoinForm(page, { answer = '' }) {
  let checks = 0;
  let texts = 0;
  if (await isLoggedOutPage(page)) return { result: 'loggedOut', checks, texts };

  for (let step = 0; step < 8; step++) {
    if (!(await isDialogOpen(page))) return { result: 'submitted', checks, texts };
    if (await dismissWelcomeDialog(page).catch(() => false)) continue;
    const dialog = page.getByRole('dialog').last();

    // Питання з вибором одного варіанта (радіокнопки): у кожній групі питань
    // обираємо варіант «так/yes/tak», а якщо такого немає — перший.
    const radios = dialog.getByRole('radio');
    const radioCount = await radios.count();
    const handledGroups = new Set();
    for (let index = 0; index < radioCount; index++) {
      const radio = radios.nth(index);
      if (!(await radio.isVisible().catch(() => false))) continue;
      const groupKey = await radio
        .evaluate((node) => {
          const g = node.closest('[role="radiogroup"]') || node.closest('fieldset') || node.parentElement?.parentElement?.parentElement;
          if (!g) return String(Math.random());
          if (!g.__fbgp) g.__fbgp = 'g' + Math.random().toString(36).slice(2);
          return g.__fbgp;
        })
        .catch(() => String(index));
      if (handledGroups.has(groupKey)) continue;
      handledGroups.add(groupKey);
      const siblings = await radio.evaluate((node) => {
        const g = node.closest('[role="radiogroup"]') || node.closest('fieldset') || node.parentElement?.parentElement?.parentElement;
        return g ? [...g.querySelectorAll('[role="radio"], input[type="radio"]')].map((n) => ({ checked: n.getAttribute('aria-checked') === 'true' || n.checked === true, text: (n.innerText || n.closest('label')?.innerText || n.getAttribute('aria-label') || '').trim() })) : [];
      }).catch(() => []);
      if (siblings.some((x) => x.checked)) continue;
      const group = radio.locator('xpath=ancestor::*[@role="radiogroup" or self::fieldset][1]');
      const options = (await group.count()) > 0 ? group.first().getByRole('radio') : radios;
      const total = await options.count();
      let pick = 0;
      for (let k = 0; k < Math.min(total, siblings.length); k++) {
        if (/^(tak|yes|так|да|zgadzam|agree|akceptuj)/i.test(siblings[k]?.text ?? '')) { pick = k; break; }
      }
      const target = options.nth(pick);
      try {
        await target.check({ timeout: 2500 });
      } catch {
        await target.click({ timeout: 2500, force: true }).catch(() => {});
      }
      checks++;
    }

    // Випадаючі списки: звичайний <select> та кастомний combobox/listbox.
    const nativeSelects = dialog.locator('select');
    const nativeCount = await nativeSelects.count();
    for (let index = 0; index < nativeCount; index++) {
      const select = nativeSelects.nth(index);
      if (!(await select.isVisible().catch(() => false))) continue;
      const value = await select.inputValue().catch(() => '');
      if (value) continue;
      await select.selectOption({ index: 1 }).catch(() => {});
      checks++;
    }
    const combos = dialog.getByRole('combobox');
    const comboCount = await combos.count();
    for (let index = 0; index < comboCount; index++) {
      const combo = combos.nth(index);
      if (!(await combo.isVisible().catch(() => false))) continue;
      const tag = await combo.evaluate((node) => node.tagName).catch(() => '');
      if (tag === 'SELECT') continue;
      const shown = ((await combo.innerText().catch(() => '')) || (await combo.inputValue().catch(() => ''))).trim();
      if (shown && !/^(wybierz|select|choose|обер|выбер)/i.test(shown)) continue;
      await combo.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(400);
      const option = page.getByRole('option').first();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 2500 }).catch(() => {});
        checks++;
      } else {
        await page.keyboard.press('Escape').catch(() => {});
        return { result: 'unsupported', checks, texts };
      }
    }

    // Галочки
    const boxes = dialog.getByRole('checkbox');
    const boxCount = await boxes.count();
    for (let index = 0; index < boxCount; index++) {
      const box = boxes.nth(index);
      if (!(await box.isVisible().catch(() => false))) continue;
      if (await box.isChecked().catch(() => false)) continue;
      try {
        await box.check({ timeout: 2500 });
      } catch {
        await box.click({ timeout: 2500 }).catch(() => {});
      }
      checks++;
    }

    // Текстові відповіді
    const fields = dialog.locator('textarea, input[type="text"], [role="textbox"]');
    const fieldCount = await fields.count();
    for (let index = 0; index < fieldCount; index++) {
      const field = fields.nth(index);
      if (!(await field.isVisible().catch(() => false))) continue;
      const current = ((await field.inputValue().catch(() => null)) ?? (await field.innerText().catch(() => ''))).trim();
      if (current) continue;
      if (!answer) return { result: 'needsAnswer', checks, texts };
      await field.fill(answer).catch(async () => {
        await field.click().catch(() => {});
        await page.keyboard.type(answer, { delay: 5 });
      });
      texts++;
    }

    // Кнопка «Надіслати» / «Далі»
    await page.waitForTimeout(500);
    const nextButton = await findVisibleButton(dialog, FORM_NEXT_NAME);
    if (!nextButton || !(await nextButton.isEnabled().catch(() => false))) {
      return { result: 'stuck', checks, texts };
    }
    await nextButton.click().catch(() => {});
    // Чекаємо, поки діалог закриється (форму надіслано) або зміниться крок
    for (let wait = 0; wait < 12; wait++) {
      await page.waitForTimeout(500);
      if (!(await isDialogOpen(page))) break;
    }
    await page.waitForTimeout(800);
  }

  return { result: (await isDialogOpen(page)) ? 'stuck' : 'submitted', checks, texts };
}

export function looksLikeLoginPage(url) {
  return /\/login|checkpoint|\/two_step_verification|recover/i.test(url);
}

/**
 * Вступає в групу (кнопка «Приєднатися до групи»), за потреби заповнює анкету
 * й підтверджує оновленням сторінки, що вступ справді збережено.
 *
 * @returns {Promise<{result:'member'|'pending'|'failed', reason?:string}>}
 *   reason (для 'failed'): formManual | joinFailed | joinNotSaved | joinUnconfirmed | noButton
 */
export async function joinGroupFlow(page, { autoForm, formAnswer, onLog, lang, current }) {
  const joinButton = await findVisibleButton(page, JOIN_NAME);
  if (!joinButton) return { result: 'failed', reason: 'noButton' };
  onLog(t(lang, 'subscribe.canJoin', { current }));
  await joinButton.scrollIntoViewIfNeeded().catch(() => {});
  await joinButton.click();
  onLog(t(lang, 'subscribe.clicked', { current }));
  const tick = (sec) => onLog(t(lang, 'subscribe.waitingConfirm', { current, seconds: sec }));
  await waitForJoinOutcome(page, 30000, tick);
  await dismissWelcomeDialog(page).catch(() => {});

  if (await isLoggedOutPage(page)) {
    onLog(t(lang, 'subscribe.sessionExpired'));
    return { result: 'failed', reason: 'session' };
  }
  if (await isDialogOpen(page)) {
    // Діалог без жодного поля вводу — це не анкета (привітання, правила, «ви вже
    // в групі»). Закриваємо його; якщо стан групи вже member/pending — анкети не було.
    const hasControls = await dialogHasControls(page);
    if (!hasControls) {
      await closeDialog(page);
    } else if (!autoForm) {
      onLog(t(lang, 'subscribe.needsAnswers', { current }));
      await closeDialog(page);
      return { result: 'failed', reason: 'formManual' };
    } else {
      onLog(t(lang, 'subscribe.formFilling', { current }));
      const form = await fillJoinForm(page, { answer: String(formAnswer ?? '').trim() });
      if (form.result === 'submitted') {
        onLog(t(lang, 'subscribe.formSubmitted', { current, checks: form.checks, texts: form.texts }));
      } else {
        await closeDialog(page);
        const st = await detectGroupState(page);
        if (st !== 'member' && st !== 'pending') {
          const key = {
            unsupported: 'subscribe.formUnsupported',
            needsAnswer: 'subscribe.formNeedsAnswer',
            stuck: 'subscribe.formStuck',
          }[form.result];
          if (key) onLog(t(lang, key, { current }));
          return { result: 'failed', reason: 'formManual' };
        }
      }
    }
  }

  await dismissWelcomeDialog(page).catch(() => {});
  const after = await waitForFinalState(page, 25000, tick);
  if (after === 'canJoin') return { result: 'failed', reason: 'joinFailed' };
  if (after !== 'member' && after !== 'pending') return { result: 'failed', reason: 'joinUnconfirmed' };

  onLog(t(lang, 'subscribe.verifying', { current }));
  const checked = await verifyAfterReload(page, (sec) =>
    onLog(t(lang, 'subscribe.stillLoading', { current, seconds: sec })),
  );
  if (checked === 'member' || checked === 'pending') {
    onLog(t(lang, 'subscribe.verified', { current }));
    return { result: checked };
  }
  if (checked === 'canJoin') {
    onLog(t(lang, 'subscribe.notPersisted', { current }));
    return { result: 'failed', reason: 'joinNotSaved' };
  }
  onLog(t(lang, 'subscribe.unverified', { current }));
  return { result: 'failed', reason: 'joinUnconfirmed' };
}
