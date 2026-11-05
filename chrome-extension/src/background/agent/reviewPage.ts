import type { AgentContext } from './types';
import { formFieldReference } from './formReview';
import { Actors, ExecutionState } from './event/types';
import { URLNotAllowedError } from '../browser/views';
import { DOMElementNode } from '../browser/dom/views';

/** Read only: validation never clicks, changes fields or submits the form. */
export async function reviewApplicationPage(context: AgentContext) {
  if (!context.options.targetOrigin) return [];
  const state = await context.browserContext.getState();
  const page = await context.browserContext.getCurrentPage();
  await context.browserContext.assertApplyTarget(page.tabId);
  const controls = new Map([...state.selectorMap].map(([index, node]) => [node, index]));
  // Required/invalid wrappers are not always assigned an interactive index.
  const visit = (node: DOMElementNode) => {
    if (node.isVisible && (node.attributes['aria-required'] === 'true' ||
      (node.attributes['aria-invalid'] && node.attributes['aria-invalid'] !== 'false'))) {
      if (!controls.has(node)) controls.set(node, node.highlightIndex ?? -1);
    }
    for (const child of node.children) if (child instanceof DOMElementNode) visit(child);
  };
  visit(state.elementTree);
  for (const [node, index] of controls) {
    if (node.attributes['data-qz-control-part'] === 'true') continue;
    const tag = node.tagName?.toLowerCase();
    if (!['input', 'textarea', 'select'].includes(tag ?? '') && node.attributes.contenteditable === undefined &&
      !['combobox', 'listbox', 'radiogroup', 'checkbox', 'radio', 'switch', 'textbox', 'spinbutton', 'slider'].includes(node.attributes.role) &&
      node.attributes['aria-required'] !== 'true' && !node.attributes['aria-invalid'] &&
      node.attributes['data-qz-control'] !== 'combobox') continue;
    if (
      tag === 'input' &&
      ['button', 'submit', 'reset', 'image', 'hidden'].includes(node.attributes.type?.toLowerCase() ?? '')
    )
      continue;
    const field = formFieldReference(state, node, index);
    try {
      const live = await page.readApplicationControl(node, context.review.chosen(field));
      context.review.reconcile(
        field,
        live,
        live.required ?? (node.attributes.required !== undefined || node.attributes['aria-required'] === 'true'),
      );
    } catch (error) {
      if (error instanceof URLNotAllowedError) throw error;
      context.review.recordFailure(field, error instanceof Error ? error.message : String(error));
    }
  }
  const entries = context.review.snapshot();
  if (!entries.length) entries.push({
    key: `unobserved:${state.url}`, label: '当前申请表', url: state.url, index: -1,
    status: 'failed', required: true, expectedValue: '', actualValue: '',
    message: '尚未观察到可核对的申请字段，请先进入表单或让用户操作，再重新观察；不能判定填写完成。',
  });
  await context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(entries));
  return entries.filter(entry => entry.status === 'failed' || (entry.required && entry.status === 'pending'));
}
