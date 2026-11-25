import type { AgentContext } from './types';
import { formFieldReference } from './formReview';
import { hasConfirmedPrivacyConsent, isStrictPrivacyTermsLabel } from './applicationEvidence';
import { Actors, ExecutionState } from './event/types';
import { URLNotAllowedError } from '../browser/views';
import { DOMElementNode } from '../browser/dom/views';

/**
 * Reconciles live form controls against `context.review`.
 * When `options.readOnly` is true (e.g. pre-advance validation), never triggers auto-upload or auto-consent clicks.
 */
export async function reviewApplicationPage(
  context: AgentContext,
  options?: { readOnly?: boolean },
) {
  if (!context.options.targetOrigin) return [];
  const readOnly = options?.readOnly === true;
  const state = await context.browserContext.getState();
  const page = await context.browserContext.getCurrentPage();
  await context.browserContext.assertApplyTarget(page.tabId);
  const controls = new Map([...state.selectorMap].map(([index, node]) => [node, index]));
  const isControlNode = (n: DOMElementNode): boolean => {
    if (n.attributes['data-qz-control-part'] === 'true') return false;
    const t = n.tagName?.toLowerCase() ?? '';
    if (t === 'label') return false;
    if (['input', 'textarea', 'select'].includes(t) && !['button', 'submit', 'reset', 'image', 'hidden'].includes(n.attributes.type?.toLowerCase() ?? ''))
      return true;
    if (n.attributes.contenteditable !== undefined && n.attributes.contenteditable !== 'false') return true;
    if (n.attributes['data-qz-control'] === 'combobox') return true;
    return ['combobox', 'listbox', 'radiogroup', 'checkbox', 'radio', 'switch', 'textbox', 'spinbutton', 'slider'].includes(n.attributes.role ?? '');
  };
  const hasDescendantControl = (n: DOMElementNode): boolean =>
    n.children.some(child => child instanceof DOMElementNode && (isControlNode(child) || controls.has(child) || hasDescendantControl(child)));
  // Required/invalid custom widgets are not always assigned an interactive index,
  // but <label> elements and wrappers around real controls must never be added as separate fields.
  const visit = (node: DOMElementNode) => {
    if (
      node.isVisible &&
      (node.tagName?.toLowerCase() ?? '') !== 'label' &&
      (node.attributes['aria-required'] === 'true' ||
        (node.attributes['aria-invalid'] && node.attributes['aria-invalid'] !== 'false')) &&
      !hasDescendantControl(node)
    ) {
      if (!controls.has(node)) controls.set(node, node.highlightIndex ?? -1);
    }
    for (const child of node.children) if (child instanceof DOMElementNode) visit(child);
  };
  visit(state.elementTree);
  const hasPendingUserQuestions = context.review
    .snapshot()
    .some(
      entry =>
        !context.review.isSkipped(entry) &&
        !entry.autoDeferred &&
        ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(entry.failureCode ?? '') &&
        ['pending', 'failed'].includes(entry.status),
    );
  const alreadyAutoUploadedOnUrl = Boolean(state.url && context.autoUploadedResumeUrls?.has(state.url));
  let resumeUploaded = alreadyAutoUploadedOnUrl;
  const liveKeys = new Set<string>();
  for (const [node, index] of controls) {
    if (node.attributes['data-qz-control-part'] === 'true') continue;
    const tag = node.tagName?.toLowerCase();
    if (tag === 'label') continue;
    if (!isControlNode(node) && hasDescendantControl(node)) continue;
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
    liveKeys.add(field.key);
    if (field.legacyKey) liveKeys.add(field.legacyKey);
    if (tag === 'input' && (node.attributes.type ?? '').toLowerCase() === 'file') {
      if (node.attributes['data-qz-uploaded']) {
        const stillValid =
          typeof (page as { verifyUploadedAttachment?: unknown }).verifyUploadedAttachment === 'function'
            ? await (
                page as unknown as { verifyUploadedAttachment: (n: DOMElementNode) => Promise<boolean> }
              ).verifyUploadedAttachment(node)
            : true;
        if (stillValid) {
          resumeUploaded = true;
          continue;
        }
        delete node.attributes['data-qz-uploaded'];
        if (state.url) context.autoUploadedResumeUrls?.delete(state.url);
        resumeUploaded = false;
        context.review.recordDeferred(field, {
          adapter: 'file-upload',
          failureCode: 'MANUAL_ATTACHMENT',
          message: '附件上传未生效或已被移除，请核对后手动上传。',
        });
        continue;
      }
      const isResumeUploadField =
        /简历|resume|cv/i.test(field.label) &&
        !/头像|证件照|个人照片|生活照|身份证|成绩单|作品集|证明材料|学位证|毕业证/.test(field.label);
      if (isResumeUploadField && alreadyAutoUploadedOnUrl) {
        resumeUploaded = true;
        continue;
      }
      if (
        !readOnly &&
        !hasPendingUserQuestions &&
        !context.review.isSkipped(field) &&
        context.options?.resumeFile &&
        isResumeUploadField &&
        typeof page.uploadApplicationFile === 'function'
      ) {
        try {
          const uploaded = await page.uploadApplicationFile(node, context.options.resumeFile, {
            dismissParseModal: true,
          });
          if (uploaded?.ok) {
            resumeUploaded = true;
            if (state.url) context.autoUploadedResumeUrls?.add(state.url);
            if (uploaded.modalAutoDismissed) {
              context.trace?.('整页后检查 · 简历浮层', 0, '已自动关闭简历解析覆盖提示，保留已填内容');
            } else if (uploaded.modalOpened) {
              context.pendingUploadModal = true;
            }
            const fileName = uploaded.fileName || context.options.resumeFile.fileName;
            context.review.recordWrite(
              field,
              fileName,
              {
                status: 'verified',
                code: 'UPLOADED',
                message: `已自动上传简历附件：${fileName}`,
                adapter: 'file-upload',
                attempts: 1,
                actualValue: fileName,
                desiredValue: fileName,
              },
              false,
            );
            continue;
          }
        } catch {
          /* Fall through to deferred attachment reminder. */
        }
      }
      if (!context.review.snapshot().some(entry => entry.key === field.key && entry.status === 'filled')) {
        context.review.recordDeferred(field, {
          adapter: 'file-upload',
          failureCode: 'MANUAL_ATTACHMENT',
          message: '附件需由用户本人确认后手动上传。',
        });
      }
      continue;
    }
    try {
      const live = await page.readApplicationControl(node, context.review.chosen(field));
      if (
        live.kind === 'toggle' &&
        live.value === 'false' &&
        isStrictPrivacyTermsLabel(field.label)
      ) {
        const existing = context.review.entry(field);
        const userDeclined =
          existing?.status === 'skipped' ||
          (existing?.status === 'deferred' && existing.failureCode !== 'CONSENT_DEFERRED');
        if (
          !readOnly &&
          hasConfirmedPrivacyConsent(context) &&
          !userDeclined &&
          typeof page.clickApplicationToggle === 'function'
        ) {
          try {
            const toggled = await page.clickApplicationToggle(node, context.controller.signal, true);
            if (toggled?.status === 'verified') {
              context.review.recordWrite(field, 'true', toggled, live.required ?? false);
              continue;
            }
          } catch {
            /* Fall through to deferred reminder if auto-toggle fails. */
          }
        }
        if (!userDeclined) {
          context.review.recordDeferred(field, {
            failureCode: 'CONSENT_DEFERRED',
            message: '协议与授权需由你在提交前亲自确认勾选。',
          });
        }
        continue;
      }
      context.review.reconcile(
        field,
        live,
        live.required ?? (node.attributes.required !== undefined || node.attributes['aria-required'] === 'true'),
      );
    } catch (error) {
      if (error instanceof URLNotAllowedError) throw error;
      context.review.recordFailure(field, error instanceof Error ? error.message : String(error), false, undefined,
        { failureCode: 'CONTROL_READ_FAILED', issue: 'unverified', autoDeferred: true });
    }
  }
  if (
    !readOnly &&
    !resumeUploaded &&
    !hasPendingUserQuestions &&
    context.options?.resumeFile &&
    typeof (page as { autoUploadResumeInPage?: unknown }).autoUploadResumeInPage === 'function'
  ) {
    try {
      const autoUploaded = await (
        page as unknown as {
          autoUploadResumeInPage: (
            f: NonNullable<typeof context.options.resumeFile>,
            opts?: { dismissParseModal?: boolean },
          ) => Promise<{ ok: boolean; fileName?: string; modalOpened?: boolean; modalAutoDismissed?: boolean }>;
        }
      ).autoUploadResumeInPage(context.options.resumeFile, { dismissParseModal: true });
      if (autoUploaded?.ok) {
        if (state.url) context.autoUploadedResumeUrls?.add(state.url);
        if (autoUploaded.modalAutoDismissed) {
          context.trace?.('整页后检查 · 简历浮层', 0, '已自动关闭简历解析覆盖提示，保留已填内容');
        } else if (autoUploaded.modalOpened) {
          context.pendingUploadModal = true;
        }
      }
    } catch {
      /* Ignore hidden resume upload errors during review. */
    }
  }
  context.review.pruneDisconnected(state.url, liveKeys);
  const entries = context.review.snapshot();
  if (!entries.length) entries.push({
    key: `unobserved:${state.url}`, label: '当前申请表', url: state.url, index: -1,
    status: 'failed', required: true, expectedValue: '', actualValue: '',
    message: '尚未观察到可核对的申请字段，请先进入表单或让用户操作，再重新观察；不能判定填写完成。',
  });
  await context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(entries));
  return entries.filter(entry => entry.status === 'failed' || (entry.required && entry.status === 'pending'));
}
