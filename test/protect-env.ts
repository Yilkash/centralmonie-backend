// Loaded before the app module, which reads its settings when it is first imported.
export const FAKE_SERV_PORT = 47_123;
process.env.SERV_PROTECT_ENABLED = 'true';
process.env.SERV_API_KEY = 'serv-key-for-tests-only';
process.env.SERV_ENDPOINT = `http://127.0.0.1:${FAKE_SERV_PORT}/v1/chat/completions`;
