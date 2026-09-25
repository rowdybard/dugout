import { z } from "zod";
import { profile, saveProfile, sameOrigin } from "@/lib/server/storage";
import { portfolio } from "@/lib/server/portfolio";
import { book, metadata } from "@/lib/server/polymarket";
import { getFeed } from "@/lib/server/ingestion";
import {
  simulateBuy,
  simulateSell,
  feeFor,
  sideBook,
} from "@/lib/market/paper";
import { scan, activitySignals } from "@/lib/market/scanner";
export async function GET(req: Request) {
  try {
    return Response.json(await portfolio(req));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Portfolio unavailable" },
      { status: 503 },
    );
  }
}
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const body = z
      .object({
        action: z.enum(["buy", "close"]),
        side: z.enum(["YES", "NO"]).default("YES"),
        budget: z.number().finite().positive().optional(),
        slug: z.string().max(250).optional(),
        id: z.string().uuid().optional(),
      })
      .parse(await req.json());
    const p = await profile(req);
    if (body.action === "buy") {
      const budget = Number(body.budget);
      if (!Number.isFinite(budget) || budget < 1 || budget > p.data.cash)
        throw new Error(
          "Choose an amount from $1 up to your available paper cash.",
        );
      const feed = await getFeed();
      const m = feed.games
        .flatMap((g) => g.markets)
        .find((m) => m.slug === body.slug);
      if (!m) throw new Error("Choose an available MLB or NFL market.");
      const depth = await book(m.slug);
      if (depth.state !== "MARKET_STATE_OPEN")
        throw new Error("This market is not open for trading.");
      const fill = simulateBuy(sideBook(depth, body.side), budget, m.fee);
      if (!fill.contracts)
        throw new Error(
          "Not enough available offers for a whole contract at this budget.",
        );
      const signal = [
        ...scan(m, p.data.config),
        ...activitySignals(m.activityHistory || [], p.data.config),
      ][0];
      const now = Date.now();
      p.data.cash -= fill.total;
      p.data.positions.push({
        id: crypto.randomUUID(),
        slug: m.slug,
        game: m.game,
        title:
          body.side === "NO" ? m.oppositeTitle || `NO · ${m.title}` : m.title,
        league: m.league,
        side: body.side,
        entry: fill.average,
        entryProbability: fill.average,
        time: now,
        amount: fill.total,
        contracts: fill.contracts,
        fee: fill.fees,
        coefficient: m.fee,
        signal: signal?.type || "MANUAL",
        reason: signal?.reason || "Opened from the game feed.",
        status: "open",
        mark: sideBook(depth, body.side).bids[0]?.price ?? null,
        markTime: now,
      });
    } else if (body.action === "close") {
      const pos = p.data.positions.find(
        (x) => x.id === body.id && x.status === "open",
      );
      if (!pos) throw new Error("Open position not found.");
      const depth = await book(pos.slug);
      if (depth.state !== "MARKET_STATE_OPEN")
        throw new Error("Market is closed. Waiting for official settlement.");
      const m = await metadata(pos.slug);
      const fill = simulateSell(
        sideBook(depth, pos.side),
        pos.contracts,
        m.feeCoefficient == null ? 0.0695 : Number(m.feeCoefficient),
      );
      if (!fill.complete)
        throw new Error(
          "Not enough buyers to close this whole paper position. Try again later.",
        );
      pos.status = "closed";
      pos.exit = fill.average;
      pos.payout = fill.net;
      pos.closedAt = Date.now();
      p.data.cash += fill.net;
    } else throw new Error("Unknown paper action.");
    const equity =
      p.data.cash +
      p.data.positions
        .filter((x) => x.status === "open")
        .reduce(
          (s, x) =>
            s +
            x.contracts * (x.mark ?? x.entry) -
            feeFor(x.contracts, x.mark ?? x.entry, x.coefficient),
          0,
        );
    p.data.equity.push({ time: Date.now(), price: equity });
    await saveProfile(p);
    return Response.json(p.data);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Paper trade failed" },
      { status: 400 },
    );
  }
}
