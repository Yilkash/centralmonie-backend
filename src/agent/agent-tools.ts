import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ContactRefused, ContactsService, describeDestination, NewDestination } from '../contacts/contacts.service';
import { User } from '../database/schema';
import { formatNaira } from '../money/money';
import { ProposedItem } from '../plans/plan.types';
import { PlanRefused, PlansService, PlanView } from '../plans/plans.service';
import { DataPlans } from '../providers/providers';
import { presentSchedule } from '../schedules/schedules.controller';
import { SchedulesService, whenOf } from '../schedules/schedules.service';
import { Timing } from '../schedules/timing';
import { WalletService } from '../wallet/wallet.service';

const nullable = (type: string) => ({ type: [type, 'null'] });

/** Deliberately read and propose only: no tool here can approve a plan or move money. */
export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_contacts',
    description: "Lists the user's saved contacts, with an ID for each place they can be paid.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'list_data_plans',
    description: 'Lists the data plans on a phone network, with their IDs and prices.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { network: { type: 'string', description: 'MTN, Glo, Airtel or 9mobile' } },
      required: ['network'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_balance',
    description:
      "Reads the user's USDC balance with its naira value, how much of the daily payment limit is used and left, and the current naira per USDC rate. Moves no money.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'list_activity',
    description: "Lists the user's recent payments and money received, newest first, with dates and status. Use it for questions about past payments, and for requests like 'the same as last time'.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'propose_plan',
    description:
      'Shows the user an approval card for one or more payments. Moves no money. amount_naira is for airtime and bank; amount_usdc is a decimal string for usdc, or for bank when the user named a USDC amount and amount_naira is then null; data_plan_id is for data. Set the others to null.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              route: { type: 'string', enum: ['airtime', 'data', 'bank', 'usdc'] },
              destination_id: { type: ['string', 'null'], description: 'A destination ID from list_contacts, or null for airtime to a new phone number' },
              amount_naira: nullable('integer'),
              amount_usdc: nullable('string'),
              data_plan_id: nullable('string'),
              new_phone_number: { type: ['string', 'null'], description: 'Only for airtime to a phone not in list_contacts. Otherwise null.' },
              new_contact_name: { type: ['string', 'null'], description: 'The name given for that new phone number, or null if none was given.' },
            },
            required: ['route', 'destination_id', 'amount_naira', 'amount_usdc', 'data_plan_id', 'new_phone_number', 'new_contact_name'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_schedule',
    description:
      'Shows the user an approval card for payments that happen later: at a set time, after a delay, or repeating. Moves no money, and nothing runs until they approve. Every item needs its own when. Fields you do not need are null.',
    // Not strict: the API allows 16 optional fields across strict tools, and this one alone has more. The code below checks every field.
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              route: { type: 'string', enum: ['airtime', 'data', 'bank', 'usdc'] },
              destination_id: { type: 'string', description: 'A destination ID from list_contacts' },
              amount_naira: nullable('integer'),
              amount_usdc: nullable('string'),
              data_plan_id: nullable('string'),
              when: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['once', 'recurring'] },
                  delay_minutes: { ...nullable('integer'), description: 'once only: minutes from now. "in 4 hours" is 240.' },
                  date: { ...nullable('string'), description: 'once only: YYYY-MM-DD. Leave null when using delay_minutes.' },
                  time: { ...nullable('string'), description: '24-hour HH:MM in Nigeria. Null means 09:00.' },
                  frequency: { anyOf: [{ type: 'string', enum: ['daily', 'weekly', 'monthly'] }, { type: 'null' }], description: 'recurring only' },
                  interval: { ...nullable('integer'), description: 'recurring only: every 2 weeks is weekly with interval 2. Null means 1.' },
                  weekday: { ...nullable('integer'), description: 'weekly only: 0 is Sunday, 6 is Saturday' },
                  day_of_month: { ...nullable('integer'), description: 'monthly only: 1 to 28. Null means the 28th.' },
                  last_day_of_month: { ...nullable('boolean'), description: 'monthly only: true for the last day of every month' },
                  occurrences: { ...nullable('integer'), description: 'recurring only: how many payments in total, if the user limited it' },
                  start_date: { ...nullable('string'), description: 'recurring only: YYYY-MM-DD to begin from, if the user said so' },
                },
                required: ['kind', 'delay_minutes', 'date', 'time', 'frequency', 'interval', 'weekday', 'day_of_month', 'last_day_of_month', 'occurrences', 'start_date'],
                additionalProperties: false,
              },
            },
            required: ['route', 'destination_id', 'amount_naira', 'amount_usdc', 'data_plan_id', 'when'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_schedules',
    description: "Lists the user's active scheduled and repeating payments, with an ID, recipient, amount and when each one runs next.",
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'propose_cancel',
    description: 'Shows the user a card to confirm stopping one scheduled payment. It keeps running until they confirm.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { schedule_id: { type: 'string', description: 'An ID from list_schedules' } },
      required: ['schedule_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_contact',
    description:
      'Checks a new recipient and shows the user a card to confirm them. Fill only the fields for kind: phone, or bank_name and account_number, or wallet_address. Set the others to null.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Other ways the user refers to them, such as "mum"' },
        kind: { type: 'string', enum: ['phone', 'bank', 'wallet'] },
        phone: nullable('string'),
        bank_name: nullable('string'),
        account_number: nullable('string'),
        wallet_address: nullable('string'),
      },
      required: ['name', 'aliases', 'kind', 'phone', 'bank_name', 'account_number', 'wallet_address'],
      additionalProperties: false,
    },
  },
];

