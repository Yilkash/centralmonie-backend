import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AgentPayout, BankLookup, DataPlan, DataPlans, ExchangeRates, PaymentProvider, PaymentRequest, PaymentResult, PaymentState } from './providers';

/** Moves nothing. An account number ending in 0000 fails, so failure paths can be exercised. */
@Injectable()
export class SimulatedPaymentProvider extends PaymentProvider {
  async refusal(): Promise<string | null> {
    return null;
  }

  async fundingAddress(): Promise<string | null> {
    return null;
  }

  async status(): Promise<PaymentState> {
    return { state: 'completed' };
  }

  async pay(request: PaymentRequest): Promise<PaymentResult> {
    const destination = request.destination as { accountNumber?: string };
    if (destination.accountNumber?.endsWith('0000')) {
      return { ok: false, reason: 'Simulated failure: the bank refused this payment' };
    }
    return { ok: true, providerReference: `simulated-${randomUUID()}` };
  }
}

@Injectable()
export class SimulatedExchangeRates extends ExchangeRates {
  async nairaPerUsdc(): Promise<number> {
    return 1500;
  }
}

/** An account number ending in 9999 does not exist. */
@Injectable()
export class SimulatedBankLookup extends BankLookup {
  async accountName(_bankName: string, accountNumber: string): Promise<string | null> {
    if (accountNumber.endsWith('9999')) return null;
    return `SIMULATED HOLDER ${accountNumber.slice(-4)}`;
  }
}

const PLANS = ['MTN', 'Glo', 'Airtel', '9mobile'].flatMap((network): DataPlan[] =>
  [
    ['500mb', '500MB, 30 days', 50000],
    ['1gb', '1GB, 30 days', 100000],
    ['5gb', '5GB, 30 days', 350000],
  ].map(([size, label, priceKobo]) => ({
    id: `${network.toLowerCase()}-${size as string}`,
    network,
    label: label as string,
    priceKobo: priceKobo as number,
  })),
);

@Injectable()
export class SimulatedDataPlans extends DataPlans {
  async forNetwork(network: string): Promise<DataPlan[]> {
    return PLANS.filter((plan) => plan.network.toLowerCase() === network.toLowerCase());
  }

  async find(id: string): Promise<DataPlan | null> {
    return PLANS.find((plan) => plan.id === id) ?? null;
  }
}

/** Test mode: pays nobody, and reports the payment as done. */
export class SimulatedAgentPayout extends AgentPayout {
  async deposit(request: PaymentRequest): Promise<{ address: string; usdcMinor: number; destinationKobo: number }> {
    return { address: `0x${randomBytes(20).toString('hex')}`, usdcMinor: request.usdcMinor, destinationKobo: request.amountKobo };
  }

  async status(): Promise<PaymentState> {
    return { state: 'completed' };
  }
}
