import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type Page from '../browser/page';
import type { UnknownTarget } from '../browser/unknownControl';
import type { UnknownObservation } from '../browser/unknownControlDom';
import { displayedValueMatches, type FormWriteResult } from '../browser/formFill';
import { explorationModel, explorationStep } from '../controlExploration';
import {
  ADAPTER_CANDIDATE_USES,
  findControlRecipe,
  markControlRecipe,
  recipeSteps,
  recipeTarget,
  saveControlRecipe,
  type RecipeStep,
} from './controlRecipes';
import type { DecisionClient } from '../decisionClient';
import type { FormFieldReference } from './formReview';
import type { AgentContext } from './types';
import { Actors, ExecutionState } from './event/types';

export const controlStepSchema = z.object({
  action: z.enum(['click', 'type', 'scroll', 'done', 'manual']),
  target: z.string().nullable(),
  value: z.string().nullable(),
  reason: z.string(),
});
export const controlTargetsSchema = z.object({
  fields: z
    .array(
      z.object({
        anchor: z.string(),
        label: z.string().min(1).max(120),
        required: z.boolean().nullable(),
        desired_value: z.string().max(500).nullable(),
        source_quote: z.string().max(800).nullable(),
        ai_inferred: z.boolean(),
        reason: z.string().max(400),
      }),
    )
    .max(12),
});
const evidenceState = ({ fieldText, values, invalid, popupOpen, targets }: UnknownObservation) => ({
  fieldText,
  values,
  invalid,
  popupOpen,
  targets: targets.map(({ text, tag, role, editable, region }) => ({ text, tag, role, editable, region })),
});

