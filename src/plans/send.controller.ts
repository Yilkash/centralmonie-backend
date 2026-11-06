import { Body, Controller, Get, HttpCode, Inject, Post, Query, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { payments } from '../database/schema';
import { z } from 'zod';
import { AgentRefusal } from '../agent-api/agent-api.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { USDC_CHAINS } from '../chain/usdc-chains';
import { ContactRefused, ContactsService, describeDestination } from '../contacts/contacts.service';
import { User } from '../database/schema';
import { formatNaira } from '../money/money';
import { DataPlans } from '../providers/providers';
import { presentPlan } from './plans.controller';
import { PlanRefused, PlansService } from './plans.service';
import { proposeWithRecipients, RecipientMissing } from './propose-with-recipients';

const PHONE_NETWORKS = ['MTN', 'Airtel', 'Glo', '9mobile'];

const sendBody = z.object({
  route: z.enum(['bank', 'usdc', 'airtime', 'data']),
  destination_id: z.string().uuid().nullish(),
  amount_naira: z.number().int().positive().max(10_000_000).nullish(),
  amount_usdc: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).nullish(),
  data_plan_id: z.string().max(100).nullish(),
  new_recipient: z
    .object({
      name: z.string().trim().max(60).nullish(),
      phone: z.string().trim().max(20).nullish(),
      wallet_address: z.string().trim().max(120).nullish(),
      wallet_chain: z.string().trim().max(30).nullish(),
      bank_name: z.string().trim().max(80).nullish(),
      account_number: z.string().trim().max(20).nullish(),
    })
    .nullish(),
});

/**
 * The Send page: the same payments as the chat, through the same rules, limits and approval card. Nothing moves
 * here; this only prepares the payment for the user to check and approve.
 */
@Controller('v1/send')
@UseGuards(AuthGuard)
export class SendController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly contacts: ContactsService,
    private readonly plans: PlansService,
    private readonly dataPlans: DataPlans,
  ) {}

  /** Saved recipients by kind, and the choices the form needs. */
  @Get('options')
  async options(@CurrentUser() user: User) {
    const saved = await this.contacts.listConfirmed(user.id);
    // Most recently paid first, so the people paid most often are at the top however many are saved.
    const paid = await this.db
      .select({ id: sql<string>`${payments.destination}->>'id'`, at: sql<Date>`max(${payments.createdAt})` })
      .from(payments)
      .where(and(eq(payments.userId, user.id), sql`${payments.destination}->>'id' is not null`))
      .groupBy(sql`${payments.destination}->>'id'`);
    const lastPaid = new Map(paid.map((row) => [row.id, new Date(row.at).toISOString()]));
    return {
      recipients: saved
        .flatMap((contact) =>
        contact.destinations.map((destination) => ({
          contact_id: contact.id,
          // Saved from the chat under its own address or number, so the page shows it short and offers a name.
          unnamed: contact.name.trim() === (destination.walletAddress ?? destination.phone ?? destination.accountNumber ?? ''),
          key: `${destination.kind}:${(destination.walletAddress ?? '').toLowerCase()}:${destination.network ?? ''}:${destination.phone ?? ''}:${destination.bankName ?? ''}:${destination.accountNumber ?? ''}`,
          last_paid_at: lastPaid.get(destination.id) ?? null,
          destination_id: destination.id,
          name: contact.name,
          kind: destination.kind,
          detail: describeDestination(destination),
          network: destination.kind === 'wallet' ? (USDC_CHAINS[(destination.network ?? 'base') as keyof typeof USDC_CHAINS]?.name ?? 'Base') : destination.kind === 'phone' ? destination.network : null,
        })),
      )
        .sort((a, b) => (b.last_paid_at ?? '').localeCompare(a.last_paid_at ?? '') || Number(a.unnamed) - Number(b.unnamed) || a.name.localeCompare(b.name))
        // The same address saved twice is one person: the most recent or best-named copy is kept.
        .filter((item, index, all) => all.findIndex((other) => other.key === item.key) === index)
        .map(({ key: _key, ...item }) => item),
      networks: Object.values(USDC_CHAINS).map((chain) => ({ id: chain.key, name: chain.name, token: chain.token })),
      phone_networks: PHONE_NETWORKS,
    };
  }

  @Get('data-plans')
  async plansFor(@Query('network') network: string) {
    if (!PHONE_NETWORKS.includes(network)) throw new UnprocessableEntityException(`Choose one of ${PHONE_NETWORKS.join(', ')}.`);
    return { plans: (await this.dataPlans.forNetwork(network)).map((plan) => ({ id: plan.id, label: plan.label, price: formatNaira(plan.priceKobo) })) };
  }

  /** Prices the payment and returns it for approval, exactly as the chat would show it. */
  @Post()
  @HttpCode(200)
  async prepare(@CurrentUser() user: User, @Body() body: unknown) {
    const parsed = sendBody.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Please fill in who to pay and how much.');
    const input = parsed.data;
    const fresh = input.new_recipient;
    try {
      const plan = await proposeWithRecipients(this.contacts, this.plans, user.id, [
        {
          route: input.route,
          destinationId: input.destination_id ?? null,
          amountNaira: input.amount_naira ?? null,
          amountUsdc: input.amount_usdc ?? null,
          dataPlanId: input.data_plan_id ?? null,
          newRecipient: fresh
            ? { name: fresh.name, phone: fresh.phone, walletAddress: fresh.wallet_address, walletChain: fresh.wallet_chain, bankName: fresh.bank_name, accountNumber: fresh.account_number }
            : null,
        },
      ]);
      return { plan: presentPlan(plan) };
    } catch (error) {
      if (error instanceof PlanRefused || error instanceof ContactRefused || error instanceof RecipientMissing || error instanceof AgentRefusal) {
        throw new UnprocessableEntityException(error.message);
      }
      throw error;
    }
  }
}
