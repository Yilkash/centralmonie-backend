import { Module } from '@nestjs/common';
import { IdentityProvider } from './identity-provider';
import { PrivyIdentityProvider } from './privy-identity-provider';

@Module({
  providers: [{ provide: IdentityProvider, useClass: PrivyIdentityProvider }],
  exports: [IdentityProvider],
})
export class IdentityModule {}
