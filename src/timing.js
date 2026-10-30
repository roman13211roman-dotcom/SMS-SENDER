/**
 * timing.js — спільні функції очікування для публікації та підписки:
 * випадкова затримка, очікування до заданого часу старту, пауза/зупинка.
 */
const PAUSE_POLL_MS = 500;

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Випадкова затримка в межах [minSec, maxSec] (секунди).
 * Якщо межі однакові — затримка фіксована.
 */
export function randomDelayMs(minSec, maxSec) {
  const lo = Math.max(0, Math.min(minSec, maxSec));
  const hi = Math.max(minSec, maxSec);
  return (lo + Math.random() * (hi - lo)) * 1000;
}

export function formatClock(timestamp) {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Чекає до вказаного моменту (timestamp, мс). Можна перервати кнопкою
 * "Зупинити". Повертає true, якщо дочекались; false — якщо зупинено.
 */
export async function waitUntilStart(startAt, shouldStop) {
  while (Date.now() < startAt) {
    if (shouldStop()) return false;
    await sleep(Math.min(1000, Math.max(50, startAt - Date.now())));
  }
  return !shouldStop();
}

/**
 * Чекає, поки користувач не зніме паузу (опитує shouldPause() кожні
 * PAUSE_POLL_MS). Перевіряє також shouldStop(), щоб можна було вийти
 * з паузи одразу натисканням "Зупинити".
 */
export async function waitWhilePaused(shouldPause, shouldStop) {
  while (shouldPause() && !shouldStop()) {
    await sleep(PAUSE_POLL_MS);
  }
}

/**
 * Затримка між діями, яку можна перервати ("Зупинити") і яка
 * враховує паузу.
 */
export async function waitWithStop(ms, shouldPause, shouldStop) {
  const end = Date.now() + ms;
  while (Date.now() < end && !shouldStop()) {
    await sleep(Math.min(500, Math.max(50, end - Date.now())));
  }
  await waitWhilePaused(shouldPause, shouldStop);
}
