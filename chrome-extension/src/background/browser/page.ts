import 'webextension-polyfill';
import {
  connect,
  ExtensionTransport,
  type HTTPRequest,
  type HTTPResponse,
  type ProtocolType,
  type KeyInput,
} from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { Browser } from 'puppeteer-core/lib/esm/puppeteer/api/Browser.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Frame } from 'puppeteer-core/lib/esm/puppeteer/api/Frame.js';
import {
  getClickableElements as _getClickableElements,
  removeHighlights as _removeHighlights,
  getScrollInfo as _getScrollInfo,
} from './dom/service';
import { DOMElementNode, type DOMState } from './dom/views';
import { type BrowserContextConfig, DEFAULT_BROWSER_CONTEXT_CONFIG, type PageState, URLNotAllowedError } from './views';
import { createLogger } from '@src/background/log';
import { ClickableElementProcessor } from './dom/clickable/service';
import { isUrlAllowed } from './util';
import {
  commitFormControl,
  readFormControl,
  rememberFormSelection,
  resolveSelectChoice,
  validateFormText,
  writeFormSelect,
  writeFormText,
  applicationSubmitGuard,
  nearbyOptions,
  ownedOptions,
  formFingerprint,
  pickNearbyOption,
  pickOwnedOption,
  soleFormControl,
  datePanel,
  markTextTarget,
} from './formControls';
import type { FormControlState } from './formControls';
import { writeVerifiedControl, type FormWriteResult, type FormWriteRequest } from './formFill';
import { RECRUITING_ADAPTERS, recruitingOptions, type RecruitingOptions } from './recruitingAdapters';
import { revealApplicationField } from './fieldFeedback';
import { scrollDropdown } from './dropdownScroll';
import { isApplicationClickTarget } from './clickTarget';
import { needsUserInteraction } from '../agent/actions/interactionPolicy';

export interface ApplicationControlOptions {
  allowReplace?: boolean;
  observedValue?: string;
  signal?: AbortSignal;
  resolveOption?: (evidence: { requested: string; candidates: string[]; fieldText: string }) => Promise<string | null>;
}

const logger = createLogger('Page');

export function build_initial_state(tabId?: number, url?: string, title?: string): PageState {
  return {
    elementTree: new DOMElementNode({
      tagName: 'root',
      isVisible: true,
      parent: null,
      xpath: '',
      attributes: {},
      children: [],
    }),
    selectorMap: new Map(),
    tabId: tabId || 0,
    url: url || '',
    title: title || '',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 0,
    visualViewportHeight: 0,
  };
}

/**
 * Cached clickable elements hashes for the last state
 */
export class CachedStateClickableElementsHashes {
  url: string;
  hashes: Set<string>;

  constructor(url: string, hashes: Set<string>) {
    this.url = url;
    this.hashes = hashes;
  }
}

export default class Page {
  private _tabId: number;
  private _browser: Browser | null = null;
  private _puppeteerPage: PuppeteerPage | null = null;
  private _config: BrowserContextConfig;
  private _state: PageState;
  private _validWebPage = false;
  private _cachedState: PageState | null = null;
  private _cachedStateClickableElementsHashes: CachedStateClickableElementsHashes | null = null;

  constructor(tabId: number, url: string, title: string, config: Partial<BrowserContextConfig> = {}) {
    this._tabId = tabId;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._state = build_initial_state(tabId, url, title);
    // chrome://newtab/, chrome://newtab/extensions, https://chromewebstore.google.com/ are not valid web pages, can't be attached
    const lowerCaseUrl = url.trim().toLowerCase();
    this._validWebPage =
      (tabId &&
        lowerCaseUrl &&
        lowerCaseUrl.startsWith('http') &&
        !lowerCaseUrl.startsWith('https://chromewebstore.google.com')) ||
      false;
  }

  updateConfig(config: Partial<BrowserContextConfig>): void {
    this._config = { ...this._config, ...config };
  }

  get tabId(): number {
    return this._tabId;
  }

  get validWebPage(): boolean {
    return this._validWebPage;
  }

  get attached(): boolean {
    return this._validWebPage && this._puppeteerPage !== null;
  }

