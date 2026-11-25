import { hasConfirmedPrivacyConsent, isStrictPrivacyTermsLabel } from '../applicationEvidence';
import { waitForApplicationDialog } from '../applicationDialog';
import { Actors, ExecutionState } from '../event/types';
import { formFieldReference } from '../formReview';
import { writeApplicationField } from '../writeApplicationField';
import { problemsText, pruneDisconnectedFields } from './fieldIssues';
import type { FormOutline } from './outline';
import { type Run, readOutlineWithOptions } from './planContext';
import { type Section, type Tally, retractUnfillableAddedSections } from './structure';

export async function finishForm(
  run: Run,
  outline: FormOutline,
  allSections: Map<string, Section>,
  tally: Tally,
  started: number,
) {
  const { context } = run;
  if ((allSections.size > 0 || run.problems.size > 0) && !context.stopped) {
    outline = await readOutlineWithOptions(run);
    pruneDisconnectedFields(run, outline);
    if (allSections.size > 0) {
      outline = await retractUnfillableAddedSections(run, outline, [...allSections.values()], tally);
      pruneDisconnectedFields(run, outline);
    }
  }

  if (hasConfirmedPrivacyConsent(context) && !context.stopped) {
    await waitForApplicationDialog(context);
    try {
      const page = await context.browserContext.getCurrentPage();
      if (typeof page.clickApplicationToggle === 'function') {
        for (const field of outline.fields.values()) {
          if (
            ['checkbox', 'radio', 'switch'].includes(field.kind) &&
            field.value === 'false' &&
            isStrictPrivacyTermsLabel(field.label) &&
            !context.review.isSkipped(field.field)
          ) {
            const toggled = await writeApplicationField(context, page, {
              field: field.field,
              node: field.node,
              value: 'true',
              method: 'check',
              policy: 'never',
              observedValue: field.value,
            });
            await run.record(context, toggled, field.field, 'true', field.required);
            if (toggled.status === 'verified') {
              field.value = 'true';
              run.written.add(field.id);
              run.asks.delete(field.id);
              run.problems.delete(field.id);
            }
          }
        }
      }
    } catch {
      /* Ignore auto-consent errors during full-page fill. */
    }
  }

  const canAutoAttachResumeNow =
    run.asks.size === 0 &&
    run.preserved.size === 0 &&
    run.structureProblems.size === 0 &&
    !context.review
      .snapshot()
      .some(
        entry =>
          !context.review.isSkipped(entry) &&
          !entry.autoDeferred &&
          ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED', 'CLICK_TARGET_OBSCURED'].includes(
            entry.failureCode ?? '',
          ) &&
          ['pending', 'failed'].includes(entry.status),
      );

  const currentUrl = outline.state?.url ?? '';
  if (
    canAutoAttachResumeNow &&
    context.options?.resumeFile &&
    outline.state?.selectorMap &&
    !(currentUrl && context.autoUploadedResumeUrls?.has(currentUrl))
  ) {
    await waitForApplicationDialog(context);
    try {
      const page = await context.browserContext.getCurrentPage();
      if (typeof page.uploadApplicationFile === 'function') {
        for (const [index, node] of outline.state.selectorMap) {
          const tag = (node.tagName ?? '').toLowerCase();
          const type = (node.attributes.type ?? '').toLowerCase();
          if (tag !== 'input' || type !== 'file' || node.attributes['data-qz-uploaded']) continue;
          const field = formFieldReference(outline.state, node, index);
          if (
            /简历|resume|cv/i.test(field.label) &&
            !/头像|证件照|个人照片|生活照|身份证|成绩单|作品集|证明材料|学位证|毕业证/.test(field.label)
          ) {
            const uploaded = await page.uploadApplicationFile(node, context.options.resumeFile, {
              dismissParseModal: true,
            });
            if (uploaded?.ok) {
              if (currentUrl) context.autoUploadedResumeUrls?.add(currentUrl);
              if (uploaded.modalAutoDismissed) {
                context.trace?.('整页填写 · 简历浮层', 0, '已自动关闭简历解析覆盖提示，保留已填内容');
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
              run.written.add(`file:${index}`);
              break;
            }
          }
        }
      }
      if (
        ![...run.written].some(k => k.startsWith('file:')) &&
        typeof (page as { autoUploadResumeInPage?: unknown }).autoUploadResumeInPage === 'function'
      ) {
        const autoUploaded = await (
          page as unknown as {
            autoUploadResumeInPage: (
              f: NonNullable<typeof context.options.resumeFile>,
              opts?: { dismissParseModal?: boolean },
            ) => Promise<{ ok: boolean; fileName?: string; modalOpened?: boolean; modalAutoDismissed?: boolean }>;
          }
        ).autoUploadResumeInPage(context.options.resumeFile, { dismissParseModal: true });
        if (autoUploaded?.ok) {
          if (currentUrl) context.autoUploadedResumeUrls?.add(currentUrl);
          if (autoUploaded.modalAutoDismissed) {
            context.trace?.('整页填写 · 简历浮层', 0, '已自动关闭简历解析覆盖提示，保留已填内容');
          } else if (autoUploaded.modalOpened) {
            context.pendingUploadModal = true;
          }
          run.written.add('file:auto-resume');
        }
      }
    } catch {
      /* Ignore auto-upload errors during full-page fill. */
    }
  }
  if (run.written.size > 0 && !context.stopped) {
    try {
      const page = await context.browserContext.getCurrentPage();
      if (typeof page.readTaggedControls === 'function') {
        const liveControls = await page.readTaggedControls();
        for (const id of [...run.written]) {
          if (id.startsWith('file:')) continue;
          const field = outline.fields.get(id);
          const live = liveControls.get(id);
          if (!field || !live || ['checkbox', 'radio', 'switch'].includes(field.kind)) continue;
          if (!live.value.trim() || live.selectionConfirmed === false) {
            run.written.delete(id);
            const prev = context.review.entry(field.field);
            context.review.reconcile(field.field, live, field.required);
            run.problems.set(id, {
              id,
              label: field.label,
              value: prev?.expectedValue || field.value,
              reason:
                live.selectionConfirmed === false
                  ? 'VERIFY_FAILED: 整页复查时输入框文字未对应已选候选，已从已完成中撤回'
                  : 'NOT_ACCEPTED: 整页复查时字段已变回空白，已从已完成中撤回',
              actual: live.value,
            });
          }
        }
      }
    } catch {
      /* Ignore end-of-fill sweep errors if page navigated or closed. */
    }
  }
  await context.emitEvent?.(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));

  const lines = [
    `整页填写结束（模型 ${run.calls} 次，${Math.round((Date.now() - started) / 1000)} 秒）：写入并核对 ${run.written.size} 项，保留已有内容 ${run.preserved.size} 项，未通过 ${run.problems.size} 项，区块缺项 ${run.structureProblems.size} 项，需要用户提供 ${run.asks.size} 项。`,
  ];
  if (run.problems.size) lines.push(`未通过：\n${problemsText(run)}`);
  if (run.structureProblems.size)
    lines.push(
      `区块未补齐（${run.structureProblems.size} 项，不能视为填写完成）：\n${[...run.structureProblems.values()].join('\n')}`,
    );
  if (run.preserved.size)
    lines.push(`已有内容与资料不同（未覆盖，需要时 ask_user 确认替换）：\n${[...run.preserved.values()].join('\n')}`);
  if (run.asks.size) lines.push(`需要用户提供：\n${[...run.asks.values()].join('\n')}`);
  lines.push(
    '技术失败字段已记入侧栏待处理清单并暂缓，继续其他独立字段。缺资料或缺日期精度的字段必须在其余可填项完成后调用 ask_user 询问，不能猜测，也不能只留提醒直接结束。用户选择跳过或稍后处理后才以部分完成结束。上传和最终提交留给用户。',
  );
  return lines.join('\n');
}
