import { openUnknownControl, type UnknownTarget } from './unknownControl';
import { collectFormAudit, revealAuditLocation, type AuditLocation } from './formAudit';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import 'webextension-polyfill';
import { readApplicationDialog } from './applicationDialogs';
import { autoUploadResumeInPage, uploadApplicationFile, verifyUploadedAttachment } from './attachments';
import { describeClickObstruction, isApplicationClickTarget, recoverApplicationClickTarget } from './clickTarget';
import { pickApplicationDate, pickApplicationDateRange } from './datePicker';
import { readCalendarPanel } from './datePanel';
import { dismissCalendarPopup } from './popupDismissal';
import { ApplicationFieldTransition } from './fieldTransition';
import type { DOMElementNode } from './dom/views';
import { listControlOptions, listCustomOptions, searchControlOptions } from './dropdownOptions';
import { getDropdownOptions, selectCustomOption, selectCustomOptions, selectDropdownOption } from './dropdownSelection';
import { locateElement, scrollIntoViewIfNeeded } from './elementLocation';
import { fieldHighlightCSS, revealApplicationField } from './fieldFeedback';
import type { FormControlState } from './formControls';
import { type FormWriteResult } from './formFill';
import { clickApplicationText, clickElementNode } from './pageClicks';
import type { PageDriver } from './pageDriver';
import {
  applicationControl,
  getFormFingerprint,
  readApplicationControl,
  readTaggedControls,
  revealApplicationControl,
  tagApplicationElements,
} from './pageInspection';
import { waitForPageAndFramesLoad, waitForPageLoadState } from './pageLoading';
import { goBack, goForward, navigateTo, refreshPage, sendKeys } from './pageNavigation';
import {
  getElementScrollInfo,
  scrollBy,
  scrollToNextPage,
  scrollToPercent,
  scrollToPreviousPage,
  scrollToText,
} from './pageScrolling';
import { PageSession } from './pageSession';
import { clickApplicationToggle, inputTextElementNode, selectNativeOption } from './textControls';

export { build_initial_state, CachedStateClickableElementsHashes } from './pageSession';
export interface ApplicationControlOptions {
  allowReplace?: boolean;
  observedValue?: string;
  signal?: AbortSignal;
  resolveOption?: (evidence: { requested: string; candidates: string[]; fieldText: string; signal?: AbortSignal }) => Promise<string | null>;
  /** Debug telemetry contains control state and counts, never the field value or option text. */
  traceDropdown?: (phase: string, detail: string) => void;
}

export default class Page extends PageSession {
  private operations?: PageDriver;
  private fieldTransition?: ApplicationFieldTransition;

  readApplicationDialog(confirmDraftRemoval = false, owner?: DOMElementNode) {
    return readApplicationDialog(this.driver, confirmDraftRemoval, owner);
  }

  prepareApplicationField(node: DOMElementNode, signal?: AbortSignal): Promise<boolean> {
    return (this.fieldTransition ??= new ApplicationFieldTransition()).prepare(this.driver, node, signal);
  }

  /** Whether the previous field's popup still blocks the next field (no page change). */
  applicationPopupBlocking(): Promise<boolean> {
    return (this.fieldTransition ??= new ApplicationFieldTransition()).blocking(this.driver);
  }

  private get driver(): PageDriver {
    return (this.operations ??= {
      page: this,
      get puppeteer() {
        return this.page._puppeteerPage;
      },
      get config() {
        return this.page._config;
      },
      checkTarget: () => this._checkApplyWebsite(),
      afterNavigation: () => this._checkAndHandleNavigation(),
      refreshState: (vision, focus) => this._updateState(vision, focus),
      reveal: element => this._revealApplicationField(element),
      waitForClickTarget: (element, signal) => this._waitForApplicationClickTarget(element, signal),
      waitForDropdownClosed: (listed, signal) => this._waitForDropdownClosed(listed, signal),
      scrollIntoView: (element, timeout) => this._scrollIntoViewIfNeeded(element, timeout),
    });
  }

  openUnknownControl(target: UnknownTarget, signal: AbortSignal) { return openUnknownControl(this.driver, target, signal); }

  async prepareApplicationControlRecovery(node: DOMElementNode, signal: AbortSignal): Promise<boolean> {
    const { element } = await applicationControl(this.driver, node);
    try {
      signal.throwIfAborted();
      await this.driver.reveal(element);
      if (!(await dismissCalendarPopup(this.driver, element, () => readCalendarPanel(element), signal)))
        return false;
      await this.driver.waitForClickTarget(element, signal);
      return true;
    } finally { await element.dispose(); }
  }

