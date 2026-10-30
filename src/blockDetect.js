/**
 * blockDetect.js — виявлення блокувань і перевірок безпеки Facebook
 * (чекпойнт, капча, «тимчасово обмежено», «дію заблоковано», відключений акаунт).
 *
 * Перевіряються: адреса сторінки, текст діалогових вікон і (якщо сторінка
 * коротка, тобто це повноекранна заглушка) увесь текст сторінки. Звичайні
 * пости в стрічці не аналізуються, щоб не було хибних спрацювань.
 */

export class BlockedError extends Error {
  constructor(reason) {
    super(`blocked: ${reason}`);
    this.name = 'BlockedError';
    this.reason = reason;
  }
}

const URL_RULES = [
  [/account_disabled|disabled_account|\/disabled/i, 'disabled'],
  [/captcha/i, 'captcha'],
  [/checkpoint|two_step_verification|confirmidentity|login\/identify|\/help\/contact\/\d+.*restrict/i, 'checkpoint'],
];

// Порядок важливий: перше збіг — причина.
const TEXT_RULES = [
  [
    'disabled',
    /your account (has been|was|is) (disabled|suspended)|we suspended your account|we('| ha)ve disabled your account|twoje konto zosta(ło|ł) (zawieszone|wyłączone|dezaktywowane)|zawiesiliśmy twoje konto|ваш обліковий запис (призупинено|вимкнено|відключено)|ваш аккаунт (отключ|заблокирован|приостановлен)/i,
  ],
  [
    'captcha',
    /security check|i'?m not a robot|nie jestem robotem|sprawdzenie zabezpiecze[ńn]|перевірка безпеки|я не робот|проверка безопасности|я не робот/i,
  ],
  [
    'checkpoint',
    /confirm your identity|we need to confirm|potwierd[źz] swoj[ąa] to[żz]samo[śs][ćc]|zablokowali[śs]my twoje konto|your account is (temporarily )?locked|підтвердьте свою особу|підтвердіть свою особу|подтвердите вашу личность|ваш обліковий запис заблоковано|аккаунт временно заблокирован/i,
  ],
  [
    'restricted',
    /temporarily (blocked|restricted)|ta funkcja jest tymczasowo|tymczasowo (zablokowan|ograniczon)|akcja zosta[ła]a zablokowana|this action was blocked|action blocked|we limit how often you can|ograniczamy cz[ęe]stotliwo[śs][ćc]|zbyt szybki, niewłaściwy|możliwość korzystania przez ciebie z tej funkcji|you.re temporarily blocked|misusing this feature|too fast|ця функція (тимчасово )?заблокована|надто швидко|ця дія (тимчасово )?заблокована|тимчасово (заблоковано|обмежено|обмежен)|ми обмежуємо|эта функция (временно )?заблокирована|слишком быстро|действие (временно )?заблокировано|временно ограничен|мы ограничиваем/i,
  ],
];

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<'checkpoint'|'captcha'|'restricted'|'disabled'|null>}
 */
export async function detectBlock(page) {
  try {
    const url = page.url();
    for (const [pattern, reason] of URL_RULES) {
      if (pattern.test(url)) return reason;
    }
    const text = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .map((node) => node.innerText || '')
        .join('\n');
      const body = document.body?.innerText ?? '';
      return dialogs + '\n' + (body.length < 2500 ? body : '');
    });
    for (const [reason, pattern] of TEXT_RULES) {
      if (pattern.test(text)) return reason;
    }
  } catch {
    // сторінка могла перейти на іншу адресу під час перевірки — це не блокування
  }
  return null;
}

/** Кидає BlockedError, якщо на сторінці видно блокування. */
export async function assertNotBlocked(page) {
  const reason = await detectBlock(page);
  if (reason) throw new BlockedError(reason);
}
