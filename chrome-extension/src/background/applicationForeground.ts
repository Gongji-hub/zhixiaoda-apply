export interface ApplicationPauseState {
  paused: boolean;
  background: boolean;
  manual: boolean;
}

/** Manual intent survives tab changes. Window focus alone does not mean the page is hidden. */
export class ApplicationForeground {
  private tabId: number | null = null;
  private windowId: number | null = null;
  private manual = false;
  private background = false;
  private revision = 0;
  private last = '';

  constructor(private changed: (state: ApplicationPauseState) => void) {
    chrome.tabs.onActivated.addListener(info => {
      if (this.tabId === null) return;
      if (this.windowId === null) { void this.refresh(); return; }
      if (info.windowId !== this.windowId) return;
      if (info.tabId !== this.tabId) {
        ++this.revision;
        this.background = true;
        this.publish();
      } else void this.refresh();
    });
    chrome.windows.onBoundsChanged.addListener(window => {
      if (this.tabId !== null && (this.windowId === null || window.id === this.windowId)) void this.refresh();
    });
    chrome.tabs.onAttached.addListener(tabId => {
      if (tabId === this.tabId) void this.refresh();
    });
  }

  async start(tabId: number, manual = false) {
    this.stop();
    this.tabId = tabId;
    this.manual = manual;
    // Hold execution until the current tab state has been checked.
    this.background = true;
    this.publish();
    await this.refresh();
  }

  async move(tabId: number) {
    this.tabId = tabId;
    this.background = true;
    this.publish();
    await this.refresh();
  }

  async setManual(paused: boolean) {
    if (paused) {
      this.manual = true;
      this.publish();
    } else {
      // Recheck before releasing a manual pause, including a resume from another tab.
      await this.refresh();
      this.manual = false;
      this.publish();
    }
  }

  async refresh() {
    const tabId = this.tabId;
    const revision = ++this.revision;
    if (tabId === null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      const window = await chrome.windows.get(tab.windowId);
      if (revision !== this.revision || tabId !== this.tabId) return;
      this.windowId = tab.windowId;
      this.background = !tab.active || window.state === 'minimized';
    } catch {
      if (revision !== this.revision || tabId !== this.tabId) return;
      this.background = true;
    }
    this.publish();
  }

  async returnToTarget() {
    const tabId = this.tabId;
    if (tabId === null) return;
    const tab = await chrome.tabs.get(tabId);
    const window = await chrome.windows.get(tab.windowId);
    if (tabId !== this.tabId) return;
    await chrome.windows.update(tab.windowId, {
      focused: true,
      ...(window.state === 'minimized' ? { state: 'normal' as const } : {}),
    });
    await chrome.tabs.update(tabId, { active: true });
    await this.refresh();
  }

  stop() {
    ++this.revision;
    this.tabId = null;
    this.windowId = null;
    this.manual = false;
    this.background = false;
    this.last = '';
  }

  private publish() {
    if (this.tabId === null) return;
    const state = { paused: this.manual || this.background, background: this.background, manual: this.manual };
    const key = JSON.stringify(state);
    if (key === this.last) return;
    this.last = key;
    this.changed(state);
  }
}
