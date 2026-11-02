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
});
