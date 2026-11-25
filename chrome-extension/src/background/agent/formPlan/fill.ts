import { fillUnknownControls } from '../discoverUnknownControls';
import type { DecisionClient } from '../../decisionClient';
import { applicationEvidence } from '../applicationEvidence';
import type { AgentContext } from '../types';
import { finishForm } from './finishForm';
import { type RecordWrite, type Run, plan, prompt, readOutlineWithOptions, structureSchema } from './planContext';
import { type Section, type Tally, applyStructure, heading } from './structure';
import { fillOptionalRows, inspectExistingOptionalRows, retractDuplicateOptionalRows } from './optionalRows';
import { reconcileUnfilledFields, runValueRounds } from './valueRounds';
import { judgeReadbackDiffs } from './readbackEquivalence';

/**
 * 整页填写：代码读表单结构，模型一次规划结构、一次规划取值，代码逐项写入并回读，失败的带网页反馈交回模型修复。
 * 逐步模式只负责导航和收尾。
 */
export async function fillApplicationForm(
  context: AgentContext,
  llm: DecisionClient,
  record: RecordWrite,
): Promise<string> {
  context.controlExplorer = llm;
  const started = Date.now();
  const run: Run = {
    context,
    llm,
    record,
    evidence: applicationEvidence(context),
    calls: 0,
    written: new Set(),
    preserved: new Map(),
    problems: new Map(),
    asks: new Map(),
    structureProblems: new Map(),
    failedAttempts: new Set(),
    resolvedRevealToggles: new Set(),
    loadedOptions: new Map(),
    preExistingFieldIds: new Set(),
    addedFieldIds: new Set(),
    addedSections: new Map(),
    sectionAddButtons: new Map(),
    replannedOptionIds: new Set(),
    pendingOptionReplan: new Set(),
    plannedFieldKeys: new Set(),
    unexpressedDetails: new Map(),
    readbackDiffs: new Map(),
    sections: [],
  };
  let step = Date.now();
  let outline = await readOutlineWithOptions(run);
  for (const id of outline.fields.keys()) run.preExistingFieldIds.add(id);
  context.trace?.('整页填写 · 读取表单', Date.now() - step, `${outline.fields.size} 个字段`);

  const hasPasswordInput = [...(outline.state?.selectorMap?.values() ?? [])].some(
    node => (node.tagName ?? '').toLowerCase() === 'input' && (node.attributes.type ?? '').toLowerCase() === 'password',
  );
  if (hasPasswordInput && outline.fields.size <= 4) {
    return '当前页面是登录或身份验证界面，不能作为网申表单自动填写。请调用 ask_user(kind=manual_action) 提醒用户在网页完成登录。';
  }

  if (!outline.fields.size) {
    await fillUnknownControls(context, llm, new Set());
    return '整页填写结束：常规字段未识别，已检查特殊控件；请核对待处理清单和整张表的遗漏检查。';
  }

  // 结构可能分层展开（取消勾选后才出现该区块的添加按钮），每轮看最新页面再核对。
  const revealed = new Set<string>();
  const tally: Tally = new Map();
  const allSections = new Map<string, Section>();
  for (let round = 0; round < 3 && !context.stopped; round++) {
    const { sections } = await plan(run, structureSchema, '结构方案', prompt(run, outline));
    for (const section of sections) allSections.set(heading(section.title), section);
    run.sections = [...allSections.values()];
    context.trace?.(
      '整页填写 · 区块核对',
      0,
      sections
        .map(
          section =>
            `${section.title} 需要${section.needed}/现有${section.existing} 入口${section.add_button ?? (section.add_text ? `「${section.add_text}」` : '无')}`,
        )
        .join('；'),
    );
    step = Date.now();
    const applied = await applyStructure(run, outline, sections, revealed, tally);
    outline = applied.outline;
    if (!applied.changed) break;
    context.trace?.('整页填写 · 调整结构', Date.now() - step);
  }

  await inspectExistingOptionalRows(run, outline);
  outline = await runValueRounds(run, outline);
  const optional = await fillOptionalRows(run, outline, revealed, tally);
  outline = await reconcileUnfilledFields(run, optional.outline);
  await judgeReadbackDiffs(run);
  outline = await retractDuplicateOptionalRows(run, outline, optional.retained);
  const summary = await finishForm(run, outline, allSections, tally, started);
  const knownIds = new Set(
    [...outline.fields.values()].map(field => field.node.attributes['data-qz-field']).filter(Boolean),
  );
  await fillUnknownControls(context, llm, knownIds);
  return summary;
}

export { structureSchema, valuesSchema } from './planContext';
