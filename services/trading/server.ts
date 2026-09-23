import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { TradingStreamService } from "./service.ts";
import { selectionsSchema, slugSchema } from "./contracts.ts";
import type { StreamEvent } from "../../lib/trading/stream-types.ts";

export function authorized(header: string | undefined, token: string | undefined) {
  if (!token || token.length < 32 || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const bodySchema = z.object({ markets: selectionsSchema, ownerId: z.string().max(400).optional() }).strict();
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128000) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
function parseMarkets(url: URL): Set<string> | undefined {
  const values = url.searchParams.get("markets");
  if (!values) return undefined;
  return new Set(z.array(slugSchema).max(500).parse(values.split(",")));
}

export function createTradingServer(service: TradingStreamService, token: string | undefined) {
  const clients = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        // Deliberately no account state, market selections, credentials, or error bodies.
        const health = service.state.health;
        json(res, 200, { service: "dugout-stream", configured: health.configured, market: health.market.state,
          private: health.private.state, reconciliation: health.reconciliation.state, liveExecution: false });
        return;
      }
      if (!token || token.length < 32) { json(res, 503, { error: "Streaming service token is not configured." }); return; }
      if (!authorized(req.headers.authorization, token)) { json(res, 401, { error: "Unauthorized" }); return; }
      if (req.method === "GET" && url.pathname === "/v1/status") { json(res, 200, service.state.health); return; }
      if (req.method === "GET" && url.pathname === "/v1/snapshot") { json(res, 200, service.state.snapshot(parseMarkets(url))); return; }
      if (req.method === "POST" && url.pathname === "/v1/subscriptions") {
        const body = bodySchema.parse(await readJson(req));
        json(res, 200, service.setSubscriptions(body.markets, body.ownerId)); return;
      }
      if (req.method === "POST" && url.pathname === "/v1/reconcile") {
        service.requestReconciliation(); json(res, 202, { health: service.state.health }); return;
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        if (clients.size >= 100) { json(res, 503, { error: "Streaming connection capacity reached." }); return; }
        const slugs = parseMarkets(url);
        const ownerId = url.searchParams.get("ownerId");
        const releaseOwner = ownerId ? service.attachSubscriptionOwner(ownerId) : () => {};
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        clients.add(res);
        // This is the service's current state, not a replay guarantee. Clients replace state on reconnect.
        const send = (type: string, data: unknown) => {
          if (!res.destroyed && !res.writableEnded) {
            if (!res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) res.destroy();
          }
        };
        send("snapshot", service.state.snapshot(slugs));
        const unsubscribe = service.state.onEvent((event: StreamEvent) => {
          if ((event.type === "quote" || event.type === "trade") && slugs && !slugs.has(event.data.slug)) return;
          if (event.type === "account") send("account", service.state.snapshot(slugs).account);
          else send(event.type, event.data);
        });
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": transport keep-alive; not a provider update\n\n"); }, 15000);
        const cleanup = () => { clearInterval(heartbeat); unsubscribe(); releaseOwner(); clients.delete(res); };
        res.on("close", cleanup);
        res.on("error", cleanup);
        return;
      }
      // Intentionally no trading endpoint, even if credentials happen to be present.
      json(res, 404, { error: "Unknown read-only service route." });
    } catch {
      if (!res.headersSent) json(res, 400, { error: "Invalid service request." });
      else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("close", () => { for (const client of clients) client.destroy(); });
  return { server, closeClients: () => { for (const client of clients) client.end(); } };
}

export function startFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.TRADING_SERVICE_PORT ?? "4179");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TRADING_SERVICE_PORT");
  const host = env.TRADING_SERVICE_HOST ?? "127.0.0.1";
  const token = env.TRADING_SERVICE_TOKEN;
  if (host !== "127.0.0.1" && host !== "localhost" && (!token || token.length < 32)) {
    throw new Error("A service token of at least 32 characters is required for non-loopback binding.");
  }
  const idleTimeoutMs = Number(env.TRADING_STREAM_IDLE_TIMEOUT_MS ?? "60000");
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 15000 || idleTimeoutMs > 300000) throw new Error("Invalid idle timeout");
  const service = new TradingStreamService({ keyId: env.POLYMARKET_KEY_ID??env.POLYNARKET_KEY_ID, secretKey: env.POLYMARKET_SECRET_KEY, idleTimeoutMs });
  const { server, closeClients } = createTradingServer(service, token);
  server.listen(port, host, () => {
    service.start();
    process.stdout.write(`Dugout read-only streaming service listening on ${host}:${port}; ${service.state.health.configured ? "credentials configured; connecting" : "not_configured"}\n`);
  });
  const shutdown = () => { service.stop(); closeClients(); server.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { server, service, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startFromEnvironment();
