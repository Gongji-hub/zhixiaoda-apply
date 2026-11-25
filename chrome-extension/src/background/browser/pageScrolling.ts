import { createLogger } from '@src/background/log';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { DOMElementNode } from './dom/views';
import type { PageDriver } from './pageDriver';

const logger = createLogger('Page');

// Get scroll position information for a specific element.

export async function getElementScrollInfo(
  driver: PageDriver,
  elementNode: DOMElementNode,
): Promise<[number, number, number]> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }

  const element = await driver.page.locateElement(elementNode);
  if (!element) {
    throw new Error(`Element: ${elementNode} not found`);
  }

  // Find the nearest scrollable ancestor
  const scrollableElement = await findNearestScrollableElement(driver, element);
  if (!scrollableElement) {
    throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
  }

  const scrollInfo = await scrollableElement.evaluate(el => {
    return {
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    };
  });

  return [scrollInfo.scrollTop, scrollInfo.clientHeight, scrollInfo.scrollHeight];
}

/**
 * Find the nearest scrollable ancestor of the given element
 * @param element The element to start searching from
 * @returns The nearest scrollable ancestor or null if none found
 */

export async function findNearestScrollableElement(
  driver: PageDriver,
  element: ElementHandle,
): Promise<ElementHandle | null> {
  if (!driver.puppeteer) {
    return null;
  }

  // Check if the current element is scrollable
  const isScrollable = await element.evaluate((el: Element) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
    const canScrollVertically =
      style.overflowY === 'scroll' ||
      style.overflowY === 'auto' ||
      style.overflow === 'scroll' ||
      style.overflow === 'auto';

    return hasVerticalScrollbar && canScrollVertically;
  });

  if (isScrollable) {
    return element;
  }

  // Check parent elements
  let currentElement: ElementHandle<Element> | null = element;

  try {
    while (currentElement) {
      // Get the parent element (as an ElementHandle) of the current element
      const parentHandle = (await currentElement.evaluateHandle(
        (el: Element) => el.parentElement,
      )) as ElementHandle<Element> | null;

      const parentElement = parentHandle ? await parentHandle.asElement() : null;

      if (!parentElement) {
        // Reached the root without finding a scrollable ancestor
        currentElement = null;
        break;
      }

      const parentIsScrollable = await parentElement.evaluate((el: Element) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
        const canScrollVertically =
          ['scroll', 'auto'].includes(style.overflowY) || ['scroll', 'auto'].includes(style.overflow);

        return hasVerticalScrollbar && canScrollVertically;
      });

      if (parentIsScrollable) {
        // Found a scrollable ancestor – return it (the caller should dispose when finished)
        return parentElement;
      }

      // Move up the DOM tree – dispose the previous element handle before continuing
      if (currentElement !== element) {
        try {
          await currentElement.dispose();
        } catch (disposeErr) {
          logger.debug('Failed to dispose element handle:', disposeErr);
        }
      }

      currentElement = parentElement;
    }
  } catch (error) {
    // Error accessing parent, break out of loop
    logger.error('Error finding scrollable parent:', error);
  }

  // If no scrollable ancestor found, return the document body or documentElement
  try {
    const bodyElement = await driver.puppeteer.$('body');
    if (bodyElement) {
      const bodyIsScrollable = await bodyElement.evaluate(el => {
        if (!(el instanceof HTMLElement)) return false;
        return el.scrollHeight > el.clientHeight;
      });
      if (bodyIsScrollable) {
        return bodyElement;
      }
    }

    // Last resort: return document element for page-level scrolling
    const documentElement = await driver.puppeteer.evaluateHandle(() => document.documentElement);
    const docElement = (await documentElement.asElement()) as ElementHandle<Element> | null;
    return docElement;
  } catch (error) {
    logger.error('Failed to find scrollable element:', error);
    return null;
  }
}

// scroll to a percentage of the page or element
// if yPercent is 0, scroll to the top of the page, if 100, scroll to the bottom of the page
// if elementNode is provided, scroll to a percentage of the element
// if elementNode is not provided, scroll to a percentage of the page

