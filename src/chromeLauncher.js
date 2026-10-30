import { chromium } from 'playwright';

const launchOptions = {
  headless: false,
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled'],
};

/**
 * Uruchamia zainstalowany Google Chrome. Niektóre wersje Chrome na Windows
 * zamykają się natychmiast, gdy Playwright dodaje --no-startup-window.
 * W takim przypadku ponawiamy start bez tego jednego domyślnego argumentu.
 */
export async function launchChrome() {
  try {
    return await chromium.launch(launchOptions);
  } catch (firstError) {
    try {
      return await chromium.launch({
        ...launchOptions,
        ignoreDefaultArgs: ['--no-startup-window'],
      });
    } catch (retryError) {
      retryError.cause = firstError;
      throw retryError;
    }
  }
}
