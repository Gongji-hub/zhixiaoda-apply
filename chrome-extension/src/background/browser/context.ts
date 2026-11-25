import 'webextension-polyfill';
import {
  type BrowserContextConfig,
  type BrowserState,
  DEFAULT_BROWSER_CONTEXT_CONFIG,
  type TabInfo,
  URLNotAllowedError,
} from './views';
import Page, { build_initial_state } from './page';
import { createLogger } from '@src/background/log';
import { isUrlAllowed } from './util';
import { analytics } from '../services/analytics';

const logger = createLogger('BrowserContext');

function siteRoot(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoPartTld = /^(?:com|net|org|gov|edu|co)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoPartTld ? -3 : -2).join('.');
}

function sameApplySite(url: URL, targetOrigin?: string): boolean {
  if (url.protocol !== 'https:' || !targetOrigin) return false;
  if (url.origin === targetOrigin) return true;
  try {
    const targetHost = new URL(targetOrigin).hostname.toLowerCase();
    return (
      siteRoot(url.hostname) === siteRoot(targetHost) ||
      decodeURIComponent(url.search).toLowerCase().includes(targetHost)
    );
  } catch {
    return false;
  }
}

export default class BrowserContext {
  private _config: BrowserContextConfig;
  private _currentTabId: number | null = null;
  public onApplyTargetChanged?: (tabId: number) => Promise<void>;
  private _attachedPages: Map<number, Page> = new Map();
  private _relatedTabIds: Set<number> = new Set();
  private _rootOrigin?: string;

  constructor(config: Partial<BrowserContextConfig>) {
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    if (config.applyTargetTabId !== undefined) this._relatedTabIds.add(config.applyTargetTabId);
    if (config.applyTargetOrigin) this._rootOrigin = config.applyTargetOrigin;
  }

  public getConfig(): BrowserContextConfig {
    return this._config;
  }

  public updateConfig(config: Partial<BrowserContextConfig>): void {
    this._config = { ...this._config, ...config };
    if (config.applyTargetTabId !== undefined) this._relatedTabIds.add(config.applyTargetTabId);
    if (config.applyTargetOrigin && !this._rootOrigin) this._rootOrigin = config.applyTargetOrigin;
    // 页面创建时复制了配置；不同步的话，任务开始后才设的整页观察等设置对已打开的页面不生效。
    for (const page of this._attachedPages.values()) page.updateConfig(config);
  }

  public updateCurrentTabId(tabId: number): void {
    // only update tab id, but don't attach it.
    this._currentTabId = tabId;
  }

  private async _getOrCreatePage(tab: chrome.tabs.Tab, forceUpdate = false): Promise<Page> {
    if (!tab.id) {
      throw new Error('Tab ID is not available');
    }

    const existingPage = this._attachedPages.get(tab.id);
    if (existingPage) {
      logger.info('getOrCreatePage', tab.id, 'already attached');
      if (!forceUpdate) {
        return existingPage;
      }
      // detach the page and remove it from the attached pages if forceUpdate is true
      await existingPage.detachPuppeteer();
      this._attachedPages.delete(tab.id);
    }
    logger.info('getOrCreatePage', tab.id, 'creating new page');
    const page = new Page(tab.id, tab.url || '', tab.title || '', this._config);
    page.onApplyOriginChanged = async origin => {
      if (this._config.applyTargetOrigin === origin) return;
      this.updateConfig({ applyTargetOrigin: origin });
      await this.onApplyTargetChanged?.(tab.id!);
    };
    return page;
  }

  public async cleanup(): Promise<void> {
    // detach all pages
    for (const page of this._attachedPages.values()) {
      await page.removeHighlight();
      await page.detachPuppeteer();
    }
    this._attachedPages.clear();
    this._currentTabId = null;
    this._relatedTabIds.clear();
    this._rootOrigin = undefined;
  }

  public async attachPage(page: Page): Promise<boolean> {
    // check if page is already attached
    if (this._attachedPages.has(page.tabId)) {
      logger.info('attachPage', page.tabId, 'already attached');
      return true;
    }

    if (await page.attachPuppeteer()) {
      logger.info('attachPage', page.tabId, 'attached');
      // add page to managed pages
      this._attachedPages.set(page.tabId, page);
      return true;
    }
    return false;
  }

  public async detachPage(tabId: number): Promise<void> {
    // detach page
    const page = this._attachedPages.get(tabId);
    if (page) {
      await page.detachPuppeteer();
      // remove page from managed pages
      this._attachedPages.delete(tabId);
    }
  }

