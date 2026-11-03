import { PaymentProvider } from './providers';
import { RoutedPaymentProvider } from './routed-provider';

const fake = (name: string) =>
  ({
    refusal: jest.fn(async () => name),
    fundingAddress: jest.fn(async () => name),
    pay: jest.fn(async () => ({ ok: true, providerReference: name })),
    status: jest.fn(async () => ({ state: 'completed' })),
  }) as unknown as PaymentProvider;

describe('RoutedPaymentProvider', () => {
  const airtime = fake('airtime');
  const bank = fake('bank');
  const usdc = fake('usdc');
  const routed = new RoutedPaymentProvider({ airtime, data: airtime, bank, usdc });
  const request = (route: 'airtime' | 'data' | 'bank') => ({ reference: 'r', route, destination: {}, amountKobo: 1, usdcMinor: 1 });

  it('sends each route to its partner', async () => {
    await expect(routed.fundingAddress(request('data'))).resolves.toBe('airtime');
    await expect(routed.refusal(request('bank'))).resolves.toBe('bank');
  });

  it('asks the right partner about a payment', async () => {
    await routed.status('r', 'p', 'airtime');
    expect(airtime.status).toHaveBeenCalledWith('r', 'p');
    expect(bank.status).not.toHaveBeenCalled();
  });
});
