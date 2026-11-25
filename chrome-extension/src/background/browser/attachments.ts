import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { DOMElementNode } from './dom/views';
import type { PageDriver } from './pageDriver';
import { clearModalTags, resolvePostUploadModal, tagVisibleModals } from './uploadDialogs';

export async function uploadApplicationFile(
  driver: PageDriver,
  elementNode: DOMElementNode,
  file: { fileName: string; mimeType: string; base64: string },
  options?: { dismissParseModal?: boolean },
): Promise<{
  ok: boolean;
  fileName?: string;
  reason?: string;
  alreadyUploaded?: boolean;
  modalOpened?: boolean;
  modalAutoDismissed?: boolean;
}> {
  const handle = await driver.page.locateElement(elementNode);
  if (!handle) return { ok: false, reason: 'ELEMENT_NOT_FOUND' };
  const preUploadAttr = 'data-qz-pre-upload-modal';
  await tagVisibleModals(driver, preUploadAttr);
  try {
    const result = await handle.evaluate((element, payload) => {
      let fileInput: HTMLInputElement | null = null;
      if (element.tagName.toLowerCase() === 'input' && (element as HTMLInputElement).type.toLowerCase() === 'file') {
        fileInput = element as HTMLInputElement;
      } else {
        fileInput = element.querySelector<HTMLInputElement>('input[type="file"]');
      }
      let container: Element | null = element;
      for (let depth = 0; !fileInput && container && depth < 5; depth++, container = container.parentElement) {
        const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
        if (inputs.length === 1) {
          fileInput = inputs[0];
          break;
        }
      }
      if (
        !fileInput &&
        element.closest('[role="dialog"], [aria-modal="true"]') &&
        ['button', 'a'].includes(element.tagName.toLowerCase())
      ) {
        return { ok: false, reason: 'DIALOG_ACTION_NOT_FILE_INPUT' };
      }
      let wrapper: Element = fileInput ?? element;
      for (let depth = 0; depth < 4 && wrapper.parentElement; depth++) {
        const parent = wrapper.parentElement;
        const tag = parent.tagName.toLowerCase();
        if (tag === 'body' || tag === 'form') break;
        if (parent.querySelectorAll('input[type="file"]').length > 1) break;
        wrapper = parent;
      }
      const contextEl =
        fileInput?.closest(
          '.ant-form-item, .el-form-item, [class*="form-item" i], [class*="upload" i], label, section, div',
        ) ||
        element.closest(
          '.ant-form-item, .el-form-item, [class*="form-item" i], [class*="upload" i], label, section, div',
        ) ||
        element;
      const contextText = (contextEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const accept = (fileInput?.getAttribute('accept') || element.getAttribute('accept') || '').toLowerCase();
      if (accept && !/pdf|doc|application\/|\*\/\*/.test(accept) && /image\/|\.png|\.jpg|\.jpeg|\.webp/.test(accept)) {
        return { ok: false, reason: 'NON_RESUME_UPLOAD' };
      }
      if (
        /头像|证件照|个人照片|生活照|身份证|成绩单|作品集|证明材料|学位证|毕业证/.test(contextText) &&
        !/简历|resume|cv/i.test(contextText)
      ) {
        return { ok: false, reason: 'NON_RESUME_UPLOAD' };
      }
      const wrapperUploaded =
        wrapper.getAttribute('data-qz-resume-uploaded') ||
        wrapper.querySelector('[data-qz-resume-uploaded]')?.getAttribute('data-qz-resume-uploaded');
      if (
        wrapperUploaded ||
        fileInput?.getAttribute('data-qz-uploaded') ||
        element.getAttribute('data-qz-uploaded') ||
        (fileInput?.files && fileInput.files.length > 0)
      ) {
        return {
          ok: true,
          fileName:
            fileInput?.files?.[0]?.name ||
            fileInput?.getAttribute('data-qz-uploaded') ||
            wrapperUploaded ||
            payload.fileName,
          alreadyUploaded: true,
        };
      }
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const fileObj = new File([bytes], payload.fileName, {
        type: payload.mimeType || 'application/pdf',
        lastModified: Date.now(),
      });
      const dt = new DataTransfer();
      dt.items.add(fileObj);
      if (fileInput) {
        fileInput.files = dt.files;
        fileInput.setAttribute('data-qz-uploaded', payload.fileName);
        wrapper.setAttribute('data-qz-resume-uploaded', payload.fileName);
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, fileName: payload.fileName, alreadyUploaded: false };
      }
      for (const type of ['dragenter', 'dragover', 'drop'] as const) {
        const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        element.dispatchEvent(evt);
      }
      element.setAttribute('data-qz-uploaded', payload.fileName);
      wrapper.setAttribute('data-qz-resume-uploaded', payload.fileName);
      return { ok: true, fileName: payload.fileName, alreadyUploaded: false };
    }, file);
    if (result.ok && !result.alreadyUploaded) {
      await new Promise(resolve => setTimeout(resolve, 450));
      const accepted = await inspectUploadedElement(handle);
      if (!accepted) {
        return { ok: false, reason: 'UPLOAD_REJECTED' };
      }
      const modal = await resolvePostUploadModal(driver, preUploadAttr, options?.dismissParseModal === true);
      return { ok: true, fileName: result.fileName, ...modal };
    }
    return { ok: result.ok, fileName: result.fileName, reason: result.reason, alreadyUploaded: result.alreadyUploaded };
  } finally {
    await clearModalTags(driver, preUploadAttr);
    await handle.dispose().catch(() => {});
  }
}

