export type PaymentRoute = 'airtime' | 'data' | 'bank' | 'usdc';

/** One payment as proposed. Exactly which amount field applies depends on the route. */
export interface ProposedItem {
  route: PaymentRoute;
  destinationId: string;
  amountNaira: number | null;
  amountUsdc: string | null;
  dataPlanId: string | null;
  /** Set by our own code, never by the agent: a phone, wallet or bank account first saved when this plan is approved. */
  newRecipient?: boolean;
}
