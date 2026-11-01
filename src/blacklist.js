/**
 * blacklist.js — ПОСТІЙНИЙ чорний список груп.
 *
 * Правила (за вимогою користувача):
 *  - група, потрапивши до списку, залишається там назавжди;
 *  - у модуля НЕМАЄ жодної функції видалення чи зміни запису — лише add/has/list;
 *  - список зберігається одразу в кількох файлах (основний + дві резервні копії,
 *    одна з них поза папкою data). При завантаженні всі файли об'єднуються, тому
 *    якщо один із них видалено чи пошкоджено — список відновлюється з решти;
 *  - запис атомарний (тимчасовий файл + перейменування).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

/** Ключ групи: 'groups/<id або назва>' у нижньому регістрі, або null. */
export function groupKey(url) {
  const m = /facebook\.com\/groups\/([^/?#\s]+)/i.exec(String(url ?? ''));
  return m ? `groups/${decodeURIComponent(m[1]).toLowerCase()}` : null;
}

/** Канонічна адреса групи без хвоста (/my_posted_content, ?ref=… тощо). */
export function groupBaseUrl(url) {
  const m = /facebook\.com\/groups\/([^/?#\s]+)/i.exec(String(url ?? ''));
  return m ? `https://www.facebook.com/groups/${m[1]}` : null;
}

async function readEntries(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const list = data && typeof data === 'object' ? data.groups : null;
    return list && typeof list === 'object' ? list : {};
  } catch {
    return {};
  }
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/**
 * @param {string[]} files - основний файл і резервні копії (мінімум один)
 */
export function createBlacklist(files) {
  const entries = new Map(); // key -> { url, reason, at, account, counts }
  let loaded = false;
  let chain = Promise.resolve();

  async function load() {
    for (const file of files) {
      const stored = await readEntries(file);
      for (const [key, value] of Object.entries(stored)) {
        if (!entries.has(key)) entries.set(key, value);
      }
    }
    loaded = true;
    // Відновлюємо всі копії: якщо якийсь файл було видалено — він з'явиться знову.
    if (entries.size > 0) await persist();
    return entries.size;
  }

  async function persist() {
    const body = JSON.stringify({ version: 1, groups: Object.fromEntries(entries) }, null, 2);
    for (const file of files) {
      await writeAtomic(file, body).catch(() => {});
    }
  }

  return {
    load,
    has(url) {
      const key = groupKey(url);
      return key ? entries.has(key) : false;
    },
    get(url) {
      const key = groupKey(url);
      return key ? (entries.get(key) ?? null) : null;
    },
    /** Додає групу. Якщо вона вже в списку — запис НЕ змінюється. */
    add(url, info = {}) {
      const key = groupKey(url);
      if (!key) return Promise.resolve(false);
      if (entries.has(key)) return Promise.resolve(false);
      entries.set(key, {
        url: groupBaseUrl(url),
        reason: info.reason ?? 'unknown',
        account: info.account ?? '',
        counts: info.counts ?? null,
        at: Date.now(),
      });
      chain = chain.then(persist, persist);
      return chain.then(() => true);
    },
    /** Повне очищення списку (кнопка «Обнулити»): очищає пам'ять і всі файли-копії. */
    clear() {
      entries.clear();
      chain = chain.then(persist, persist);
      return chain.then(() => true);
    },
    /** Пакетне додавання (один запис на диск). Існуючі записи не змінюються. */
    addMany(items) {
      let added = 0;
      for (const item of items) {
        const key = groupKey(item.url);
        if (!key || entries.has(key)) continue;
        entries.set(key, {
          url: groupBaseUrl(item.url),
          reason: item.reason ?? 'unknown',
          account: item.account ?? '',
          counts: item.counts ?? null,
          at: item.at ?? Date.now(),
        });
        added++;
      }
      if (added === 0) return Promise.resolve(0);
      chain = chain.then(persist, persist);
      return chain.then(() => added);
    },
    list() {
      return [...entries.entries()].map(([key, value]) => ({ key, ...value }));
    },
    get size() {
      return entries.size;
    },
    get loaded() {
      return loaded;
    },
    files,
  };
}

/** Список «Групи в роботу» — групи, де пости проходять (та сама надійна схема зберігання). */
export const createWorklist = createBlacklist;
