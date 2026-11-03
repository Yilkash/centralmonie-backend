import { NotificationsService } from '../src/notifications/notifications.service';
import Anthropic from '@anthropic-ai/sdk';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AgentChatResponder } from '../src/agent/agent-chat-responder';
import { ModelClient, ModelRequest, ModelResponse } from '../src/agent/model-client';
import { configureApp, createAdapter } from '../src/app';
import { AppModule } from '../src/app.module';
import { ChatResponder } from '../src/chat/chat-responder';
import { ContactsService } from '../src/contacts/contacts.service';
import { applyMigrations } from '../src/database/migrate';
import { IdentityProvider } from '../src/identity/identity-provider';
import { UsersRepository } from '../src/users/users.repository';

const DATABASE_URL = process.env.DATABASE_URL!;
const usage = {} as Anthropic.Usage;

/** Stands in for Claude: each step decides what the model "does" next. No network, no cost. */
class ScriptedModel extends ModelClient {
  script: ((request: ModelRequest) => ModelResponse)[] = [];
  async create(request: ModelRequest): Promise<ModelResponse> {
    const step = this.script.shift();
    if (!step) throw new Error('script finished');
    return step(request);
  }
}

const say = (text: string) => (): ModelResponse => ({ content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn', usage });
const tool = (name: string, input: unknown) => (): ModelResponse => ({
  content: [{ type: 'tool_use', id: 't1', name, input, caller: { type: 'direct' } } as Anthropic.ToolUseBlock],
  stop_reason: 'tool_use',
  usage,
});
const lastToolResult = (request: ModelRequest) => (request.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;

describe('agent through the API', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let model: ScriptedModel;
  let userId: string;
  let destinationId: string;
  let motherId: string;

  const call = (method: 'GET' | 'POST', url: string, body?: object) =>
    app.inject({ method, url, headers: { authorization: 'Bearer alice' }, ...(body ? { payload: body } : {}) });
  const paymentCount = async () => (await pool.query('SELECT count(*) FROM payments')).rows[0].count;

  beforeAll(async () => {
    await applyMigrations(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    model = new ScriptedModel();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IdentityProvider)
      .useValue({ verify: async () => ({ subject: 'did:privy:alice', email: null, walletAddress: null }) })
      .overrideProvider(ModelClient)
      .useValue(model)
      .overrideProvider(ChatResponder)
      .useFactory({ factory: (agent: AgentChatResponder) => agent, inject: [AgentChatResponder] })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
    userId = (await app.get(UsersRepository, { strict: false }).upsert({ subject: 'did:privy:alice', email: null, walletAddress: null })).id;
    const contacts = app.get(ContactsService, { strict: false });
    const mother = await contacts.propose(userId, 'Mother', ['mum'], { kind: 'bank', bankName: 'Access', accountNumber: '0123454821' });
    await contacts.confirm(userId, mother.id);
    destinationId = mother.destinations[0]!.id;
    motherId = mother.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const planFor = (amount: number, id = destinationId) => ({
    items: [{ route: 'bank', destination_id: id, amount_naira: amount, amount_usdc: null, data_plan_id: null }],
  });

  describe('separate chats', () => {
    const chat = async (content: string, target: object = {}) => (await call('POST', '/v1/chat/messages', { content, ...target })).json();
    const texts = async (url: string) => (await call('GET', url)).json().messages.map((m: { content: string }) => m.content);

    it('keeps each chat apart, and the model only sees the chat it is in', async () => {
      let seen = '';
      model.script = [say('first reply'), say('second reply'), (request) => {
        seen = JSON.stringify(request.messages);
        return say('third reply')();
      }];
      const first = (await chat('send 5k to Mum')).conversation_id;
      const second = (await chat('what is my balance', { new_chat: true })).conversation_id;
      expect(second).not.toBe(first);
      expect(await texts(`/v1/chat/messages?conversation=${first}`)).toEqual(['send 5k to Mum', 'first reply']);
      expect(await texts(`/v1/chat/messages?conversation=${second}`)).toEqual(['what is my balance', 'second reply']);

      await chat('and again', { conversation_id: first });
      expect(seen).toContain('send 5k to Mum');
      expect(seen).not.toContain('what is my balance');
    });

    it('lists chats newest first, named from their first message', async () => {
      model.script = [say('a'), say('b'), say('c')];
      const first = (await chat('send 5k to Mum')).conversation_id;
      await chat('a very long message that goes on and on well past the length of a title', { new_chat: true });
      const { conversations } = (await call('GET', '/v1/chat/messages/conversations')).json();
      expect(conversations[0].title).toBe('a very long message that goes on and on well…');
      expect(conversations[1].title).toBe('send 5k to Mum');
      await chat('back here', { conversation_id: first });
      expect((await call('GET', '/v1/chat/messages/conversations')).json().conversations[0].id).toBe(first);
    });

    it("refuses another user's chat, and a chat id that is not one", async () => {
      const bob = (await pool.query(`INSERT INTO users (provider_subject) VALUES ('did:privy:bob') RETURNING id`)).rows[0].id;
      const theirs = (await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, 'private') RETURNING id`, [bob])).rows[0].id;
      expect((await call('GET', `/v1/chat/messages?conversation=${theirs}`)).statusCode).toBe(404);
      expect((await call('POST', '/v1/chat/messages', { content: 'hi', conversation_id: theirs })).statusCode).toBe(404);
      expect((await call('GET', '/v1/chat/messages?conversation=nope')).statusCode).toBe(400);
    });

    it('renames and deletes a chat, leaving payments alone', async () => {
      model.script = [tool('list_contacts', {}), tool('propose_plan', planFor(5000)), say('Please approve.'), say('other')];
      const first = (await call('POST', '/v1/chat/messages', { content: 'send 5k to my mum' })).json();
      const planId = first.reply.plan.id;
      await call('POST', `/v1/plans/${planId}/approve`);
      const second = (await chat('hello', { new_chat: true })).conversation_id;
      const patch = (id: string, title: string) => app.inject({ method: 'PATCH', url: `/v1/chat/messages/conversations/${id}`, headers: { authorization: 'Bearer alice' }, payload: { title } });
      const remove = (id: string) => app.inject({ method: 'DELETE', url: `/v1/chat/messages/conversations/${id}`, headers: { authorization: 'Bearer alice' } });

      expect((await patch(first.conversation_id, 'Family')).statusCode).toBe(200);
      expect((await patch(first.conversation_id, '  ')).statusCode).toBe(400);
      expect((await call('GET', '/v1/chat/messages/conversations')).json().conversations.find((c: { id: string }) => c.id === first.conversation_id).title).toBe('Family');

      expect((await remove(first.conversation_id)).statusCode).toBe(200);
      expect((await call('GET', `/v1/chat/messages?conversation=${first.conversation_id}`)).statusCode).toBe(404);
      expect((await pool.query('SELECT count(*) FROM chat_messages WHERE conversation_id = $1', [first.conversation_id])).rows[0].count).toBe('0');
      expect(await paymentCount()).toBe('1');
      expect((await call('GET', '/v1/chat/messages/conversations')).json().conversations.map((c: { id: string }) => c.id)).toEqual([second]);
      expect((await remove(first.conversation_id)).statusCode).toBe(404);
    });

    it("cannot rename or delete another user's chat", async () => {
      const bob = (await pool.query(`INSERT INTO users (provider_subject) VALUES ('did:privy:bob') RETURNING id`)).rows[0].id;
      const theirs = (await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, 'private') RETURNING id`, [bob])).rows[0].id;
      const headers = { authorization: 'Bearer alice' };
      expect((await app.inject({ method: 'PATCH', url: `/v1/chat/messages/conversations/${theirs}`, headers, payload: { title: 'mine' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/v1/chat/messages/conversations/${theirs}`, headers })).statusCode).toBe(404);
      expect((await pool.query('SELECT title FROM conversations WHERE id = $1', [theirs])).rows[0].title).toBe('private');
    });

    it('puts a notice in the latest chat, and makes a chat if there is none', async () => {
      const notifications = app.get(NotificationsService, { strict: false });
      await notifications.notify(userId, 'Your deposit is complete.');
      expect(await texts('/v1/chat/messages')).toEqual(['Your deposit is complete.']);
      expect((await call('GET', '/v1/chat/messages/conversations')).json().conversations[0].title).toBe('Updates');
    });
  });

  it('turns a message into a card, and pays only after approval', async () => {
    model.script = [tool('list_contacts', {}), tool('propose_plan', planFor(5000)), say('Please check and approve.')];

    const { reply } = (await call('POST', '/v1/chat/messages', { content: 'send 5k to my mum' })).json();
    expect(reply.plan.status).toBe('proposed');
    expect(reply.plan.items[0]).toMatchObject({ recipient_name: 'Mother', amount_naira: '₦5,000' });
    expect(await paymentCount()).toBe('0');

    const approved = (await call('POST', `/v1/plans/${reply.plan.id}/approve`)).json();
    expect(approved.items[0].payment_status).toBe('completed');
    expect(await paymentCount()).toBe('1');
  });

  it('continues after a contact is confirmed, without showing the app\'s message', async () => {
    let seen = '';
    model.script = [(request) => ((seen = JSON.stringify(request.messages)), say('Please check and approve.')())];
    const response = await call('POST', '/v1/chat/messages/contact-confirmed', { contact_id: motherId });
    expect(response.statusCode).toBe(201);
    expect(seen).toContain('I confirmed Mother');
    const { messages } = (await call('GET', '/v1/chat/messages')).json();
    expect(messages.some((message: { content: string }) => message.content.includes('I confirmed'))).toBe(false);
    expect(messages.at(-1).content).toBe('Please check and approve.');
  });

  it('refuses to continue for a contact that is not this user\'s', async () => {
    const response = await call('POST', '/v1/chat/messages/contact-confirmed', {
      contact_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.statusCode).toBe(400);
  });

  it('shows the contacts to the model, and only this user\'s', async () => {
    let seen = '';
    model.script = [tool('list_contacts', {}), (request) => ((seen = String(lastToolResult(request).content)), say('ok')())];
    await call('POST', '/v1/chat/messages', { content: 'who do I know?' });
    expect(seen).toContain('Mother');
    expect(seen).toContain(destinationId);
    expect(seen).not.toContain('0123454821');
  });

  it('shows two saved entries with one name as one person', async () => {
    const contacts = app.get(ContactsService, { strict: false });
    const phone = await contacts.propose(userId, 'mother', [], { kind: 'phone', phone: '08031234567' });
    await contacts.confirm(userId, phone.id);
    let seen: { name: string; destinations: unknown[] }[] = [];
    model.script = [tool('list_contacts', {}), (request) => ((seen = JSON.parse(String(lastToolResult(request).content))), say('ok')())];
    await call('POST', '/v1/chat/messages', { content: 'who do I know?' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.destinations).toHaveLength(2);
  });

  it('refuses an invented recipient, and tells the model why', async () => {
    let refusal: Anthropic.ToolResultBlockParam | undefined;
    model.script = [
      tool('propose_plan', planFor(5000, '00000000-0000-4000-8000-000000000000')),
      (request) => ((refusal = lastToolResult(request)), say('I could not find that person.')()),
    ];
    const { reply } = (await call('POST', '/v1/chat/messages', { content: 'send 5k to a stranger' })).json();
    expect(refusal).toMatchObject({ is_error: true });
    expect(reply.plan).toBeNull();
  });

  it('refuses a plan over the daily limit', async () => {
    let refusal: Anthropic.ToolResultBlockParam | undefined;
    model.script = [
      tool('propose_plan', planFor(500_001)),
      (request) => ((refusal = lastToolResult(request)), say('That is over your daily limit.')()),
    ];
    const { reply } = (await call('POST', '/v1/chat/messages', { content: 'send 500001 to mum' })).json();
    expect(String(refusal?.content)).toContain('daily limit');
    expect(reply.plan).toBeNull();
  });

  it('shows a new contact card, and only allows paying them once confirmed', async () => {
    model.script = [
      tool('propose_contact', {
        name: 'Grace', aliases: ['my sister'], kind: 'bank', phone: null,
        bank_name: 'GTBank', account_number: '0123456789', wallet_address: null,
      }),
      say('Please confirm this is Grace.'),
    ];
    const { reply } = (await call('POST', '/v1/chat/messages', { content: 'add Grace, GTBank 0123456789' })).json();
    expect(reply.contact).toMatchObject({ name: 'Grace', status: 'proposed' });
    expect(reply.contact.detail).toContain('SIMULATED HOLDER 6789');

    const contacts = app.get(ContactsService, { strict: false });
    const grace = (await contacts.get(userId, reply.contact.id))!.destinations[0]!;
    let refusal: Anthropic.ToolResultBlockParam | undefined;
    model.script = [tool('propose_plan', planFor(100, grace.id)), (request) => ((refusal = lastToolResult(request)), say('Not yet.')())];
    await call('POST', '/v1/chat/messages', { content: 'pay her' });
    expect(refusal).toMatchObject({ is_error: true });

    expect((await call('POST', `/v1/contacts/${reply.contact.id}/confirm`)).statusCode).toBe(204);
    model.script = [tool('propose_plan', planFor(100, grace.id)), say('Please approve.')];
    const second = (await call('POST', '/v1/chat/messages', { content: 'pay her' })).json();
    expect(second.reply.plan.status).toBe('proposed');
  });

  it('keeps the chat alive when the model fails', async () => {
    model.script = [];
    const sent = await call('POST', '/v1/chat/messages', { content: 'hello' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().reply.content).toContain('Nothing has been sent');
  });
});