export async function inspectUploadedElement(handle: ElementHandle): Promise<boolean> {
  return handle
    .evaluate((element: Element) => {
      const fileInput =
        element instanceof HTMLInputElement && element.type === 'file'
          ? element
          : element.querySelector<HTMLInputElement>('input[type="file"]');
      const target = fileInput ?? element;
      const uploadedName =
        target.getAttribute('data-qz-uploaded') ||
        element.getAttribute('data-qz-uploaded') ||
        element.closest('[data-qz-resume-uploaded]')?.getAttribute('data-qz-resume-uploaded') ||
        '';
      let wrapper: Element = target;
      for (let depth = 0; depth < 4 && wrapper.parentElement; depth++) {
        const parent = wrapper.parentElement;
        const tag = parent.tagName.toLowerCase();
        if (tag === 'body' || tag === 'form') break;
        if (parent.querySelectorAll('input[type="file"]').length > 1) break;
        wrapper = parent;
      }
      const clearUploadMarks = () => {
        fileInput?.removeAttribute('data-qz-uploaded');
        element.removeAttribute('data-qz-uploaded');
        wrapper.removeAttribute('data-qz-resume-uploaded');
        wrapper
          .querySelectorAll('[data-qz-resume-uploaded]')
          .forEach(el => el.removeAttribute('data-qz-resume-uploaded'));
      };
      const hasErrorEl = Boolean(
        wrapper.querySelector(
          '.ant-upload-list-item-error, .atsx-upload-list-item-error, .ud__upload-list-item-error, .el-upload-list__item.is-fail, .is-error, [aria-invalid="true"]',
        ),
      );
      const wrapperText = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
      const hasErrorText =
        /上传失败|文件解析失败|格式不支持|格式错误|不支持该格式|大小不能超过|超过.*限制|file\s*too\s*large|upload\s*failed|invalid\s*file/i.test(
          wrapperText,
        );
      if (hasErrorEl || hasErrorText) {
        clearUploadMarks();
        return false;
      }
      if (fileInput?.files && fileInput.files.length > 0) return true;
      const stem = uploadedName.replace(/\.[^.]+$/, '').trim();
      const nameVisible =
        (uploadedName.length >= 2 && wrapperText.includes(uploadedName)) ||
        (stem.length >= 2 && wrapperText.includes(stem));
      const itemEl = wrapper.querySelector(
        '.ant-upload-list-item, .atsx-upload-list-item, .ud__upload-list-item, .el-upload-list__item, [class*="upload-list"] li, [class*="file-item"], [class*="uploaded"]',
      );
      if (nameVisible || itemEl) return true;
      clearUploadMarks();
      return false;
    })
    .catch(() => true);
}

