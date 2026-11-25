import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import { readCalendarPanel } from './datePanel';
import { popupVisibilityGuard } from './popupVisibility';

/** Re-read calendar targets after scrolling; a generic popup is not a calendar. */
export function calendarVisibilityGuard(
  driver: { checkTarget(): Promise<void> }, element: ElementHandle, signal?: AbortSignal,
) {
  const reveal = popupVisibilityGuard(driver, element, signal, 'date');
  return (target?: { year: number; month: number }) =>
    reveal(() => readCalendarPanel(element, target), panel => panel.view !== 'unknown', panel => panel.allowClippedPanel === true);
}
