import { Module } from '@nestjs/common';
import { IdentityProvider } from './identity-provider';
import { PrivyIdentityProvider } from './privy-identity-provider';
import { TestIdentityProvider } from './test-identity-provider';

@Module({
  providers: [{
      provide: IdentityProvider,
      useClass: process.env.IDENTITY_PROVIDER === 'test' ? TestIdentityProvider : PrivyIdentityProvider,
    },],
  exports: [IdentityProvider],
})
export class IdentityModule {}
