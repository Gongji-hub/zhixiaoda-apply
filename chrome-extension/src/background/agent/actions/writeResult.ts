import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { type FormWriteResult } from '../../browser/formFill';
import { Actors, ExecutionState } from '../event/types';
import { recordVerifiedFieldWrite } from '../formPlan/siteFieldCache';
import { type FormFieldReference } from '../formReview';
import { wrapUntrustedContent } from '../messages/utils';
import { isVerifiedWrite, recordApplicationFieldWrite } from '../writeApplicationField';
import { formStructureKey } from './formBatch';

export async function formWriteActionResult(
  context: AgentContext,
  result: FormWriteResult,
  field?: FormFieldReference,
  expectedValue = '',
  required = false,
): Promise<ActionResult> {
  const succeeded = isVerifiedWrite(result, expectedValue);
  if (field) {
    if (succeeded) {
      if (result.status === 'verified' && result.adapter !== 'file-upload') {
        const how =
          result.adapter === 'date-panel'
            ? 'date'
            : result.adapter === 'popup-multi-click'
              ? 'choose_many'
              : result.adapter === 'popup-option-click' || result.adapter.includes('select')
                ? 'choose'
                : 'type';
        const kind =
          result.adapter === 'popup-option-click' || result.adapter === 'popup-multi-click'
            ? 'combobox'
            : result.adapter.includes('select')
              ? 'select'
              : 'text';
        void recordVerifiedFieldWrite(
          context,
          field.url,
          kind,
          field.label,
          '',
          result.desiredValue ?? expectedValue,
          how,
        );
      }
    }
    if (
      !succeeded &&
      !['MISSING_INFORMATION', 'DATE_RANGE_INCOMPLETE', 'CLICK_TARGET_OBSCURED'].includes(result.code) &&
      (result.attempts > 0 || result.code === 'EXISTING_VALUE_PRESERVED') &&
      !context.stopped
    ) {
      const state = await context.browserContext.getState();
      context.formRetries.record(
        field.key,
        expectedValue || result.desiredValue || '',
        result.actualValue,
        formStructureKey(state),
      );
    }
    await recordApplicationFieldWrite(context, field, expectedValue, result, required);
    void context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));
  }
  const details = wrapUntrustedContent(
    JSON.stringify({ control_write: result }),
    true,
    Boolean(context.options.targetOrigin),
  );
  context.emitEvent(
    Actors.NAVIGATOR,
    succeeded ? ExecutionState.ACT_OK : ExecutionState.ACT_FAIL,
    `${result.code}: ${result.message}`,
  );
  return new ActionResult({
    success: succeeded,
    fieldFailure: !succeeded && Boolean(field && context.options.targetOrigin),
    extractedContent: details,
    error: succeeded
      ? null
      : `${result.code}: ${result.message} ${
          ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(result.code)
            ? '先处理其他独立字段，随后 ask_user 询问缺少的信息，不得猜测。'
            : result.code === 'DATE_RANGE_INCOMPLETE'
              ? '使用 fill_application_form 同时规划这组开始和结束日期，成组选择后核对；缺少任一端时先询问用户，不要重复逐项写入。'
              : result.code === 'CLICK_TARGET_OBSCURED'
                ? '请先处理当前遮挡页面的顶层弹窗或浮层（若表单已有填写内容而弹出简历解析覆盖确认框，请点击“否，仅上传附件 / 不解析”保留已填信息；若涉及志愿或身份决策则调用 ask_user(kind=manual_action)），解除遮挡后再回填该字段。'
                : result.code === 'EXISTING_VALUE_PRESERVED'
                  ? '请先按字段请求替换确认；未确认前停止重试。'
                  : SELF_CORRECT
        }`,
    includeInMemory: true,
  });
}

/** 失败后的统一下一步：先自己判断、换做法，确实解决不了才交给用户。 */
export const SELF_CORRECT =
  '此字段已记入侧栏待处理项，先继续其他独立字段；依赖此字段的项暂缓。不要反复操作该字段或弹出问题。其他可填写项处理完后以部分完成结束。';

export function recordFormFailure(context: AgentContext, field: FormFieldReference, message: string): void {
  if (!context.options.targetOrigin) return;
  context.review.recordFailure(field, message);
  void context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));
}
