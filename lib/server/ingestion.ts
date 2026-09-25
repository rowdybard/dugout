import { replayData } from "./replay";
import type { Feed, Game, League, Market, Point } from "@/lib/market/types";
import { scan, activitySignals, DEFAULT_CONFIG } from "@/lib/market/scanner";
import {
  amount,
  getLeaguePage,
  numeric,
  type Raw,
} from "./polymarket";
import { cached, db, readCached } from "./storage";
import {discoverPages} from './catalog';
function normalize(e: Raw, league: League,observedAt:number): Game {
  const teams = (e.teams || []).map((t: Raw) => ({
    id: t.id,
    name: t.name,
    abbreviation: t.displayAbbreviation || t.abbreviation,
    record: t.record,
    logo: t.logo,
  }));
  const game: Game = {
    id: String(e.id),
    title: e.title || e.slug,
    league,
    start: e.startTime || e.eventDate || "",
    teams,
    markets: [],
  };
  game.markets = (e.markets || [])
    .filter((m: Raw) => m.slug && !m.hidden && m.active && !m.closed)
    .map((m: Raw): Market => {
      const long = m.marketSides?.find((s: Raw) => s.long === true);
      const winner = m.sportsMarketType?.endsWith("full_game_winner");
      const bid = amount(m.bestBidQuote),
        ask = amount(m.bestAskQuote);
      return {
        slug: m.slug,
        id: String(m.id),
        title:
          winner && long?.description
            ? `${long.description} win`
            : m.title || m.question,
        oppositeTitle: winner
          ? `${m.marketSides?.find((s: Raw) => s.long === false)?.description || "Other team"} win`
          : `NO · ${m.title || m.question}`,
        question: m.question || "",
        rules: m.description || "",
        gameId: game.id,
        game: game.title,
        league,
        start: game.start,
        teams: winner ? teams : [],
        kind: m.sportsMarketType || "",
        bid,
        ask,
        price: ask,
        volume: numeric(m.volume),
        fee: numeric(m.feeCoefficient) ?? 0.0695,
        active: true,
        history: [],
        signals: [],
        observedAt,
      };
    });
  return game;
}
export async function getCatalog(leagues:League[]=['MLB','NFL']):Promise<Feed>{
  return cached(`catalog-v1:${[...new Set(leagues)].sort().join(',')}`,15000,async()=>{
    const games: Game[] = [];
    const {pages,errors}=await discoverPages((league,offset,signal)=>getLeaguePage(league.toLowerCase(),offset,signal),12000,leagues);
    for(const {league,page} of pages){
          for (const e of page.events) {
            if (!e.closed && !e.ended && e.active) {
              const g = normalize(e, league,page.observedAt);
              if (g.markets.length) games.push(g);
            }
          }
    }
    if (!games.length && errors.length)
      throw new Error(
        "Unable to reach Polymarket US right now. Please try again shortly.",
      );
    const unique = [...new Map(games.map((g) => [g.id, g])).values()]
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
    const markets = unique
      .map(
        (g) =>
          g.markets.find((m) => m.kind.endsWith("full_game_winner")) ||
          g.markets[0],
      )
      .filter(Boolean);
    return {
      games: unique,
      markets,
      updated: Date.now(),
      errors,
      replayAt: (await replayData())?.recordedAt,
      coverage:
        `Full-game winners · ${unique.length} games loaded · up to 24 per league. Listing quotes may be up to 2 minutes old; trades require a fresh book.`,
    };
  });
}

/** Home charts use saved observations. Optional remote chart loads cannot block starting/scanning. */
export async function getFeed():Promise<Feed>{
  return cached('feed-v7',15000,async()=>{
    const feed=structuredClone(await getCatalog());
    await Promise.all(feed.markets.map(async m=>{
      try{
        const cutoff=Date.now()-3600000;
        const [rows,ticks,saved]=await Promise.all([
          db().prepare('SELECT time,price,(ask-bid) AS spread,volume FROM snapshots WHERE slug=? AND time>? ORDER BY time').bind(m.slug,cutoff).all<Point>(),
          db().prepare("SELECT time,ask AS price,(ask-bid) AS spread FROM trading_observations WHERE slug=? AND time>? AND ask IS NOT NULL AND source!='REPLAY' ORDER BY time LIMIT 1000").bind(m.slug,cutoff).all<Point>(),
          readCached<Point[]>(`history:${m.slug}:INTERVAL_1H`),
        ]);
        const observations=[...(saved?.value??[]),...rows.results,...ticks.results]
          .filter(p=>p.time>=cutoff&&Number.isFinite(p.price)&&p.price>=0&&p.price<=1);
        // Record a listing once at its actual receipt, never as a fresh tick on every render.
        if(m.price!==null&&m.observedAt>=cutoff)observations.push({time:m.observedAt,price:m.price,spread:m.ask!==null&&m.bid!==null?m.ask-m.bid:null});
        m.history=[...new Map(observations.map(p=>[p.time,p])).values()].sort((a,b)=>a.time-b.time);
        m.activityHistory=[...rows.results.map(p=>({time:p.time,volume:p.volume})),{time:m.observedAt,volume:m.volume}].sort((a,b)=>a.time-b.time);
        m.signals=[...scan(m),...activitySignals(m.activityHistory,DEFAULT_CONFIG)];
        if(m.history.length<2)m.historyError='Collecting history. Open the market for available exchange history.';
        await record(m);
      }catch{m.historyError='Saved history is temporarily unavailable.';}
    }));
    // Cleanup once per hour, not on every dashboard request.
    await cached('maintenance:observations',3600000,async()=>{
      await db().batch([
        db().prepare("DELETE FROM cache WHERE updated < ? AND key NOT LIKE 'simulation:%' AND key NOT LIKE 'bot-archive:%'").bind(Date.now()-7*86400000),
        db().prepare('DELETE FROM snapshots WHERE time < ?').bind(Date.now()-30*86400000),
        db().prepare('DELETE FROM trading_observations WHERE time < ?').bind(Date.now()-7*86400000),
      ]);return true;
    }).catch(()=>false);
    return feed;
  });
}
export async function record(m: Market) {
  await db()
    .prepare(
      "INSERT OR IGNORE INTO snapshots(id,slug,time,price,bid,ask,volume,depth,signals) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      `${m.slug}:${Math.floor(m.observedAt / 60000)}`,
      m.slug,
      m.observedAt,
      m.price,
      m.bid,
      m.ask,
      m.volume,
      m.depth ?? null,
      JSON.stringify(m.signals),
    )
    .run();
}
export async function enrich(m: Market) {
  const rows = await db()
    .prepare(
      "SELECT time,volume FROM snapshots WHERE slug=? AND time>? ORDER BY time",
    )
    .bind(m.slug, Date.now() - 3600000)
    .all<Point>();
  m.activityHistory = [
    ...rows.results,
    { time: m.observedAt, volume: m.volume },
  ];
  m.signals.push(...activitySignals(m.activityHistory, DEFAULT_CONFIG));
  return m;
}