  /** Follow an active related tab on the target site, never an unrelated active tab. */
  public async reconcileApplyTarget(allowSameSiteActive = false): Promise<void> {
    const targetId = this._config.applyTargetTabId;
    if (!targetId) return;
    this._relatedTabIds.add(targetId);
    const tabs = await chrome.tabs.query({ windowId: this._config.applyTargetWindowId });
    const matchesSite = (urlStr?: string) => {
      if (!urlStr) return false;
      try {
        const url = new URL(urlStr);
        return (
          sameApplySite(url, this._config.applyTargetOrigin) ||
          (this._rootOrigin ? sameApplySite(url, this._rootOrigin) : false)
        );
      } catch {
        return false;
      }
    };
    let added = true;
    while (added) {
      added = false;
      for (const tab of tabs) {
        const tabUrl = tab.url || (tab as { pendingUrl?: string }).pendingUrl;
        if (
          tab.id !== undefined &&
          !this._relatedTabIds.has(tab.id) &&
          ((tab.openerTabId !== undefined && this._relatedTabIds.has(tab.openerTabId)) ||
            (allowSameSiteActive && tab.active)) &&
          matchesSite(tabUrl)
        ) {
          this._relatedTabIds.add(tab.id);
          added = true;
        }
      }
    }
    const relatedTabs = tabs.filter(tab => {
      const tabUrl = tab.url || (tab as { pendingUrl?: string }).pendingUrl;
      return tab.id !== undefined && this._relatedTabIds.has(tab.id) && matchesSite(tabUrl);
    });
    const parent = tabs.find(tab => tab.id === targetId);
    const activeRelated = relatedTabs.filter(tab => tab.active);
    const nextTarget =
      activeRelated.length === 1
        ? activeRelated[0]
        : parent
          ? parent
          : relatedTabs.length >= 1
            ? relatedTabs[relatedTabs.length - 1]
            : undefined;
    if (nextTarget?.id) {
      const nextUrl = nextTarget.url || (nextTarget as { pendingUrl?: string }).pendingUrl;
      const nextOrigin = nextUrl ? new URL(nextUrl).origin : this._config.applyTargetOrigin!;
      const changed = nextTarget.id !== targetId || nextOrigin !== this._config.applyTargetOrigin;
      this.updateConfig({ applyTargetTabId: nextTarget.id, applyTargetOrigin: nextOrigin });
      this._currentTabId = nextTarget.id;
      if (changed) {
        await this.onApplyTargetChanged?.(nextTarget.id);
      }
    } else if (parent) {
      this._currentTabId = targetId;
    } else {
      throw new URLNotAllowedError('本次岗位标签页已关闭或无法确认后续页面。自动操作已停止，请在目标页面重新开始。');
    }
  }

  public async assertApplyTarget(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    let origin = '';
    try {
      const url = new URL(tab.url || '');
      if (url.protocol === 'https:') origin = url.origin;
    } catch { /* Incomplete navigation. */ }
    if (tabId !== this._config.applyTargetTabId || !origin) {
      throw new URLNotAllowedError('目标页面发生变化，已停止自动操作。请检查当前网站后继续。');
    }
    if (origin !== this._config.applyTargetOrigin) {
      this.updateConfig({ applyTargetOrigin: origin });
      await this.onApplyTargetChanged?.(tabId);
    }
  }

  public async formFingerprint(): Promise<string | null> {
    return (await this.getCurrentPage()).formFingerprint();
  }

  public async getCurrentPage(): Promise<Page> {
    await this.reconcileApplyTarget();
    // 1. If _currentTabId not set, query the active tab and attach it
    if (!this._currentTabId) {
      let activeTab: chrome.tabs.Tab;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        // open a new tab with blank page
        const newTab = await chrome.tabs.create({ url: this._config.homePageUrl });
        if (!newTab.id) {
          // this should rarely happen
          throw new Error('No tab ID available');
        }
        activeTab = newTab;
      } else {
        activeTab = tab;
      }
      logger.info('active tab', activeTab.id, activeTab.url, activeTab.title);
      const page = await this._getOrCreatePage(activeTab);
      await this.attachPage(page);
      this._currentTabId = activeTab.id || null;
      return page;
    }

    // 2. If _currentTabId is set but not in attachedPages, attach the tab
    const existingPage = this._attachedPages.get(this._currentTabId);
    if (!existingPage) {
      const tab = await chrome.tabs.get(this._currentTabId);
      const page = await this._getOrCreatePage(tab);
      // set current tab id to null if the page is not attached successfully
      await this.attachPage(page);
      return page;
    }

