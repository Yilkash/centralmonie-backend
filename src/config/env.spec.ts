import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://localhost/db',
  PRIVY_APP_ID: 'app',
  PRIVY_APP_SECRET: 'super-secret-value',
  PRIVY_VERIFICATION_KEY: 'key',
};

describe('validateEnv', () => {
  it('applies defaults and splits the allowed origins', () => {
    const env = validateEnv({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.PORT).toBe(4010);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('names a missing variable', () => {
    const { PRIVY_APP_ID: _omitted, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow('PRIVY_APP_ID');
  });

  it('needs no Privy settings in test mode, so anyone can try it without keys', () => {
    expect(() => validateEnv({ DATABASE_URL: 'postgres://localhost/db', IDENTITY_PROVIDER: 'test' })).not.toThrow();
    expect(() => validateEnv({ DATABASE_URL: 'postgres://localhost/db' })).toThrow('IDENTITY_PROVIDER=test');
  });

  it('never repeats a value in its error', () => {
    expect(() => validateEnv({ ...valid, PORT: 'not-a-port' })).not.toThrow('super-secret-value');
  });

  describe('real money', () => {
    const live = {
      ...valid,
      CHAIN_ID: '8453',
      ALLOW_REAL_MONEY: 'I understand this moves real money',
      PAYMENTS_MODE: 'chain',
      REQUIRE_PIN: 'true',
      CHAIN_RPC_URL: 'https://mainnet.base.org',
      USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      COLLECTION_ADDRESS: '0x1',
      COLLECTION_KEY: 'k',
      SERVER_OWNER_KEY: 'k',
      ADMIN_TOKEN: 'a'.repeat(24),
      PAYSCRIBE_SECRET_KEY: 'k',
      PAYSCRIBE_BASE_URL: 'https://api.payscribe.ng/api/v1/',
      SWITCH_API_KEY: 'k',
      SWITCH_BASE_URL: 'https://api.onswitch.xyz',
      SWITCH_REFUND_ADDRESS: '0x1',
      SWITCH_SANDBOX: 'false',
    };

    it('accepts complete live settings', () => {
      expect(validateEnv(live).CHAIN_ID).toBe(8453);
    });

    it('refuses test-network leftovers', () => {
      const { USDC_ADDRESS: _usdc, ...noUsdc } = live;
      const { CHAIN_RPC_URL: _rpc, ...noRpc } = live;
      expect(() => validateEnv(noUsdc)).toThrow(/USDC_ADDRESS/);
      expect(() => validateEnv(noRpc)).toThrow(/CHAIN_RPC_URL/);
      expect(() => validateEnv({ ...live, PAYSCRIBE_BASE_URL: 'https://sandbox.payscribe.ng/api/v1/' })).toThrow(/PAYSCRIBE_BASE_URL/);
      expect(() => validateEnv({ ...live, SWITCH_SANDBOX: 'true' })).toThrow(/SWITCH_SANDBOX/);
      expect(() => validateEnv({ ...live, REQUIRE_PIN: 'false' })).toThrow(/REQUIRE_PIN/);
    });

    it('runs without a PIN only when that is stated in full', () => {
      expect(() => validateEnv({ ...live, REQUIRE_PIN: 'false', ALLOW_NO_PIN: 'yes' })).toThrow(/REQUIRE_PIN/);
      expect(validateEnv({ ...live, REQUIRE_PIN: 'false', ALLOW_NO_PIN: 'I understand approvals have no PIN' }).REQUIRE_PIN).toBe(false);
    });

    it('refuses real USDC on a test network', () => {
      expect(() => validateEnv({ ...valid, USDC_ADDRESS: live.USDC_ADDRESS })).toThrow(/real USDC/);
    });
  });

  describe('partners on a test network', () => {
    const chain = { ...valid, PAYMENTS_MODE: 'chain', COLLECTION_ADDRESS: '0x1' };
    const switchKey = { ...chain, SWITCH_API_KEY: 'k', SWITCH_BASE_URL: 'https://api.onswitch.xyz' };

    it('refuses a Switch key unless it is declared a sandbox key', () => {
      expect(() => validateEnv(switchKey)).toThrow(/SWITCH_SANDBOX must be true/);
      expect(() => validateEnv({ ...switchKey, SWITCH_SANDBOX: 'false' })).toThrow(/SWITCH_SANDBOX must be true/);
      expect(validateEnv({ ...switchKey, SWITCH_SANDBOX: 'true' }).SWITCH_SANDBOX).toBe('true');
    });

    it('refuses the live Payscribe address', () => {
      const key = { ...chain, PAYSCRIBE_SECRET_KEY: 'k' };
      expect(() => validateEnv({ ...key, PAYSCRIBE_BASE_URL: 'https://api.payscribe.ng/api/v1/' })).toThrow(/sandbox/);
      expect(() => validateEnv(key)).toThrow(/sandbox/);
      expect(validateEnv({ ...key, PAYSCRIBE_BASE_URL: 'https://sandbox.payscribe.ng/api/v1/' }).PAYSCRIBE_SECRET_KEY).toBe('k');
    });

    it('refuses partner keys in simulated mode', () => {
      expect(() => validateEnv({ ...valid, SWITCH_API_KEY: 'k', SWITCH_SANDBOX: 'true' })).toThrow(/PAYMENTS_MODE=chain/);
    });
  });
});
