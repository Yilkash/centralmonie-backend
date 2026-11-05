import { mayRun, parseEvent } from './demo-agent-runner';

describe('the demo agent runner', () => {
  it('only runs when switched on, from this computer, with no proxy in front', () => {
    expect(mayRun({ enabled: true, proxyHops: 0, ip: '127.0.0.1' })).toBe(true);
    expect(mayRun({ enabled: true, proxyHops: 0, ip: '::1' })).toBe(true);
    expect(mayRun({ enabled: false, proxyHops: 0, ip: '127.0.0.1' })).toBe(false);
    expect(mayRun({ enabled: true, proxyHops: 0, ip: '41.58.1.1' })).toBe(false);
    expect(mayRun({ enabled: true, proxyHops: 1, ip: '127.0.0.1' })).toBe(false);
  });

  it('keeps only lines the agent marked as events', () => {
    expect(parseEvent('EVENT {"type":"quote","cost":"1.02"}')).toEqual({ type: 'quote', cost: '1.02' });
    expect(parseEvent('ed25519:secret')).toBeNull();
    expect(parseEvent('EVENT not json')).toBeNull();
    expect(parseEvent('EVENT {"no":"type"}')).toBeNull();
  });
});
