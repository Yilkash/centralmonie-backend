import { Injectable } from '@nestjs/common';
import { IdentityProvider, InvalidIdentityError, VerifiedIdentity } from './identity-provider';

/**
 * For automated browser tests only: a token "test|email|wallet" signs in as that person with no check.
 * The environment check refuses this provider in production, and the module never selects it by default.
 */
@Injectable()
export class TestIdentityProvider extends IdentityProvider {
  async verify(token: string): Promise<VerifiedIdentity> {
    const [scheme, email, wallet] = token.split('|');
    if (scheme !== 'test' || !email) throw new InvalidIdentityError('Not a test token');
    return { subject: `test:${email}`, email, walletAddress: wallet || null };
  }
}