const planInput = z.object({
  items: z.array(
    z.object({
      route: z.enum(['airtime', 'data', 'bank', 'usdc']),
      destination_id: z.string().uuid().nullable(),
      amount_naira: z.number().nullable(),
      amount_usdc: z.string().nullable(),
      data_plan_id: z.string().nullable(),
      new_phone_number: z.string().nullish(),
      new_contact_name: z.string().nullish(),
    }),
  ),
});

const optional = <T extends z.ZodType>(type: T) => type.nullish().transform((value) => value ?? null);

const scheduleInput = z.object({
  items: z.array(
    z.object({
      route: z.enum(['airtime', 'data', 'bank', 'usdc']),
      destination_id: z.string().uuid(),
      amount_naira: z.number().nullable(),
      amount_usdc: z.string().nullable(),
      data_plan_id: z.string().nullable(),
      when: z.object({
        kind: z.enum(['once', 'recurring']),
        delay_minutes: optional(z.number()),
        date: optional(z.string()),
        time: optional(z.string()),
        frequency: optional(z.enum(['daily', 'weekly', 'monthly'])),
        interval: optional(z.number()),
        weekday: optional(z.number()),
        day_of_month: optional(z.number()),
        last_day_of_month: optional(z.boolean()),
        occurrences: optional(z.number()),
        start_date: optional(z.string()),
      }),
    }),
  ),
});

const toTiming = (when: z.infer<typeof scheduleInput>['items'][number]['when']): Timing => {
  if (when.kind === 'once') return { kind: 'once', delayMinutes: when.delay_minutes, date: when.date, time: when.time };
  if (!when.frequency) throw new PlanRefused('A repeating payment needs to say daily, weekly or monthly.');
  return {
    kind: 'recurring',
    frequency: when.frequency,
    interval: when.interval ?? 1,
    weekday: when.weekday,
    dayOfMonth: when.day_of_month,
    lastDayOfMonth: when.last_day_of_month ?? false,
    time: when.time,
    occurrences: when.occurrences,
    startDate: when.start_date,
  };
};

const contactInput = z.object({
  name: z.string().trim().min(1).max(100),
  aliases: z.array(z.string().max(50)).max(10),
  kind: z.enum(['phone', 'bank', 'wallet']),
  phone: z.string().nullable(),
  bank_name: z.string().nullable(),
  account_number: z.string().nullable(),
  wallet_address: z.string().nullable(),
});

export interface ToolOutcome {
  result: string;
  isError?: boolean;
  planId?: string;
  contactId?: string;
  scheduleGroupId?: string;
  cancelScheduleId?: string;
}

@Injectable()
export class AgentToolbox {
  constructor(
    private readonly contacts: ContactsService,
    private readonly plans: PlansService,
    private readonly dataPlans: DataPlans,
    private readonly wallet: WalletService,
    private readonly schedules: SchedulesService,
  ) {}

