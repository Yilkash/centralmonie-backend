import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ChatReply, ChatResponder, ChatTurn } from '../chat/chat-responder';
import { ChatMessage } from '../database/schema';
import { PlansService } from '../plans/plans.service';
import { SchedulesService, whenOf } from '../schedules/schedules.service';
import { describeNow } from '../schedules/timing';
import { AGENT_TOOLS, AgentToolbox } from './agent-tools';
import { ModelClient } from './model-client';
import { SYSTEM_PROMPT } from './system-prompt';

const MAX_MODEL_CALLS = 8;
const HISTORY_MESSAGES = 20;
const FAILED = 'Sorry, I could not process that just now. Nothing has been sent. Please try again.';

@Injectable()
export class AgentChatResponder extends ChatResponder {
  private readonly logger = new Logger(AgentChatResponder.name);

  constructor(
    private readonly model: ModelClient,
    private readonly tools: AgentToolbox,
    private readonly plans: PlansService,
    private readonly schedules: SchedulesService,
  ) {
    super();
  }

  async reply(turn: ChatTurn): Promise<ChatReply> {
    const messages: Anthropic.MessageParam[] = [
      ...(await this.history(turn)),
      // The time goes with the message and not in the fixed instructions, so those stay cached.
      { role: 'user', content: `[Now: ${describeNow(new Date())}]\n${turn.message}` },
    ];
    let planId: string | undefined;
    let contactId: string | undefined;
    let scheduleGroupId: string | undefined;
    let cancelScheduleId: string | undefined;
    const cards = () => ({ planId, contactId, scheduleGroupId, cancelScheduleId });

    try {
      for (let call = 0; call < MAX_MODEL_CALLS; call += 1) {
        const response = await this.model.create({ system: SYSTEM_PROMPT, tools: AGENT_TOOLS, messages });
        const text = textOf(response.content);

        if (response.stop_reason !== 'tool_use') {
          if (response.stop_reason !== 'end_turn') this.logger.warn(`Model stopped with ${response.stop_reason}`);
          return { text: text || FAILED, ...cards() };
        }

        // The full content goes back, because it can carry thinking the model needs.
        messages.push({ role: 'assistant', content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          const outcome = await this.tools.run(turn.user, block.name, block.input);
          planId = outcome.planId ?? planId;
          contactId = outcome.contactId ?? contactId;
          scheduleGroupId = outcome.scheduleGroupId ?? scheduleGroupId;
          cancelScheduleId = outcome.cancelScheduleId ?? cancelScheduleId;
          results.push({ type: 'tool_result', tool_use_id: block.id, content: outcome.result, is_error: outcome.isError ?? false });
        }
        messages.push({ role: 'user', content: results });
      }
      this.logger.warn('Agent stopped after too many steps');
    } catch (error) {
      this.logger.error(`Agent failed: ${(error as Error).name}`);
    }
    return { text: FAILED, ...cards() };
  }

  /** Earlier text only, noting what became of any card, so the model knows what was approved. */
  private async history(turn: ChatTurn): Promise<Anthropic.MessageParam[]> {
    const recent = turn.history.slice(-HISTORY_MESSAGES);
    const start = recent.findIndex((message) => message.role === 'user');
    if (start === -1) return [];
    return Promise.all(
      recent.slice(start).map(async (message) => ({ role: message.role, content: await this.described(turn, message) })),
    );
  }

  private async described(turn: ChatTurn, message: ChatMessage): Promise<string> {
    if (message.scheduleGroupId) {
      const group = await this.schedules.group(turn.user.id, message.scheduleGroupId);
      return `${message.content}\n[Scheduled payment card shown earlier. Its status now: ${group.status}. ${group.items
        .map((item) => `${item.recipientName}: ${whenOf(item)}`)
        .join('; ')}]`;
    }
    if (!message.planId) return message.content;
    const plan = await this.plans.get(turn.user.id, message.planId);
    return `${message.content}\n[Approval card shown earlier. Its status now: ${plan.status}. Payments: ${plan.items
      .map((item) => `${item.recipientName} ${item.payment?.status ?? 'not paid'}`)
      .join(', ')}]`;
  }
}

function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}
