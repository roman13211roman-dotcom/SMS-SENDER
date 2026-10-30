/**
 * logger.js — записує повідомлення журналу у файл на диску,
 * окремим файлом на кожен день: data/logs/YYYY-MM-DD.log.
 * Використовується разом із виведенням у GUI (не замінює його).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Створює функцію логування, прив'язану до конкретної папки логів.
 * @param {string} logsDir - шлях до data/logs
 * @returns {(message: string) => Promise<void>}
 */
export function createFileLogger(logsDir) {
  return async function logToFile(message) {
    try {
      await mkdir(logsDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filePath = path.join(logsDir, `${today}.log`);
      const timestamp = new Date().toISOString();
      await appendFile(filePath, `[${timestamp}] ${message}\n`, 'utf-8');
    } catch {
      // Помилка запису логу не повинна зупиняти роботу застосунку —
      // журнал у GUI все одно покаже повідомлення.
    }
  };
}