    // 3. Return existing page from attachedPages
    return existingPage;
  }

  /**
   * Get all tab IDs from the browser and the current window.
   * @returns A set of tab IDs.
   */
  public async getAllTabIds(): Promise<Set<number>> {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return new Set(tabs.map(tab => tab.id).filter(id => id !== undefined));
  }

  /**
   * Wait for tab events to occur after a tab is created or updated.
   * @param tabId - The ID of the tab to wait for events on.
   * @param options - An object containing options for the wait.
   * @returns A promise that resolves when the tab events occur.
   */
  private async waitForTabEvents(
    tabId: number,
    options: {
      waitForUpdate?: boolean;
      waitForActivation?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const { waitForUpdate = true, waitForActivation = true, timeoutMs = 5000 } = options;

    const promises: Promise<void>[] = [];

    if (waitForUpdate) {
      const updatePromise = new Promise<void>(resolve => {
        let hasUrl = false;
        let hasTitle = false;
        let isComplete = false;

        const onUpdatedHandler = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId !== tabId) return;

          if (changeInfo.url) hasUrl = true;
          if (changeInfo.title) hasTitle = true;
          if (changeInfo.status === 'complete') isComplete = true;

          // Resolve when we have all the information we need
          if (hasUrl && hasTitle && isComplete) {
            chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdatedHandler);

        // Check current state
        chrome.tabs.get(tabId).then(tab => {
          if (tab.url) hasUrl = true;
          if (tab.title) hasTitle = true;
          if (tab.status === 'complete') isComplete = true;

          if (hasUrl && hasTitle && isComplete) {
            chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
            resolve();
          }
        });
      });
      promises.push(updatePromise);
    }

    if (waitForActivation) {
      const activatedPromise = new Promise<void>(resolve => {
        const onActivatedHandler = (activeInfo: chrome.tabs.TabActiveInfo) => {
          if (activeInfo.tabId === tabId) {
            chrome.tabs.onActivated.removeListener(onActivatedHandler);
            resolve();
          }
        };
        chrome.tabs.onActivated.addListener(onActivatedHandler);

        // Check current state
        chrome.tabs.get(tabId).then(tab => {
          if (tab.active) {
            chrome.tabs.onActivated.removeListener(onActivatedHandler);
            resolve();
          }
        });
      });
      promises.push(activatedPromise);
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tab operation timed out after ${timeoutMs} ms`)), timeoutMs),
    );

    await Promise.race([Promise.all(promises), timeoutPromise]);
  }

  public async switchTab(tabId: number): Promise<Page> {
    logger.info('switchTab', tabId);

    await chrome.tabs.update(tabId, { active: true });
    await this.waitForTabEvents(tabId, { waitForUpdate: false });

    const page = await this._getOrCreatePage(await chrome.tabs.get(tabId));
    await this.attachPage(page);
    this._currentTabId = tabId;
    return page;
  }

  public async navigateTo(url: string): Promise<void> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    // Track domain visit for analytics
    void analytics.trackDomainVisit(url);

    const page = await this.getCurrentPage();
    if (!page) {
      await this.openTab(url);
      return;
    }
    // if page is attached, use puppeteer to navigate to the url
    if (page.attached) {
      await page.navigateTo(url);
      return;
    }
    //  Use chrome.tabs.update only if the page is not attached
    const tabId = page.tabId;
    // Update tab and wait for events
    await chrome.tabs.update(tabId, { url, active: true });
    await this.waitForTabEvents(tabId);

    // Reattach the page after navigation completes
    const updatedPage = await this._getOrCreatePage(await chrome.tabs.get(tabId), true);
    await this.attachPage(updatedPage);
    this._currentTabId = tabId;
  }

  public async openTab(url: string): Promise<Page> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`Open tab failed. URL: ${url} is not allowed`);
    }

    // Create the new tab
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) {
      throw new Error('No tab ID available');
    }
    // Wait for tab events
    await this.waitForTabEvents(tab.id);

    // Get updated tab information
    const updatedTab = await chrome.tabs.get(tab.id);
    // Create and attach the page after tab is fully loaded and activated
    const page = await this._getOrCreatePage(updatedTab);
    await this.attachPage(page);
    this._currentTabId = tab.id;

    return page;
  }

  public async closeTab(tabId: number): Promise<void> {
    await this.detachPage(tabId);
    await chrome.tabs.remove(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  /**
   * Remove a tab from the attached pages map. This will not run detachPuppeteer.
   * @param tabId - The ID of the tab to remove.
   */
  public removeAttachedPage(tabId: number): void {
    this._attachedPages.delete(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  public async getTabInfos(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    const tabInfos: TabInfo[] = [];

    for (const tab of tabs) {
      if (this._config.applyTargetTabId && tab.id !== this._config.applyTargetTabId) continue;
      if (tab.id && tab.url && tab.title) {
        tabInfos.push({
          id: tab.id,
          url: tab.url,
          title: tab.title,
        });
      }
    }
    return tabInfos;
  }

  public async getCachedState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    const currentPage = await this.getCurrentPage();

    let pageState = !currentPage ? build_initial_state() : currentPage.getCachedState();
    if (!pageState) {
      pageState = await currentPage.getState(useVision, cacheClickableElementsHashes);
    }

    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
    };
    return browserState;
  }

  public async getState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    const currentPage = await this.getCurrentPage();

    const pageState = !currentPage
      ? build_initial_state()
      : await currentPage.getState(useVision, cacheClickableElementsHashes);
    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
      // browser_errors: [],
    };
    return browserState;
  }

  public async removeHighlight(): Promise<void> {
    const page = await this.getCurrentPage();
    if (page) {
      await page.removeHighlight();
    }
  }
}