export async function verifyUploadedAttachment(driver: PageDriver, elementNode: DOMElementNode): Promise<boolean> {
  if (!driver.puppeteer) return true;
  const handle = await driver.page.locateElement(elementNode);
  if (!handle) return false;
  try {
    return await inspectUploadedElement(handle);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/**
 * 扫描整页 DOM 中属于「简历」区块的 <input type="file">（含 display:none 隐藏文件框），
 * 自动挂载用户的简历原件。
 */

export async function autoUploadResumeInPage(
  driver: PageDriver,
  file: { fileName: string; mimeType: string; base64: string },
  options?: { dismissParseModal?: boolean },
): Promise<{
  ok: boolean;
  fileName?: string;
  alreadyUploaded?: boolean;
  modalOpened?: boolean;
  modalAutoDismissed?: boolean;
}> {
  if (!driver.puppeteer) return { ok: false };
  const preUploadAttr = 'data-qz-pre-upload-modal';
  await tagVisibleModals(driver, preUploadAttr);
  try {
    const result = await driver.puppeteer.evaluate(payload => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
      const candidates: Array<{ fileInput: HTMLInputElement; wrapper: Element; isParseBanner: boolean }> = [];

      for (const fileInput of inputs) {
        if (fileInput.disabled) continue;

        const accept = (fileInput.getAttribute('accept') || '').toLowerCase();
        if (
          accept &&
          !/pdf|doc|application\/|\*\/\*/.test(accept) &&
          /image\/|\.png|\.jpg|\.jpeg|\.webp/.test(accept)
        ) {
          continue;
        }

        let contextText = '';
        let cur: Element | null = fileInput;
        for (let depth = 0; cur && depth < 6; depth++, cur = cur.parentElement) {
          const text = (cur.textContent || '').replace(/\s+/g, ' ').trim();
          if (text.length >= 2 && text.length <= 240) {
            contextText = text;
            if (/简历|resume|cv|头像|证件照|个人照片|成绩单|作品集|证明材料/i.test(text)) {
              break;
            }
          }
        }

        if (!/简历|resume|cv/i.test(contextText)) continue;
        if (/头像|证件照|个人照片|生活照|身份证|成绩单|作品集|证明材料|学位证|毕业证/.test(contextText)) continue;

        let wrapper: Element = fileInput;
        for (let depth = 0; depth < 4 && wrapper.parentElement; depth++) {
          const parent = wrapper.parentElement;
          const tag = parent.tagName.toLowerCase();
          if (tag === 'body' || tag === 'form') break;
          if (parent.querySelectorAll('input[type="file"]').length > 1) break;
          wrapper = parent;
        }

        const wrapperText = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
        const hasError = Boolean(
          wrapper.querySelector(
            '.ant-upload-list-item-error, .atsx-upload-list-item-error, .ud__upload-list-item-error, .el-upload-list__item.is-fail, .is-error',
          ),
        );
        const hasExistingListItem =
          !hasError &&
          Boolean(
            wrapper.querySelector(
              '.ant-upload-list-item, .atsx-upload-list-item, .ud__upload-list-item, .el-upload-list__item, [class*="upload-list"] li',
            ),
          );
        const hasUploadedMarker = Boolean(
          fileInput.getAttribute('data-qz-uploaded') ||
            wrapper.getAttribute('data-qz-resume-uploaded') ||
            wrapper.querySelector('[data-qz-resume-uploaded]') ||
            (fileInput.files && fileInput.files.length > 0) ||
            (!hasError && payload.fileName.length >= 2 && wrapperText.includes(payload.fileName)) ||
            hasExistingListItem,
        );
        //Survives rc-upload <input key={uid}> remounts and avoids re-uploading over an already attached resume.
        if (hasUploadedMarker) {
          return { ok: true, fileName: payload.fileName, alreadyUploaded: true };
        }

        const isParseBanner = /解析|智能填写|自动填写|一键填写|识别简历|导入简历/.test(contextText);
        candidates.push({ fileInput, wrapper, isParseBanner });
      }

      if (!candidates.length) return { ok: false };
      candidates.sort((a, b) => Number(a.isParseBanner) - Number(b.isParseBanner));
      const chosen = candidates[0];

      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const fileObj = new File([bytes], payload.fileName, {
        type: payload.mimeType || 'application/pdf',
        lastModified: Date.now(),
      });
      const dt = new DataTransfer();
      dt.items.add(fileObj);
      chosen.fileInput.files = dt.files;
      chosen.fileInput.setAttribute('data-qz-uploaded', payload.fileName);
      chosen.wrapper.setAttribute('data-qz-resume-uploaded', payload.fileName);
      chosen.fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      chosen.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, fileName: payload.fileName, alreadyUploaded: false };
    }, file);
    if (result.ok && !result.alreadyUploaded) {
      await new Promise(resolve => setTimeout(resolve, 450));
      const modal = await resolvePostUploadModal(driver, preUploadAttr, options?.dismissParseModal !== false);
      return { ...result, ...modal };
    }
    return { ...result, modalOpened: false };
  } catch {
    return { ok: false };
  } finally {
    await clearModalTags(driver, preUploadAttr);
  }
}
