/** DOM structure only; field meaning and the choice of answer stay with the Agent. */
export interface RecruitingAdapter {
  id: string;
  root: string;
  item: string;
  popup: string;
  option: string;
  omit: string;
  disabled: string;
  error: string;
  invalid: string;
  required?: string;
  multiple?: string;
  selectedItems?: string;
  optionLabel?: string;
  optionControl?: string;
  settleMs: number;
}

// Selectors informed by OfferGo's public ATS adapters; see UPSTREAM.md.
// Keep these explicit: broad `class*=error/select` rules match unrelated content.
export const RECRUITING_ADAPTERS: RecruitingAdapter[] = [
  {
    id: 'phoenix', root: '.phoenix-select, .phoenix__select, [class~="phoenix-select--single"], [class~="phoenix-select--multiple"]',
    item: '.phoenix__form-item, .phoenix-form-item',
    popup: '.phoenix-selectList', option: '.phoenix-selectList__listItem, .phoenix-select-option',
    omit: '.phoenix-select__placeholder, .phoenix-select__arrow, .phoenix-select__clear',
    disabled: '.phoenix-select--disabled, .phoenix-selectList__listItem--disabled',
    error: '.phoenix-form-explain', invalid: '.phoenix-input--error, .phoenix-select--error', settleMs: 500,
  },
  {
    id: 'feishu', root: '.ud__select', item: '.ud-formily-item, .ud-form-item',
    required: '.ud-formily-item-asterisk',
    popup: '.ud__select__list, .ud__tree__list', option: '.ud__select__list__item, .ud__tree__node',
    multiple: '.ud__select__selector-multiple', selectedItems: '.ud__select__selector__tag .ud__tag__content',
    optionLabel: '.ud__tree__node__label', optionControl: 'input[type="checkbox"]',
    omit: '.ud__select__placeholder, .ud__select__suffix, .ud__select__clear',
    disabled: '.ud__select--disabled, .ud__select__list__item--disabled',
    error: '.ud-formily-item-error, .ud-form-item-error', invalid: '.ud-formily-item--error', settleMs: 600,
  },
  {
    id: 'antd', root: '.ant-select', item: '.ant-form-item',
    popup: '.ant-select-dropdown', option: '.ant-select-item-option, .ant-select-dropdown-menu-item',
    omit: '.ant-select-selection-placeholder, .ant-select-selection__placeholder, .ant-select-search__field__placeholder, .ant-select-arrow, .ant-select-clear, .ant-select-selection__clear, .ant-select-selection-item-remove',
    disabled: '.ant-select-disabled, .ant-select-item-option-disabled, .ant-select-dropdown-menu-item-disabled',
    error: '.ant-form-item-explain-error, .has-error .ant-form-explain', invalid: '.ant-form-item-has-error, .has-error',
    required: '.ant-form-item-required', settleMs: 500,
  },
  {
    id: 'element', root: '.el-select', item: '.el-form-item',
    popup: '.el-select-dropdown', option: '.el-select-dropdown__item',
    omit: '.el-select__placeholder.is-transparent, .el-input__suffix, .el-select__suffix, .el-tag__close',
    disabled: '.el-select.is-disabled, .el-select-dropdown__item.is-disabled',
    error: '.el-form-item__error', invalid: '.el-form-item.is-error', settleMs: 500,
  },
  {
    id: 'moka', root: '', item: '.moka-form-item',
    popup: '.moka-autocomplete-dropdown', option: '.moka-select-option',
    omit: '', disabled: '', error: '.moka-form-item-error', invalid: '.form-item--error', settleMs: 650,
  },
];

export interface RecruitingOptions {
  supported: boolean;
  open: boolean;
  options: string[];
  matches: number;
  box: { x: number; y: number; height: number } | null;
}

/** Self-contained for evaluate. A declared owner wins; otherwise require one anchored popup. */
export function recruitingOptions(
  element: Element, adapters: RecruitingAdapter[], label = '', pick = false,
): RecruitingOptions | Element | null {
  const adapter = adapters.find(rule => rule.root && element.matches(rule.root)) ?? adapters.find(rule => element.closest(rule.item));
  const empty: RecruitingOptions = { supported: Boolean(adapter), open: false, options: [], matches: 0, box: null };
  if (!adapter) return pick ? null : empty;
  const doc = element.ownerDocument;
  const tree = element.getRootNode() as Document | ShadowRoot;
  const view = doc.defaultView!;
  const shown = (node: Element) => {
    if (node.closest('[hidden], [aria-hidden="true"]')) return false;
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return typeof node.checkVisibility !== 'function' || node.checkVisibility({ visibilityProperty: true });
  };
  const controllers = [element, ...Array.from(element.querySelectorAll('input, [role="combobox"]'))];
  const ids = controllers.flatMap(node => `${node.getAttribute('aria-controls') || ''} ${node.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean));
  const selector = `${adapter.option}, [role="option"]`;
  let owners: Element[];
  if (ids.length) owners = [...new Set(ids.map(id => tree.getElementById(id)).filter((owner): owner is HTMLElement => Boolean(owner)))];
  else {
    const anchor = element.getBoundingClientRect();
    owners = Array.from(tree.querySelectorAll(`${adapter.popup}, [role="listbox"]`)).filter(popup => {
      if (!shown(popup) || popup.contains(element)) return false;
      if (element.contains(popup)) return true;
      const rect = popup.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > anchor.left && rect.left < anchor.right &&
        ((rect.top >= anchor.bottom - 4 && rect.top <= anchor.bottom + 24) ||
          (rect.bottom <= anchor.top + 4 && rect.bottom >= anchor.top - 24));
    });
    // Nested listbox and component popup describe one owner; two independent popups are ambiguous.
    owners = owners.filter(owner => !owners.some(other => other !== owner && other.contains(owner)));
    if (owners.length !== 1) return pick ? null : empty;
  }
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
  const candidates = [...new Set(owners.filter(shown).flatMap(owner => Array.from(owner.querySelectorAll(selector))))];
  const available = candidates.filter(option => shown(option) &&
    !option.closest(`[disabled], [aria-disabled="true"]${adapter.disabled ? `, ${adapter.disabled}` : ''}`) &&
    !candidates.some(other => other !== option && other.contains(option)));
  const text = (option: Element) => norm(option.getAttribute('aria-label') ||
    (adapter.optionLabel ? option.querySelector(adapter.optionLabel)?.textContent : '') ||
    (option as HTMLElement).innerText || option.textContent || '');
  const matches = available.filter(option => text(option) === norm(label));
  if (pick) return matches.length === 1
    ? (adapter.optionControl ? matches[0].querySelector(adapter.optionControl) : null) ?? matches[0]
    : null;
  const rect = owners.find(shown)?.getBoundingClientRect();
  return {
    supported: true, open: owners.some(shown), options: available.map(text).filter(Boolean).slice(0, 60), matches: matches.length,
    box: rect && rect.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, height: rect.height } : null,
  };
}
