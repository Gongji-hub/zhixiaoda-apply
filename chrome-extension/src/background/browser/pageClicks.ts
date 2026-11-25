import { createLogger } from '@src/background/log';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import { needsUserInteraction } from '../agent/actions/interactionPolicy';
import type { DOMElementNode } from './dom/views';
import { allSearchContexts } from './elementLocation';
import { applicationSubmitGuard, markTextTarget } from './formControls';
import type { PageDriver } from './pageDriver';
import { URLNotAllowedError } from './views';

const logger = createLogger('Page');

export async function clickApplicationText(
  driver: PageDriver,
  text: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!driver.puppeteer) return false;
  await driver.checkTarget();
  const mark = `t${Date.now()}`;
  let target: ElementHandle | null = null;
  for (const ctx of allSearchContexts(driver)) {
    if (typeof ctx.$ !== 'function') continue;
    const body = await ctx.$('body').catch(() => null);
    if (!body) continue;
    const found = await body.evaluate(markTextTarget, { text, after, mark }).catch(() => false);
    await body.dispose().catch(() => undefined);
    if (found) {
      target = await ctx.$(`[data-qz-click="${mark}"]`).catch(() => null);
      if (target) break;
    }
  }
  if (!target) return false;
  try {
    if (signal?.aborted) throw new Error('操作已取消。');
    await driver.scrollIntoView(target);
    await driver.reveal(target);
    await driver.waitForClickTarget(target, signal);
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

export async function clickElementNode(
  driver: PageDriver,
  useVision: boolean,
  elementNode: DOMElementNode,
  signal?: AbortSignal,
): Promise<void> {
  if (driver.config.applyTargetOrigin && needsUserInteraction(elementNode, 'open_interface'))
    throw new Error('MANUAL_ACTION_REQUIRED: 受保护控件不能通过普通点击操作，请使用对应字段工具或请求用户处理。');
  if (!driver.puppeteer) {
    throw new Error('Puppeteer is not connected');
  }

  let guarded: ElementHandle | null = null;
  let submissionBlocked = false;
  try {
    // Highlight before clicking
    // if (elementNode.highlightIndex !== null) {
    //   await driver.refreshState(useVision, elementNode.highlightIndex);
    // }

    const element = await driver.page.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    const anchor = driver.config.applyTargetOrigin && elementNode.tagName?.toLowerCase() === 'a';
    if (anchor) {
      const href = await element.evaluate(el => el.getAttribute('href'));
      if (href !== (elementNode.attributes.href ?? null)) throw new Error('控件的链接已变化，请重新观察。');
      // Some UI libraries use an anchor without href for an in-page button.
      // Only anchors with a destination use the navigation path.
      if (href !== null) {
        if (!href.trim()) throw new Error('网页链接没有有效地址，请重新观察。');
        const url = new URL(href, driver.page.getCachedState()?.url || driver.config.applyTargetOrigin);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('链接需要用户亲自操作。');
        signal?.throwIfAborted();
        await driver.page.navigateTo(url.href);
        await driver.afterNavigation();
        return;
      }
    }

    const checkBeforeClick = async () => {
      signal?.throwIfAborted();
      if (anchor && await element.evaluate(el => el.hasAttribute('href') || el.hasAttribute('download'))) {
        throw new URLNotAllowedError('控件已变成链接，请重新观察。');
      }
      signal?.throwIfAborted();
    };

    // Scroll element into view if needed
    await driver.scrollIntoView(element);
    if (signal?.aborted) throw new Error('操作已取消。');
    if (driver.config.applyTargetOrigin) {
      await driver.reveal(element);
      await driver.waitForClickTarget(element, signal);
      await element.evaluate(applicationSubmitGuard, 'start' as const);
      guarded = element;
    }

    try {
      await element
        .evaluate(el => {
          const target = el as HTMLElement & { __qzClicked?: boolean };
          target.__qzClicked = false;
          target.addEventListener(
            'click',
            () => {
              target.__qzClicked = true;
            },
            { capture: true, once: true },
          );
        })
        .catch(() => undefined);
      // First attempt: Use Puppeteer's click method with timeout
      await checkBeforeClick();
      await Promise.race([
        element.click(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout')), 2000)),
      ]);
      const clicked = await element
        .evaluate(el => {
          const target = el as HTMLElement & { __qzClicked?: boolean };
          return !target.isConnected || target.__qzClicked === true;
        })
        .catch(() => true);
      if (!clicked) {
        if (driver.config.applyTargetOrigin) await driver.waitForClickTarget(element, signal);
        await checkBeforeClick();
        await element.evaluate(el => (el as HTMLElement).click());
      }
      await driver.afterNavigation();
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
        if (driver.config.applyTargetOrigin) await driver.waitForClickTarget(element, signal);
        await checkBeforeClick();
        await element.evaluate(el => (el as HTMLElement).click());
        await driver.afterNavigation();
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
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('CLICK_TARGET_OBSCURED') || message.startsWith('Failed to click element:')) {
      throw new Error(message);
    }
    throw new Error(`Failed to click element [${elementNode.tagName}]: ${message}`);
  } finally {
    if (guarded) {
      submissionBlocked = await guarded.evaluate(applicationSubmitGuard, 'stop' as const).catch(() => false);
    }
  }
  if (submissionBlocked) throw new Error('已阻止原生表单提交，请由用户亲自提交。');
}
