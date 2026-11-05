import type { z } from 'zod';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { DecisionClient, DecisionStage } from '../../decisionClient';

export interface BaseAgentOptions {
  chatLLM: DecisionClient;
  context: AgentContext;
  prompt: BasePrompt;
}
export interface ExtraAgentOptions {
  id?: string;
}

/** Browser-side lifecycle and validation; all semantic decisions come from the service. */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: DecisionClient;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected modelOutputSchema: T;
  protected modelOutputToolName: DecisionStage;
  declare ModelOutput: z.infer<T>;

  constructor(schema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    this.modelOutputSchema = schema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.id = extraOptions?.id || 'navigator';
    this.modelOutputToolName = `${this.id}_output` as DecisionStage;
  }

  async invoke(messages: BaseMessage[]): Promise<this['ModelOutput']> {
    const result = await this.chatLLM.decide(this.modelOutputToolName, messages, this.context.controller.signal);
    return this.modelOutputSchema.parse(result);
  }

  abstract execute(): Promise<AgentOutput<M>>;
}
