/**
 * textVariants.js — різноманітність текстів публікацій.
 *
 *  - Кілька варіантів тексту розділяються рядком з трьох дефісів: ---
 *  - Усередині тексту можна писати підстановки {привіт|вітаю|добрий день};
 *    вони можуть бути вкладеними: {a|b {c|d}}.
 *  - Кожна група отримує випадковий варіант (без повтору підряд, поки є вибір),
 *    у якому підстановки розкриті випадково.
 */

export function splitVariants(text) {
  const parts = String(text ?? '')
    .split(/^\s*---\s*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [''];
}

/** Розкриває підстановки {a|b|c} (з вкладеністю). */
export function spin(text) {
  let result = String(text);
  const innermost = /\{([^{}]*)\}/;
  for (let guard = 0; guard < 500; guard++) {
    const match = innermost.exec(result);
    if (!match) break;
    const options = match[1].split('|');
    const choice = options[Math.floor(Math.random() * options.length)];
    result = result.slice(0, match.index) + choice + result.slice(match.index + match[0].length);
  }
  return result;
}

/** Повертає функцію, що видає випадковий варіант без повтору підряд. */
export function createPicker(variants) {
  let last = -1;
  return () => {
    if (variants.length === 1) return spin(variants[0]);
    let index;
    do {
      index = Math.floor(Math.random() * variants.length);
    } while (index === last);
    last = index;
    return spin(variants[index]);
  };
}

export function previewText(text) {
  const variants = splitVariants(text);
  return { count: variants.length, sample: spin(variants[Math.floor(Math.random() * variants.length)]) };
}
