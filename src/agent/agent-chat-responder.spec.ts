import Anthropic from '@anthropic-ai/sdk';
import { ChatTurn } from '../chat/chat-responder';
import { ChatMessage, User } from '../database/schema';
import { PlansService } from '../plans/plans.service';
import { AgentChatResponder } from './agent-chat-responder';
import { AGENT_TOOLS, AgentToolbox, ToolOutcome } from './agent-tools';
import { ModelClient, ModelRequest, ModelResponse } from './model-client';

const usage = {} as Anthropic.Usage;
const say = (text: string, stop: ModelResponse['stop_reason'] = 'end_turn'): ModelResponse => ({
  content: [{ type: 'text', text, citations: null }],
  stop_reason: stop,
  usage,
});
const useTool = (name: string, input: unknown, id = 't1'): ModelResponse => ({
  content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } } as Anthropic.ToolUseBlock],
  stop_reason: 'tool_use',
  usage,
});

const user = { id: 'user-1' } as User;
const turn = (history: Partial<ChatMessage>[] = [], message = 'hello'): ChatTurn => ({ user, message, history: history as ChatMessage[] });

function setUp(responses: (ModelResponse | Error)[], outcome: ToolOutcome = { result: 'ok' }) {
  const requests: ModelRequest[] = [];
  const model: ModelClient = {
    create: async (request) => {
      requests.push({ ...request, messages: [...request.messages] });
      const next = responses.shift();
      if (!next) throw new Error('no scripted response');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const run = jest.fn(async () => outcome);
  const plans = { get: jest.fn(async () => ({ status: 'approved', items: [{ recipientName: 'Mother', payment: { status: 'completed' } }] })) };
  const responder = new AgentChatResponder(model, { run } as unknown as AgentToolbox, plans as unknown as PlansService);
  return { responder, requests, run };
}

describe('AgentChatResponder', () => {
  it('offers no tool that can approve or send', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    expect(names).toEqual(['list_contacts', 'list_data_plans', 'get_balance', 'list_activity', 'propose_plan', 'propose_contact']);
    expect(names.some((name) => /approve|send|pay|execute|transfer/.test(name))).toBe(false);
  });

  it('returns plain text when no tool is needed', async () => {
    const { responder, run } = setUp([say('Hello!')]);
    await expect(responder.reply(turn())).resolves.toMatchObject({ text: 'Hello!', planId: undefined });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a tool for the signed-in user and returns the plan it created', async () => {
    const { responder, run, requests } = setUp(
      [useTool('propose_plan', { items: [] }), say('Please check and approve.')],
      { result: 'card showing', planId: 'plan-1' },
    );
    const reply = await responder.reply(turn());
    expect(run).toHaveBeenCalledWith(user, 'propose_plan', { items: [] });
    expect(reply).toEqual({ text: 'Please check and approve.', planId: 'plan-1', contactId: undefined });
    const results = requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
    expect(results[0]).toMatchObject({ tool_use_id: 't1', content: 'card showing', is_error: false });
  });

  it('passes a refusal back to the model as an error', async () => {
    const { responder, requests } = setUp(
      [useTool('propose_plan', {}), say('That goes over your daily limit.')],
      { result: 'over the limit', isError: true },
    );
    await responder.reply(turn());
    expect((requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!.is_error).toBe(true);
  });

  it('says nothing was sent when the model fails', async () => {
    const { responder } = setUp([new Error('API down')]);
    expect((await responder.reply(turn())).text).toContain('Nothing has been sent');
  });

  it('stops a runaway tool loop', async () => {
    const { responder, requests } = setUp(Array.from({ length: 20 }, () => useTool('list_contacts', {})));
    expect((await responder.reply(turn())).text).toContain('Nothing has been sent');
    expect(requests).toHaveLength(8);
  });

  it('gives a safe answer when the model refuses or returns no text', async () => {
    const { responder } = setUp([{ content: [], stop_reason: 'refusal', usage }]);
    expect((await responder.reply(turn())).text).toContain('Nothing has been sent');
  });

  it('starts history at a user message and reports what became of a card', async () => {
    const { responder, requests } = setUp([say('ok')]);
    await responder.reply(
      turn([
        { role: 'assistant', content: 'cut off' },
        { role: 'user', content: 'send 5k to my mother' },
        { role: 'assistant', content: 'Please approve.', planId: 'plan-1' },
      ]),
    );
    const [first, second] = requests[0]!.messages;
    expect(first).toEqual({ role: 'user', content: 'send 5k to my mother' });
    expect(second!.content).toContain('Its status now: approved');
  });
});
