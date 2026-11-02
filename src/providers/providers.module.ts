import { Module } from '@nestjs/common';
import { BankLookup, DataPlans, ExchangeRates, PaymentProvider } from './providers';
import {
  SimulatedBankLookup,
  SimulatedDataPlans,
  SimulatedExchangeRates,
  SimulatedPaymentProvider,
} from './simulated-providers';

@Module({
  providers: [
    { provide: PaymentProvider, useClass: SimulatedPaymentProvider },
    { provide: ExchangeRates, useClass: SimulatedExchangeRates },
    { provide: BankLookup, useClass: SimulatedBankLookup },
    { provide: DataPlans, useClass: SimulatedDataPlans },
  ],
  exports: [PaymentProvider, ExchangeRates, BankLookup, DataPlans],
})
export class ProvidersModule {}
