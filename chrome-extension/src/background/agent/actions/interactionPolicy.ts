/** The Agent classifies effects from the observed page, not control-label keywords. */
export const interactionEffects = [
  'open_interface', 'edit_application', 'advance_form', 'authenticate', 'submit_application',
  'accept_terms', 'upload_file', 'solve_challenge', 'uncertain',
] as const;

type ElementStructure = {
  tagName: string | null;
  attributes: Record<string, string>;
  parent: ElementStructure | null;
};

export function needsUserInteraction(node: ElementStructure, effect: string, operation: 'click' | 'input' = 'click'): boolean {
  const consent = effect === 'accept_terms';
  if (effect !== 'open_interface' && effect !== 'edit_application' && effect !== 'advance_form' && !consent) return true;
  const type = (node.attributes.type || '').toLowerCase();
  if (['file', 'password', 'submit', 'image'].includes(type)) return true;
  // A button without type inside a form defaults to submission. Inspect ancestors
  // too: the indexed target may be a span or icon inside that button.
  for (let current: ElementStructure | null = node; current; current = current.parent) {
    const tag = (current.tagName || '').toLowerCase();
    if (tag !== 'button' && tag !== 'input') continue;
    const currentType = (current.attributes.type || '').toLowerCase();
    if (['submit', 'image', 'file', 'password', 'reset'].includes(currentType)) return true;
    if (tag === 'button' && !currentType) {
      if (current.attributes.form) return true;
      for (let parent = current.parent; parent; parent = parent.parent) {
        if ((parent.tagName || '').toLowerCase() === 'form') return true;
      }
    }
  }
  if (operation === 'input') return consent || effect === 'advance_form';
  // 常规招聘同意只允许通过字段控件勾选，不放开“同意并提交”等按钮。
  const tag = (node.tagName || '').toLowerCase();
  if ((tag === 'input' && ['checkbox', 'radio'].includes(type)) || ['checkbox', 'radio', 'switch'].includes(node.attributes.role))
    return effect !== 'edit_application' && !consent;
  if (consent) return true;
  // Value-changing ARIA widgets use the field-bound selection tool instead.
  // Ordinary entry/add/next buttons are classified by the Agent in page context.
  for (let current: ElementStructure | null = node; current; current = current.parent) {
    if (current.attributes['data-qz-option'] === 'true') return true;
    const role = current.attributes.role;
    if (['option', 'listbox', 'checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role))
      return true;
  }
  // Keep non-web destinations and downloads outside automatic entry navigation.
  if (tag === 'a' && ('download' in node.attributes || /^\s*(?:javascript|data):/i.test(node.attributes.href || '')))
    return true;
  return false;
}
