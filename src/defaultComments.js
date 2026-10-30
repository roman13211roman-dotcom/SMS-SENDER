/**
 * defaultComments.js — стандартні короткі коментарі, коли користувач не
 * задав власних варіантів. Здебільшого мовно-нейтральні (емодзі) та
 * найпростіші фрази, щоб не потрапити не в мову допису.
 */
export const DEFAULT_COMMENTS = [
  '👍',
  '👏',
  '🔥',
  '❤️',
  '👌',
  '🙂',
  '👍👍',
  '💪',
  '+',
  'Super 👍',
  'Thanks!',
  'Dzięki 👍',
  'Дякую 👍',
  'Nice 👌',
];

export function withDefaultComments(list) {
  const clean = (list ?? []).filter(Boolean);
  return clean.length > 0 ? clean : DEFAULT_COMMENTS;
}
