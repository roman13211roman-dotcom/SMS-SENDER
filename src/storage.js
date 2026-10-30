/**
 * storage.js — збереження та завантаження налаштувань застосунку
 * (текст поста, список груп) у data/config.json.
 * Автоматично викликається при кожній зміні полів у GUI, тому
 * користувачу не потрібно нічого зберігати вручну.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const MAX_ACCOUNTS = 10;

const DEFAULT_CONFIG = {
  language: 'uk',
  // Список акаунтів (до MAX_ACCOUNTS). Кожен акаунт має власну сесію
  // Facebook, текст, групи, зображення, час старту та затримку між постами.
  accounts: [],
  activeAccountId: null,
};

/**
 * Створює порожній акаунт зі значеннями за замовчуванням.
 * @param {string} id
 * @param {string} name
 */
export function createAccount(id, name) {
  return {
    id,
    name,
    text: '',
    groups: [],
    imagePath: '',
    startTime: '', // "HH:MM" або порожньо — старт одразу
    delayMinSec: 3,
    delayMaxSec: 5,
    mode: 'publish', // 'publish' | 'subscribe'
    dailyJoinLimit: 20, // 0 — без ліміту
    autoForm: true, // автозаповнення анкети вступу
    formAnswer: '', // відповідь на текстові запитання анкети
    activity: {
      durMin: 10,
      durMax: 20,
      pauseMin: 30,
      pauseMax: 90,
      likesMin: 2,
      likesMax: 6,
      followsMin: 1,
      followsMax: 3,
      commentsMin: 0,
      commentsMax: 1,
      commentTexts: '',
      dailyLimit: 0,
      visitGroups: true,
      openPosts: true,
    },
  };
}

/**
 * @param {string} configPath - шлях до data/config.json
 */
export async function loadConfig(configPath) {
  try {
    const raw = await readFile(configPath, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    // Файлу ще немає або він пошкоджений — повертаємо значення за замовчуванням
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * @param {string} configPath - шлях до data/config.json
 * @param {object} config - об'єкт налаштувань для збереження
 */
export async function saveConfig(configPath, config) {
  await mkdir(path.dirname(configPath), { recursive: true });
  const current = await loadConfig(configPath);
  await writeFile(configPath, JSON.stringify({ ...current, ...config }, null, 2), 'utf-8');
}
