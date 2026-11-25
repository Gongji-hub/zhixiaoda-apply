import { HistoryTreeProcessor } from '@src/background/browser/dom/history/service';
import { type DOMHistoryElement } from '@src/background/browser/dom/history/view';
import { type BrowserState } from '@src/background/browser/views';
import { createLogger } from '@src/background/log';
import type { AgentStepRecord } from '../history';
import type { AgentContext } from '../types';
import { ActionResult } from '../types';
import type { NavigatorActionRegistry } from './navigator';

const logger = createLogger('NavigatorAgent');
interface Replay {
  context: AgentContext;
  updateIndices: (
    element: DOMHistoryElement,
    action: Record<string, unknown>,
    state: BrowserState,
  ) => Promise<Record<string, unknown> | null>;
  executeActions: (actions: Record<string, unknown>[]) => Promise<ActionResult[]>;
}
interface ParsedModelOutput {
  current_state?: {
    next_goal?: string;
  };
  action?: (Record<string, unknown> | null)[] | null;
}
/**
 * Parse and validate model output from history item
 */
function parseHistoryModelOutput(historyItem: AgentStepRecord): {
  parsedOutput: ParsedModelOutput;
  goal: string;
  actionsToReplay: (Record<string, unknown> | null)[] | null;
} {
  if (!historyItem.modelOutput) {
    throw new Error('No model output found in history item');
  }

  let parsedOutput: ParsedModelOutput;
  try {
    parsedOutput = JSON.parse(historyItem.modelOutput) as ParsedModelOutput;
  } catch (error) {
    throw new Error(`Could not parse modelOutput: ${error}`);
  }

  // logger.info('Parsed output', JSON.stringify(parsedOutput, null, 2));

  const goal = parsedOutput?.current_state?.next_goal || '';
  const actionsToReplay = parsedOutput?.action;

  // Validate that there are actions to replay
  if (
    !parsedOutput || // No model output string at all
    !actionsToReplay || // 'action' field is missing or null after parsing
    (Array.isArray(actionsToReplay) && actionsToReplay.length === 0) || // 'action' is an empty array
    (Array.isArray(actionsToReplay) && actionsToReplay.length === 1 && actionsToReplay[0] === null) // 'action' is [null]
  ) {
    throw new Error('No action to replay');
  }

  return { parsedOutput, goal, actionsToReplay };
}

/**
 * Execute actions from history with element index updates
 */
async function executeHistoryActions(
  replay: Replay,
  parsedOutput: ParsedModelOutput,
  historyItem: AgentStepRecord,
  delay: number,
): Promise<ActionResult[]> {
  const state = await replay.context.browserContext.getState(replay.context.options.useVision);
  if (!state) {
    throw new Error('Invalid browser state');
  }

  const updatedActions: (Record<string, unknown> | null)[] = [];
  for (let i = 0; i < parsedOutput.action!.length; i++) {
    const result = historyItem.result[i];
    if (!result) {
      break;
    }
    const interactedElement = result.interactedElement;
    const currentAction = parsedOutput.action![i];

    // Skip null actions
    if (currentAction === null) {
      updatedActions.push(null);
      continue;
    }

    // If there's no interacted element, just use the action as is
    if (!interactedElement) {
      updatedActions.push(currentAction);
      continue;
    }

    const updatedAction = await replay.updateIndices(interactedElement, currentAction, state);
    updatedActions.push(updatedAction);

    if (updatedAction === null) {
      throw new Error(`Could not find matching element ${i} in current page`);
    }
  }

  logger.debug('updatedActions', updatedActions);

  // Filter out null values and cast to the expected type
  const validActions = updatedActions.filter((action): action is Record<string, unknown> => action !== null);
  const result = await replay.executeActions(validActions);

  // Wait for the specified delay
  await new Promise(resolve => setTimeout(resolve, delay));
  return result;
}

export async function replayHistoryStep(
  replay: Replay,
  historyItem: AgentStepRecord,
  stepIndex: number,
  totalSteps: number,
  maxRetries = 3,
  delay = 1000,
  skipFailures = true,
): Promise<ActionResult[]> {
  const replayLogger = createLogger('NavigatorAgent:executeHistoryStep');
  const results: ActionResult[] = [];

  // Parse and validate model output
  let parsedData: {
    parsedOutput: ParsedModelOutput;
    goal: string;
    actionsToReplay: (Record<string, unknown> | null)[] | null;
  };
  try {
    parsedData = parseHistoryModelOutput(historyItem);
  } catch (error) {
    const errorMsg = `Step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
    replayLogger.warning(errorMsg);
    return [
      new ActionResult({
        error: errorMsg,
        includeInMemory: false,
      }),
    ];
  }

  const { parsedOutput, goal, actionsToReplay } = parsedData;
  replayLogger.info(`Replaying step ${stepIndex + 1}/${totalSteps}: goal: ${goal}`);
  replayLogger.debug(`🔄 Replaying actions:`, actionsToReplay);

  // Try to execute the step with retries
  let retryCount = 0;
  let success = false;

  while (retryCount < maxRetries && !success) {
    try {
      // Check if execution should stop
      if (replay.context.stopped) {
        replayLogger.info('Replay stopped by user');
        break;
      }

      // Execute the history actions
      const stepResults = await executeHistoryActions(replay, parsedOutput, historyItem, delay);
      results.push(...stepResults);
      success = true;
    } catch (error) {
      retryCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (retryCount >= maxRetries) {
        const failMsg = `Step ${stepIndex + 1} failed after ${maxRetries} attempts: ${errorMessage}`;
        replayLogger.error(failMsg);

        results.push(
          new ActionResult({
            error: failMsg,
            includeInMemory: true,
          }),
        );

        if (!skipFailures) {
          throw new Error(failMsg);
        }
      } else {
        replayLogger.warning(`Step ${stepIndex + 1} failed (attempt ${retryCount}/${maxRetries}), retrying...`);
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  return results;
}

export async function updateActionIndices(
  registry: NavigatorActionRegistry,
  historicalElement: DOMHistoryElement,
  action: Record<string, unknown>,
  currentState: BrowserState,
): Promise<Record<string, unknown> | null> {
  // If no historical element or no element tree in current state, return the action unchanged
  if (!historicalElement || !currentState.elementTree) {
    return action;
  }

  // Find the current element in the tree based on the historical element
  const currentElement = await HistoryTreeProcessor.findHistoryElementInTree(
    historicalElement,
    currentState.elementTree,
  );

  // If no current element found or it doesn't have a highlight index, return null
  if (!currentElement || currentElement.highlightIndex === null) {
    return null;
  }

  // Get action name and args
  const actionName = Object.keys(action)[0];
  const actionArgs = action[actionName] as Record<string, unknown>;

  // Get the action instance to access the index
  const actionInstance = registry.getAction(actionName);
  if (!actionInstance) {
    return action;
  }

  // Get the index argument from the action
  const oldIndex = actionInstance.getIndexArg(actionArgs);

  // If the index has changed, update it
  if (oldIndex !== null && oldIndex !== currentElement.highlightIndex) {
    // Create a new action object with the updated index
    const updatedAction: Record<string, unknown> = { [actionName]: { ...actionArgs } };

    // Update the index in the action arguments
    actionInstance.setIndexArg(updatedAction[actionName] as Record<string, unknown>, currentElement.highlightIndex);

    logger.info(`Element moved in DOM, updated index from ${oldIndex} to ${currentElement.highlightIndex}`);
    return updatedAction;
  }

  return action;
}
