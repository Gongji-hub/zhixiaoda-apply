import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import type { DecisionClient } from '../../decisionClient';
import type { AgentContext } from '../types';
import { applicationEvidence } from '../applicationEvidence';
import { Actors, ExecutionState } from '../event/types';
import type { ApplicationControlOptions } from '../../browser/page';
import { waitForApplicationResume } from './outline';
import { MissingFormInformationError } from '../../browser/formFill';

export const choiceSchema = z.object({
  candidate: z.number().int().min(0).nullable(),
  reason: z.string(),
  needs_information: z.boolean().default(false),
  unexpressed_detail: z.string().nullable().optional(),
});

export interface OptionResolutionMeta {
  requested: string;
  selected: string | null;
  unexpressedDetail: string | null;
  reason: string;
}

/** The model resolves meaning; the browser only locates the chosen real option and verifies the write. */
export function optionResolver(
  context: AgentContext,
  llm: DecisionClient,
  label: string,
  onCall?: () => void,
  onResolved?: (meta: OptionResolutionMeta) => void,
): NonNullable<ApplicationControlOptions['resolveOption']> {
  return async evidence => {
    const { signal = context.controller.signal, ...facts } = evidence;
    signal.throwIfAborted();
    await waitForApplicationResume(context);
    signal.throwIfAborted();
    await context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, `正在判断候选 · ${label}`);
    signal.throwIfAborted();
    const started = Date.now();
    onCall?.();
    const resume = applicationEvidence(context);
    const parsed = await llm.decide('application_option_choice', [
      new HumanMessage(JSON.stringify({ field: label, ...facts,
        candidates: evidence.candidates.map((text, candidate) => ({ candidate, text })), resume })),
    ], signal);
    signal.throwIfAborted();
    const choice = choiceSchema.parse(parsed);
    await waitForApplicationResume(context);
    signal.throwIfAborted();
    if (choice.candidate !== null && choice.candidate >= evidence.candidates.length) throw new Error('候选判断返回了不存在的选项。');
    const selected = choice.candidate === null ? null : evidence.candidates[choice.candidate];
    const unexpressedDetail =
      selected !== null && typeof choice.unexpressed_detail === 'string' && choice.unexpressed_detail.trim()
        ? choice.unexpressed_detail.trim()
        : null;
    onResolved?.({ requested: evidence.requested, selected, unexpressedDetail, reason: choice.reason });
    const detailNote = unexpressedDetail ? `（待补充细节：${unexpressedDetail}）` : '';
    context.trace?.('候选判断', Date.now() - started, `${label}：${selected === null ? '无法确定合适候选' : `「${evidence.requested}」→「${selected}」`}${detailNote}；${choice.reason}`);
    if (selected === null && choice.needs_information)
      throw new MissingFormInformationError(choice.reason, evidence.candidates);
    return selected;
  };
}
