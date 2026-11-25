import { createLogger } from '@src/background/log';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Frame } from 'puppeteer-core/lib/esm/puppeteer/api/Frame.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { DOMElementNode } from './dom/views';
import type { PageDriver } from './pageDriver';

const logger = createLogger('Page');

export function allSearchContexts(driver: PageDriver): Array<PuppeteerPage | Frame> {
  if (!driver.puppeteer) return [];
  const contexts: Array<PuppeteerPage | Frame> = [driver.puppeteer];
  const mainFrame = typeof driver.puppeteer.mainFrame === 'function' ? driver.puppeteer.mainFrame() : null;
  const frames = typeof driver.puppeteer.frames === 'function' ? driver.puppeteer.frames() : [];
  for (const frame of frames) {
    if (frame && frame !== mainFrame && !contexts.includes(frame)) contexts.push(frame);
  }
  return contexts;
}

export async function resolveElementFrame(
  driver: PageDriver,
  element?: DOMElementNode,
): Promise<PuppeteerPage | Frame | null> {
  if (!driver.puppeteer) return null;
  if (!element) return driver.puppeteer;
  let currentFrame: PuppeteerPage | Frame = driver.puppeteer;

  const parents: DOMElementNode[] = [];
  let current: DOMElementNode | null = element;
  while (current.parent) {
    parents.push(current.parent);
    current = current.parent;
  }

  const iframes = parents.reverse().filter(item => item.tagName?.toLowerCase() === 'iframe');
  for (const parent of iframes) {
    const cssSelector = parent.enhancedCssSelectorForElement(driver.config.includeDynamicAttributes);
    let frameElement: ElementHandle | null = await currentFrame.$(cssSelector);
    if (!frameElement && parent.xpath) {
      const fullXpath = parent.xpath.startsWith('/') ? parent.xpath : `/${parent.xpath}`;
      frameElement = await currentFrame.$(`::-p-xpath(${fullXpath})`).catch(() => null);
    }
    let frame: Frame | null = frameElement ? await frameElement.contentFrame() : null;
    if (frameElement) await frameElement.dispose().catch(() => undefined);
    if (!frame && typeof driver.puppeteer.frames === 'function') {
      const src = parent.attributes?.src || '';
      const name = parent.attributes?.name || parent.attributes?.id || '';
      const frames = driver.puppeteer.frames();
      frame =
        frames.find(
          f =>
            (src && typeof f.url === 'function' && f.url().includes(src)) ||
            (name && typeof f.name === 'function' && f.name() === name),
        ) ?? null;
    }
    if (!frame) {
      logger.warning(`Could not access frame content for selector: ${cssSelector}`);
      return null;
    }
    currentFrame = frame;
    logger.info('currentFrame changed', currentFrame);
  }
  return currentFrame;
}

export async function locateElement(driver: PageDriver, element: DOMElementNode, scroll = true): Promise<ElementHandle | null> {
  if (!driver.puppeteer) {
    // throw new Error('Puppeteer page is not connected');
    logger.warning('Puppeteer is not connected');
    return null;
  }
  const currentFrame = await resolveElementFrame(driver, element);
  if (!currentFrame) {
    return null;
  }

  // 整页填写给控件打的稳定标记：区块增删后编号和路径会变，标记不会。
  const tagged = element.attributes['data-qz-field'];
  if (tagged && /^q\d+$/.test(tagged)) {
    const contexts = currentFrame === driver.puppeteer ? allSearchContexts(driver) : [currentFrame];
    for (const ctx of contexts) {
      const handle = await ctx.$(`[data-qz-field="${tagged}"]`);
      if (handle) {
        if (scroll && !(await handle.isHidden())) await driver.scrollIntoView(handle);
        return handle;
      }
    }
    return null;
  }

  const cssSelector = element.enhancedCssSelectorForElement(driver.config.includeDynamicAttributes);

  try {
    // Try CSS selector first
    let elementHandle: ElementHandle | null = await currentFrame.$(cssSelector);

    // If CSS selector failed, try XPath
    if (!elementHandle) {
      const xpath = element.xpath;
      if (xpath) {
        try {
          logger.info('Trying XPath selector:', xpath);
          const fullXpath = xpath.startsWith('/') ? xpath : `/${xpath}`;
          const xpathSelector = `::-p-xpath(${fullXpath})`;
          elementHandle = await currentFrame.$(xpathSelector);
          if (!elementHandle && (fullXpath === '/body' || fullXpath.startsWith('/body/'))) {
            elementHandle = await currentFrame.$(`::-p-xpath(/html${fullXpath})`).catch(() => null);
          }
        } catch (xpathError) {
          logger.error('Failed to locate element using XPath:', xpathError);
        }
      }
    }

    // If element found, check visibility and scroll into view
    if (elementHandle) {
      const isHidden = await elementHandle.isHidden();
      if (scroll && !isHidden) {
        await driver.scrollIntoView(elementHandle);
      }
      return elementHandle;
    }

    logger.info('elementHandle not located');
  } catch (error) {
    logger.error('Failed to locate element:', error);
  }

  return null;
}

/**
 * Wait for an element to become stable (no position/size changes)
 * Similar to Playwright's wait_for_element_state('stable')
 */

export async function waitForElementStability(element: ElementHandle, timeout = 1000): Promise<void> {
  const startTime = Date.now();
  let lastRect = await element.boundingBox();

  while (Date.now() - startTime < timeout) {
    // Wait a short time
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get current position and size
    const currentRect = await element.boundingBox();

    // If element is no longer in DOM or not visible
    if (!currentRect) {
      break;
    }

    // Compare with previous position/size
    if (
      lastRect &&
      Math.abs(lastRect.x - currentRect.x) < 2 &&
      Math.abs(lastRect.y - currentRect.y) < 2 &&
      Math.abs(lastRect.width - currentRect.width) < 2 &&
      Math.abs(lastRect.height - currentRect.height) < 2
    ) {
      // Position is stable - wait a bit more to be sure and then return
      await new Promise(resolve => setTimeout(resolve, 50));
      return;
    }

    // Update last position
    lastRect = currentRect;
  }

  // If we got here, either the element stabilized or we timed out
  logger.debug('Element stability check completed (timeout or stable)');
}

export async function scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
  const startTime = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check if element is in viewport
    const isVisible = await element.evaluate(el => {
      const rect = el.getBoundingClientRect();

      // Check if element has size
      if (rect.width === 0 || rect.height === 0) return false;

      // Check if element is hidden
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        return false;
      }

      // Check if element is in viewport
      const isInViewport =
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth);

      if (!isInViewport) {
        // Scroll into view if not visible
        el.scrollIntoView({
          behavior: 'auto',
          block: 'center',
          inline: 'center',
        });
        return false;
      }

      return true;
    });

    if (isVisible) break;

    // Check timeout - log warning and return instead of throwing
    if (Date.now() - startTime > timeout) {
      logger.warning('Timed out while trying to scroll element into view, continuing anyway');
      break;
    }

    // Small delay before next check
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
