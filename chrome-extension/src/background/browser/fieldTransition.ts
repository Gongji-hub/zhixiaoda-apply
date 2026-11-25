import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { DOMElementNode } from './dom/views';
import type { PageDriver } from './pageDriver';
import { applicationControl } from './pageInspection';
import { customDropdown } from './dropdownOptions';
import { readCalendarPanel } from './datePanel';
import { dismissCalendarPopup } from './popupDismissal';
import { CALENDAR_ADAPTERS } from './calendarAdapters';
import { readLiveControl } from './formControls';
import { URLNotAllowedError } from './views';
import { explorationPaused, ExplorationStopped } from '../controlExploration';
import { centerApplicationField } from './fieldViewport';

/** Keep the actual last control, not a selector that could now name another row.
 * A failed dismissal is tried once; the write entry then asks the user to close it
 * (see `blocking`) instead of failing every later field. */
export class ApplicationFieldTransition {
  private previous?: ElementHandle;
  private dismissalFailed = false;

  /** Read-only: whether the last entered field still has its own popup open. */
  async blocking(driver: PageDriver): Promise<boolean> {
    const previous = this.previous;
    if (!previous || !(await previous.evaluate(el => el.isConnected).catch(() => false))) return false;
    const control = await readLiveControl(previous, true);
    if (control.datePicker) return (await readCalendarPanel(previous)).open;
    const dropdown = await customDropdown(driver, previous, '');
    try {
      return (await dropdown.peek()).open;
    } finally {
      await dropdown.searchHandle.dispose();
    }
  }

  async prepare(driver: PageDriver, node: DOMElementNode, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    // Resolve identity without moving the form until the previous popup has closed.
    let { element: next } = await applicationControl(driver, node, false);
    let adopted = false;
    try {
      const previous = this.previous;
      let same = false;
      if (previous && await previous.evaluate(el => el.isConnected).catch(() => false)) {
        same = previous.frame === next.frame && await previous.evaluate((el, target, range) =>
          el === target || el.contains(target) || target.contains(el) ||
          Boolean(el.closest(range) && el.closest(range) === target.closest(range)),
        next, CALENDAR_ADAPTERS.ant.range);
        if (!same) {
          const control = await readLiveControl(previous, true);
          const dropdown = control.datePicker ? null : await customDropdown(driver, previous, '', signal);
          const read = () => control.datePicker ? readCalendarPanel(previous) : dropdown!.peek();
          try {
            if ((await read()).open) {
              if (this.dismissalFailed) return false;
              this.dismissalFailed = true;
              if (dropdown) await dropdown.close();
              else await dismissCalendarPopup(driver, previous, () => readCalendarPanel(previous), signal);
              const stillOpen = (await read()).open;
              signal?.throwIfAborted();
              if (stillOpen) return false;
            }
          } catch (error) {
            if (signal?.reason === explorationPaused) this.dismissalFailed = false;
            signal?.throwIfAborted();
            if (error instanceof URLNotAllowedError || error instanceof ExplorationStopped) throw error;
            if (!this.dismissalFailed) throw error;
            return false;
          } finally {
            await dropdown?.searchHandle.dispose();
          }
        }
      }
      signal?.throwIfAborted();
      await driver.checkTarget();
      if (!(await next.evaluate(el => el.isConnected))) {
        await next.dispose();
        ({ element: next } = await applicationControl(driver, node));
      }
      // Only center when entering a different field. Option clicks and repeated
      // observations keep the popup's current position and use its own guard.
      if (!same) await next.evaluate(centerApplicationField);
      await this.previous?.dispose().catch(() => undefined);
      this.previous = next;
      this.dismissalFailed = false;
      adopted = true;
      return true;
    } finally {
      if (!adopted) await next.dispose();
    }
  }
}
