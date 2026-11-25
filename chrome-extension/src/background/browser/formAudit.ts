import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { PageDriver } from './pageDriver';
import { fieldHighlightCSS, revealApplicationField } from './fieldFeedback';
import { hasCommittedControlValue, readFormControl } from './controlState';
import { CALENDAR_ADAPTERS, type CalendarAdapters } from './calendarAdapters';
import { RECRUITING_ADAPTERS, type RecruitingAdapter } from './recruitingAdapters';

export interface AuditLocation {
  frame: number;
  frameUrl: string;
  anchor: string;
}
export interface AuditBlock {
  id: string;
  text: string;
  structuralPath?: string;
  fieldIds?: string[];
  explorable?: boolean;
  controls: Array<{
    tag: string;
    role: string;
    type?: string;
    checked?: boolean | 'mixed';
    label: string;
    value: string;
    placeholder: string;
    required: boolean;
    invalid: string;
    disabled: boolean;
    state?: 'filled' | 'empty' | 'unconfirmed' | 'invalid' | 'unknown';
  }>;
  location: AuditLocation;
}
export interface AuditSnapshot {
  url: string;
  blocks: AuditBlock[];
  gaps: string[];
}

export function confirmedAuditControl(block: AuditBlock) {
  return block.controls.length === 1 && block.controls[0].state === 'filled' ? block.controls[0] : undefined;
}

