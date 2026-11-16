// Uses an explicitly paired Tailscale address without changing system DNS.
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
export function validTailAddress(address) {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}
export async function fetchPeer(url, options, address) {
  if (!address) return fetch(url, options);
  if (!validTailAddress(address)) throw Error('目标电脑的私网地址无效');
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    // URL hostname and SNI stay unchanged. Normal TLS hostname/chain checks
    // still apply; only DNS resolution uses our explicitly configured peer IP.
    const request = https.request(target, { method: options.method, headers: options.headers, signal: options.signal,
      lookup: (_hostname, opts, callback) => opts?.all ? callback(null, [{address, family:4}]) : callback(null, address, 4),
    }, response => resolve({ status: response.statusCode,
      headers: new Headers(Object.entries(response.headers).filter(([,v]) => v != null).map(([k,v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])),
      body: Readable.toWeb(response) }));
    request.once('error', reject);
    request.end(options.body);
  });
}
