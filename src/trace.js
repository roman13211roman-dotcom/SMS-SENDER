/**
 * trace.js — докладний запис дій для розбору проблем (окремо від журналу в
 * інтерфейсі). Пише:
 *  • trace/<акаунт>/<дата>.jsonl — по рядку JSON на подію (повний журнал,
 *    початок/кінець запуску, стан групи, докази, на підставі яких визначено
 *    результат, помилки зі стеком);
 *  • trace/<акаунт>/shots/<час>_<назва>.png/.txt — знімок екрана й видимий
 *    текст у ключових місцях (збій, невідомий результат, блокування тощо).
 * Куки, паролі й повний текст постів не записуються. Старі файли (>10 днів)
 * видаляються автоматично.
 */
import { mkdir, appendFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

const KEEP_DAYS = 30;
const MAX_SHOTS_PER_RUN = 1500;

export const noopTracer = {
  path: '',
  event() {},
  async snap() {},
  async close() {},
};

const pad = (n) => String(n).padStart(2, '0');
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function cleanOld(dir) {
  try {
    const now = Date.now();
    for (const name of await readdir(dir).catch(() => [])) {
      const full = path.join(dir, name);
      const info = await stat(full).catch(() => null);
      if (info && now - info.mtimeMs > KEEP_DAYS * 86400000) await rm(full, { recursive: true, force: true });
    }
  } catch { /* очищення не критичне */ }
}

export function createTracer({ dir, account, mode, version }) {
  if (!dir) return noopTracer;
  const accDir = path.join(dir, String(account));
  const shotsDir = path.join(accDir, 'shots');
  const file = path.join(accDir, `${dayKey()}.jsonl`);
  let queue = mkdir(shotsDir, { recursive: true }).catch(() => {});
  let shots = 0;
  const runId = Date.now().toString(36);

  const write = (record) => {
    queue = queue
      .then(() => appendFile(file, JSON.stringify({ t: new Date().toISOString(), run: runId, ...record }) + '\n'))
      .catch(() => {});
  };

  queue = queue.then(() => cleanOld(accDir)).then(() => cleanOld(shotsDir));
  write({ type: 'run.open', mode, version });

  return {
    path: file,
    event(type, data = {}) {
      write({ type, ...data });
    },
    async snap(name, page) {
      if (shots >= MAX_SHOTS_PER_RUN) return;
      shots++;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.join(shotsDir, `${stamp}_${name}`);
      let url = '';
      try {
        url = page.url();
        const text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 8000)).catch(() => '');
        await page.screenshot({ path: `${base}.png` }).catch(() => {});
        queue = queue.then(() => writeFile(`${base}.txt`, `${url}\n\n${text}`)).catch(() => {});
      } catch { /* знімок не повинен ламати роботу */ }
      write({ type: 'snap', name, url, file: path.basename(base) });
    },
    async close() {
      write({ type: 'run.close' });
      await queue;
    },
  };
}
