import { ConfigService } from '@nestjs/config';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { IdentityUnavailableError, InvalidIdentityError } from './identity-provider';
import { PrivyIdentityProvider } from './privy-identity-provider';

const SUBJECT = 'did:privy:abc';
const WALLET = '0x393eA6fbd50b821CdE7EdC1b936c567dbb15c26d';

describe('PrivyIdentityProvider', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let provider: PrivyIdentityProvider;

  const sign = (claims: { issuer?: string; audience?: string; subject?: string; expires?: string } = {}) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(claims.issuer ?? 'privy.io')
      .setAudience(claims.audience ?? 'app')
      .setSubject(claims.subject ?? SUBJECT)
      .setIssuedAt()
      .setExpirationTime(claims.expires ?? '5m')
      .sign(keys.privateKey);

  const privyAnswers = (status: number, body: unknown) =>
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));

  beforeAll(async () => {
    keys = await generateKeyPair('ES256');
  });

  beforeEach(async () => {
    const settings: Record<string, string> = {
      PRIVY_APP_ID: 'app',
      PRIVY_APP_SECRET: 'secret',
      PRIVY_VERIFICATION_KEY: await exportSPKI(keys.publicKey),
    };
    provider = new PrivyIdentityProvider({ get: (name: string) => settings[name] } as unknown as ConfigService<never, true>);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the email and checksummed wallet of a valid token', async () => {
    privyAnswers(200, {
      id: SUBJECT,
      linked_accounts: [
        { type: 'email', address: 'a@example.com' },
        { type: 'smart_wallet', address: WALLET.toLowerCase() },
      ],
    });
    await expect(provider.verify(await sign())).resolves.toEqual({
      subject: SUBJECT,
      email: 'a@example.com',
      walletAddress: WALLET,
    });
  });

  it('allows a user whose wallet is not created yet', async () => {
    privyAnswers(200, { id: SUBJECT, linked_accounts: [] });
    await expect(provider.verify(await sign())).resolves.toMatchObject({ walletAddress: null });
  });

  it.each([
    ['another app', { audience: 'other' }],
    ['another issuer', { issuer: 'evil.example' }],
    ['an unexpected subject', { subject: 'someone' }],
    ['an expired token', { expires: '-1m' }],
  ])('rejects %s without asking Privy', async (_name, claims) => {
    const fetchSpy = privyAnswers(200, {});
    await expect(provider.verify(await sign(claims))).rejects.toBeInstanceOf(InvalidIdentityError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('ES256');
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' }).setIssuer('privy.io').setAudience('app')
      .setSubject(SUBJECT).setExpirationTime('5m').sign(other.privateKey);
    await expect(provider.verify(forged)).rejects.toBeInstanceOf(InvalidIdentityError);
  });

  it('treats a Privy outage as unavailable, not as a bad token', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(provider.verify(await sign())).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  describe('saved profiles', () => {
    const withWallet = { id: SUBJECT, linked_accounts: [{ type: 'smart_wallet', address: WALLET }] };

    it('asks Privy once while the profile is fresh', async () => {
      const fetchSpy = privyAnswers(200, withWallet);
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify(withWallet)));
      await provider.verify(await sign());
      await provider.verify(await sign());
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps asking until the wallet exists', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: SUBJECT, linked_accounts: [] })));
      await provider.verify(await sign());
      await provider.verify(await sign());
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('still checks the token every time', async () => {
      jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(withWallet)));
      await provider.verify(await sign());
      await expect(provider.verify(await sign({ audience: 'other' }))).rejects.toBeInstanceOf(InvalidIdentityError);
    });

    it('uses the saved profile when Privy is down', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(withWallet)));
      await provider.verify(await sign());
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000);
      fetchSpy.mockRejectedValue(new Error('network down'));
      await expect(provider.verify(await sign())).resolves.toMatchObject({ walletAddress: WALLET });
    });

    it('notices a deleted user once the profile is no longer fresh', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(withWallet)));
      await provider.verify(await sign());
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000);
      fetchSpy.mockImplementation(async () => new Response('{}', { status: 404 }));
      await expect(provider.verify(await sign())).rejects.toBeInstanceOf(InvalidIdentityError);
    });
  });

  it('refuses a user record for someone else', async () => {
    privyAnswers(200, { id: 'did:privy:other', linked_accounts: [] });
    await expect(provider.verify(await sign())).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});