  collectFormAudit(signal: AbortSignal) { return collectFormAudit(this.driver, signal); }

  revealAuditLocation(location: AuditLocation) { return revealAuditLocation(this.driver, location); }

  getElementScrollInfo(elementNode: DOMElementNode): Promise<[number, number, number]> {
    return getElementScrollInfo(this.driver, elementNode);
  }

  navigateTo(url: string): Promise<void> {
    return navigateTo(this.driver, url);
  }

  refreshPage(): Promise<void> {
    return refreshPage(this.driver);
  }

  goBack(): Promise<void> {
    return goBack(this.driver);
  }

  goForward(): Promise<void> {
    return goForward(this.driver);
  }

  scrollToPercent(yPercent: number, elementNode?: DOMElementNode): Promise<void> {
    return scrollToPercent(this.driver, yPercent, elementNode);
  }

  scrollBy(y: number, elementNode?: DOMElementNode): Promise<void> {
    return scrollBy(this.driver, y, elementNode);
  }

  scrollToPreviousPage(elementNode?: DOMElementNode): Promise<void> {
    return scrollToPreviousPage(this.driver, elementNode);
  }

  scrollToNextPage(elementNode?: DOMElementNode): Promise<void> {
    return scrollToNextPage(this.driver, elementNode);
  }

  sendKeys(keys: string): Promise<void> {
    return sendKeys(this.driver, keys);
  }

  scrollToText(text: string, nth: number = 1): Promise<boolean> {
    return scrollToText(this.driver, text, nth);
  }

  getDropdownOptions(index: number): Promise<Array<{ index: number; text: string; value: string }>> {
    return getDropdownOptions(this.driver, index);
  }

  selectDropdownOption(
    index: number,
    text: string,
    options: ApplicationControlOptions = {},
  ): Promise<string | FormWriteResult> {
    return selectDropdownOption(this.driver, index, text, options);
  }

  locateElement(element: DOMElementNode, scroll = true): Promise<ElementHandle | null> {
    return locateElement(this.driver, element, scroll);
  }

  inputTextElementNode(
    useVision: boolean,
    elementNode: DOMElementNode,
    text: string,
    options: ApplicationControlOptions = {},
  ): Promise<void | FormWriteResult> {
    return inputTextElementNode(this.driver, useVision, elementNode, text, options);
  }

  private _applicationControl(
    node: DOMElementNode,
  ): Promise<{ element: ElementHandle; identity: Record<string, string> }> {
    return applicationControl(this.driver, node);
  }

  formFingerprint(): Promise<string | null> {
    return getFormFingerprint(this.driver);
  }

  tagApplicationElements(xpaths: string[], nodes?: DOMElementNode[]): Promise<(string | null)[]> {
    return tagApplicationElements(this.driver, xpaths, nodes);
  }

  readTaggedControls(): Promise<Map<string, FormControlState & { options?: string[] }>> {
    return readTaggedControls(this.driver);
  }

  selectApplicationOption(node: DOMElementNode, text: string, options: ApplicationControlOptions = {}) {
    return selectNativeOption(this.driver, node, text, options);
  }

  readApplicationControl(node: DOMElementNode, display = false) {
    return readApplicationControl(this.driver, node, display);
  }

  private async _revealApplicationField(element: ElementHandle) {
    await element.evaluate(revealApplicationField, fieldHighlightCSS);
  }

  revealApplicationControl(node: DOMElementNode): Promise<void> {
    return revealApplicationControl(this.driver, node);
  }

