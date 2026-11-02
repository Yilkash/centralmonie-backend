export type PaymentRoute = 'airtime' | 'data' | 'bank' | 'usdc';

/** One payment as proposed. Exactly which amount field applies depends on the route. */
export interface ProposedItem {
  route: PaymentRoute;
  destinationId: string;
  amountNaira: number | null;
  amountUsdc: string | null;
  dataPlanId: string | null;
}
