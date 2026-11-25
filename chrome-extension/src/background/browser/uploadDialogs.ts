import type { PageDriver } from './pageDriver';

export async function countVisibleModals(driver: PageDriver, excludeAttr?: string): Promise<number> {
  if (!driver.puppeteer) return 0;
  try {
    return await driver.puppeteer.evaluate((skipAttr?: string) => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], dialog[open], .ant-modal, .el-message-box, .el-dialog, [class*="modal" i], [class*="dialog" i]',
        ),
      );
      const topModals: Element[] = [];
      for (const el of candidates) {
        if (el.closest('#qz-agent-feedback')) continue;
        if (skipAttr && (el.hasAttribute(skipAttr) || el.closest(`[${skipAttr}]`))) continue;
        if (topModals.some(existing => existing.contains(el) || el.contains(existing))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 80) continue;
        const cx = Math.min(Math.max(rect.left + rect.width / 2, 1), (window.innerWidth || 800) - 1);
        const cy = Math.min(Math.max(rect.top + rect.height / 2, 1), (window.innerHeight || 600) - 1);
        const hit = document.elementFromPoint(cx, cy);
        if (hit && (hit === el || el.contains(hit))) {
          topModals.push(el);
        }
      }
      return topModals.length;
    }, excludeAttr);
  } catch {
    return 0;
  }
}

export async function tagVisibleModals(driver: PageDriver, attr: string): Promise<number> {
  if (!driver.puppeteer) return 0;
  try {
    return await driver.puppeteer.evaluate((tagAttr: string) => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], dialog[open], .ant-modal, .el-message-box, .el-dialog, [class*="modal" i], [class*="dialog" i]',
        ),
      );
      const topModals: Element[] = [];
      for (const el of candidates) {
        if (el.closest('#qz-agent-feedback')) continue;
        if (topModals.some(existing => existing.contains(el) || el.contains(existing))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 80) continue;
        const cx = Math.min(Math.max(rect.left + rect.width / 2, 1), (window.innerWidth || 800) - 1);
        const cy = Math.min(Math.max(rect.top + rect.height / 2, 1), (window.innerHeight || 600) - 1);
        const hit = document.elementFromPoint(cx, cy);
        if (hit && (hit === el || el.contains(hit))) {
          el.setAttribute(tagAttr, '1');
          topModals.push(el);
        }
      }
      return topModals.length;
    }, attr);
  } catch {
    return 0;
  }
}

export async function clearModalTags(driver: PageDriver, attr: string): Promise<void> {
  if (!driver.puppeteer) return;
  await driver.puppeteer
    .evaluate((tagAttr: string) => {
      document.querySelectorAll(`[${tagAttr}]`).forEach(el => el.removeAttribute(tagAttr));
    }, attr)
    .catch(() => {});
}

