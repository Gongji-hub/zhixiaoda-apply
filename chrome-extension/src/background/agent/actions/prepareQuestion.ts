import { ActionResult, type AgentContext } from '@src/background/agent/types';
import type { DOMElementNode } from '@src/background/browser/dom/views';
import { z } from 'zod';
import { fieldKind } from '../formPlan/outline';
import { formFieldReference } from '../formReview';
import type { UserQuestion } from '../userInput';
import { formStructureKey } from './formBatch';

export const askUserSchema = {
  name: 'ask_user',
  description: '',
  schema: z.object({
    kind: z.enum(['information', 'manual_action']).default('information'),
    question: z.string().min(1).max(300),
    reason: z.string().min(1).max(600),
    options: z.array(z.string().min(1).max(120)).max(8),
    index: z.number().int().nonnegative().optional(),
    proposed_value: z.string().max(12000).optional(),
    replacements: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          proposed_value: z.string().max(12000),
        }),
      )
      .min(1)
      .max(20)
      .optional(),
    review_key: z.string().max(8000).optional(),
  }),
};

export async function prepareQuestion(context: AgentContext, input: z.infer<typeof askUserSchema.schema>) {
  const questionInput: Omit<UserQuestion, 'id'> = {
    kind: input.kind,
    question: input.question,
    reason: input.reason,
    options: input.options,
  };
  let resolvedIndex = input.index;
  let resolvedReviewKey = input.review_key;
  if (
    resolvedReviewKey !== undefined &&
    resolvedIndex !== undefined &&
    input.proposed_value === undefined &&
    input.replacements === undefined &&
    context.review.snapshot().some(entry => entry.key === resolvedReviewKey)
  ) {
    resolvedIndex = undefined;
  }
  if (
    context.options.targetOrigin &&
    input.kind === 'information' &&
    resolvedIndex === undefined &&
    resolvedReviewKey === undefined &&
    input.replacements === undefined
  ) {
    if (input.proposed_value === undefined) {
      const norm = (s: string) => s.replace(/[\s*＊?？:：!！"'“”‘’「」『』()（）[\]【】·、，,。]/g, '').toLowerCase();
      const queryNorm = norm(`${input.question} ${input.reason}`);
      const missingEntries = context.review
        .snapshot()
        .filter(
          entry =>
            !context.review.isSkipped(entry) &&
            ['MISSING_INFORMATION', 'DATE_PRECISION_REQUIRED'].includes(entry.failureCode ?? '') &&
            ['pending', 'failed'].includes(entry.status),
        );
      const labelMatched = missingEntries.filter(entry => {
        const l = norm(entry.label);
        return l.length >= 2 && queryNorm.includes(l);
      });
      if (labelMatched.length >= 1) {
        const optionMatched = input.options?.length
          ? labelMatched.filter(entry => entry.options?.some(opt => input.options.includes(opt)))
          : [];
        let matches = optionMatched.length ? optionMatched : labelMatched;
        if (matches.length > 1) {
          const questionOnlyNorm = norm(input.question);
          const questionMatches = matches.filter(entry => {
            const l = norm(entry.label);
            return l.length >= 2 && questionOnlyNorm.includes(l);
          });
          if (questionMatches.length === 1) matches = questionMatches;
        }
        if (matches.length !== 1)
          return new ActionResult({
            error: '存在多处同名字段，请指定当前经历对应的 index 或 review_key 后再询问。',
            includeInMemory: true,
          });
        resolvedReviewKey = matches[0].key;
      } else if (
        missingEntries.length === 1 &&
        input.options?.length &&
        missingEntries[0].options?.some(opt => input.options.includes(opt))
      ) {
        resolvedReviewKey = missingEntries[0].key;
      } else {
        const cached = await context.browserContext.getCachedState().catch(() => null);
        if (cached?.selectorMap) {
          const matchedIndices: number[] = [];
          for (const [idx, candidate] of cached.selectorMap.entries()) {
            const tag = (candidate.tagName ?? '').toLowerCase();
            if (tag === 'label' || (tag === 'input' && (candidate.attributes.type ?? '').toLowerCase() === 'hidden'))
              continue;
            const ref = formFieldReference(cached, candidate, idx);
            const l = norm(ref.label);
            if (l.length >= 2 && l !== '控件' && queryNorm.includes(l)) matchedIndices.push(idx);
          }
          if (matchedIndices.length === 1) resolvedIndex = matchedIndices[0];
        }
      }
    }
    if (resolvedIndex === undefined && resolvedReviewKey === undefined) {
      return new ActionResult({
        error: '信息问题必须绑定已观察字段 index 或已有核对项 review_key。先观察实际表单，不能为推测出的隐藏字段提问。',
        includeInMemory: true,
      });
    }
  }
  if (input.replacements !== undefined) {
    if (
      input.kind !== 'information' ||
      input.index !== undefined ||
      input.proposed_value !== undefined ||
      input.review_key !== undefined ||
      new Set(input.replacements.map(item => item.index)).size !== input.replacements.length
    )
      return new ActionResult({ error: '批量替换确认需要唯一的字段列表，不能混用单字段参数。', includeInMemory: true });
    const indices = input.replacements.map(item => item.index);
    const observed = await context.browserContext.getCachedState();
    const structure = formStructureKey(observed, indices);
    const fresh = await context.browserContext.getState();
    if (formStructureKey(fresh, indices) !== structure)
      return new ActionResult({ error: '页面已变化，请重新观察后再询问这些字段。', includeInMemory: true });
    const page = await context.browserContext.getCurrentPage();
    const replacements: NonNullable<UserQuestion['replacements']> = [];
    for (const item of input.replacements) {
      const node = fresh.selectorMap.get(item.index);
      if (!node) return new ActionResult({ error: '当前字段不存在，请重新观察。', includeInMemory: true });
      const field = formFieldReference(fresh, node, item.index);
      if (context.review.isSkipped(field)) continue;
      const live = await page.readApplicationControl(node);
      if (live.valueKnown === false)
        return new ActionResult({
          error: '无法可靠读取当前值，请重新观察或请求用户在官网处理。',
          includeInMemory: true,
        });
      replacements.push({ field, tabId: fresh.tabId, currentValue: live.value, proposedValue: item.proposed_value });
    }
    if (!replacements.length)
      return new ActionResult({
        success: true,
        extractedContent: '这些字段已跳过，本轮不再询问。',
        includeInMemory: true,
      });
    questionInput.replacements = replacements;
    questionInput.field = replacements[0].field;
    questionInput.replacement = replacements[0];
  }
  let targetNode: DOMElementNode | undefined;
  if (resolvedReviewKey !== undefined) {
    const entry = context.review.snapshot().find(entry => entry.key === resolvedReviewKey);
    if (!entry || resolvedIndex !== undefined || input.proposed_value !== undefined || input.kind !== 'information')
      return new ActionResult({
        error: '核对项不存在或参数冲突，请根据当前清单重新观察。',
        includeInMemory: true,
      });
    questionInput.field = entry;
    if (context.review.isSkipped(entry))
      return new ActionResult({
        success: true,
        includeInMemory: true,
        extractedContent: '用户已跳过或选择稍后处理此字段，本轮不再提问。继续其他项目。',
      });
    if (entry.options?.length && !questionInput.options.length) {
      questionInput.options = [...entry.options];
    }
    const fresh = await context.browserContext.getState().catch(() => null);
    if (fresh?.selectorMap) {
      const byIndex = fresh.selectorMap.get(entry.index);
      if (byIndex) {
        const ref = formFieldReference(fresh, byIndex, entry.index);
        if (ref.key === entry.key || ref.legacyKey === entry.key) targetNode = byIndex;
      }
      if (!targetNode) {
        for (const [idx, candidate] of fresh.selectorMap.entries()) {
          const ref = formFieldReference(fresh, candidate, idx);
          if (ref.key === entry.key || ref.legacyKey === entry.key) {
            targetNode = candidate;
            break;
          }
        }
      }
    }
  }
  if (input.proposed_value !== undefined && (resolvedIndex === undefined || input.kind !== 'information')) {
    return new ActionResult({
      error: '替换确认必须指定当前字段 index，并使用 information。',
      includeInMemory: true,
    });
  }
  if (resolvedIndex !== undefined) {
    const observed = await context.browserContext.getCachedState();
    const structure = formStructureKey(observed, [resolvedIndex]);
    const fresh = await context.browserContext.getState();
    if (formStructureKey(fresh, [resolvedIndex]) !== structure)
      return new ActionResult({ error: '页面已变化，请重新观察后再询问该字段。', includeInMemory: true });
    const node = fresh.selectorMap.get(resolvedIndex);
    if (!node) return new ActionResult({ error: '当前字段不存在，请重新观察。', includeInMemory: true });
    targetNode = node;
    questionInput.field = formFieldReference(fresh, node, resolvedIndex);
    if (context.review.isSkipped(questionInput.field))
      return new ActionResult({
        extractedContent: '用户已明确跳过此字段，本轮不再提问或填写。请继续其他项目。',
        includeInMemory: true,
      });
    const entry = context.review
      .snapshot()
      .find(item => item.key === questionInput.field!.key || item.legacyKey === questionInput.field!.key);
    if (entry?.options?.length && !questionInput.options.length) {
      questionInput.options = [...entry.options];
    }
    if (input.proposed_value !== undefined) {
      const page = await context.browserContext.getCurrentPage();
      const live = await page.readApplicationControl(node);
      if (live.valueKnown === false)
        return new ActionResult({
          error: '无法可靠读取当前值，请使用 manual_action 请求用户在官网处理。',
          includeInMemory: true,
        });
      questionInput.replacement = {
        tabId: fresh.tabId,
        currentValue: live.value,
        proposedValue: input.proposed_value,
      };
    }
  }
  let answerObservedValue: string | undefined;
  // The website owns the options and cardinality; model suggestions may be a subset.
  if (targetNode && input.kind === 'information' && !questionInput.replacement) {
    const page = await context.browserContext.getCurrentPage();
    const live = await page.readApplicationControl(targetNode);
    answerObservedValue = live.value;
    if (['combobox', 'select'].includes(fieldKind(targetNode) ?? '') && !live.datePicker) {
      try {
        if (!questionInput.field) throw new Error('未绑定具体字段，无法展开候选。');
        const node = targetNode;
        const options = await context.controlExploration.run(questionInput.field, context.controller.signal,
          signal => page.listControlOptions(node, signal));
        if (!options.length) throw new Error('候选尚未加载');
        questionInput.options = [...new Set(options)];
        questionInput.multiple = live.multiple === true;
      } catch {
        if (context.controller.signal.aborted) throw new Error('操作已取消。');
        questionInput.kind = 'manual_action';
        questionInput.question = `请在网页选择「${questionInput.field?.label ?? '此项'}」，选好后继续。`;
        questionInput.options = [];
      }
    } else {
      questionInput.options = [];
    }
  }
  if (questionInput.replacement && questionInput.field) {
    questionInput.replacements ??= [{ ...questionInput.replacement, field: questionInput.field }];
    questionInput.question = `是否替换以下 ${questionInput.replacements.length} 处字段？`;
    questionInput.reason = '确认仅适用于下方列出的字段及替换值。';
  }
  return { questionInput, targetNode, answerObservedValue };
}
