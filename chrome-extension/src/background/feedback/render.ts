import type { FeedbackState } from '../feedbackOverlay';
import { type OverlayUI } from './model';

import { bindCardActions } from './cardActions';
import { createCardLayout } from './cardLayout';
import { createFieldLocation } from './fieldLocation';
import { createOverlayModel } from './model';
import { updateCard } from './updateCard';
import { removeViewportGlow } from './viewportGlow';

export function renderFeedback(state: FeedbackState | null, highlightCSS: string) {
  const key = '__qzApplicationFeedback';
  const scope = window as unknown as Record<string, { host: HTMLElement; update: (next: FeedbackState) => void }>;
  if (!state || location.origin !== state.origin) {
    scope[key]?.host.remove();
    delete scope[key];
    removeViewportGlow();
    document.getElementById('qz-agent-field-focus')?.remove();
    return;
  }
  document.getElementById('qz-agent-floating-entry')?.remove();
  if (state.mode !== 'running' && state.mode !== 'done' && state.mode !== 'paused') {
    document.getElementById('qz-agent-field-focus')?.remove();
  }
  if (scope[key]?.host.isConnected) return scope[key].update(state);

  const ui: OverlayUI = {
    view: createCardLayout(),
    fields: createFieldLocation(highlightCSS),
    model: createOverlayModel(state),
  };
  const update = (next: FeedbackState) => updateCard(ui, next);
  bindCardActions(ui, () => {
    delete scope[key];
  });
  scope[key] = { host: ui.view.host, update };
  document.documentElement.append(ui.view.host);
  update(state);
}