  private async _waitForApplicationClickTarget(element: ElementHandle, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('操作已取消。');
    await element.scrollIntoView();
    let lastOffset = { x: 0, y: 0 };
    for (let poll = 0; poll < 16; poll++) {
      if (signal?.aborted) throw new Error('操作已取消。');
      const point = await element.clickablePoint();
      const box = await element.boundingBox();
      if (box) {
        lastOffset = { x: point.x - box.x, y: point.y - box.y };
        // Puppeteer reports main-frame coordinates; DOM hit testing uses the element's own document.
        if (await element.evaluate(isApplicationClickTarget, lastOffset)) return;
        if (poll < 2 && await element.evaluate(recoverApplicationClickTarget, lastOffset)) continue;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const obstruction = await element.evaluate(describeClickObstruction, lastOffset).catch(() => '');
    throw new Error(
      `CLICK_TARGET_OBSCURED: 目标仍被上层浮层/遮罩遮挡${obstruction ? `（${obstruction}）` : ''}，未执行点击。若属于新手引导请先点击引导按钮（如“下一步”/关闭）；若属于意向部门/城市选择等前置弹窗且需要用户决策，请直接调用 ask_user(kind=manual_action) 请用户在网页完成操作后继续，不要重复点击同一被遮挡控件。`,
    );
  }

  private async _waitForDropdownClosed(listed: () => Promise<{ open: boolean }>, signal?: AbortSignal) {
    for (let poll = 0; poll < 40; poll++) {
      if (signal?.aborted) throw new Error('操作已取消。');
      if (!(await listed()).open) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('DROPDOWN_STILL_OPEN: 下拉弹层尚未关闭，不能继续当作已收起。');
  }

  listCustomOptions(node: DOMElementNode, signal?: AbortSignal): Promise<string[]> {
    return listCustomOptions(this.driver, node, signal);
  }

  listControlOptions(node: DOMElementNode, signal?: AbortSignal): Promise<string[]> {
    return listControlOptions(this.driver, node, signal);
  }

  searchControlOptions(node: DOMElementNode, query: string, signal?: AbortSignal): Promise<string[]> {
    return searchControlOptions(this.driver, node, query, signal);
  }

  selectCustomOptions(
    node: DOMElementNode,
    items: string[],
    options: ApplicationControlOptions = {},
  ): Promise<FormWriteResult> {
    return selectCustomOptions(this.driver, node, items, options);
  }

  selectCustomOption(
    node: DOMElementNode,
    text: string,
    options: ApplicationControlOptions = {},
  ): Promise<FormWriteResult> {
    return selectCustomOption(this.driver, node, text, options);
  }

  private dateDriver() {
    return {
      page: this._puppeteerPage,
      resolve: (node: DOMElementNode) => this._applicationControl(node),
      checkTarget: () => this._checkApplyWebsite(),
      reveal: (element: ElementHandle) => this._revealApplicationField(element),
      waitForClickTarget: (element: ElementHandle, signal?: AbortSignal) =>
        this._waitForApplicationClickTarget(element, signal),
    };
  }

  pickApplicationDate(node: DOMElementNode, value: string, options: ApplicationControlOptions = {}) {
    return pickApplicationDate(this.dateDriver(), node, value, options);
  }

  async pickApplicationDateRange(
    nodes: [DOMElementNode, DOMElementNode],
    values: [string, string],
    options: [ApplicationControlOptions, ApplicationControlOptions],
  ) {
    if (!(await this.prepareApplicationField(nodes[0], options[0].signal))) {
      return values.map(value => ({ status: 'failed', code: 'PREVIOUS_POPUP_OPEN',
        message: '上一项的弹层尚未关闭，起止日期未操作。请收起弹层后重试。',
        adapter: 'field-transition', attempts: 0, actualValue: '', desiredValue: value })) as [FormWriteResult, FormWriteResult];
    }
    return pickApplicationDateRange(this.dateDriver(), nodes, values, options);
  }

  clickApplicationText(text: string, after: string | null, signal?: AbortSignal): Promise<boolean> {
    return clickApplicationText(this.driver, text, after, signal);
  }

  clickApplicationToggle(node: DOMElementNode, signal?: AbortSignal, checked?: boolean): Promise<FormWriteResult> {
    return clickApplicationToggle(this.driver, node, signal, checked);
  }

  private _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
    return scrollIntoViewIfNeeded(element, timeout);
  }

  clickElementNode(useVision: boolean, elementNode: DOMElementNode, signal?: AbortSignal): Promise<void> {
    return clickElementNode(this.driver, useVision, elementNode, signal);
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

  uploadApplicationFile(
    elementNode: DOMElementNode,
    file: { fileName: string; mimeType: string; base64: string },
    options?: { dismissParseModal?: boolean },
  ): Promise<{
    ok: boolean;
    fileName?: string;
    reason?: string;
    alreadyUploaded?: boolean;
    modalOpened?: boolean;
    modalAutoDismissed?: boolean;
  }> {
    return uploadApplicationFile(this.driver, elementNode, file, options);
  }

  verifyUploadedAttachment(elementNode: DOMElementNode): Promise<boolean> {
    return verifyUploadedAttachment(this.driver, elementNode);
  }

  autoUploadResumeInPage(
    file: { fileName: string; mimeType: string; base64: string },
    options?: { dismissParseModal?: boolean },
  ): Promise<{
    ok: boolean;
    fileName?: string;
    alreadyUploaded?: boolean;
    modalOpened?: boolean;
    modalAutoDismissed?: boolean;
  }> {
    return autoUploadResumeInPage(this.driver, file, options);
  }

  waitForPageLoadState(timeout?: number) {
    return waitForPageLoadState(this.driver, timeout);
  }

  waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    return waitForPageAndFramesLoad(this.driver, timeoutOverwrite);
  }
}
