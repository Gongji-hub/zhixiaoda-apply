import type { DOMElementNode } from './dom/views';
import { allSearchContexts, resolveElementFrame } from './elementLocation';
import type { PageDriver } from './pageDriver';

/** Runs in the page. Ignore the extension card when determining the site's top layer. */
export function inspectApplicationDialog(confirmDraftRemoval = false): 'clear' | 'open' | 'confirmed' {
  const semantic = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';
  const containers = `${semantic}, .modal, .dialog, .el-message-box, [class*="-modal" i], [class*="-dialog" i]`;
  const buttonSelector = 'button, [role="button"], input[type="button"]';
  const coversPage = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.width >= innerWidth * 0.8 && box.height >= innerHeight * 0.8 && getComputedStyle(element).position === 'fixed';
  };
  const topAt = (x: number, y: number) => document.elementsFromPoint(x, y)
    .find(element => !element.closest('#qz-agent-feedback'));
  const visible = (element: Element) => {
    const styles = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return styles.visibility === 'visible' && styles.display !== 'none' && styles.opacity !== '0' &&
      box.width > 0 && box.height > 0 && box.left < innerWidth && box.right > 0 && box.top < innerHeight && box.bottom > 0;
  };
  const candidates = Array.from(document.querySelectorAll(containers)).filter(el => {
    if (el.closest('#qz-agent-feedback, [hidden], [aria-hidden="true"]') || !visible(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 60) return false;
    if (!el.matches(semantic) && (!el.querySelector(buttonSelector) || !Array.from(el.classList).some(name =>
      /(?:^|[-_])(?:modal|dialog|message-box)(?:[-_]+(?:confirm|content|panel|container|wrapper))?$/iu.test(name)))) return false;
    // Nonmodal date pickers can have role=dialog. Look for a real modal layer.
    let modal = el.matches('dialog:modal, [aria-modal="true"], [role="alertdialog"]');
    for (let parent: Element | null = el; parent && parent !== document.body && !modal; parent = parent.parentElement) {
      modal = coversPage(parent);
    }
    if (!modal && getComputedStyle(el).position === 'fixed') {
      modal = [0.05, 0.95].some(offset => {
        const edge = topAt(innerWidth * offset, innerHeight / 2);
        return edge && coversPage(edge) && /mask|backdrop|overlay/iu.test(edge.getAttribute('class') ?? '');
      });
    }
    if (!modal) return false;
    const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = topAt(x, y);
    return Boolean(hit && el.contains(hit));
  });
  const dialogs = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
  if (!dialogs.length) return 'clear';
  if (!confirmDraftRemoval || dialogs.length !== 1) return 'open';
  const [dialog] = dialogs;
  const text = (dialog.textContent ?? '').replace(/\s+/gu, ' ').trim();
  if (!/删除|移除|\b(?:delete|remove)\b/iu.test(text) ||
      /全部|所有|批量|附件|简历|账号注销|提交|投递|\ball\b|\bevery\b|attachment|\baccount\b|\bsubmit\b|resum[eé]/iu.test(text)) return 'open';
  const buttons = Array.from(dialog.querySelectorAll<HTMLElement>(buttonSelector)).filter(el =>
    visible(el) && !el.matches(':disabled, [aria-disabled="true"], a, [type="submit"], [type="reset"]') &&
    !(el instanceof HTMLButtonElement && el.form && el.type !== 'button'));
  const label = (el: HTMLElement) => ((el instanceof HTMLInputElement ? el.value : el.textContent) || el.getAttribute('aria-label') || '').trim();
  const accept = buttons.filter(el => /^(?:(?:确认|确定)?(?:删除|移除)|确认|确定|是|delete|remove|confirm|ok|yes)$/iu.test(label(el)));
  const decline = buttons.some(el => /^(?:取消|否|返回|cancel|no|keep)$/iu.test(label(el)));
  if (!decline || accept.length !== 1) return 'open';
  const button = accept[0];
  const rect = button.getBoundingClientRect();
  const target = topAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!target || !button.contains(target)) return 'open';
  button.click();
  return 'confirmed';
}

export async function readApplicationDialog(driver: PageDriver, confirmDraftRemoval = false, owner?: DOMElementNode) {
  await driver.checkTarget();
  const open = [];
  for (const frame of allSearchContexts(driver)) {
    if (typeof frame.evaluate !== 'function') continue;
    if (await frame.evaluate(inspectApplicationDialog) === 'open') open.push(frame);
  }
  if (!open.length) return 'clear';
  if (confirmDraftRemoval && owner && open.length === 1 && open[0] === await resolveElementFrame(driver, owner)) {
    await driver.checkTarget();
    return open[0].evaluate(inspectApplicationDialog, true);
  }
  return 'open';
}
