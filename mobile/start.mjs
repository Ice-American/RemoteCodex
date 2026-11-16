// Starts only this phone bridge; the official desktop stays independently owned.
import { createGateway } from './gateway.mjs';
const peers = JSON.parse(process.env.MOBILE_CONTROL_PEERS ?? '[]');
const gateway = await createGateway({ port: Number(process.env.MOBILE_CONTROL_PORT ?? 43128), peers });
console.log(JSON.stringify({ service: 'codex-mobile-control', listening: '127.0.0.1', port: gateway.port, host: gateway.hostId }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await gateway.close(); process.exit(0); });