export async function resolvePostUploadModal(driver: PageDriver, preUploadAttr: string, dismiss: boolean) {
  // Some uploaders open the dialog after the attachment request completes.
  for (let attempt = 0; attempt < 6; attempt++) {
    if ((await countVisibleModals(driver, preUploadAttr)) > 0) {
      const modalAutoDismissed = dismiss && (await tryDismissResumeParseModal(driver, preUploadAttr));
      return { modalOpened: !modalAutoDismissed, modalAutoDismissed };
    }
    if (!dismiss || attempt === 5) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return { modalOpened: false };
}

// Deterministically dismisses post-upload "parse resume & overwrite filled form?" modals without risking volunteer/business dialogs.

export async function tryDismissResumeParseModal(driver: PageDriver, preUploadAttr: string): Promise<boolean> {
  if (!driver.puppeteer) return false;
  try {
    const clicked = await driver.puppeteer.evaluate((skipAttr: string) => {
      const candidates = Array.from(
        document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], dialog[open], .ant-modal, .el-message-box, .el-dialog, [class*="modal" i], [class*="dialog" i]',
        ),
      );
      const newModals: Element[] = [];
      for (const el of candidates) {
        if (el.closest('#qz-agent-feedback')) continue;
        if (el.hasAttribute(skipAttr) || el.closest(`[${skipAttr}]`)) continue;
        if (newModals.some(existing => existing.contains(el) || el.contains(existing))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 80) continue;
        const cx = Math.min(Math.max(rect.left + rect.width / 2, 1), (window.innerWidth || 800) - 1);
        const cy = Math.min(Math.max(rect.top + rect.height / 2, 1), (window.innerHeight || 600) - 1);
        const hit = document.elementFromPoint(cx, cy);
        if (hit && (hit === el || el.contains(hit))) {
          newModals.push(el);
        }
      }
      if (newModals.length !== 1) return false;
      const modal = newModals[0];
      const modalText = (modal.textContent || '').replace(/\s+/g, ' ').trim();
      if (/志愿|投递岗位|调剂|部门选择|意向城市|验证码|安全验证|登录|注册/.test(modalText)) {
        return false;
      }
      const isParseOrOverwritePrompt =
        /解析|覆盖|替换|填充|自动填写|智能填写|识别简历|导入.*信息|导入.*简历|同步.*表单/.test(modalText) &&
        !/删除附件|移除附件|确认删除/.test(modalText);

      const isClickable = (el: Element, maxIconSize?: number): boolean => {
        if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (maxIconSize && (r.width > maxIconSize || r.height > maxIconSize)) return false;
        return true;
      };

      const buttons = Array.from(modal.querySelectorAll('button, [role="button"], a')).filter(el => isClickable(el));
      const buttonLabel = (el: Element) => (el.textContent || '').replace(/\s+/g, '').replace(/,/g, '，');
      // Meituan's attachment dialog offers a separate, explicit action that preserves the form.
      const attachmentOnly = buttons.filter(el => buttonLabel(el) === '否，仅做附件上传');
      let target: Element | undefined;
      if (
        modalText.replace(/\s+/g, '').includes('是否需要对简历附件进行解析并填充下方简历内容') &&
        buttons.some(el => buttonLabel(el) === '是，需同步更新简历内容') &&
        attachmentOnly.length === 1
      ) {
        [target] = attachmentOnly;
      }

      target ??= buttons.find(el => {
        const compact = (el.textContent || '').replace(/\s+/g, '');
        return (
          /仅上传|不解析|不覆盖|不替换|保留已填|保留原|暂不解析|跳过解析|不导入|不同步|不填充/.test(compact) &&
          !/删除|移除/.test(compact)
        );
      });

      if (!target && isParseOrOverwritePrompt) {
        target = buttons.find(el => {
          const compact = (el.textContent || '').replace(/\s+/g, '');
          return /^(否|取消|暂不|跳过|不用了|关闭|算了|cancel|no)$/i.test(compact);
        });
      }

      if (!target && isParseOrOverwritePrompt) {
        const closeIcons = Array.from(
          modal.querySelectorAll(
            '[aria-label="Close" i], [aria-label*="关闭"], .ant-modal-close, .atsx-modal-close, .ud__modal__close, .ud__dialog__close, .semi-modal-close, .arco-modal-close-icon, .el-dialog__headerbtn, .el-message-box__headerbtn, [class*="modal-close" i], [class*="dialog-close" i], [class*="modal__close" i], [class*="dialog__close" i]',
          ),
        );
        target = closeIcons.find(el => isClickable(el, 120));
      }

      if (!target) return false;
      if (typeof (target as HTMLElement).click === 'function') {
        (target as HTMLElement).click();
      } else {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      return true;
    }, preUploadAttr);

    if (!clicked) return false;
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if ((await countVisibleModals(driver, preUploadAttr)) === 0) {
        return true;
      }
    }
    return (await countVisibleModals(driver, preUploadAttr)) === 0;
  } catch {
    return false;
  }
}