  /** The user comes from the signed-in session, never from the model, so it cannot act for anyone else. */
  async run(user: User, name: string, input: unknown): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'list_contacts':
          return { result: JSON.stringify(await this.listContacts(user)) };
        case 'list_data_plans':
          return { result: await this.listDataPlans(input) };
        case 'get_balance':
          return { result: JSON.stringify(await this.wallet.summary(user)) };
        case 'list_activity':
          return { result: JSON.stringify(await this.wallet.activity(user.id)) };
        case 'propose_plan':
          return await this.proposePlan(user, input);
        case 'propose_schedule':
          return await this.proposeSchedule(user, input);
        case 'list_schedules':
          return { result: JSON.stringify((await this.schedules.list(user.id)).map(presentSchedule)) };
        case 'propose_cancel':
          return await this.proposeCancel(user, input);
        case 'propose_contact':
          return await this.proposeContact(user, input);
        default:
          return { result: `Unknown tool: ${name}`, isError: true };
      }
    } catch (error) {
      if (error instanceof PlanRefused || error instanceof ContactRefused) return { result: error.message, isError: true };
      if (error instanceof z.ZodError) return { result: 'Those details are not in the expected form.', isError: true };
      throw error;
    }
  }

  private async listContacts(user: User) {
    // Saving someone's phone and later their bank makes two rows. To the user, that is one person.
    const people = new Map<string, { name: string; aliases: string[]; destinations: object[] }>();
    for (const contact of await this.contacts.listConfirmed(user.id)) {
      const key = contact.name.trim().toLowerCase();
      const person = people.get(key) ?? { name: contact.name, aliases: [], destinations: [] };
      person.aliases = [...new Set([...person.aliases, ...contact.aliases])];
      person.destinations.push(
        ...contact.destinations.map((destination) => ({
          destination_id: destination.id,
          kind: destination.kind,
          detail: describeDestination(destination),
        })),
      );
      people.set(key, person);
    }
    return [...people.values()];
  }

  private async listDataPlans(input: unknown): Promise<string> {
    const { network } = z.object({ network: z.string() }).parse(input);
    const plans = await this.dataPlans.forNetwork(network);
    return JSON.stringify(plans.map((plan) => ({ data_plan_id: plan.id, plan: plan.label, price: formatNaira(plan.priceKobo) })));
  }

  private async proposePlan(user: User, input: unknown): Promise<ToolOutcome> {
    const { items } = planInput.parse(input);
    const created: string[] = [];
    const resolved: ProposedItem[] = [];
    let plan: PlanView;
    try {
      for (const item of items) {
        let destinationId = item.destination_id;
        const isNew = destinationId === null;
        if (isNew) {
          if (item.route !== 'airtime' || !item.new_phone_number) return { result: 'That payment needs a saved recipient first.', isError: true };
          // Stored unconfirmed. Approving this plan is what saves it, and the card shows the number.
          const contact = await this.contacts.propose(user.id, item.new_contact_name?.trim() || item.new_phone_number, [], { kind: 'phone', phone: item.new_phone_number });
          created.push(contact.id);
          destinationId = contact.destinations[0]!.id;
        }
        resolved.push({
          route: item.route,
          destinationId: destinationId!,
          amountNaira: item.amount_naira,
          amountUsdc: item.amount_usdc,
          dataPlanId: item.data_plan_id,
          newPhone: isNew,
        });
      }
      plan = await this.plans.propose(user.id, resolved);
    } catch (error) {
      // Nothing to approve, so nothing should be left waiting.
      await Promise.all(created.map((id) => this.contacts.discard(user.id, id).catch(() => undefined)));
      throw error;
    }
    return {
      result: `The approval card is showing ${plan.items.length} payment(s), total ${formatNaira(plan.totalKobo)}. Nothing has moved.`,
      planId: plan.id,
    };
  }

  private async proposeSchedule(user: User, input: unknown): Promise<ToolOutcome> {
    const { items } = scheduleInput.parse(input);
    const group = await this.schedules.propose(
      user.id,
      items.map((item) => ({
        route: item.route,
        destinationId: item.destination_id,
        amountNaira: item.amount_naira,
        amountUsdc: item.amount_usdc,
        dataPlanId: item.data_plan_id,
        timing: toTiming(item.when),
      })),
    );
    return {
      result: `The approval card is showing: ${group.items.map((item) => `${item.recipientName}: ${whenOf(item)}`).join('; ')}. Nothing runs until they approve.`,
      scheduleGroupId: group.groupId,
    };
  }

  private async proposeCancel(user: User, input: unknown): Promise<ToolOutcome> {
    const { schedule_id: id } = z.object({ schedule_id: z.string().uuid() }).parse(input);
    const schedule = await this.schedules.get(user.id, id);
    if (!schedule || schedule.status !== 'active') return { result: 'That is not one of the active scheduled payments.', isError: true };
    return { result: `The card to stop ${schedule.recipientName}'s payment is showing. It keeps running until they confirm.`, cancelScheduleId: schedule.id };
  }

  private async proposeContact(user: User, input: unknown): Promise<ToolOutcome> {
    const details = contactInput.parse(input);
    const contact = await this.contacts.propose(user.id, details.name, details.aliases, this.destination(details));
    return {
      result: `The confirmation card is showing: ${describeDestination(contact.destinations[0]!)}. Wait for the user to confirm.`,
      contactId: contact.id,
    };
  }

  private destination(details: z.infer<typeof contactInput>): NewDestination {
    switch (details.kind) {
      case 'phone':
        return { kind: 'phone', phone: details.phone ?? '' };
      case 'bank':
        return { kind: 'bank', bankName: details.bank_name ?? '', accountNumber: details.account_number ?? '' };
      case 'wallet':
        return { kind: 'wallet', walletAddress: details.wallet_address ?? '' };
    }
  }
}
