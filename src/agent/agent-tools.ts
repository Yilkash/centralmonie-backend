import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ContactRefused, ContactsService, describeDestination, NewDestination } from '../contacts/contacts.service';
import { User } from '../database/schema';
import { formatNaira } from '../money/money';
import { PlanRefused, PlansService } from '../plans/plans.service';
import { DataPlans } from '../providers/providers';

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
    name: 'propose_plan',
    description:
      'Shows the user an approval card for one or more payments. Moves no money. amount_naira is for airtime and bank; amount_usdc is a decimal string for usdc; data_plan_id is for data. Set the others to null.',
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
              destination_id: { type: 'string', description: 'A destination ID from list_contacts' },
              amount_naira: nullable('integer'),
              amount_usdc: nullable('string'),
              data_plan_id: nullable('string'),
            },
            required: ['route', 'destination_id', 'amount_naira', 'amount_usdc', 'data_plan_id'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
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
      destination_id: z.string().uuid(),
      amount_naira: z.number().nullable(),
      amount_usdc: z.string().nullable(),
      data_plan_id: z.string().nullable(),
    }),
  ),
});

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
}

@Injectable()
export class AgentToolbox {
  constructor(
    private readonly contacts: ContactsService,
    private readonly plans: PlansService,
    private readonly dataPlans: DataPlans,
  ) {}

  /** The user comes from the signed-in session, never from the model, so it cannot act for anyone else. */
  async run(user: User, name: string, input: unknown): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'list_contacts':
          return { result: JSON.stringify(await this.listContacts(user)) };
        case 'list_data_plans':
          return { result: await this.listDataPlans(input) };
        case 'propose_plan':
          return await this.proposePlan(user, input);
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
    return (await this.contacts.listConfirmed(user.id)).map((contact) => ({
      name: contact.name,
      aliases: contact.aliases,
      destinations: contact.destinations.map((destination) => ({
        destination_id: destination.id,
        kind: destination.kind,
        detail: describeDestination(destination),
      })),
    }));
  }

  private async listDataPlans(input: unknown): Promise<string> {
    const { network } = z.object({ network: z.string() }).parse(input);
    const plans = await this.dataPlans.forNetwork(network);
    return JSON.stringify(plans.map((plan) => ({ data_plan_id: plan.id, plan: plan.label, price: formatNaira(plan.priceKobo) })));
  }

  private async proposePlan(user: User, input: unknown): Promise<ToolOutcome> {
    const { items } = planInput.parse(input);
    const plan = await this.plans.propose(
      user.id,
      items.map((item) => ({
        route: item.route,
        destinationId: item.destination_id,
        amountNaira: item.amount_naira,
        amountUsdc: item.amount_usdc,
        dataPlanId: item.data_plan_id,
      })),
    );
    return {
      result: `The approval card is showing ${plan.items.length} payment(s), total ${formatNaira(plan.totalKobo)}. Nothing has moved.`,
      planId: plan.id,
    };
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
