import { createLogger } from '@src/background/log';
import { type KeyInput } from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { PageDriver } from './pageDriver';
import { isUrlAllowed } from './util';
import { URLNotAllowedError } from './views';

const logger = createLogger('Page');

export async function navigateTo(driver: PageDriver, url: string): Promise<void> {
  if (!driver.puppeteer) {
    return;
  }
  logger.info('navigateTo', url);

  // Check if URL is allowed
  if (!isUrlAllowed(url, driver.config.allowedUrls, driver.config.deniedUrls)) {
    throw new URLNotAllowedError(`URL: ${url} is not allowed`);
  }

  try {
    await Promise.all([driver.page.waitForPageAndFramesLoad(), driver.puppeteer.goto(url)]);
    logger.info('navigateTo complete');
  } catch (error) {
    if (error instanceof URLNotAllowedError) {
      throw error;
    }

    if (error instanceof Error && error.message.includes('timeout')) {
      logger.warning('Navigation timeout, but page might still be usable:', error);
      return;
    }

    logger.error('Navigation failed:', error);
    throw error;
  }
}

export async function refreshPage(driver: PageDriver): Promise<void> {
  if (!driver.puppeteer) return;

  try {
    await Promise.all([driver.page.waitForPageAndFramesLoad(), driver.puppeteer.reload()]);
    logger.info('Page refresh complete');
  } catch (error) {
    if (error instanceof URLNotAllowedError) {
      throw error;
    }

    if (error instanceof Error && error.message.includes('timeout')) {
      logger.warning('Refresh timeout, but page might still be usable:', error);
      return;
    }

    logger.error('Page refresh failed:', error);
    throw error;
  }
}

export async function goBack(driver: PageDriver): Promise<void> {
  if (!driver.puppeteer) return;

  try {
    await Promise.all([driver.page.waitForPageAndFramesLoad(), driver.puppeteer.goBack()]);
    logger.info('Navigation back completed');
  } catch (error) {
    if (error instanceof URLNotAllowedError) {
      throw error;
    }

    if (error instanceof Error && error.message.includes('timeout')) {
      logger.warning('Back navigation timeout, but page might still be usable:', error);
      return;
    }

    logger.error('Could not navigate back:', error);
    throw error;
  }
}

export async function goForward(driver: PageDriver): Promise<void> {
  if (!driver.puppeteer) return;

  try {
    await Promise.all([driver.page.waitForPageAndFramesLoad(), driver.puppeteer.goForward()]);
    logger.info('Navigation forward completed');
  } catch (error) {
    if (error instanceof URLNotAllowedError) {
      throw error;
    }

    if (error instanceof Error && error.message.includes('timeout')) {
      logger.warning('Forward navigation timeout, but page might still be usable:', error);
      return;
    }

    logger.error('Could not navigate forward:', error);
    throw error;
  }
}

export async function sendKeys(driver: PageDriver, keys: string): Promise<void> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer page is not connected');
  }

  // Split combination keys (e.g., "Control+A" or "Shift+ArrowLeft")
  const keyParts = keys.split('+');
  const modifiers = keyParts.slice(0, -1);
  const mainKey = keyParts[keyParts.length - 1];

  // Press modifiers and main key, ensure modifiers are released even if an error occurs.
  try {
    // Press all modifier keys (e.g., Control, Shift, etc.)
    for (const modifier of modifiers) {
      await driver.puppeteer.keyboard.down(convertKey(modifier));
    }
    // Press the main key
    // also wait for stable state
    await Promise.all([driver.puppeteer.keyboard.press(convertKey(mainKey)), driver.page.waitForPageAndFramesLoad()]);
    logger.info('sendKeys complete', keys);
  } catch (error) {
    logger.error('Failed to send keys:', error);
    throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Release all modifier keys in reverse order regardless of any errors in key press.
    for (const modifier of [...modifiers].reverse()) {
      try {
        await driver.puppeteer.keyboard.up(convertKey(modifier));
      } catch (releaseError) {
        logger.error('Failed to release modifier:', modifier, releaseError);
      }
    }
  }
}

export function convertKey(key: string): KeyInput {
  const lowerKey = key.trim().toLowerCase();
  const isMac = navigator.userAgent.toLowerCase().includes('mac os x');

  if (isMac) {
    if (lowerKey === 'control' || lowerKey === 'ctrl') {
      return 'Meta' as KeyInput; // Use Command key on Mac
    }
    if (lowerKey === 'command' || lowerKey === 'cmd') {
      return 'Meta' as KeyInput; // Map Command/Cmd to Meta on Mac
    }
    if (lowerKey === 'option' || lowerKey === 'opt') {
      return 'Alt' as KeyInput; // Map Option/Opt to Alt on Mac
    }
  }

  const keyMap: { [key: string]: string } = {
    // Letters
    a: 'KeyA',
    b: 'KeyB',
    c: 'KeyC',
    d: 'KeyD',
    e: 'KeyE',
    f: 'KeyF',
    g: 'KeyG',
    h: 'KeyH',
    i: 'KeyI',
    j: 'KeyJ',
    k: 'KeyK',
    l: 'KeyL',
    m: 'KeyM',
    n: 'KeyN',
    o: 'KeyO',
    p: 'KeyP',
    q: 'KeyQ',
    r: 'KeyR',
    s: 'KeyS',
    t: 'KeyT',
    u: 'KeyU',
    v: 'KeyV',
    w: 'KeyW',
    x: 'KeyX',
    y: 'KeyY',
    z: 'KeyZ',

    // Numbers
    '0': 'Digit0',
    '1': 'Digit1',
    '2': 'Digit2',
    '3': 'Digit3',
    '4': 'Digit4',
    '5': 'Digit5',
    '6': 'Digit6',
    '7': 'Digit7',
    '8': 'Digit8',
    '9': 'Digit9',

    // Special keys
    control: 'Control',
    shift: 'Shift',
    alt: 'Alt',
    meta: 'Meta',
    enter: 'Enter',
    backspace: 'Backspace',
    delete: 'Delete',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    escape: 'Escape',
    tab: 'Tab',
    space: 'Space',
  };

  const convertedKey = keyMap[lowerKey] || key;
  logger.info('convertedKey', convertedKey);
  return convertedKey as KeyInput;
}
