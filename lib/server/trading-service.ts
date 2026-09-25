import { env } from 'cloudflare:workers';
import {polymarketSecrets} from '../trading/credentials';

function connection() {
  const values = env as unknown as Record<string, unknown>;
  const base = typeof values.TRADING_SERVICE_URL === 'string' ? values.TRADING_SERVICE_URL : '';
  const token = typeof values.TRADING_SERVICE_TOKEN === 'string' ? values.TRADING_SERVICE_TOKEN : '';
  if (!base || !token) return null;
  const url = new URL(base);
  if (url.protocol !== 'https:') throw new Error('Trading service requires HTTPS.');
  return { base: url.origin, token };
}
export async function serviceRequest(path: string, init: RequestInit = {}) {
  const config = connection();
  if (!config) return null;
  return fetch(config.base + path, {
    ...init, headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${config.token}` },
    signal: init.signal ?? AbortSignal.timeout(8000),
  });
}
export async function tradingStatus() {
  try {
    if(polymarketSecrets(env as unknown as Record<string,unknown>))return {transport:'stream',state:'available',liveEnabled:false,
      message:'US market streaming is configured. Connection is verified when a valid market book arrives.',updatedAt:Date.now()};
    const response = await serviceRequest('/v1/status');
    if (!response) return { transport: 'rest', state: 'not_configured', liveEnabled: false,
      message: 'REST quotes · streaming account not connected', updatedAt: Date.now() };
    if (!response.ok) throw new Error('Service unavailable');
    const health = await response.json() as import('@/lib/trading/stream-types').StreamHealth;
    const ready=health.market.state==='connected' && health.private.state==='connected' && health.reconciliation.state==='ready';
    const state=!health.configured?'not_configured':ready?'ready':health.market.state==='stale'||health.market.state==='error'?'stale':'reconciling';
    return { transport: 'stream', state, liveEnabled: false,
      message: ready?'Streaming connected · live execution not enabled':'Streaming awaiting connection or reconciliation', health, updatedAt: Date.now() };
  } catch {
    return { transport: 'rest', state: 'stale', liveEnabled: false,
      message: 'Streaming unavailable · REST fallback', updatedAt: Date.now() };
  }
}
