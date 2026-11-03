// Local runs only. Some Nigerian networks will not resolve coinbase.com, and the gas proxy must reach it.
// Asks Cloudflare over HTTPS for that one domain. A hosted server does not load this.
const dns = require('node:dns');
const https = require('node:https');
const original = dns.lookup;
dns.lookup = function (host, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : options ?? {};
  if (typeof host !== 'string' || !/(^|\.)coinbase\.com$/.test(host)) return original.apply(dns, arguments);
  const url = `https://1.1.1.1/dns-query?name=${host}&type=A`;
  https.get(url, { headers: { accept: 'application/dns-json' } }, (res) => {
    let body = '';
    res.on('data', (part) => (body += part));
    res.on('end', () => {
      try {
        const ip = JSON.parse(body).Answer.map((a) => a.data).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))[0];
        if (!ip) throw new Error('no address');
        opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);
      } catch (err) {
        cb(err);
      }
    });
  }).on('error', cb);
};
