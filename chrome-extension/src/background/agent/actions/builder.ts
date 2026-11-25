import { type AgentContext } from '@src/background/agent/types';
import type { DecisionClient } from '../../decisionClient';
import { applyActionPolicy } from './actionPolicy';
import { createFormActions } from './formActions';
import { createInputActions } from './inputActions';
import { createNavigationActions } from './navigationActions';
import { createQuestionAction } from './questionActions';
import { createSelectionActions } from './selectionActions';

export { Action, buildDynamicActionSchema, InvalidInputError } from './action';
export { formWriteActionResult } from './writeResult';

export class ActionBuilder {
  constructor(
    private readonly context: AgentContext,
    private readonly extractorLLM: DecisionClient,
  ) { context.controlExplorer = extractorLLM; }

  buildDefaultActions() {
    // Keep the tool list stable: its order is visible to the navigator and the decision service.
    const navigation = createNavigationActions(this.context, this.extractorLLM);
    const input = createInputActions(this.context);
    const selection = createSelectionActions(this.context, this.extractorLLM);
    const form = createFormActions(this.context, this.extractorLLM);
    return applyActionPolicy(this.context, [
      createQuestionAction(this.context), navigation.done, navigation.wait, input.clickElement, input.inputText,
      navigation.scrollToPercent, selection.getDropdownOptions, selection.selectDropdownOption, selection.customOption,
      form.clickText, selection.pickDate, selection.multiSelect, form.fullForm,
    ]);
  }
}
