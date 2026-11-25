import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type Page from './page';
import { type BrowserContextConfig, type PageState } from './views';

/** Operations that need the current tab connection use getters so redirects and reattachment stay visible. */
export interface PageDriver {
  readonly page: Page;
  readonly puppeteer: PuppeteerPage | null;
  readonly config: BrowserContextConfig;
  checkTarget(): Promise<void>;
  afterNavigation(): Promise<void>;
  refreshState(useVision?: boolean, focusElement?: number): Promise<PageState>;
  reveal(element: ElementHandle): Promise<void>;
  waitForClickTarget(element: ElementHandle, signal?: AbortSignal): Promise<void>;
  waitForDropdownClosed(listed: () => Promise<{ open: boolean }>, signal?: AbortSignal): Promise<void>;
  scrollIntoView(element: ElementHandle, timeout?: number): Promise<void>;
}
