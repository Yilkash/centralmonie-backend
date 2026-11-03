// AppModule validates settings when it is imported, so they must exist before any test file loads.
// Set unconditionally, so a developer's .env cannot point the tests at a real database.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://tenkobo:localdev@localhost:54445/tenkobo_test';
process.env.CORS_ORIGINS = 'http://allowed.test';
process.env.PRIVY_APP_ID = 'test';
process.env.PRIVY_APP_SECRET = 'test';
process.env.PRIVY_VERIFICATION_KEY = 'test';
delete process.env.ANTHROPIC_API_KEY;
process.env.WORKER_ENABLED = 'false';
process.env.ADMIN_TOKEN = 'admin-token-for-tests-only-0001';
process.env.SPONSORSHIP_TOKEN = 'sponsor-token-for-tests-only-001';
process.env.PAYMENTS_MODE = 'simulated';
