/**
 * warmup.js — окремий режим «Прогрів» для НОВИХ акаунтів: автономна
 * активність (перегляд, лайки, підписки, коментарі), навантаження якої
 * автоматично росте за днями. Старі акаунти, що давно в роботі, цей режим
 * не потребують — для них є звичайна «Активність» зі своїми налаштуваннями.
 *
 * День 1–2:   лише перегляд і до 2 лайків
 * День 3–5:   лайки до 6
 * День 6–8:   + підписки на людей
 * День 9–11:  + рідкісні коментарі
 * День 12–14: трохи більше дій
 * День 15+:   прогрів завершено — акаунт готовий до публікацій і підписки на групи
 */

export const WARMUP_DAYS = 14;

const STAGES = [
  { from: 1, to: 2, likes: [0, 2], follows: [0, 0], comments: [0, 0], actionsPerDay: 6 },
  { from: 3, to: 5, likes: [2, 6], follows: [0, 0], comments: [0, 0], actionsPerDay: 15 },
  { from: 6, to: 8, likes: [3, 8], follows: [1, 3], comments: [0, 0], actionsPerDay: 25 },
  { from: 9, to: 11, likes: [3, 8], follows: [1, 4], comments: [0, 1], actionsPerDay: 40 },
  { from: 12, to: 14, likes: [3, 10], follows: [2, 5], comments: [0, 2], actionsPerDay: 60 },
];


function localMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function todayKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * @param {string} startDate - "YYYY-MM-DD" (локальна дата старту прогріву)
 * @returns {null | {day:number, done:true} | (object & {day:number, done:false})}
 */
export function getWarmup(startDate, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startDate ?? ''));
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const day = Math.floor((localMidnight(now) - localMidnight(start)) / 86_400_000) + 1;
  if (day < 1) return { day: 1, done: false, ...STAGES[0] };
  if (day > WARMUP_DAYS) return { day, done: true };
  const stage = STAGES.find((s) => day >= s.from && day <= s.to);
  return { day, done: false, ...stage };
}

/** Налаштування активності для поточного дня прогріву. */
export function stageActivity(warm, commentTexts = []) {
  // порожній список → runActivity підставить стандартні короткі коментарі
  const range = ([, max]) => [Math.floor(max / 2), max];
  const [likesMin, likesMax] = range(warm.likes);
  const [followsMin, followsMax] = range(warm.follows);
  const commentsMax = warm.comments[1];
  return {
    durMin: 8,
    durMax: 15,
    pauseMin: 40,
    pauseMax: 90,
    likesMin,
    likesMax,
    followsMin,
    followsMax,
    commentsMin: 0,
    commentsMax,
    commentTexts,
    dailyLimit: warm.actionsPerDay,
    visitGroups: true,
    openPosts: true,
  };
}
