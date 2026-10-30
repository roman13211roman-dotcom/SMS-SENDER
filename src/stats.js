/**
 * stats.js — лічильник успішно опублікованих постів за поточну добу.
 * Рахує ЛИШЕ успішні публікації (викликається з publisher.js тільки
 * після підтвердженого успіху, не при помилках/фейлах). Автоматично
 * скидається на 0 з настанням нової доби (00:00 за локальним часом) —
 * порівнює збережену дату з поточною при кожному читанні.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * @returns {string} поточна дата у форматі YYYY-MM-DD за локальним часом
 */
function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Читає поточний лічильник. Якщо збережена дата — не сьогоднішня,
 * повертає 0 (нова доба почалась, стара статистика не рахується).
 *
 * @param {string} statsPath - шлях до data/stats.json
 * @returns {Promise<number>}
 */
export async function loadDailyCount(statsPath) {
  try {
    const raw = await readFile(statsPath, 'utf-8');
    const data = JSON.parse(raw);
    return data.date === todayStr() ? (data.count ?? 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * Збільшує лічильник на 1 (з урахуванням скидання на нову добу) і
 * зберігає результат на диск.
 *
 * @param {string} statsPath - шлях до data/stats.json
 * @returns {Promise<number>} нове значення лічильника
 */
export async function incrementDailyCount(statsPath) {
  const current = await loadDailyCount(statsPath);
  const next = current + 1;
  await mkdir(path.dirname(statsPath), { recursive: true });
  await writeFile(statsPath, JSON.stringify({ date: todayStr(), count: next }, null, 2), 'utf-8');
  return next;
}
