import { PaymentRoute } from '../plans/plan.types';
import { PaymentProvider, PaymentRequest, PaymentResult, PaymentState } from './providers';

/** Sends each route to whichever partner handles it, so partners can go live one at a time. */
export class RoutedPaymentProvider extends PaymentProvider {
  constructor(private readonly routes: Record<PaymentRoute, PaymentProvider>) {
    super();
  }

  refusal(request: PaymentRequest): Promise<string | null> {
    return this.routes[request.route].refusal(request);
  }

  fundingAddress(request: PaymentRequest): Promise<string | null> {
    return this.routes[request.route].fundingAddress(request);
  }

  pay(request: PaymentRequest): Promise<PaymentResult> {
    return this.routes[request.route].pay(request);
  }

  status(reference: string, providerReference: string, route: PaymentRoute = 'bank'): Promise<PaymentState> {
    return this.routes[route].status(reference, providerReference);
  }
}