export async function scrollToPercent(
  driver: PageDriver,
  yPercent: number,
  elementNode?: DOMElementNode,
): Promise<void> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }
  if (!elementNode) {
    await driver.puppeteer.evaluate(yPercent => {
      const scrollHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
      window.scrollTo({
        top: scrollTop,
        left: window.scrollX,
        behavior: 'smooth',
      });
    }, yPercent);
  } else {
    const element = await driver.page.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await findNearestScrollableElement(driver, element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }

    await scrollableElement.evaluate((el, yPercent) => {
      const scrollHeight = el.scrollHeight;
      const viewportHeight = el.clientHeight;
      const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
      el.scrollTo({
        top: scrollTop,
        left: el.scrollLeft,
        behavior: 'smooth',
      });
    }, yPercent);
  }
}

export async function scrollBy(driver: PageDriver, y: number, elementNode?: DOMElementNode): Promise<void> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }
  if (!elementNode) {
    await driver.puppeteer.evaluate(y => {
      window.scrollBy({
        top: y,
        left: 0,
        behavior: 'smooth',
      });
    }, y);
  } else {
    const element = await driver.page.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await findNearestScrollableElement(driver, element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }
    await scrollableElement.evaluate(el => {
      el.scrollBy({
        top: y,
        left: 0,
        behavior: 'smooth',
      });
    });
  }
}

export async function scrollToPreviousPage(driver: PageDriver, elementNode?: DOMElementNode): Promise<void> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }

  if (!elementNode) {
    // Scroll the whole page up by viewport height
    await driver.puppeteer.evaluate('window.scrollBy(0, -(window.visualViewport?.height || window.innerHeight));');
  } else {
    // Scroll the specific element up by its client height
    const element = await driver.page.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await findNearestScrollableElement(driver, element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }

    await scrollableElement.evaluate(el => {
      el.scrollBy(0, -el.clientHeight);
    });
  }
}

export async function scrollToNextPage(driver: PageDriver, elementNode?: DOMElementNode): Promise<void> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }

  if (!elementNode) {
    // Scroll the whole page down by viewport height
    await driver.puppeteer.evaluate('window.scrollBy(0, (window.visualViewport?.height || window.innerHeight));');
  } else {
    // Scroll the specific element down by its client height
    const element = await driver.page.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await findNearestScrollableElement(driver, element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }

    await scrollableElement.evaluate(el => {
      el.scrollBy(0, el.clientHeight);
    });
  }
}

export async function scrollToText(driver: PageDriver, text: string, nth: number = 1): Promise<boolean> {
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }

  try {
    // Convert text to lowercase for consistent searching
    const lowerCaseText = text.toLowerCase();

    // Try different locator strategies to find all elements containing the text
    const selectors = [
      // Using text selector (equivalent to get_by_text) - for exact text match
      `::-p-text(${text})`,
      // Using XPath selector (contains text) - case insensitive
      `::-p-xpath(//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerCaseText}')])`,
    ];

    for (const selector of selectors) {
      try {
        // Use $$ to get all matching elements
        const elements = await driver.puppeteer.$$(selector);

        if (elements.length > 0) {
          // Find visible elements and select the nth occurrence
          const visibleElements = [];

          for (const element of elements) {
            const isVisible = await element.evaluate(el => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0
              );
            });

            if (isVisible) {
              visibleElements.push(element);
            }
          }

          // Check if we have enough visible elements for the requested nth occurrence
          if (visibleElements.length >= nth) {
            const targetElement = visibleElements[nth - 1]; // Convert to 0-indexed
            await driver.scrollIntoView(targetElement);
            await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete

            // Dispose of all element handles to prevent memory leaks
            for (const element of elements) {
              await element.dispose();
            }

            return true;
          }
        }

        // Dispose of all element handles to prevent memory leaks
        for (const element of elements) {
          await element.dispose();
        }
      } catch (e) {
        logger.debug(`Locator attempt failed: ${e}`);
      }
    }
    return false;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
