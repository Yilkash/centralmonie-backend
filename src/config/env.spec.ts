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

  it('never repeats a value in its error', () => {
    expect(() => validateEnv({ ...valid, PORT: 'not-a-port' })).not.toThrow('super-secret-value');
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