/** Discover regions independently; read the actual live control with the shared adapters. */
export function collectAuditDocument(
  adapters: RecruitingAdapter[] = [],
  readControl?: typeof readFormControl,
  calendars?: CalendarAdapters,
  isCommitted?: typeof hasCommittedControlValue,
) {
  const blocks: Omit<AuditBlock, 'location'>[] = [];
  const gaps: string[] = [];
  const roots: ParentNode[] = [document];
  const seen = new Set<Element>();
  const anchors = new Set<string>();
  let visited = 0,
    chars = 0;
  const visible = (el: Element) => {
    if (el.closest('[hidden], [aria-hidden="true"], [inert], [id^="qz-agent-"]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const widgetSelector = adapters.map(adapter => adapter.root).filter(Boolean).join(', ');
  const controlSelector = [
    'input:not([type=hidden]):not([type=password]), textarea, select, [contenteditable=true], [role=combobox], [role=checkbox], [role=radio], [role=switch], [role=textbox]',
    widgetSelector,
  ].filter(Boolean).join(', ');
  const widgetRoot = (el: Element) => widgetSelector ? el.closest(widgetSelector) : null;
  const isControl = (el: Element) => el.matches(controlSelector) && (widgetRoot(el) ?? el) === el;
  const controlFacts = new WeakMap<Element, AuditBlock['controls'][number]>();
  const observeControl = (node: Element): AuditBlock['controls'][number] => {
    const cached = controlFacts.get(node);
    if (cached) return cached;
    const input = node as HTMLInputElement;
    const isFile = node.tagName === 'INPUT' && input.type === 'file';
    const toggle = ['checkbox', 'radio'].includes(input.type) ||
      ['checkbox', 'radio', 'switch'].includes(node.getAttribute('role') ?? '');
    const live = isFile ? undefined : readControl?.(node, true, adapters, calendars);
    const known = live && live.kind !== 'unsupported' && live.valueKnown !== false;
    const selected = node instanceof HTMLSelectElement
      ? Array.from(node.selectedOptions).map(option => option.text).join(' / ')
      : undefined;
    const value = isFile
      ? Array.from(input.files ?? []).map(file => file.name).join(', ')
      : known ? live.value
        : toggle ? String(input.checked)
        : (selected ?? input.value ?? node.getAttribute('aria-valuetext') ?? textOf(node));
    const invalid = (live?.pageValidationMessage ?? (known ? live.validationMessage : '')) || input.validationMessage ||
      (node.getAttribute('aria-invalid') === 'true' ? '网页标记为无效' : '');
    let state: AuditBlock['controls'][number]['state'];
    if (invalid) state = 'invalid';
    else if (known || isFile) {
      // False is an observed answer, not a missing value. Required checkboxes
      // still fail their native validity check; groups are interpreted by the model.
      const hasValue = toggle ? ['true', 'false', 'mixed'].includes(value) : Boolean(value.trim());
      const committed = known ? (isCommitted?.(live) ?? live.valid) : isFile;
      state = known && live.selectionConfirmed === false ? 'unconfirmed'
        : !hasValue ? 'empty'
        : !committed ? 'invalid' : 'filled';
    } else if (readControl) state = 'unknown';
    const primaryInput = node.matches('input,textarea') ? node : node.querySelector('input,textarea');
    const facts = {
      tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role') ?? (toggle ? input.type : widgetRoot(node) === node ? 'combobox' : ''),
      ...(node.tagName === 'INPUT' ? { type: input.type } : {}),
      ...(toggle && ['true', 'false', 'mixed'].includes(value) ? { checked: value === 'mixed' ? 'mixed' as const : value === 'true' } : {}),
      label: node.getAttribute('aria-label') ?? primaryInput?.getAttribute('aria-label') ?? '',
      value: value.slice(0, 700),
      placeholder: primaryInput?.getAttribute('placeholder') ?? '',
      required: live?.required ?? (node.hasAttribute('required') || node.getAttribute('aria-required') === 'true'),
      invalid,
      disabled: live?.disabled ?? Boolean(input.disabled),
      state,
    };
    controlFacts.set(node, facts);
    return facts;
  };
  const textOf = (el: Element) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !parent.closest('script,style,noscript') && visible(parent)) parts.push(node.textContent ?? '');
      if (parts.join(' ').length > 1600 || parts.length > 800) break;
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  for (let r = 0; r < roots.length; r++) {
    for (const el of Array.from(roots[r].querySelectorAll('*'))) {
      if (++visited > 12000 || blocks.length >= 480 || chars > 60000) {
        gaps.push('页面内容超过本次检查范围，剩余区域未核查。');
        return { blocks, gaps };
      }
      if (!visible(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) continue;
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.getAttribute('aria-busy') === 'true') gaps.push('页面仍有正在加载的区域。');
      if (el.matches('canvas')) gaps.push('页面含画布区域，文字检查无法确认其中的字段。');
      if (el.matches('input[type=password]')) continue;
      const directText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (
        !directText &&
        !isControl(el) &&
        !el.hasAttribute('aria-required') &&
        !el.hasAttribute('aria-invalid')
      )
        continue;
      let block = widgetRoot(el) ?? el;
      // Gather nearby labels and values without class/site-specific field rules.
      for (let depth = 0; depth < 3 && block.parentElement; depth++) {
        const p = block.parentElement;
        if (
          p.matches('body,main,form,section,fieldset') ||
          p.children.length > 6 ||
          textOf(p).length > 700 ||
          Array.from(p.querySelectorAll(controlSelector)).filter(isControl).length > 1 ||
          p.querySelectorAll('label').length > 1 ||
          Array.from(p.querySelectorAll('*')).filter(
            node =>
              getComputedStyle(node).cursor === 'pointer' &&
              getComputedStyle(node.parentElement ?? p).cursor !== 'pointer',
          ).length > 1
        )
          break;
        block = p;
      }
      if (seen.has(block)) continue;
      seen.add(block);
      const all = [block, ...Array.from(block.querySelectorAll('*'))].filter(visible);
      // CSS generated stars carry required-field evidence too. No semantic label matching here.
      const pseudo = all
        .flatMap(node =>
          ['::before', '::after'].map(part => {
            const value = getComputedStyle(node, part).content;
            return value && !['none', 'normal', '""', "''"].includes(value) ? value : '';
          }),
        )
        .filter(Boolean)
        .join(' ');
      const controls = all.filter(isControl).map(observeControl);
      const fullText = `${textOf(block)} ${pseudo}`.trim();
      if (fullText.length > 1500) gaps.push('部分长文本区域未完整读取，请手动核对。');
      const text = fullText.slice(0, 1500);
      if (!text && !controls.length) continue;
      let id = block.getAttribute('data-qz-audit');
      if (!id || anchors.has(id)) {
        id = `a${crypto.randomUUID()}`;
        block.setAttribute('data-qz-audit', id);
      }
      anchors.add(id);
      const parts: string[] = [];
      for (let node: Element | null = block; node; ) {
        const parent: Element | null = node.parentElement;
        parts.unshift(`${node.tagName}:${parent ? Array.from(parent.children).indexOf(node) : 0}`);
        const root = node.getRootNode();
        node = parent ?? (root instanceof ShadowRoot ? root.host : null);
      }
      const structuralPath = parts.join('/');
      const fieldIds = all.map(node => node.getAttribute('data-qz-field')).filter((id): id is string => Boolean(id));
      const rect = block.getBoundingClientRect();
      const explorable =
        rect.width <= 1200 &&
        rect.height <= 500 &&
        controls.length <= 1 &&
        !block.matches('html,body,form,button,a') &&
        all.some(
          node =>
            node.matches('label,[aria-required],[tabindex],[role=combobox]') ||
            getComputedStyle(node).cursor === 'pointer',
        );
      blocks.push({ id, text, controls, structuralPath, fieldIds, explorable });
      chars += JSON.stringify(blocks.at(-1)).length;
    }
  }
  return { blocks, gaps: [...new Set(gaps)] };
}

export async function collectFormAudit(driver: PageDriver, signal: AbortSignal): Promise<AuditSnapshot> {
  signal.throwIfAborted();
  await driver.checkTarget();
  if (!driver.puppeteer) throw new Error('页面连接不可用。');
  const frames = driver.puppeteer.frames();
  // Frame.evaluate serializes each function in isolation. Pass the existing
  // self-contained reader as executable source from the extension bundle.
  const observe = `(${collectAuditDocument.toString()})(${JSON.stringify(RECRUITING_ADAPTERS)}, ${readFormControl.toString()}, ${JSON.stringify(CALENDAR_ADAPTERS)}, ${hasCommittedControlValue.toString()})`;
  const snapshot: AuditSnapshot = { url: driver.puppeteer.url(), blocks: [], gaps: [] };
  for (const [index, frame] of frames.entries()) {
    signal.throwIfAborted();
    if (index >= 12) {
      snapshot.gaps.push('嵌入页面数量超过检查范围。');
      break;
    }
    try {
      if (frame.parentFrame()) {
        const host = await frame.frameElement();
        try {
          if (
            host &&
            !(await host.evaluate(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'))
          )
            continue;
        } finally {
          await host?.dispose();
        }
      }
      const result = await frame.evaluate(observe) as ReturnType<typeof collectAuditDocument>;
      signal.throwIfAborted();
      snapshot.blocks.push(
        ...result.blocks.map(block => ({
          ...block,
          id: `${index}:${block.id}`,
          location: { frame: index, frameUrl: frame.url(), anchor: block.id },
        })),
      );
      snapshot.gaps.push(...result.gaps);
    } catch (error) {
      signal.throwIfAborted();
      snapshot.gaps.push(`第 ${index + 1} 个页面区域读取失败。`);
    }
  }
  return snapshot;
}

export async function revealAuditLocation(driver: PageDriver, location: AuditLocation) {
  await driver.checkTarget();
  const frame = driver.puppeteer?.frames()[location.frame];
  if (!frame || frame.url() !== location.frameUrl) throw new Error('核查位置已变化，请重新检查表单。');
  const handle = await frame.evaluateHandle((anchor: string) => {
    const roots: ParentNode[] = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of Array.from(roots[i].querySelectorAll('*'))) {
        if (el.getAttribute('data-qz-audit') === anchor) return el;
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return null;
  }, location.anchor);
  try {
    const element = handle.asElement() as ElementHandle<Element> | null;
    if (!element) throw new Error('核查位置已移除，请重新检查表单。');
    await element.evaluate(revealApplicationField, fieldHighlightCSS, '待核查区域');
  } finally {
    await handle.dispose();
  }
}
