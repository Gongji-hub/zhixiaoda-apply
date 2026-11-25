import { renderFeedback } from './render';

// This bundle runs only in the extension’s isolated world, once per document.
Object.assign(globalThis, { __qzRenderFeedback: renderFeedback });
