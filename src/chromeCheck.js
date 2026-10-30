/**
 * chromeCheck.js — перевіряє, чи встановлений у системі Google Chrome.
 * Це потрібно, оскільки login.js/publisher.js запускають браузер через
 * channel: 'chrome' (справжній Chrome, а не Playwright-Chromium) —
 * якщо Chrome не встановлений, про це варто повідомити користувача
 * зрозуміло, а не давати застосунку впасти з незрозумілою помилкою.
 */
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

// Типові шляхи встановлення Google Chrome у Windows.
function getWindowsChromePaths() {
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';

  return [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  ].filter(Boolean);
}

/**
 * @returns {Promise<boolean>} true, якщо Chrome знайдено в одному з типових шляхів
 */
export async function isChromeInstalled() {
  const candidates =
    process.platform === 'win32'
      ? getWindowsChromePaths()
      : ['/Applications/Google Chrome.app', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return true;
    } catch {
      // пробуємо наступний шлях
    }
  }
  return false;
}

export const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';
