/**
 * login.js — відкриває Facebook у видимому вікні Chromium,
 * дозволяє користувачу увійти вручну, і зберігає сесію (cookies)
 * у data/cookies.json, щоб повторний вхід не був потрібен.
 *
 * Логіка ідентична оригінальному Zaloguj.js — змінено лише:
 *  - require → import (ES Modules)
 *  - хардкод-шлях 'sesja.json' → параметризований шлях (data/cookies.json)
 *  - очікування Enter у консолі → очікування виклику confirmLogin()
 *    (викликається з GUI, коли користувач натисне "Я увійшов")
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { t } from './i18n.js';
import { launchChrome } from './chromeLauncher.js';

/**
 * Відкриває браузер для ручного логіну.
 * Повертає об'єкт з методами confirmLogin() та cancel(),
 * якими керує GUI (main process через IPC).
 *
 * @param {string} cookiesPath - шлях до файлу, куди зберегти сесію
 * @param {(msg: string) => void} onLog - callback для журналу виконання
 * @param {string} [lang] - мова інтерфейсу для повідомлень журналу ('uk' | 'en')
 * @returns {Promise<{ confirmLogin: () => Promise<void>, cancel: () => Promise<void> }>}
 */
export async function startLogin(cookiesPath, onLog = () => {}, lang = 'uk') {
  const browser = await launchChrome();

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });

  // Ukryj ślad automatyzacji przed załadowaniem strony
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  await page.goto('https://www.facebook.com');

  onLog(t(lang, 'login.openWindow'));

  const confirmLogin = async () => {
    await mkdir(path.dirname(cookiesPath), { recursive: true });
    await context.storageState({ path: cookiesPath });
    onLog(t(lang, 'login.sessionSaved'));
    await browser.close();
  };

  const cancel = async () => {
    await browser.close();
  };

  return { confirmLogin, cancel };
}