  async attachPuppeteer(): Promise<boolean> {
    if (!this._validWebPage) {
      return false;
    }

    if (this._puppeteerPage) {
      return true;
    }

    logger.info('attaching puppeteer', this._tabId);
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(this._tabId),
      defaultViewport: null,
      protocol: 'cdp' as ProtocolType,
    });
    this._browser = browser;

    const [page] = await browser.pages();
    this._puppeteerPage = page;

    // Add anti-detection scripts
    await this._addAntiDetectionScripts();

    return true;
  }

  private async _addAntiDetectionScripts(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    await this._puppeteerPage.evaluateOnNewDocument(`
      // Webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Languages
      // Object.defineProperty(navigator, 'languages', {
      //   get: () => ['en-US']
      // });

      // Plugins
      // Object.defineProperty(navigator, 'plugins', {
      //   get: () => [1, 2, 3, 4, 5]
      // });

      // Chrome runtime
      window.chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Shadow DOM
      (function () {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachShadow(options) {
          return originalAttachShadow.call(this, { ...options, mode: "open" });
        };
      })();
    `);
  }

  async detachPuppeteer(): Promise<void> {
    if (this._browser) {
      await this._browser.disconnect();
      this._browser = null;
      this._puppeteerPage = null;
      // reset the state
      this._state = build_initial_state(this._tabId);
    }
  }

  async removeHighlight(): Promise<void> {
    if (this._config.displayHighlights && this._validWebPage) {
      await _removeHighlights(this._tabId);
    }
  }

  async getClickableElements(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    if (!this._validWebPage) {
      return null;
    }
    return _getClickableElements(
      this._tabId,
      this.url(),
      showHighlightElements,
      focusElement,
      this._config.viewportExpansion,
    );
  }

  // Get scroll position information for the current page.
  async getScrollInfo(): Promise<[number, number, number]> {
    if (!this._validWebPage) {
      return [0, 0, 0];
    }
    return _getScrollInfo(this._tabId);
  }

  // Get scroll position information for a specific element.
  async getElementScrollInfo(elementNode: DOMElementNode): Promise<[number, number, number]> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const element = await this.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await this._findNearestScrollableElement(element);
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
  private async _findNearestScrollableElement(element: ElementHandle): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
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
      const bodyElement = await this._puppeteerPage.$('body');
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
      const documentElement = await this._puppeteerPage.evaluateHandle(() => document.documentElement);
      const docElement = (await documentElement.asElement()) as ElementHandle<Element> | null;
      return docElement;
    } catch (error) {
      logger.error('Failed to find scrollable element:', error);
      return null;
    }
  }

  async getContent(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return await this._puppeteerPage.content();
  }

  getCachedState(): PageState | null {
    return this._cachedState;
  }

  async getState(useVision = false, cacheClickableElementsHashes = false): Promise<PageState> {
    await this._checkApplyWebsite();
    if (!this._validWebPage) {
      // return the initial state
      return build_initial_state(this._tabId);
    }
    await this.waitForPageAndFramesLoad();
    const updatedState = await this._updateState(useVision);

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // If we are on the same url as the last state, we can use the cached hashes
      if (
        this._cachedStateClickableElementsHashes &&
        this._cachedStateClickableElementsHashes.url === updatedState.url
      ) {
        // Get clickable elements from the updated state
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree);

        // Mark elements as new if they weren't in the previous state
        for (const domElement of updatedStateClickableElements) {
          const hash = await ClickableElementProcessor.hashDomElement(domElement);
          domElement.isNew = !this._cachedStateClickableElementsHashes.hashes.has(hash);
        }
      }

      // In any case, we need to cache the new hashes
      const newHashes = await ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree);
      this._cachedStateClickableElementsHashes = new CachedStateClickableElementsHashes(updatedState.url, newHashes);
    }

    // Save the updated state as the cached state
    this._cachedState = updatedState;

    return updatedState;
  }

  async _updateState(useVision = false, focusElement = -1): Promise<PageState> {
    await this._checkApplyWebsite();
    try {
      // Test if page is still accessible
      // @ts-expect-error - puppeteerPage is not null, already checked before calling this function
      await this._puppeteerPage.evaluate('1');
    } catch (error) {
      logger.warning('Current page is no longer accessible:', error);
      if (this._browser) {
        const pages = await this._browser.pages();
        if (pages.length > 0) {
          this._puppeteerPage = pages[0];
        } else {
          throw new Error('Browser closed: no valid pages available');
        }
      }
    }

    try {
      await this.removeHighlight();

      // Get DOM content (equivalent to dom_service.get_clickable_elements)
      // This part would need to be implemented based on your DomService logic
      // showHighlightElements is true if either useVision or displayHighlights is true
      const displayHighlights = this._config.displayHighlights || useVision;
      const content = await this.getClickableElements(displayHighlights, focusElement);
      if (!content) {
        logger.warning('Failed to get clickable elements');
        // Return last known good state if available
        return this._state;
      }
      // log the attributes of content object
      if ('selectorMap' in content) {
        logger.debug('content.selectorMap:', content.selectorMap.size);
      } else {
        logger.debug('content.selectorMap: not found');
      }
      if ('elementTree' in content) {
        logger.debug('content.elementTree:', content.elementTree?.tagName);
      } else {
        logger.debug('content.elementTree: not found');
      }

      // Take screenshot if needed
      const screenshot = useVision ? await this.takeScreenshot() : null;
      const [scrollY, visualViewportHeight, scrollHeight] = await this.getScrollInfo();

      // update the state
      this._state.elementTree = content.elementTree;
      this._state.selectorMap = content.selectorMap;
      this._state.url = this._puppeteerPage?.url() || '';
      this._state.title = (await this._puppeteerPage?.title()) || '';
      this._state.screenshot = screenshot;
      this._state.scrollY = scrollY;
      this._state.visualViewportHeight = visualViewportHeight;
      this._state.scrollHeight = scrollHeight;
      return this._state;
    } catch (error) {
      logger.error('Failed to update state:', error);
      // Return last known good state if available
      return this._state;
    }
  }

  async takeScreenshot(fullPage = false): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    try {
      // First disable animations/transitions
      await this._puppeteerPage.evaluate(() => {
        const styleId = 'puppeteer-disable-animations';
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = `
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.appendChild(style);
        }
      });

      // Take the screenshot using JPEG format with 80% quality
      const screenshot = await this._puppeteerPage.screenshot({
        fullPage: fullPage,
        encoding: 'base64',
        type: 'jpeg',
        quality: 80, // Good balance between quality and file size
      });

      // Clean up the style element
      await this._puppeteerPage.evaluate(() => {
        const style = document.getElementById('puppeteer-disable-animations');
        if (style) {
          style.remove();
        }
      });

      return screenshot as string;
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      throw error;
    }
  }

  url(): string {
    if (this._puppeteerPage) {
      return this._puppeteerPage.url();
    }
    return this._state.url;
  }

  async title(): Promise<string> {
    if (this._puppeteerPage) {
      return await this._puppeteerPage.title();
    }
    return this._state.title;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    logger.info('navigateTo', url);

    // Check if URL is allowed
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goto(url)]);
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

  async refreshPage(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.reload()]);
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

  async goBack(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goBack()]);
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

  async goForward(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goForward()]);
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

  // scroll to a percentage of the page or element
  // if yPercent is 0, scroll to the top of the page, if 100, scroll to the bottom of the page
  // if elementNode is provided, scroll to a percentage of the element
  // if elementNode is not provided, scroll to a percentage of the page
  async scrollToPercent(yPercent: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._puppeteerPage.evaluate(yPercent => {
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
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
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

  async scrollBy(y: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._puppeteerPage.evaluate(y => {
        window.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      }, y);
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
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

  async scrollToPreviousPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      // Scroll the whole page up by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, -(window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element up by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, -el.clientHeight);
      });
    }
  }

  async scrollToNextPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      // Scroll the whole page down by viewport height
      await this._puppeteerPage.evaluate('window.scrollBy(0, (window.visualViewport?.height || window.innerHeight));');
    } else {
      // Scroll the specific element down by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, el.clientHeight);
      });
    }
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this._puppeteerPage) {
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
        await this._puppeteerPage.keyboard.down(this._convertKey(modifier));
      }
      // Press the main key
      // also wait for stable state
      await Promise.all([
        this._puppeteerPage.keyboard.press(this._convertKey(mainKey)),
        this.waitForPageAndFramesLoad(),
      ]);
      logger.info('sendKeys complete', keys);
    } catch (error) {
      logger.error('Failed to send keys:', error);
      throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Release all modifier keys in reverse order regardless of any errors in key press.
      for (const modifier of [...modifiers].reverse()) {
        try {
          await this._puppeteerPage.keyboard.up(this._convertKey(modifier));
        } catch (releaseError) {
          logger.error('Failed to release modifier:', modifier, releaseError);
        }
      }
    }
  }

  private _convertKey(key: string): KeyInput {
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

  async scrollToText(text: string, nth: number = 1): Promise<boolean> {
    if (!this._puppeteerPage) {
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
          const elements = await this._puppeteerPage.$$(selector);

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
              await this._scrollIntoViewIfNeeded(targetElement);
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

  async getDropdownOptions(index: number): Promise<Array<{ index: number; text: string; value: string }>> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error('Dropdown element not found');
      }

      // Evaluate the select element to get all options
      const options = await elementHandle.evaluate(select => {
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Element is not a select element');
        }

        return Array.from(select.options).map(option => ({
          index: option.index,
          text: option.text, // Not trimming to maintain exact match for selection
          value: option.value,
        }));
      });

      if (!options.length) {
        throw new Error('No options found in dropdown');
      }

      return options;
    } catch (error) {
      throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async selectDropdownOption(
    index: number,
    text: string,
    options: ApplicationControlOptions = {},
  ): Promise<string | FormWriteResult> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    if (this._config.applyTargetOrigin) return this._selectApplicationOption(element, text, options);

    logger.debug(`Attempting to select '${text}' from dropdown`);
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    // Validate that we're working with a select element
    if (element.tagName?.toLowerCase() !== 'select') {
      const msg = `Cannot select option: Element with index ${index} is a ${element.tagName}, not a SELECT`;
      logger.error(msg);
      throw new Error(msg);
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }

      // Verify dropdown and select option in one call
      const result = await elementHandle.evaluate(
        (select, optionText, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            return {
              found: false,
              message: `Element with index ${elementIndex} is not a SELECT`,
            };
          }

          const options = Array.from(select.options);
          const option = options.find(opt => opt.text.trim() === optionText);

          if (!option) {
            const availableOptions = options.map(o => o.text.trim()).join('", "');
            return {
              found: false,
              message: `Option "${optionText}" not found in dropdown element with index ${elementIndex}. Available options: "${availableOptions}"`,
            };
          }

          // Set the value and dispatch events
          const previousValue = select.value;
          select.value = option.value;

          // Only dispatch events if the value actually changed
          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
          }

          return {
            found: true,
            message: `Selected option "${optionText}" with value "${option.value}"`,
          };
        },
        text,
        index,
      );

      logger.debug('Selection result:', result);
      // whether found or not, return the message
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async locateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      // throw new Error('Puppeteer page is not connected');
      logger.warning('Puppeteer is not connected');
      return null;
    }
    let currentFrame: PuppeteerPage | Frame = this._puppeteerPage;

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = [];
    let current = element;
    while (current.parent) {
      parents.push(current.parent);
      current = current.parent;
    }

    // Process all iframe parents in sequence (in reverse order - top to bottom)
    const iframes = parents.reverse().filter(item => item.tagName === 'iframe');
    for (const parent of iframes) {
      const cssSelector = parent.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
      const frameElement: ElementHandle | null = await currentFrame.$(cssSelector);
      if (!frameElement) {
        // throw new Error(`Could not find iframe with selector: ${cssSelector}`);
        logger.warning(`Could not find iframe with selector: ${cssSelector}`);
        return null;
      }
      const frame: Frame | null = await frameElement.contentFrame();
      if (!frame) {
        // throw new Error(`Could not access frame content for selector: ${cssSelector}`);
        logger.warning(`Could not access frame content for selector: ${cssSelector}`);
        return null;
      }
      currentFrame = frame;
      logger.info('currentFrame changed', currentFrame);
    }

    // 整页填写给控件打的稳定标记：区块增删后编号和路径会变，标记不会。
    const tagged = element.attributes['data-qz-field'];
    if (tagged && /^q\d+$/.test(tagged)) {
      const handle = await currentFrame.$(`[data-qz-field="${tagged}"]`);
      if (handle) {
        if (!(await handle.isHidden())) await this._scrollIntoViewIfNeeded(handle);
        return handle;
      }
    }

    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);

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
          } catch (xpathError) {
            logger.error('Failed to locate element using XPath:', xpathError);
          }
        }
      }

      // If element found, check visibility and scroll into view
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(elementHandle);
        }
        return elementHandle;
      }

      logger.info('elementHandle not located');
    } catch (error) {
      logger.error('Failed to locate element:', error);
    }

    return null;
  }

  async inputTextElementNode(
    useVision: boolean,
    elementNode: DOMElementNode,
    text: string,
    options: ApplicationControlOptions = {},
  ): Promise<void | FormWriteResult> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (this._config.applyTargetOrigin) return this._inputApplicationText(elementNode, text, options);

    try {
      // Highlight before typing
      // if (elementNode.highlightIndex != null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Ensure element is ready for input
      try {
        // First wait for element stability
        await this._waitForElementStability(element, 1500);

        // Then check visibility and scroll into view if needed
        const isHidden = await element.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(element, 1500);
        }
      } catch (e) {
        // Continue even if these operations fail
        logger.debug(`Non-critical error preparing element: ${e}`);
      }

      // Get element properties to determine input method
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const isContentEditable = await element.evaluate(el => {
        if (el instanceof HTMLElement) {
          return el.isContentEditable;
        }
        return false;
      });
      const isReadOnly = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.readOnly;
        }
        return false;
      });
      const isDisabled = await element.evaluate(el => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return el.disabled;
        }
        return false;
      });

      // Choose appropriate input method based on element properties
      if ((isContentEditable || tagName === 'input') && !isReadOnly && !isDisabled) {
        // Clear content and set value directly
        await element.evaluate(el => {
          if (el instanceof HTMLElement) {
            el.textContent = '';
          }
          if ('value' in el) {
            (el as HTMLInputElement).value = '';
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // Type the text with a small delay between keypresses
        await element.type(text, { delay: this._config.applyTargetOrigin ? 0 : 50 });
      } else {
        // Use direct value setting for other types of elements
        await element.evaluate((el, value) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = value;
          } else if (el instanceof HTMLElement && el.isContentEditable) {
            el.textContent = value;
          }
          // Dispatch events
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, text);
      }

      // Wait for page stability after input
      await this.waitForPageAndFramesLoad();
    } catch (error) {
      const errorMsg = `Failed to input text into element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  private _formIdentity(node: DOMElementNode): Record<string, string> {
    return {
      tagName: (node.tagName ?? '').toLowerCase(),
      ...Object.fromEntries(
        ['id', 'name', 'type', 'role', 'aria-label', 'placeholder', 'contenteditable'].map(key => [
          key,
          node.attributes[key] ?? '',
        ]),
      ),
    };
  }

  /** 定位观察到的控件；指向外框时换成框内唯一的真实控件，身份核对随之改用该控件。 */
  private async _applicationControl(
    node: DOMElementNode,
  ): Promise<{ element: ElementHandle; identity: Record<string, string> }> {
    await this._checkApplyWebsite();
    const located = await this.locateElement(node);
    if (!located) throw new Error('目标控件已移除，请重新观察页面。');
    if (await located.isHidden()) throw new Error('目标控件已隐藏，请观察当前可用的交互入口。');
    const identity = this._formIdentity(node);
    const handle = await located.evaluateHandle(soleFormControl, RECRUITING_ADAPTERS);
    const inner = handle.asElement() as ElementHandle | null;
    if (!inner) {
      await handle.dispose();
      return { element: located, identity };
    }
    const outer = await located.evaluate(readFormControl, false, RECRUITING_ADAPTERS);
    if (Object.entries(identity).some(([key, value]) => outer.identity[key] !== value))
      throw new Error('控件已变化或移除，请重新观察页面。');
    return { element: inner, identity: (await inner.evaluate(readFormControl, false, RECRUITING_ADAPTERS)).identity };
  }

  /** 批量填写途中的轻量结构指纹，替代每个动作前完整重建 DOM 树。 */
  async formFingerprint(): Promise<string | null> {
    if (!this._puppeteerPage) return null;
    return this._puppeteerPage.$eval('body', formFingerprint, RECRUITING_ADAPTERS);
  }

  /** 按观察到的路径给元素打稳定标记，已有标记的沿用；找不到的返回 null。 */
  async tagApplicationElements(xpaths: string[]): Promise<(string | null)[]> {
    if (!this._puppeteerPage) return xpaths.map(() => null);
    await this._checkApplyWebsite();
    return this._puppeteerPage.evaluate((paths: string[]) => {
      const holder = window as unknown as { __qzSeq?: number };
      return paths.map(path => {
        const found = path
          ? document.evaluate(`/${path}`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          : null;
        if (!(found instanceof Element)) return null;
        const existing = found.getAttribute('data-qz-field');
        if (existing) return existing;
        holder.__qzSeq = (holder.__qzSeq ?? 0) + 1;
        const id = `q${holder.__qzSeq}`;
        found.setAttribute('data-qz-field', id);
        return id;
      });
    }, xpaths);
  }

  /** 并行读取所有带标记控件的真实状态，不滚动页面；原生下拉附带选项文字。 */
  async readTaggedControls(): Promise<Map<string, FormControlState & { options?: string[] }>> {
    const result = new Map<string, FormControlState & { options?: string[] }>();
    if (!this._puppeteerPage) return result;
    await this._checkApplyWebsite();
    const handles = await this._puppeteerPage.$$('[data-qz-field]');
    await Promise.all(
      handles.map(async handle => {
        try {
          const [id, state, options] = await Promise.all([
            handle.evaluate(el => el.getAttribute('data-qz-field') ?? ''),
            handle.evaluate(readFormControl, false, RECRUITING_ADAPTERS),
            handle.evaluate(el =>
              el.tagName === 'SELECT' ? Array.from((el as HTMLSelectElement).options, option => option.text.trim()) : null,
            ),
          ]);
          if (id) result.set(id, options ? { ...state, options } : state);
        } catch {
          /* 读取途中被移除的控件不计入。 */
        } finally {
          await handle.dispose();
        }
      }),
    );
    return result;
  }

  async selectApplicationOption(node: DOMElementNode, text: string, options: ApplicationControlOptions = {}) {
    return this._selectApplicationOption(node, text, options);
  }

  /** display：字段是从列表或面板选出来的，读控件框里显示的值。 */
  async readApplicationControl(node: DOMElementNode, display = false) {
    const { element } = await this._applicationControl(node);
    return element.evaluate(readFormControl, display, RECRUITING_ADAPTERS);
  }

  private async _revealApplicationField(element: ElementHandle) {
    await element.evaluate(revealApplicationField);
  }

  /** 侧栏定位只滚动和高亮，不点击、不改值。调用方必须先重新核对字段身份。 */
  async revealApplicationControl(node: DOMElementNode): Promise<void> {
    const element = await this.locateElement(node);
    if (!element) throw new Error('字段已变化，请重新检查表单。');
    try { await this._revealApplicationField(element); }
    finally { await element.dispose(); }
  }

  private async _waitForApplicationClickTarget(element: ElementHandle, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('操作已取消。');
    await element.scrollIntoView();
    for (let poll = 0; poll < 40; poll++) {
      if (signal?.aborted) throw new Error('操作已取消。');
      const point = await element.clickablePoint();
      const box = await element.boundingBox();
      // Puppeteer reports main-frame coordinates; DOM hit testing uses the element's own document.
      if (box && await element.evaluate(isApplicationClickTarget, { x: point.x - box.x, y: point.y - box.y })) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('CLICK_TARGET_OBSCURED: 目标仍被其他控件遮挡，未执行点击。请重新观察页面。');
  }

  private async _waitForDropdownClosed(listed: () => Promise<{ open: boolean }>, signal?: AbortSignal) {
    for (let poll = 0; poll < 40; poll++) {
      if (signal?.aborted) throw new Error('操作已取消。');
      if (!(await listed()).open) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('DROPDOWN_STILL_OPEN: 下拉弹层尚未关闭，不能继续当作已收起。');
  }

  /** 自定义下拉的展开、滚动与收起；选择和列出选项共用同一套归属规则。 */
  private async _customDropdown(element: ElementHandle, text: string, signal?: AbortSignal) {
    const searchHandle = await element.evaluateHandle(el => {
      const inputs = el.tagName === 'INPUT' ? [el] : Array.from(el.querySelectorAll('input'));
      const eligible = inputs.filter(input => ['text', 'search'].includes((input as HTMLInputElement).type) &&
        !(input as HTMLInputElement).readOnly && !(input as HTMLInputElement).disabled &&
        !input.closest('[hidden], [aria-hidden="true"]'));
      return eligible.length === 1 ? eligible[0] : null;
    });
    const search = searchHandle.asElement() as ElementHandle | null;
    const typable = Boolean(search);
    const adapted = (await element.evaluate(recruitingOptions, RECRUITING_ADAPTERS, text)) as RecruitingOptions;
    // 网页声明了归属就只认声明；位置退路只给完全没有声明的网页。
    const declared = await element.evaluate(el => Boolean(el.getAttribute('aria-controls') || el.getAttribute('aria-owns')));
    const clickGuarded = async (target: ElementHandle, reveal = true) => {
      await this._checkApplyWebsite();
      if (signal?.aborted) throw new Error('操作已取消。');
      if (reveal) await this._revealApplicationField(target);
      await this._waitForApplicationClickTarget(target, signal);
      await target.evaluate(applicationSubmitGuard, 'start' as const);
      let blocked = false;
      try { await target.click(); }
      finally { blocked = await target.evaluate(applicationSubmitGuard, 'stop' as const); }
      if (blocked) throw new Error('点击会触发表单提交，已阻止。');
    };
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const listed = async (label = text) => {
      if (adapted.supported) return (await element.evaluate(recruitingOptions, RECRUITING_ADAPTERS, label)) as RecruitingOptions;
      const owned = await element.evaluate(ownedOptions, label);
      if (owned.open || declared) return { ...owned, box: (await element.evaluate(nearbyOptions, label)).box };
      return element.evaluate(nearbyOptions, label);
    };
    const open = async (allowSearch = false) => {
      const current = await listed();
      if (current.open) return current;
      for (let round = 0; round < 2; round++) {
        // 第一次点击可能把正在收起的弹层再次收起；等动画结束再点一次。
        if (round) await wait(500);
        await clickGuarded(element);
        for (let poll = 0; poll < 20; poll++) {
          if (signal?.aborted) throw new Error('操作已取消。');
          await wait(100);
          const state = await listed();
          if (state.open) return state;
          // Remote school searches can render no popup until the first query.
          if (allowSearch && typable) return state;
        }
      }
      throw new Error('点开后没有出现该字段的选项。');
    };
    const move = async (state: Awaited<ReturnType<typeof listed>>, direction: 'start' | 'next', label = text) => {
      if (signal?.aborted) throw new Error('操作已取消。');
      if (!state.box) return null;
      const movement = await element.evaluate(scrollDropdown, state.box, direction);
      if (!movement?.moved) return null;
      // Virtual rows arrive after the scroll event. Unchanged text alone does not mean the list ended.
      let next = state;
      for (let poll = 0; poll < 10; poll++) {
        await wait(50);
        if (signal?.aborted) throw new Error('操作已取消。');
        next = await listed(label);
        if (next.options.join('\n') !== state.options.join('\n')) break;
      }
      return next;
    };
    const rewind = async (state: Awaited<ReturnType<typeof listed>>, label = text) =>
      (await move(state, 'start', label)) ?? await listed(label);
    const scroll = (state: Awaited<ReturnType<typeof listed>>, label = text) => move(state, 'next', label);
    const close = async () => {
      // Escape cancels the committed value in some editable selects (including Feishu).
      await element.evaluate(el => {
        const active = el.ownerDocument.activeElement;
        if (active && (active === el || el.contains(active))) (active as HTMLElement).blur();
      });
      // Blur only starts the closing animation. Do not let the next field click land on this popup.
      await this._waitForDropdownClosed(listed, signal);
    };
    return { typable, search, searchHandle, adapted: adapted.supported, declared, listed, open, rewind, scroll, close, clickGuarded, wait };
  }

  /** 展开自定义下拉并列出全部可选项（只读长列表滚动收集），不做选择，最后收起。 */
  async listCustomOptions(node: DOMElementNode, signal?: AbortSignal): Promise<string[]> {
    const { element } = await this._applicationControl(node);
    const dropdown = await this._customDropdown(element, '', signal);
    try {
      let state = await dropdown.rewind(await dropdown.open(true));
      const all = new Set(state.options);
      for (let round = 0; round < 30; round++) {
        const next = await dropdown.scroll(state);
        if (!next) return [...all];
        next.options.forEach(option => all.add(option));
        state = next;
      }
      throw new Error('下拉候选尚未遍历完，不能将部分选项当作完整列表。');
    } finally {
      try { await dropdown.close(); }
      finally { await dropdown.searchHandle.dispose(); }
    }
  }

  /** 点开（或输入筛选、滚动查找）字段自己的弹出列表，精确点中一个选项；单选和多选共用。 */
  private async _chooseOption(element: ElementHandle, text: string, signal?: AbortSignal, resolveOption?: ApplicationControlOptions['resolveOption']): Promise<string> {
    const requested = text;
    const { typable, search, searchHandle, adapted, declared, listed, open, rewind, scroll, clickGuarded, wait } = await this._customDropdown(element, text, signal);
    try {
      let state = await open(true);
      let searchOptions: string[] = [];
      if (!state.matches && typable) {
        await search!.evaluate(writeFormText, '');
        await search!.type(text, { delay: 20 });
        for (let poll = 0; poll < 15 && !state.matches; poll++) {
          await wait(150);
          state = await listed();
        }
        // 有的下拉能输入但不按输入筛选：清掉输入，回到完整列表里滚动查找。
        if (!state.matches && !(resolveOption && state.options.length)) {
          searchOptions = state.options;
          await search!.evaluate(writeFormText, '');
          await wait(300);
          state = await listed();
        }
      }
      if (!state.matches) state = await rewind(state);
      const candidates = new Set(state.options);
      let exhausted = false;
      for (let round = 0; round < 30 && !state.matches; round++) {
        const next = await scroll(state);
        if (!next) { exhausted = true; break; }
        state = next;
        state.options.forEach(option => candidates.add(option));
      }
      if (!state.matches && !exhausted) throw new Error('下拉候选尚未遍历完，不能将部分选项交给 Agent 判断。');
      if (!state.matches && resolveOption && candidates.size) {
        const control = await element.evaluate(readFormControl, true, RECRUITING_ADAPTERS);
        const selected = await resolveOption({ requested, candidates: [...candidates], fieldText: control.context ?? '' });
        if (signal?.aborted) throw new Error('操作已取消。');
        if (selected === null) throw new Error(`Agent 无法确定适合「${requested}」的候选名称或类别。实际候选：${[...candidates].join('、')}。请结合资料进一步确认。`);
        if (!candidates.has(selected)) throw new Error('Agent 返回的候选不在实际列表中，未点击。');
        text = selected;
        // Use the original filtered list: searching again with its label could change the remote results.
        state = await listed(text);
        if (!state.matches) {
          state = await rewind(state, text);
          for (let round = 0; round < 30 && !state.matches; round++) {
            const next = await scroll(state, text);
            if (!next) break;
            state = next;
          }
        }
      }
      if (state.matches !== 1) {
        throw new Error(state.matches > 1
          ? `有多个与「${text}」完全相同的选项，无法区分。`
          : `没有与「${text}」完全一致的选项。搜索结果：${searchOptions.join('、') || '无'}；当前可见选项：${state.options.join('、') || '无'}。请核对候选是否与资料一致，再选择精确文本，不得把不同实体直接替换。`);
      }
      let option: ElementHandle | null = null;
      if (adapted) {
        const handle = await element.evaluateHandle(recruitingOptions, RECRUITING_ADAPTERS, text, true);
        option = handle.asElement() as ElementHandle | null;
        if (!option) await handle.dispose();
      }
      for (const finder of adapted ? [] : declared ? [pickOwnedOption] : [pickOwnedOption, pickNearbyOption]) {
        const handle = await element.evaluateHandle(finder, text);
        option = handle.asElement() as ElementHandle | null;
        if (option) break;
        await handle.dispose();
      }
      if (!option) throw new Error('选项已变化，请重新观察。');
      try {
        // Focusing a popup checkbox before its mousedown can blur and close the dropdown.
        await clickGuarded(option, false);
        // Cleanup is never evidence that the site accepted an option.
        const control = await element.evaluate(readFormControl, true, RECRUITING_ADAPTERS);
        if (control.selectionConfirmed === false) {
          let committed = false;
          for (let poll = 0; poll < 10; poll++) {
            if (signal?.aborted) throw new Error('操作已取消。');
            await wait(100);
            const current = await element.evaluate(readFormControl, true, RECRUITING_ADAPTERS);
            if (current.value === text && (current.selectionConfirmed === true || !(await listed()).open)) {
              if (current.selectionConfirmed !== true) await element.evaluate(rememberFormSelection, text);
              committed = true;
              break;
            }
          }
          if (!committed) throw new Error('点击候选后尚未确认选中：输入框文字或弹层状态未完成更新。');
        }
      } finally {
        await option.dispose();
      }
      return text;
    } finally {
      // 选后保留控件自己的展开和焦点状态，多选可能还需要继续勾选。
      await searchHandle.dispose();
    }
  }

  /**
   * 多选：逐个选中 items 里还没选上的项，最后回读控件框，确认每一项都在。只增加，不取消已有选择；
   * 已有选择里有资料之外的内容时不改动，交给用户确认。
   */
  async selectCustomOptions(node: DOMElementNode, items: string[], options: ApplicationControlOptions = {}): Promise<FormWriteResult> {
    const { element } = await this._applicationControl(node);
    const read = async () => {
      await this._checkApplyWebsite();
      return element.evaluate(readFormControl, true, RECRUITING_ADAPTERS);
    };
    const norm = (value: string) => value.replace(/\s+/g, '');
    const resolvedItems = [...items];
    const desiredValue = items.join('、');
    const initial = await read();
    const result = (status: FormWriteResult['status'], code: string, message: string, actualValue: string, attempts: number): FormWriteResult => ({
      status, code, message, adapter: 'popup-multi-click', attempts, actualValue, desiredValue,
      ...(status === 'failed' ? { observedValue: initial.value, fieldText: initial.context ?? '' } : {}),
    });
    if (initial.disabled) return result('failed', 'READ_ONLY_CONTROL', '控件已禁用。', initial.value, 0);
    const contains = (state: FormControlState, item: string) => state.selectionConfirmed !== false &&
      (state.selectedValues ? state.selectedValues.some(value => norm(value) === norm(item)) : norm(state.value).includes(norm(item)));
    const missing = items.filter(item => !contains(initial, item));
    // 核对清单以控件实际显示的样子为准（标签之间的分隔各网站不同）。
    if (!missing.length && initial.valid) return { ...result('verified', 'ALREADY_MATCHED', '这些选项都已选中。', initial.value, 0), desiredValue: initial.value };
    const others = initial.selectionConfirmed === false ? '' : items.reduce((rest, item) => rest.split(norm(item)).join(''), norm(initial.value));
    if (/[^\s×xX+\d,，、|/]/.test(others) && !options.allowReplace)
      return result('preserved', 'EXISTING_VALUE_PRESERVED', '字段里已有资料之外的选择，未改动。需要时先 ask_user 确认。', initial.value, 0);
    let attempts = 0;
    try {
      for (const item of missing) {
        if (options.signal?.aborted) throw new Error('操作已取消。');
        attempts++;
        const selected = await this._chooseOption(element, item, options.signal, options.resolveOption);
        resolvedItems[items.indexOf(item)] = selected;
        await new Promise(resolve => setTimeout(resolve, Math.max(200, initial.settleMs ?? 0)));
      }
    } catch (error) {
      return result('failed', 'WRITE_FAILED', error instanceof Error ? error.message : String(error), (await read()).value, attempts);
    }
    const after = await read();
    const absent = resolvedItems.filter(item => !contains(after, item));
    if (!after.valid) return result('failed', 'VALIDATION_REJECTED', after.validationMessage, after.value, attempts);
    return absent.length
      ? result('failed', 'VERIFY_FAILED', `回读控件里没有：${absent.join('、')}。`, after.value, attempts)
      : { ...result('verified', 'VERIFIED', '每个选项都已出现在控件里。', after.value, attempts), desiredValue: after.value };
  }

  /**
   * 一步选完自定义下拉：在写入核验流程内点开字段、找到选项、真实点击，再回读。
   * 选项归属优先用网页声明的 aria-controls/aria-owns；未声明时只认点开后新出现、紧贴该字段的选项。
   * 能输入的下拉先输入文字筛选，只读的长列表在弹层内有限次滚动。没有同名项时由注入的 Agent 判断真实候选。
   */
  async selectCustomOption(
    node: DOMElementNode,
    text: string,
    options: ApplicationControlOptions = {},
  ): Promise<FormWriteResult> {
    const { element, identity } = await this._applicationControl(node);
    await element.evaluate(rememberFormSelection, null);
    // 选择后的值常显示在输入框旁边：一律读控件框里显示的值。
    const read = async () => {
      await this._checkApplyWebsite();
      return element.evaluate(readFormControl, true, RECRUITING_ADAPTERS);
    };
    const initial = await read();
    if (initial.valueKnown === false || !['custom', 'text'].includes(initial.kind))
      return { status: 'failed', code: 'UNVERIFIABLE_CUSTOM_CONTROL', message: '无法可靠读取字段值。',
        adapter: '', attempts: 0, actualValue: initial.value, desiredValue: text };
    // 没有下拉标记的输入框也可以从紧贴它弹出的列表里选；多选需要另外的交互，不在这里处理。
    if (initial.multiple)
      return { status: 'failed', code: 'UNVERIFIABLE_CUSTOM_CONTROL', message: '这是多选控件，请改用多选方式（select_multiple_options / how=choose_many）。',
        adapter: '', attempts: 0, actualValue: initial.value, desiredValue: text };
    const request: FormWriteRequest = {
      kind: initial.kind, expectedIdentity: identity,
      observedValue: options.observedValue ?? initial.value, desiredValue: text,
      allowReplace: options.allowReplace, allowReadOnly: true, signal: options.signal, maxAttempts: 1,
    };
    return writeVerifiedControl({
      read,
      adapters: ['popup-option-click'],
      write: async () => {
        await this._chooseOption(element, text, options.signal, options.resolveOption ? async evidence => {
          const selected = await options.resolveOption!(evidence);
          if (selected !== null && evidence.candidates.includes(selected)) request.desiredValue = selected;
          return selected;
        } : undefined);
      },
    }, request);
  }

  /**
   * 日期面板选择：点开字段旁的面板，按表头年月用箭头翻页（大跨度先点表头切到年/月视图），再点目标格子。
   * 值写成 YYYY-MM 或 YYYY-MM-DD；面板只给年月时选到月即可。
   */
  async pickApplicationDate(node: DOMElementNode, value: string, options: ApplicationControlOptions = {}): Promise<FormWriteResult> {
    const { element, identity } = await this._applicationControl(node);
    const read = async () => {
      await this._checkApplyWebsite();
      return element.evaluate(readFormControl, true, RECRUITING_ADAPTERS);
    };
    const initial = await read();
    const parts = value.match(/^\s*(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/);
    if (!parts || !this._puppeteerPage)
      return { status: 'failed', code: 'DATE_FORMAT', message: '日期请写成 YYYY-MM 或 YYYY-MM-DD。',
        adapter: '', attempts: 0, actualValue: initial.value, desiredValue: value };
    const [year, month, day] = [Number(parts[1]), Number(parts[2]), parts[3] ? Number(parts[3]) : null];
    const page = this._puppeteerPage;
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const press = async (point: { x: number; y: number }) => {
      if (options.signal?.aborted) throw new Error('操作已取消。');
      await page.mouse.click(point.x, point.y);
      await wait(180);
    };
    let popupCloseError = '';
    let dateFailure: { code: string; message: string } | undefined;
    let dateDiagnostic: FormWriteResult['dateDiagnostic'];
    const failDate = (code: string, message: string): never => { dateFailure = { code, message }; throw new Error(message); };
    const closeFailure = (message: string): never => { popupCloseError = message; throw new Error(message); };
    const result = await writeVerifiedControl({
      read,
      adapters: ['date-panel'],
      write: async () => {
        await this._revealApplicationField(element);
        try {
          let state = await element.evaluate(datePanel);
          if (!state.open) {
            await this._waitForApplicationClickTarget(element, options.signal);
            await element.click();
            for (let poll = 0; poll < 15 && !state.open; poll++) {
              await wait(120);
              state = await element.evaluate(datePanel);
            }
          }
          if (!state.open) throw new Error('点开后没有出现日期面板。');
          let headerTried = false;
          let monthHeaderTried = false;
          for (let step = 0; step < 60; step++) {
            state = await element.evaluate(datePanel);
            if (!state.open) return;
            const formats = state.input?.formats ?? [];
            if (day === null && formats.length && formats.every(format => {
              const tokens = format.replace(/\[[^\]]*\]|\\./g, '');
              return /Y/.test(tokens) && /M/.test(tokens) && /D/.test(tokens);
            })) {
              dateDiagnostic = { formats, inputPresent: true, inputInvalid: false, inputMatches: false };
              failDate('DATE_PRECISION_REQUIRED', '网页要求完整的年、月、日，当前资料只有年月，请补充具体日期。已暂缓此项，不会自动补造日期。');
            }
            if (state.view === 'unknown' || state.year === null) throw new Error('认不出日期面板的结构。');
            const outerPrev = state.prev[0];
            const outerNext = state.next[state.next.length - 1];
            if (state.view === 'year') {
              const cell = state.cells.find(entry => entry.value === year);
              if (cell) {
                if (cell.disabled) throw new Error(`面板上 ${year} 年不可选。`);
                await press(cell);
                continue;
              }
              const lowest = Math.min(...state.cells.map(entry => entry.value));
              const arrow = year < lowest ? outerPrev : outerNext;
              if (!arrow) throw new Error('日期面板没有翻页箭头。');
              await press(arrow);
              continue;
            }
            if (state.view === 'month') {
              if (state.year === year) {
                const cell = state.cells.find(entry => entry.value === month);
                if (!cell || cell.disabled) throw new Error(`面板上 ${year} 年 ${month} 月不可选。`);
                await press(cell);
                continue;
              }
              const arrow = year < state.year ? outerPrev : outerNext;
              if (!arrow) throw new Error('日期面板没有翻页箭头。');
              await press(arrow);
              continue;
            }
            // 日网格不代表字段要求日精度。Ant3 弹层输入框按网页自身格式严格校验，
            // 只输入资料已有的年月；无效时绝不能按 Enter（旧版会提交面板当前日期）。
            if (day === null) {
              if (state.input) {
                await page.mouse.click(state.input.x, state.input.y, { clickCount: 3 });
                if (options.signal?.aborted) throw new Error('操作已取消。');
                if (!(await element.evaluate(datePanel)).input?.active)
                  throw new Error('日期弹层输入框未获得焦点，已停止输入。');
                await page.keyboard.type(value);
                await wait(180);
                const edited = await element.evaluate(datePanel);
                dateDiagnostic = { formats: edited.input?.formats ?? formats, inputPresent: Boolean(edited.input),
                  inputInvalid: edited.input?.invalid === true, inputMatches: edited.input?.value === value };
                if (!edited.input) failDate('DATE_INPUT_MISSING', '输入后日期弹层输入框已消失，需要重新核对主字段。');
                if (edited.input!.value !== value) failDate('DATE_INPUT_MISMATCH', '日期弹层读回内容与输入不一致，已停止；不能据此判断日期精度。');
                if (edited.input!.invalid) failDate('DATE_INPUT_REJECTED', '日期输入被网页校验拒绝，当前无法确认所需格式或日期范围，请核对后补填。');
                return; // 退出前收起弹层，再由 writeVerifiedControl 两次核对主字段。
              }
              if (state.monthHeader && !monthHeaderTried) {
                monthHeaderTried = true;
                await press(state.monthHeader);
                continue;
              }
              throw new Error('未找到能提交年月的交互入口，已停止；不会补造具体日期。');
            }
            // 日视图
            if (state.year === year && state.month === month) {
              const cell = state.cells.find(entry => entry.value === day);
              if (!cell || cell.disabled) throw new Error(`面板上 ${value} 不可选。`);
              await press(cell);
              continue;
            }
            const gap = (year - state.year) * 12 + (month - (state.month ?? month));
            if (Math.abs(year - state.year) >= 2 && state.header && !headerTried) {
              headerTried = true;
              await press(state.header);
              continue;
            }
            const twoEach = state.prev.length >= 2 && state.next.length >= 2;
            const arrow =
              year !== state.year && twoEach
                ? gap < 0 ? outerPrev : outerNext
                : gap < 0 ? state.prev[state.prev.length - 1] : state.next[0];
            if (!arrow) throw new Error('日期面板没有翻页箭头。');
            await press(arrow);
          }
          throw new Error('日期面板翻页次数过多，已停止。');
        } finally {
          // 关闭属于本字段的日历，不点击背景、logo 或导航链接。
          if (!options.signal?.aborted) {
            const state = await element.evaluate(datePanel);
            if (state.open) {
              let focused = state.focused;
              const point = state.input ?? state.header;
              // Ant3 忽略从输入框冒泡的 Escape，需先聚焦日历容器。
              if (point) focused = await element.evaluate((el, point) => {
                const doc = el.ownerDocument;
                const panel = doc.elementFromPoint(point.x, point.y)?.closest('.ant-calendar-picker-container');
                const target = panel?.querySelector<HTMLElement>('.ant-calendar[tabindex], [tabindex="0"]:not(input)');
                target?.focus();
                return Boolean(target && doc.activeElement === target);
              }, point);
              if (!focused) closeFailure('日期弹层无法安全聚焦关闭，请手动收起。');
              await page.keyboard.press('Escape');
              for (let poll = 0; poll < 20; poll++) {
                if (!(await element.evaluate(datePanel)).open) break;
                if (poll === 19) closeFailure('日期弹层尚未收起，请手动关闭后重试。');
                await wait(50);
              }
            }
          }
        }
      },
    }, {
      kind: initial.kind, expectedIdentity: identity,
      observedValue: options.observedValue ?? initial.value, desiredValue: value,
      allowReplace: options.allowReplace, allowReadOnly: true, signal: options.signal, maxAttempts: 1,
    });
    if (popupCloseError) return { ...result, status: 'failed', code: 'DATE_PANEL_STILL_OPEN', message: popupCloseError, dateDiagnostic };
    return dateFailure && result.status === 'failed' ? { ...result, ...dateFailure, dateDiagnostic } : result;
  }

  /** 按显示文字点击页面没做成按钮的元素（after 用来限定在某段文字之后）；会离开页面或提交的不点。 */
  async clickApplicationText(text: string, after: string | null, signal?: AbortSignal): Promise<boolean> {
    if (!this._puppeteerPage) return false;
    await this._checkApplyWebsite();
    const mark = `t${Date.now()}`;
    const body = await this._puppeteerPage.$('body');
    if (!body) return false;
    const found = await body.evaluate(markTextTarget, { text, after, mark });
    await body.dispose();
    if (!found) return false;
    const target = await this._puppeteerPage.$(`[data-qz-click="${mark}"]`);
    if (!target) return false;
    try {
      if (signal?.aborted) throw new Error('操作已取消。');
      await this._scrollIntoViewIfNeeded(target);
      await this._revealApplicationField(target);
      await this._waitForApplicationClickTarget(target, signal);
      await target.evaluate(applicationSubmitGuard, 'start' as const);
      let blocked = false;
      try {
        await target.click();
      } finally {
        blocked = await target.evaluate(applicationSubmitGuard, 'stop' as const);
      }
      if (blocked) throw new Error('点击会触发表单提交，已阻止。');
      return true;
    } finally {
      await target.evaluate(el => el.removeAttribute('data-qz-click')).catch(() => undefined);
      await target.dispose();
    }
  }

  private async _inputApplicationText(
    node: DOMElementNode,
    text: string,
    options: ApplicationControlOptions,
  ): Promise<FormWriteResult> {
    const { element, identity } = await this._applicationControl(node);
    const read = async () => {
      await this._checkApplyWebsite();
      return element.evaluate(readFormControl, false, RECRUITING_ADAPTERS);
    };
    const initial = await read();
    if (!['text', 'contenteditable'].includes(initial.kind))
      return {
        status: 'failed',
        code: 'UNSUPPORTED_CONTROL',
        message: '此控件不支持文本赋值，请观察其真实交互方式。',
        adapter: '',
        attempts: 0,
        actualValue: '',
      };
    const validation = await element.evaluate(validateFormText, text);
    if (!validation.valid)
      return {
        status: 'failed',
        code: 'VALIDATION_REJECTED',
        message: validation.message,
        adapter: 'native-setter',
        attempts: 0,
        actualValue: initial.value,
      };
    return writeVerifiedControl(
      {
        read,
        adapters: ['native-setter', 'keyboard'],
        write: async attempt => {
          await this._checkApplyWebsite();
          if (options.signal?.aborted) throw new Error('操作已取消。');
          await this._revealApplicationField(element);
          if (attempt === 0) await element.evaluate(writeFormText, text);
          else {
            await element.evaluate(writeFormText, '');
            if (options.signal?.aborted) throw new Error('操作已取消。');
            await element.type(text, { delay: 0 });
          }
          if (options.signal?.aborted) throw new Error('操作已取消。');
          await element.evaluate(commitFormControl, attempt === 0);
        },
      },
      {
        kind: initial.kind,
        expectedIdentity: identity,
        observedValue: options.observedValue ?? node.attributes.value ?? '',
        desiredValue: text,
        allowReplace: options.allowReplace,
        signal: options.signal,
      },
    );
  }

  private async _selectApplicationOption(
    node: DOMElementNode,
    text: string,
    options: ApplicationControlOptions,
  ): Promise<FormWriteResult> {
    const { element, identity } = await this._applicationControl(node);
    let choice = await element.evaluate(resolveSelectChoice, text);
    if (!choice.found && options.resolveOption) {
      const candidates = await element.evaluate(el => Array.from((el as HTMLSelectElement).options)
        .filter(option => !option.disabled && !option.parentElement?.hasAttribute('disabled'))
        .map(option => option.text.trim()).filter(Boolean));
      if (candidates.length) {
        const control = await element.evaluate(readFormControl, false, RECRUITING_ADAPTERS);
        const selected = await options.resolveOption({ requested: text, candidates, fieldText: control.context ?? '' });
        if (options.signal?.aborted) throw new Error('操作已取消。');
        if (selected !== null && candidates.includes(selected)) choice = await element.evaluate(resolveSelectChoice, selected);
      }
    }
    if (!choice.found || choice.value === undefined)
      return {
        status: 'failed',
        code: choice.code ?? 'OPTION_NOT_FOUND',
        message: choice.message ?? '没有找到目标选项。',
        adapter: 'native-select',
        attempts: 0,
        actualValue: '',
      };
    const value = choice.value;
    return writeVerifiedControl(
      {
        read: async () => {
          await this._checkApplyWebsite();
          return element.evaluate(readFormControl, false, RECRUITING_ADAPTERS);
        },
        adapters: ['native-select', 'puppeteer-select'],
        write: async attempt => {
          await this._checkApplyWebsite();
          if (options.signal?.aborted) throw new Error('操作已取消。');
          await this._revealApplicationField(element);
          if (attempt === 0) await element.evaluate(writeFormSelect, value);
          else await element.select(value);
          if (options.signal?.aborted) throw new Error('操作已取消。');
          await element.evaluate(commitFormControl, attempt === 0);
        },
      },
      {
        kind: 'select',
        expectedIdentity: identity,
        observedValue: options.observedValue ?? node.attributes.value ?? '',
        desiredValue: value,
        allowReplace: options.allowReplace,
        signal: options.signal,
      },
    );
  }

  async clickApplicationToggle(node: DOMElementNode, signal?: AbortSignal, checked?: boolean): Promise<FormWriteResult> {
    const { element, identity } = await this._applicationControl(node);
    // 目标值按模型观察到的状态定：观察后用户自己改过的，写入核验会判为已匹配，不会被翻回去。
    const { kind } = await element.evaluate(readFormControl, false, RECRUITING_ADAPTERS);
    const observedValue = node.attributes.checked === 'true' || node.attributes['aria-checked'] === 'true' ? 'true' : 'false';
    const radio = node.attributes.type?.toLowerCase() === 'radio' || node.attributes.role === 'radio';
    const desiredValue = checked !== undefined ? String(checked) : radio ? 'true' : String(observedValue !== 'true');
    return writeVerifiedControl(
      {
        read: async () => {
          await this._checkApplyWebsite();
          return element.evaluate(readFormControl, false, RECRUITING_ADAPTERS);
        },
        adapters: ['native-click', 'dom-click'],
        write: async attempt => {
          await this._checkApplyWebsite();
          if (signal?.aborted) throw new Error('操作已取消。');
          await this._revealApplicationField(element);
          await this._waitForApplicationClickTarget(element, signal);
          await element.evaluate(applicationSubmitGuard, 'start' as const);
          let blocked = false;
          try {
            if (attempt === 0) await element.click();
            else await element.evaluate(el => (el as HTMLElement).click());
          } finally { blocked = await element.evaluate(applicationSubmitGuard, 'stop' as const); }
          if (blocked) throw new Error('勾选会触发表单提交，已阻止。');
        },
      },
      {
        kind,
        expectedIdentity: identity,
        observedValue,
        desiredValue,
        preserveExisting: false,
        signal,
      },
    );
  }

  /**
   * Wait for an element to become stable (no position/size changes)
   * Similar to Playwright's wait_for_element_state('stable')
   */
  private async _waitForElementStability(element: ElementHandle, timeout = 1000): Promise<void> {
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

  private async _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
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

  async clickElementNode(useVision: boolean, elementNode: DOMElementNode, signal?: AbortSignal): Promise<void> {
    if (this._config.applyTargetOrigin && needsUserInteraction(elementNode, 'open_interface'))
      throw new Error('MANUAL_ACTION_REQUIRED: 受保护控件不能通过普通点击操作，请使用对应字段工具或请求用户处理。');
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    let guarded: ElementHandle | null = null;
    let submissionBlocked = false;
    try {
      // Highlight before clicking
      // if (elementNode.highlightIndex !== null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Follow the observed link destination without executing arbitrary onclick handlers.
      if (this._config.applyTargetOrigin && elementNode.tagName?.toLowerCase() === 'a') {
        const href = await element.evaluate(el => el.getAttribute('href'));
        if (href !== elementNode.attributes.href || !href) throw new Error('链接已变化，请重新观察。');
        const url = new URL(href, this._cachedState?.url || this._config.applyTargetOrigin);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('链接需要用户亲自操作。');
        if (signal?.aborted) throw new Error('操作已取消。');
        await this.navigateTo(url.href);
        await this._checkAndHandleNavigation();
        return;
      }

      // Scroll element into view if needed
      await this._scrollIntoViewIfNeeded(element);
      if (signal?.aborted) throw new Error('操作已取消。');
      if (this._config.applyTargetOrigin) {
        await this._revealApplicationField(element);
        await this._waitForApplicationClickTarget(element, signal);
        await element.evaluate(applicationSubmitGuard, 'start' as const);
        guarded = element;
      }

      try {
        // First attempt: Use Puppeteer's click method with timeout
        await Promise.race([
          element.click(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout')), 2000)),
        ]);
        await this._checkAndHandleNavigation();
      } catch (error) {
        // if URLNotAllowedError, throw it
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        if (signal?.aborted) throw new Error('操作已取消。');
        if (guarded && (await guarded.evaluate(applicationSubmitGuard, 'status' as const)))
          throw new Error('已阻止原生表单提交，请由用户亲自提交。');
        // Second attempt: Use evaluate to perform a direct click
        logger.info('Failed to click element, trying again', error);
        try {
          if (this._config.applyTargetOrigin) await this._waitForApplicationClickTarget(element, signal);
          await element.evaluate(el => (el as HTMLElement).click());
        } catch (secondError) {
          // if URLNotAllowedError, throw it
          if (secondError instanceof URLNotAllowedError) {
            throw secondError;
          }
          throw new Error(
            `Failed to click element: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError) throw error;
      throw new Error(
        `Failed to click element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (guarded) {
        submissionBlocked = await guarded.evaluate(applicationSubmitGuard, 'stop' as const).catch(() => false);
      }
    }
    if (submissionBlocked) throw new Error('已阻止原生表单提交，请由用户亲自提交。');
  }

  getSelectorMap(): Map<number, DOMElementNode> {
    // If there is no cached state, return an empty map
    if (this._cachedState === null) {
      return new Map();
    }
    // Otherwise return the cached state's selector map
    return this._cachedState.selectorMap;
  }

  async getElementByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap.get(index);
    if (!element) return null;
    return await this.locateElement(element);
  }

  getDomElementByIndex(index: number): DOMElementNode | null {
    const selectorMap = this.getSelectorMap();
    return selectorMap.get(index) || null;
  }

  isFileUploader(elementNode: DOMElementNode, maxDepth = 3, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    // Check current element
    if (elementNode.tagName === 'input') {
      // Check for file input attributes
      const attributes = elementNode.attributes;
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (attributes['type']?.toLowerCase() === 'file' || !!attributes['accept']) {
        return true;
      }
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if ('tagName' in child) {
          // DOMElementNode type guard
          if (this.isFileUploader(child as DOMElementNode, maxDepth, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async waitForPageLoadState(timeout?: number) {
    const timeoutValue = timeout || 8000;
    await this._puppeteerPage?.waitForNavigation({ timeout: timeoutValue });
  }

  private async _waitForStableNetwork() {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // 招聘官网多是单页应用，岗位和表单内容靠 XHR/fetch 加载；不等它们会在内容渲染前就观察页面。
    const RELEVANT_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe', 'xhr', 'fetch']);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

    const IGNORED_URL_PATTERNS = new Set([
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs
      'cloudfront.net',
      'fastly.net',
    ]);

    const pendingRequests = new Set();
    let lastActivity = Date.now();

    const onRequest = (request: HTTPRequest) => {
      // Filter by resource type
      const resourceType = request.resourceType();
      if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio'
      ) {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now();
    };

    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip streaming content
      if (
        ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
          contentType.includes(t),
        )
      ) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip large responses
      const contentLength = response.headers()['content-length'];
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Add event listeners
    this._puppeteerPage.on('request', onRequest);
    this._puppeteerPage.on('response', onResponse);

    try {
      const startTime = Date.now();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const now = Date.now();
        const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

        if (pendingRequests.size === 0 && timeSinceLastActivity >= this._config.waitForNetworkIdlePageLoadTime) {
          break;
        }

        const elapsedTime = (now - startTime) / 1000; // Convert to seconds
        if (elapsedTime > this._config.maximumWaitPageLoadTime) {
          console.debug(
            `Network timeout after ${this._config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
            Array.from(pendingRequests).map(r => (r as HTTPRequest).url()),
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      this._puppeteerPage.off('request', onRequest);
      this._puppeteerPage.off('response', onResponse);
    }
    console.debug(`Network stabilized for ${this._config.waitForNetworkIdlePageLoadTime} seconds`);
  }

  async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = Date.now();

    // Wait for page load
    try {
      // 刚打开的标签页先等文档加载完，否则加载前已发出的数据请求监听不到。按时间轮询：后台标签页不跑 rAF。
      await this._puppeteerPage
        ?.waitForFunction(() => document.readyState === 'complete', {
          polling: 100,
          timeout: this._config.maximumWaitPageLoadTime * 1000,
        })
        .catch(() => undefined);
      await this._waitForStableNetwork();

      // Check if the loaded URL is allowed
      if (this._puppeteerPage) {
        await this._checkAndHandleNavigation();
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }
      console.warn('Page load failed, continuing...', error);
    }

    // Calculate remaining time to meet minimum wait time
    const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
    const minWaitTime = timeoutOverwrite || this._config.minimumWaitPageLoadTime;
    const remaining = Math.max(minWaitTime - elapsed, 0);

    console.debug(
      `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
    }
  }

  /**
   * Check the current page URL and handle if it's not allowed
   * @throws URLNotAllowedError if the current URL is not allowed
   */
  private async _checkApplyWebsite(): Promise<void> {
    if (!this._config.applyTargetOrigin) return;
    const tab = await chrome.tabs.get(this._tabId);
    let origin = '';
    try {
      origin = new URL(tab.url || '').origin;
    } catch {
      /* Still navigating. */
    }
    if (origin !== this._config.applyTargetOrigin) {
      throw new URLNotAllowedError('官网已跳转到另一个网站。请点击侧栏“继续自动填写”，继续本次填写。');
    }
  }

  private async _checkAndHandleNavigation(): Promise<void> {
    await this._checkApplyWebsite();
    if (!this._puppeteerPage) {
      return;
    }

    const currentUrl = this._puppeteerPage.url();
    if (!isUrlAllowed(currentUrl, this._config.allowedUrls, this._config.deniedUrls)) {
      const errorMessage = `URL: ${currentUrl} is not allowed`;
      logger.error(errorMessage);

      // Keep the destination visible so the user can complete login or grant
      // its website permission. Never replace their page with about:blank.
      throw new URLNotAllowedError(errorMessage);
    }
  }
}
