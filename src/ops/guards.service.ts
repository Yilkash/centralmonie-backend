import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inArray, notInArray, sql } from 'drizzle-orm';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { agentPayments, payments } from '../database/schema';
import { PaymentRoute } from '../plans/plan.types';
import { SwitchesService } from './switches.service';

/** Agent payments that have taken, or may take, money out of the day's allowance. */
export const AGENT_STATUSES_THAT_COUNT = ['creating', 'awaiting_deposit', 'processing', 'paying', 'paid', 'needs_support'] as const;
/** Money has really arrived. Unpaid payments without a key stop counting here, so a stranger who starts payments and
 * never pays cannot use up a shop's, a bank account's or everyone's allowance for the day. */
export const AGENT_STATUSES_MONEY_ARRIVED = ['processing', 'paying', 'paid', 'needs_support'] as const;
const KEYLESS_ID = '00000000-0000-4000-8000-000000000402';

const startOfLagosDay = sql`(date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos')`;

/** The checks that apply to everyone, whichever way a payment starts. */
@Injectable()
export class GuardsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly switches: SwitchesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Why these payments cannot go ahead right now, or null if they can. Payments with no USDC behind them
   * yet are left out of the company cap, or a few accounts could use it up with nothing at stake.
   */
  async refusal(routes: readonly PaymentRoute[], addedKobo: number, db: Pick<Database, 'select'> = this.db): Promise<string | null> {
    const switches = await this.switches.all();
    if (switches.payments) return 'Payments are paused for the moment. Nothing was sent. Please try again later.';
    const paused = routes.find((route) => switches[route]);
    if (paused) return `${paused === 'usdc' ? 'USDC' : paused[0]!.toUpperCase() + paused.slice(1)} payments are paused for the moment. Nothing was sent.`;
    const cap = this.config.get('COMPANY_DAILY_CAP_NAIRA', { infer: true }) * 100;
    const [row] = await db
      .select({ used: sql<string>`coalesce(sum(${payments.amountKobo}), 0)` })
      .from(payments)
      .where(sql`${notInArray(payments.status, ['failed', 'returned', 'awaiting_signature', 'funding'])} and ${payments.createdAt} >= ${startOfLagosDay}`);
    const [agents] = await db
      .select({ used: sql<string>`coalesce(sum(${agentPayments.amountKobo}), 0)` })
      .from(agentPayments)
      // A keyed agent's unpaid payments count, as its own key is at stake; keyless ones count only once money arrives.
      .where(
        sql`${agentPayments.acceptedAt} >= ${startOfLagosDay} and (${inArray(agentPayments.status, [...AGENT_STATUSES_MONEY_ARRIVED])} or (${inArray(agentPayments.status, [...AGENT_STATUSES_THAT_COUNT])} and ${agentPayments.keyId} <> ${KEYLESS_ID}))`,
      );
    if (Number(row!.used) + Number(agents!.used) + addedKobo > cap) return 'Payments are busy right now. Nothing was sent. Please try again later.';
    return null;
  }
}
