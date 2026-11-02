import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { importSPKI, jwtVerify, type KeyLike } from 'jose';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { Env } from '../config/env';
import {
  IdentityProvider,
  IdentityUnavailableError,
  InvalidIdentityError,
  VerifiedIdentity,
} from './identity-provider';

const privyUser = z.object({
  id: z.string(),
  linked_accounts: z.array(z.object({ type: z.string(), address: z.string().optional() })),
});

const PROFILE_FRESH_MS = 5 * 60 * 1000;
const PROFILE_STALE_MS = 60 * 60 * 1000;
const MAX_CACHED_PROFILES = 10_000;

/** Authentication and lookup only. Never signs, delegates, or exports keys. */
@Injectable()
export class PrivyIdentityProvider extends IdentityProvider {
  private readonly logger = new Logger(PrivyIdentityProvider.name);
  /** The token proves who is calling on its own. Only the profile comes from Privy, so it is reused. */
  private readonly profiles = new Map<string, { identity: VerifiedIdentity; fetchedAt: number }>();
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly verificationKey: string;
  private key: Promise<KeyLike> | undefined;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.appId = config.get('PRIVY_APP_ID', { infer: true });
    this.appSecret = config.get('PRIVY_APP_SECRET', { infer: true });
    this.verificationKey = config.get('PRIVY_VERIFICATION_KEY', { infer: true });
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const subject = await this.subjectOf(token);
    const cached = this.profiles.get(subject);
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached?.identity.walletAddress && age < PROFILE_FRESH_MS) return cached.identity;

    try {
      const identity = await this.fetchProfile(subject);
      this.profiles.delete(subject);
      if (this.profiles.size >= MAX_CACHED_PROFILES) this.profiles.delete(this.profiles.keys().next().value!);
      this.profiles.set(subject, { identity, fetchedAt: Date.now() });
      return identity;
    } catch (error) {
      // The token already verified, so a slow Privy need not sign anyone out. A deleted user still fails.
      if (error instanceof IdentityUnavailableError && cached && age < PROFILE_STALE_MS) {
        this.logger.warn(`Using a saved profile: ${error.message}`);
        return cached.identity;
      }
      if (error instanceof IdentityUnavailableError) this.logger.warn(error.message);
      throw error;
    }
  }

  private async fetchProfile(subject: string): Promise<VerifiedIdentity> {
    const user = await this.lookup(subject);
    const emailAccount = user.linked_accounts.find((account) => account.type === 'email');
    const wallet = user.linked_accounts.find((account) => account.type === 'smart_wallet');
    if (wallet && (!wallet.address || !isAddress(wallet.address))) {
      throw new IdentityUnavailableError('Privy returned an invalid smart wallet address');
    }
    return {
      subject,
      email: emailAccount?.address ?? null,
      walletAddress: wallet?.address ? getAddress(wallet.address) : null,
    };
  }

  private async subjectOf(token: string): Promise<string> {
    let key: KeyLike;
    try {
      this.key ??= importSPKI(this.verificationKey.replace(/\\n/g, '\n'), 'ES256');
      key = await this.key;
    } catch {
      throw new IdentityUnavailableError('The Privy verification key is invalid');
    }
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['ES256'],
        issuer: 'privy.io',
        audience: this.appId,
        requiredClaims: ['sub', 'exp'],
      });
      if (!payload.sub?.startsWith('did:privy:')) throw new Error('unexpected subject');
      return payload.sub;
    } catch {
      throw new InvalidIdentityError('Invalid access token');
    }
  }

  private async lookup(subject: string): Promise<z.infer<typeof privyUser>> {
    let response: Response;
    try {
      response = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(subject)}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`${this.appId}:${this.appSecret}`).toString('base64')}`,
          'privy-app-id': this.appId,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new IdentityUnavailableError('Privy could not be reached');
    }
    if (response.status === 404) throw new InvalidIdentityError('This user no longer exists');
    if (!response.ok) throw new IdentityUnavailableError('Privy user lookup failed');

    const parsed = privyUser.safeParse(await response.json().catch(() => null));
    if (!parsed.success || parsed.data.id !== subject) {
      throw new IdentityUnavailableError('Privy returned an unexpected user');
    }
    return parsed.data;
  }
}
