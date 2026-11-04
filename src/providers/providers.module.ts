import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { PayscribeProvider } from './payscribe/payscribe.provider';
import { AgentPayout, BankLookup, DataPlans, ExchangeRates, NairaOnramp, PaymentProvider } from './providers';
import { RoutedPaymentProvider } from './routed-provider';
import { SimulatedAgentPayout, SimulatedBankLookup, SimulatedDataPlans, SimulatedExchangeRates, SimulatedPaymentProvider } from './simulated-providers';
import { SwitchProvider } from './switch/switch.provider';

type Config = ConfigService<Env, true>;
const PAYSCRIBE = Symbol('payscribe');
const SWITCH = Symbol('switch');

// Each partner switches on when its key is set, and until then that route stays simulated.
@Module({
  providers: [
    {
      provide: PAYSCRIBE,
      inject: [ConfigService],
      useFactory: (config: Config) => {
        const apiKey = config.get('PAYSCRIBE_SECRET_KEY', { infer: true });
        const baseUrl = config.get('PAYSCRIBE_BASE_URL', { infer: true });
        return apiKey && baseUrl ? new PayscribeProvider({ apiKey, baseUrl }) : null;
      },
    },
    {
      provide: SWITCH,
      inject: [ConfigService],
      useFactory: (config: Config) => {
        const apiKey = config.get('SWITCH_API_KEY', { infer: true });
        const baseUrl = config.get('SWITCH_BASE_URL', { infer: true });
        const refundAddress = config.get('SWITCH_REFUND_ADDRESS', { infer: true });
        return apiKey && baseUrl && refundAddress
          ? new SwitchProvider({
              apiKey,
              baseUrl,
              refundAddress,
              sandbox: config.get('SWITCH_SANDBOX', { infer: true }) === 'true',
              webhookSecret: config.get('SWITCH_WEBHOOK_SECRET', { infer: true }),
              callbackUrl: config.get('SWITCH_CALLBACK_URL', { infer: true }),
              onrampCallbackUrl: config.get('SWITCH_ONRAMP_CALLBACK_URL', { infer: true }),
            })
          : null;
      },
    },
    {
      provide: PaymentProvider,
      inject: [PAYSCRIBE, SWITCH],
      useFactory: (payscribe: PayscribeProvider | null, switch_: SwitchProvider | null) => {
        const simulated = new SimulatedPaymentProvider();
        return new RoutedPaymentProvider({
          airtime: payscribe ?? simulated,
          data: payscribe ?? simulated,
          bank: switch_ ?? simulated,
          usdc: simulated, // never called: a USDC payment goes straight to the recipient
        });
      },
    },
    {
      provide: AgentPayout,
      inject: [SWITCH],
      useFactory: (switch_: SwitchProvider | null): AgentPayout =>
        switch_
          ? { deposit: (request) => switch_.deposit(request), status: (reference) => switch_.status(reference, reference) }
          : new SimulatedAgentPayout(),
    },
    { provide: ExchangeRates, inject: [SWITCH], useFactory: (switch_: SwitchProvider | null) => switch_ ?? new SimulatedExchangeRates() },
    { provide: BankLookup, inject: [SWITCH], useFactory: (switch_: SwitchProvider | null) => switch_ ?? new SimulatedBankLookup() },
    { provide: NairaOnramp, inject: [SWITCH], useFactory: (switch_: SwitchProvider | null) => switch_ },
    { provide: DataPlans, inject: [PAYSCRIBE], useFactory: (payscribe: PayscribeProvider | null) => payscribe ?? new SimulatedDataPlans() },
  ],
  exports: [AgentPayout, PaymentProvider, ExchangeRates, BankLookup, DataPlans, NairaOnramp],
})
export class ProvidersModule {}
