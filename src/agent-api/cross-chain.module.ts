import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';
import { CrossChain, OneClickCrossChain, SimulatedCrossChain } from './cross-chain';

@Module({
  providers: [
    {
      provide: CrossChain,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): CrossChain =>
        config.get('PAYMENTS_MODE', { infer: true }) === 'simulated'
          ? new SimulatedCrossChain()
          : new OneClickCrossChain(config.get('ONECLICK_API_KEY', { infer: true }), config.get('ONECLICK_BASE_URL', { infer: true }), fetch, 1500, {
              bps: config.get('ONECLICK_FEE_BPS', { infer: true }),
              recipient: config.get('ONECLICK_FEE_RECIPIENT', { infer: true }),
            }),
    },
  ],
  exports: [CrossChain],
})
export class CrossChainModule {}