/** Caller owns the field budget. A repair/fallback never creates a second allowance. */
export async function exploreUnknownControl(
  context: AgentContext,
  page: Page,
  target: UnknownTarget,
  field: FormFieldReference,
  desired: string,
  signal: AbortSignal,
  llm: DecisionClient,
): Promise<FormWriteResult> {
  let attempts = 0;
  const result = (
    status: FormWriteResult['status'],
    code: string,
    message: string,
    actualValue = '',
  ): FormWriteResult => ({
    status,
    code,
    message,
    actualValue,
    desiredValue: desired,
    attempts,
    adapter: 'unknown-control-exploration',
  });
  signal.throwIfAborted();
  const session = await page.openUnknownControl(target, signal);
  try {
    let observation = await session.observe();
    const initialValues = [...observation.values];
    const shows = (value: string) => displayedValueMatches(value, desired);
    const matched = (state: UnknownObservation) =>
      !state.popupOpen && state.selectionConfirmed !== false && state.invalid.length === 0 && state.values.some(shows);
    /** Closed, valid and changed by us, yet not literally the target: left to the equivalence judgement. */
    const differs = (state: UnknownObservation) =>
      !state.popupOpen && state.selectionConfirmed !== false && state.invalid.length === 0 &&
      state.values.some(value => value.trim()) && JSON.stringify(state.values) !== JSON.stringify(initialValues);
    const settle = async (): Promise<FormWriteResult> => {
      if (initialValues.some(shows))
        return result('failed', 'EXPLORATION_UNVERIFIED', '模型认为完成，但字段值或弹层状态未通过核验，请手动核对。');
      // The snapshot taken right after the last click still shows a popup that is
      // animating closed; judge fresh reads once it settles, never that snapshot.
      let first = observation;
      for (let poll = 0; poll < 5 && first.popupOpen; poll++) {
        await new Promise(resolve => setTimeout(resolve, 120));
        signal.throwIfAborted();
        first = await session.observe();
      }
      if (!(matched(first) || differs(first)))
        return result('failed', 'EXPLORATION_UNVERIFIED', '模型认为完成，但字段值或弹层状态未通过核验，请手动核对。');
      await new Promise(resolve => setTimeout(resolve, 220));
      signal.throwIfAborted();
      const second = await session.observe();
      observation = second;
      if (JSON.stringify(second.values) !== JSON.stringify(first.values))
        return result('failed', 'EXPLORATION_UNVERIFIED', '字段值未稳定或网页校验仍未通过，请手动核对。');
      if (matched(second))
        return result('verified', 'VERIFIED', '特殊控件已填写，弹层关闭且两次真实回读一致。', second.values.find(shows)!);
      if (differs(second))
        return result('failed', 'READBACK_DIFFERS', '已写入，网页显示的写法与拟填写值不同，待判定是否等同。',
          second.values.find(value => value.trim())!);
      return result('failed', 'EXPLORATION_UNVERIFIED', '字段值未稳定或网页校验仍未通过，请手动核对。');
    };
    const recipe = await findControlRecipe(field.url, field.label);
    if (recipe) {
      let replayed: FormWriteResult | null = null;
      try {
        let complete = true;
        for (const step of recipe.steps) {
          const candidate = recipeTarget(step, observation, desired);
          if (!candidate) { complete = false; break; }
          const before = observation;
          attempts++;
          // Replaying a verified record is a known path, not a model guess.
          await explorationStep(signal, `recipe:${step.action}:${candidate.region}:${candidate.tag}:${candidate.text}`,
            evidenceState(before),
            () => session.act(before, { action: step.action, target: candidate.id, value: step.action === 'type' ? desired : null }),
            async () => {
              observation = await session.observe();
              return evidenceState(observation);
            }, { kind: 'adapter' });
        }
        if (complete) replayed = await settle();
      } catch (error) {
        signal.throwIfAborted();
        context.trace?.('特殊控件 · 操作记录失效', 0, `${field.label} · ${error instanceof Error ? error.message : '重放失败'}`);
      }
      if (replayed?.status === 'verified') {
        const uses = await markControlRecipe(field.url, field.label, true);
        context.trace?.('特殊控件 · 复用操作记录', 0,
          `${field.label} · 第 ${uses} 次${uses >= ADAPTER_CANDIDATE_USES ? ' · 已多次复用，可考虑写成适配器' : ''}`);
        return { ...replayed, message: '已复用本站记录的操作，弹层关闭且两次回读一致。' };
      }
      await markControlRecipe(field.url, field.label, false);
      context.trace?.('特殊控件 · 操作记录失效', 0, `${field.label} · 改由模型探索`);
      observation = await session.observe();
    }
    const performed: Array<{ action: RecipeStep['action']; target: UnknownObservation['targets'][number] }> = [];
    const history: Array<{ action: string; targetText: string; reason: string }> = [];
    for (let round = 0; round < 9; round++) {
      signal.throwIfAborted();
      if (context.paused) return result('failed', 'EXPLORATION_PAUSED', '探索已暂停，请在网页核对此字段。');
      await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在尝试特殊控件 · ${field.label}`);
      const { screenshot, ...facts } = observation;
      const decision = controlStepSchema.parse(
        await explorationModel(signal, () =>
          llm.decide(
            'application_control_step',
            [
              new HumanMessage(
                JSON.stringify({
                  field: field.label,
                  desired_value: desired,
                  observation: facts,
                  screenshot,
                  history,
                }),
              ),
            ],
            signal,
          ),
        ),
      );
      signal.throwIfAborted();
      if (context.paused || context.stopped)
        return result('failed', 'EXPLORATION_PAUSED', '探索已停止，请在网页核对此字段。');
      if (decision.action === 'manual')
        return result('failed', 'EXPLORATION_MANUAL_REQUIRED', decision.reason || '无法确认此控件的操作，请手动补充。');
      if (decision.action === 'done') {
        const settled = await settle();
        if (settled.status === 'verified') {
          const steps = recipeSteps(performed, desired);
          if (steps) {
            await saveControlRecipe(field.url, field.label, steps);
            context.trace?.('特殊控件 · 已记录操作', 0, `${field.label} · ${steps.length} 步，下次本站直接复用`);
          }
        }
        return settled;
      }
      const candidate = observation.targets.find(item => item.id === decision.target);
      if (!candidate) return result('failed', 'EXPLORATION_INVALID_TARGET', '模型目标不在本次观察中，已停止。');
      if (decision.action === 'type' && (!candidate.editable || decision.value !== desired))
        return result('failed', 'EXPLORATION_UNAUTHORIZED_VALUE', '输入内容必须是本字段已有依据的目标值。');
      const before = observation;
      attempts++;
      await explorationStep(
        signal,
        `${decision.action}:${candidate.region}:${candidate.tag}:${candidate.text}`,
        evidenceState(before),
        () =>
          session.act(before, {
            action: decision.action as 'click' | 'type' | 'scroll',
            target: candidate.id,
            value: decision.value,
          }),
        async () => {
          observation = await session.observe();
          return evidenceState(observation);
        },
      );
      performed.push({ action: decision.action as RecipeStep['action'], target: candidate });
      history.push({ action: decision.action, targetText: candidate.text, reason: decision.reason });
    }
    return result('failed', 'EXPLORATION_STEPS', '此字段已达到探索次数上限，请手动补充。');
  } catch (error) {
    signal.throwIfAborted();
    return result(
      'failed',
      'EXPLORATION_FAILED',
      error instanceof Error ? error.message : '未知控件操作失败，请手动补充。',
    );
  } finally {
    await session.close();
  }
}
