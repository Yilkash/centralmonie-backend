import { PaymentRoute } from '../plans/plan.types';

export interface DataPlan {
  id: string;
  network: string;
  label: string;
  priceKobo: number;
}

export interface PaymentRequest {
  reference: string;
  route: PaymentRoute;
  destination: unknown;
  amountKobo: number;
  usdcMinor: number;
}

export type PaymentResult = { ok: true; providerReference: string } | { ok: false; reason: string };

/**
 * The outside services behind money. Each is simulated in Phase 1, and the real
 * partners replace them one at a time without changing the plan or chat code.
 */
export abstract class PaymentProvider {
  abstract pay(request: PaymentRequest): Promise<PaymentResult>;
}

export abstract class ExchangeRates {
  abstract nairaPerUsdc(): Promise<number>;
}

export abstract class BankLookup {
  /** The account holder's name according to the bank, or null if there is no such account. */
  abstract accountName(bankName: string, accountNumber: string): Promise<string | null>;
}

export abstract class DataPlans {
  abstract forNetwork(network: string): Promise<DataPlan[]>;
  abstract find(id: string): Promise<DataPlan | null>;
}

export const PHONE_NETWORKS: Record<string, string> = {
  '0803': 'MTN', '0806': 'MTN', '0703': 'MTN', '0706': 'MTN', '0813': 'MTN', '0816': 'MTN', '0810': 'MTN',
  '0814': 'MTN', '0903': 'MTN', '0906': 'MTN', '0913': 'MTN', '0916': 'MTN',
  '0805': 'Glo', '0807': 'Glo', '0705': 'Glo', '0815': 'Glo', '0811': 'Glo', '0905': 'Glo', '0915': 'Glo',
  '0802': 'Airtel', '0808': 'Airtel', '0708': 'Airtel', '0812': 'Airtel', '0701': 'Airtel', '0902': 'Airtel',
  '0901': 'Airtel', '0904': 'Airtel', '0907': 'Airtel', '0912': 'Airtel',
  '0809': '9mobile', '0818': '9mobile', '0817': '9mobile', '0909': '9mobile', '0908': '9mobile',
};
