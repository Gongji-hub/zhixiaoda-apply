import { HumanMessage } from '@langchain/core/messages';
import type { DecisionClient } from '../decisionClient';
import type { AgentContext } from './types';
import { applicationEvidence } from './applicationEvidence';
import { controlTargetsSchema, exploreUnknownControl } from './unknownControlExploration';
import { explorationModel } from '../controlExploration';
import { Actors, ExecutionState } from './event/types';
import { confirmedAuditControl } from '../browser/formAudit';

/** Runs once after ordinary writes. Final omission review stays read-only and never calls this module. */
export async function fillUnknownControls(
  context: AgentContext,
  llm: DecisionClient,
  knownIds: Set<string>,
): Promise<void> {
  if (!context.options.targetOrigin || context.stopped || context.paused || context.pendingUploadModal) return;
  const page = await context.browserContext.getCurrentPage();
  const cached = await context.browserContext.getCachedState();
  const url = cached?.url ?? '';
  const discoveryField = { key: `unknown-discovery:${url}`, label: '特殊控件检查', url, index: -1 };
  const evidence = applicationEvidence(context);
  try {
    const planned = await context.controlExploration.run(discoveryField, context.controller.signal, async signal => {
      const snapshot = await page.collectFormAudit(signal);
      const candidates = snapshot.blocks.filter(
        block => block.explorable && !confirmedAuditControl(block) && !block.fieldIds?.some(id => knownIds.has(id)),
      );
      if (!candidates.length) return [];
      if (candidates.length > 100)
        throw new Error('页面特殊控件超出本次探索范围，请查看遗漏检查结果。');
      await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, '正在识别特殊控件');
      const result = controlTargetsSchema.parse(
        await explorationModel(signal, () =>
          llm.decide(
            'application_control_targets',
            [
              new HumanMessage(
                JSON.stringify({
                  blocks: candidates.map(({ id, text, controls }) => ({ id, text, controls })),
                  evidence,
                }),
              ),
            ],
            signal,
          ),
        ),
      );
      signal.throwIfAborted();
      if (new Set(result.fields.map(item => item.anchor)).size !== result.fields.length)
        throw new Error('特殊控件方案重复使用同一字段位置，已停止。');
      return result.fields.map(item => {
        const block = candidates.find(b => b.id === item.anchor);
        if (!block) throw new Error('特殊控件方案返回了未观察到的位置。');
        return { item, block };
      });
    });
    for (const { item, block } of planned) {
      context.controller.signal.throwIfAborted();
      if (context.paused || context.stopped) break;
      const field = {
        key: `unknown:${url}:${block.id}`,
        legacyKey: block.structuralPath
          ? `unknown-path:${url}:${block.location.frame}:${block.structuralPath}`
          : undefined,
        label: item.label,
        url,
        index: -1,
        auditLocation: block.location,
      };
      const prior = context.review
        .snapshot()
        .find(entry => entry.key === field.key || (field.legacyKey && entry.legacyKey === field.legacyKey));
      if (prior?.autoDeferred || prior?.status === 'skipped' || prior?.status === 'filled') continue;
      if (
        context.review.isSkipped(field) ||
        context.review.isAutoDeferred(field) ||
        context.review.entry(field)?.status === 'filled'
      )
        continue;
      if (item.ai_inferred || !item.desired_value || !item.source_quote || !evidence.includes(item.source_quote)) {
        context.review.recordFailure(
          field,
          item.reason || '资料中没有明确依据，请在网页补充。',
          item.required !== false,
          undefined,
          { failureCode: 'UNKNOWN_CONTROL_MANUAL', autoDeferred: true, readOnly: true },
        );
        continue;
      }
      try {
        const result = await context.controlExploration.run(field, context.controller.signal, async signal => {
          const fresh = await page.collectFormAudit(signal);
          const current = fresh.blocks.find(b => b.id === block.id);
          if (
            !current ||
            current.text !== block.text ||
            JSON.stringify(current.controls) !== JSON.stringify(block.controls)
          )
            throw new Error('字段在规划后已变化，保留网页当前内容，请核对。');
          return exploreUnknownControl(
            context,
            page,
            { location: block.location },
            field,
            item.desired_value!,
            signal,
            llm,
          );
        });
        context.review.recordWrite(field, item.desired_value, result, item.required !== false);
        if (result.status !== 'verified')
          context.review.recordFailure(field, result.message, item.required !== false, undefined, {
            failureCode: 'UNKNOWN_CONTROL_MANUAL',
            autoDeferred: true,
            readOnly: true,
          });
      } catch (error) {
        if (context.controller.signal.aborted) throw error;
        context.review.recordFailure(
          field,
          error instanceof Error ? error.message : '此控件无法自动处理。',
          item.required !== false,
          undefined,
          { failureCode: 'UNKNOWN_CONTROL_MANUAL', autoDeferred: true, readOnly: true },
        );
      }
    }
  } catch (error) {
    if (context.controller.signal.aborted) throw error;
    context.review.recordFailure(
      discoveryField,
      error instanceof Error ? error.message : '特殊控件检查失败，请手动核对。',
      true,
      undefined,
      { failureCode: 'UNKNOWN_CONTROL_MANUAL', autoDeferred: true, readOnly: true },
    );
  }
  await context.emitEvent(Actors.SYSTEM, ExecutionState.REVIEW_UPDATED, JSON.stringify(context.review.snapshot()));
}
