import {specSchema,specKey,type StrategySpec} from './spec.ts';

/**
 * Every strategy version Dugout has specified, including killed and replaced ones (the record of what was tried).
 * Strategy code reads its thresholds from here (`paramsOf`), so the pre-registration lock (prereg.lock.json) covers
 * exactly what trades. Evidence citations: docs/STRATEGY-ARCHITECTURE.md#evidence. "Internal" means
 * research/studies/report.md (in-sample: it may suggest a hypothesis but cannot confirm one).
 */

const FOOTBALL_LATENCY='Game reports arrive seconds after the play; books are polled about every 2.5 s; paper fills need a later book after a 1 s delay.';

const RAW:StrategySpec[]=[
  {id:'favourite-hold',version:'1',title:'Pregame favourite, held to the final',family:'favourite-longshot',sports:['CFB','NFL','MLB'],phases:['pregame'],
    hypothesis:'Bettors overpay for longshots and underpay for favourites (the favourite-longshot bias), so buying the favourite at the pregame close and holding it earns more than fees in markets where the bias is strong.',
    mechanism:'Misperception of small probabilities (Snowberg & Wolfers 2010). The bias should be strongest where casual money dominates and weakest where books are sharp: expected in college football, not in NFL or MLB pregame (both match sportsbook closes internally). False if the forward test\'s interval is not above zero.',
    edgeSource:'winner-identification',
    basis:{kind:'documented',support:['Snowberg & Wolfers 2010, JPE: favourite-longshot bias from misperceptions','Bürgi, Deng & Whelan 2025 (Kalshi): low-price contracts win far less than break-even','Internal: CFB pregame underdogs −33% [−50, −13], favourites +2.5% [−1.4, +6.6] (576 games, discovery)'],
      against:['Polymarket-wide study (arXiv 2609.12878): the bias is absent in sports categories','Internal: NFL and MLB pregame efficient (matches sportsbook close)']},
    requiredFeatures:['minutesToStart','role','price'],
    entry:{rule:'Buy the side priced as favourite at its ask on the first executable book between minLeadMinutes and maxLeadMinutes before the scheduled start.',params:{minLeadMinutes:5,maxLeadMinutes:8}},
    exits:{primary:[{kind:'settlement'}],alternatives:[]},
    style:'taker-hold',maxSpread:0.05,latency:{assumedMs:1000,note:'Pregame prices move slowly; one delayed book costs little.'},
    expectedHold:'settlement',sizing:'quarter-kelly-lower-bound',
    invalidation:['Forward test: after 300 settled picks the 95% interval of return per pick is not above zero','CFB favourite hold turns negative in the holdout season'],
    minSample:{trades:300,games:300},
    research:{status:'forward-paper',study:'research/studies/pregame.py; scripts/forward-test.ts',result:'CFB favourites +2.5% [−1.4, +6.6] discovery; NFL and MLB dropped.'},
    forward:{status:'paper',note:'forward-test.yml ledger on the forward-test-data branch'}},

  {id:'model-edge-hold',version:'1',title:'Model beats price by a fixed margin, held to the final',family:'model-disagreement',sports:['NFL','MLB','CFB'],phases:['live','pregame'],
    hypothesis:'When a research win-probability model exceeds the break-even win rate by 3 points, the side is underpriced.',
    mechanism:'Assumes the model knows something the price does not. Internally false for NFL and MLB: the market beat every model tested.',
    edgeSource:'winner-identification',
    basis:{kind:'speculative',support:[],against:['Internal: NFL model disagreements lost −7% to −15%; MLB −3.8% to +0.8%, all intervals spanning zero','Internal: market Brier beats nflfastR-style and MLB LightGBM models']},
    requiredFeatures:[],entry:{rule:'Model probability minus break-even at least threshold.',params:{threshold:0.03}},
    exits:{primary:[{kind:'settlement'}],alternatives:[]},style:'taker-hold',maxSpread:0.05,latency:{assumedMs:1000,note:'Hold to settlement.'},
    expectedHold:'settlement',sizing:'quarter-kelly-lower-bound',
    invalidation:['Replaced: ignores model uncertainty and calibration.'],minSample:{trades:150,games:100},
    research:{status:'superseded',study:'research/studies/fair_value_nfl.py, fair_value_mlb.py',result:'Dropped for NFL and MLB; replaced by model-edge-hold@2.'},
    forward:{status:'complete'}},

  {id:'model-edge-hold',version:'2',title:'Calibrated model edge after all costs and uncertainty, held to the final',family:'model-disagreement',sports:['NFL','MLB','CFB'],phases:['live','pregame'],
    hypothesis:'A model whose probabilities are calibrated (with a measured interval) identifies underpriced sides when its LOWER bound still clears the all-in break-even price.',
    mechanism:'Only a model with information the price lacks can do this. Requiring the lower bound of a calibrated interval to clear fees, depth slippage and a latency allowance removes trades that exist only because of model noise. False if forward trades with positive lower-bound edge do not beat the market.',
    edgeSource:'winner-identification',
    basis:{kind:'speculative',support:['Structure follows the edge definition in docs/STRATEGY-ARCHITECTURE.md'],against:['Internal: no tested model beats the market in NFL or MLB']},
    requiredFeatures:[],entry:{rule:'Loaded calibrated model: lower bound of P(side wins) minus (ask after depth slippage + taker fee + latency allowance) is above minLowerEdge.',params:{minLowerEdge:0,latencyCents:0.5}},
    exits:{primary:[{kind:'settlement'}],alternatives:[{id:'time-10m',rules:[{kind:'time',ms:600_000}]}]},style:'taker-hold',maxSpread:0.05,
    latency:{assumedMs:2500,note:'Model inputs are as fresh as the game report; the allowance covers a half-cent adverse move before the fill.'},
    expectedHold:'settlement',sizing:'quarter-kelly-lower-bound',
    invalidation:['Forward: mean return of trades with positive lower-bound edge is not above zero after minSample','Model calibration slope outside 0.9–1.1 on forward data'],
    minSample:{trades:150,games:60},research:{status:'specified',result:'Waiting for a calibrated model with intervals in an evidence pack.'},forward:{status:'shadow'},supersedes:'model-edge-hold@1'},

  {id:'maker-quote',version:'1',title:'Rest at the best bid on both sides, pulled after each event',family:'liquidity-provision',sports:['CFB','MLB','NFL'],phases:['pregame','live'],
    hypothesis:'Resting orders earn the spread and the maker rebate instead of paying fees, and where order flow is mostly uninformed that beats adverse selection.',
    mechanism:'Makers are paid for immediacy; they lose to informed flow (Glosten & Milgrom 1985). Informed flow is concentrated right after plays, so quotes are pulled then. Positive only where uninformed flow dominates: internally CFB and pregame windows. False if conservative-fill markout plus rebates is negative in paper.',
    edgeSource:'liquidity-provision',
    basis:{kind:'documented',support:['Bürgi, Deng & Whelan 2025 (Kalshi): makers earn far better returns than takers','Internal markout: CFB live +0.14¢, CFB pregame +0.48¢, MLB pregame +0.12¢ (optimistic fills)'],
      against:['Internal: NFL live −0.40¢ (toxic flow); conservative-fill markouts negative everywhere']},
    requiredFeatures:['bid','spread'],
    entry:{rule:'Rest a buy at each side\'s best bid when the evidence permits resting orders; pull for pullMs after each play or pitch report; inventory capped at inventoryMultiple × stake per side.',
      params:{pullMsFootball:30_000,pullMsBaseball:10_000,maxQuoteSpread:0.05,inventoryMultiple:2}},
    exits:{primary:[{kind:'markout',ms:60_000}],alternatives:[{id:'settlement',rules:[{kind:'settlement'}]}]},style:'maker',maxSpread:0.05,
    latency:{assumedMs:1000,note:'Quotes go live after the 1 s paper delay; conservative fills only.'},
    expectedHold:{minMs:1000,maxMs:3_600_000},sizing:'paper-fixed',
    invalidation:['Paper: conservative markout plus rebate below zero over minSample fills','Pilot: realized fills, rebates and rewards negative'],
    minSample:{trades:500,games:20},research:{status:'forward-paper',study:'research/studies/maker_markout.py',result:'Leads in CFB live/pregame and MLB pregame; dropped in NFL and MLB live.'},forward:{status:'paper'}},

  {id:'quiet-window-maker',version:'1',title:'Rest orders only during dead-ball windows, pulled before play resumes',family:'liquidity-provision',sports:['NFL','CFB'],phases:['live'],
    hypothesis:'A maker that quotes only while the ball is dead (after a score or kick, a timeout, a quarter break) and pulls before the next snap avoids most informed flow, so its markout beats always-on quoting in the same games.',
    mechanism:'Adverse selection is concentrated when information arrives: liquidity providers widen and thin quotes before scheduled information events (Lee, Mucklow & Ready 1993). In football the information arrives at snaps; internally 88% of a big play\'s move happens within 30 s of the snap. Dugout\'s game feed tells it WHEN information is coming, which a naive quote ignores. False if dead-ball fills mark out no better than always-on fills.',
    edgeSource:'liquidity-provision',
    basis:{kind:'plausible',support:['Lee, Mucklow & Ready 1993, RFS: spreads widen and depth falls ahead of information events','Glosten & Milgrom 1985: the spread compensates informed flow','Internal: NFL live maker flow toxic; 88% of big-play moves within 30 s of the snap'],
      against:['Dead-ball fills may be rare (few takers when nothing happens)','Feed latency may leave windows too short']},
    requiredFeatures:['game.phase','game.deadBallSeconds','bid','spread'],
    entry:{rule:'Rest a buy at each side\'s best bid only while the latest verified game report is a dead-ball report received at most maxWindowSeconds ago; never within pullOnMoveCents of a fresh price move; spread at most maxQuoteSpread.',
      params:{maxWindowSeconds:20,maxQuoteSpread:0.03,pullOnMoveCents:2,inventoryMultiple:2}},
    exits:{primary:[{kind:'markout',ms:60_000}],alternatives:[{id:'settlement',rules:[{kind:'settlement'}]}]},style:'maker',maxSpread:0.03,
    latency:{assumedMs:1000,note:FOOTBALL_LATENCY},expectedHold:{minMs:1000,maxMs:3_600_000},sizing:'paper-fixed',
    invalidation:['Dead-ball markout not better than maker-quote@1 markout in the same games (paired by game)','Fewer than 2 fills per game on average (not worth running)'],
    minSample:{trades:300,games:30},research:{status:'specified',study:'research/studies/maker_windows.py'},forward:{status:'shadow'}},

  {id:'comeback-drive',version:'1',title:'Trailing team in scoring position, sold when the drive ends',family:'temporary-mispricing',sports:['NFL','CFB'],phases:['live'],
    hypothesis:'While a trailing team drives inside the opponent\'s 30, its price rises by more than round-trip costs by the time the drive ends.',
    mechanism:'Reaching scoring position is public, so this needs the market to under-anticipate a drive\'s expected points (a martingale violation). No documented mechanism predicts that, and the favourite-longshot bias predicts the opposite (see drive-fade@1). Kept as the pre-registered candidate; the drive study settles it.',
    edgeSource:'temporary-mispricing',
    basis:{kind:'speculative',support:['Choi & Hui 2014: markets underreact to expected events (goals), which would favour continuation'],
      against:['Internal: NFL follow-through after big plays only 0.4–0.8¢; round-trip costs about 4¢','Internal: NFL in-game scalping −10% per trade, random entries the same','Favourite-longshot bias: trailing longshots tend to be overpriced']},
    requiredFeatures:['hasBall','trailingBy','yardsToEndZone','down','period'],
    entry:{rule:'The team with the ball trails by minDeficit–maxDeficit, is within maxYardsToEndZone of the end zone on downs 1–maxDown, with at least minSecondsRemaining left (whole quarters before the 4th). Buy that team at the ask. One entry per drive.',
      params:{minDeficit:3,maxDeficit:24,maxYardsToEndZone:30,maxDown:3,minSecondsRemaining:300}},
    exits:{primary:[{kind:'drive-end'},{kind:'stop',netReturn:0.35},{kind:'time',ms:720_000}],
      alternatives:[{id:'settlement',rules:[{kind:'settlement'}]},{id:'time-5m',rules:[{kind:'time',ms:300_000}]},{id:'target-10',rules:[{kind:'target',netReturn:0.1},{kind:'drive-end'}]}]},
    style:'taker-scalp',maxSpread:0.02,latency:{assumedMs:2500,note:FOOTBALL_LATENCY},expectedHold:{minMs:30_000,maxMs:720_000},sizing:'paper-fixed',
    invalidation:['drive_entry.py: discovery or holdout mean return not above zero','Not better than random entries in the same games'],
    minSample:{trades:30,games:20},research:{status:'specified',study:'research/studies/drive_entry.py',result:'Study written, not run.'},forward:{status:'shadow'}},

  {id:'comeback-drive-hold',version:'1',title:'Trailing team in scoring position, held to the final',family:'state-calibration',sports:['NFL','CFB'],phases:['live'],
    hypothesis:'Trailing teams in scoring position are underpriced relative to how often they go on to win.',
    mechanism:'State-dependent miscalibration in the trailing team\'s favour. The favourite-longshot bias predicts the opposite direction, so this is the weaker of the pair (see drive-fade@1).',
    edgeSource:'winner-identification',
    basis:{kind:'speculative',support:[],against:['Favourite-longshot bias (Snowberg & Wolfers 2010; Page & Clemen 2013)','Internal: NFL live sides under 10¢ lost 72% held to the final']},
    requiredFeatures:['hasBall','trailingBy','yardsToEndZone','down','period'],
    entry:{rule:'Same setup as comeback-drive@1; hold to the final.',params:{minDeficit:3,maxDeficit:24,maxYardsToEndZone:30,maxDown:3,minSecondsRemaining:300}},
    exits:{primary:[{kind:'settlement'}],alternatives:[{id:'drive-end',rules:[{kind:'drive-end'}]}]},
    style:'taker-hold',maxSpread:0.02,latency:{assumedMs:2500,note:FOOTBALL_LATENCY},expectedHold:'settlement',sizing:'paper-fixed',
    invalidation:['drive_entry.py hold variant: mean not above zero, or not above selling at the drive end'],
    minSample:{trades:30,games:20},research:{status:'specified',study:'research/studies/drive_entry.py'},forward:{status:'shadow'}},

  {id:'drive-fade',version:'1',title:'Longshot driving: buy the leader, hold to the final',family:'favourite-longshot',sports:['NFL','CFB'],phases:['live'],
    hypothesis:'When a trailing longshot (priced at most maxLongshotPrice) has the ball in scoring position, its price overstates its comeback chances, so the leader is underpriced to the final.',
    mechanism:'The favourite-longshot bias comes from overweighting small probabilities (Snowberg & Wolfers 2010) and should be strongest when a comeback is most salient: a trailing team driving. This is the opposite claim to comeback-drive, measured on the same setups. False if the leader\'s realized win rate does not exceed its all-in price.',
    edgeSource:'winner-identification',
    basis:{kind:'plausible',support:['Snowberg & Wolfers 2010; Page & Clemen 2013 (bias grows with time to expiry); Bürgi, Deng & Whelan 2025','Internal (in-sample, suggestive only): NFL live sides under 10¢ lost 72%; MLB live under 10¢ lost 48%'],
      against:['arXiv 2609.12878: no favourite-longshot bias in Polymarket sports markets','Internal: NFL live 90¢+ favourites broke even (−0.2%)']},
    requiredFeatures:['hasBall','trailingBy','yardsToEndZone','down','period','price','otherPrice'],
    entry:{rule:'The team with the ball trails, is within maxYardsToEndZone on downs 1–maxDown, and its ask is at most maxLongshotPrice; buy the OTHER team (the leader) at its ask if that ask is at most maxLeaderPrice. One entry per drive.',
      params:{maxLongshotPrice:0.3,maxLeaderPrice:0.95,maxYardsToEndZone:30,maxDown:3}},
    exits:{primary:[{kind:'settlement'}],alternatives:[{id:'drive-end',rules:[{kind:'drive-end'}]},{id:'time-12m',rules:[{kind:'time',ms:720_000}]}]},
    style:'taker-hold',maxSpread:0.02,latency:{assumedMs:2500,note:FOOTBALL_LATENCY},expectedHold:'settlement',sizing:'paper-fixed',
    invalidation:['drive_entry.py fade variant: discovery or holdout mean not above zero after fees','Leader realized win rate not above average entry cost'],
    minSample:{trades:60,games:40},research:{status:'specified',study:'research/studies/drive_entry.py'},forward:{status:'shadow'}},

  {id:'surprise-fade',version:'1',title:'After a surprising score, buy the team that was scored on',family:'event-reaction',sports:['NFL','CFB'],phases:['live'],
    hypothesis:'Markets overreact to surprising scores (the underdog scoring) and underreact to expected ones, so after an underdog scores, the other team is underpriced for the rest of the game.',
    mechanism:'Choi & Hui (2014) found exactly this asymmetry in in-play soccer betting: underreaction to expected goals, overreaction to surprising ones, profitable when bet 2 minutes after the goal. Salience of an unexpected event is the proposed cause. Entry waits out the market\'s own adjustment (most of a big move lands within 30 s), and it holds to the final because Polymarket charges a fee on each fill but none at settlement. False if the non-scoring side does not beat its all-in price after surprising scores.',
    edgeSource:'winner-identification',
    basis:{kind:'plausible',support:['Choi & Hui 2014, JEBO: overreaction to surprising goals, 2.79% return betting 2 minutes after','Ötting et al. (arXiv 2108.00821): live betting markets may overreact to recent news'],
      against:['Croxson & Reade 2014, EJ: prices update swiftly and fully after goals','Internal: after big NFL plays prices continue slightly (+0.4 to +0.8¢), no reversal on average']},
    requiredFeatures:['lastScore.secondsSince','lastScore.scorerPreEventPrice','lastScore.moveAgainst','spread'],
    entry:{rule:'A score was reported between minSecondsAfter and maxSecondsAfter ago; the scoring team\'s price just before the report was at most maxScorerPrice (a surprise); the scoring team\'s price has since risen by at least minMove; buy the team that was scored on at its ask. One entry per event.',
      params:{minSecondsAfter:45,maxSecondsAfter:180,maxScorerPrice:0.35,minMove:0.08}},
    exits:{primary:[{kind:'settlement'}],alternatives:[{id:'retrace-half',rules:[{kind:'retrace',fraction:0.5},{kind:'time',ms:900_000}]},{id:'time-5m',rules:[{kind:'time',ms:300_000}]},{id:'time-15m',rules:[{kind:'time',ms:900_000}]}]},
    style:'taker-hold',maxSpread:0.02,latency:{assumedMs:45_000,note:'Enters at least 45 s after the feed reports the score, after the market\'s own adjustment.'},
    expectedHold:'settlement',sizing:'paper-fixed',
    invalidation:['event_reaction.py: surprising-score fades not above zero in discovery and holdout','Expected-score fades do as well (no surprise asymmetry)'],
    minSample:{trades:80,games:60},research:{status:'specified',study:'research/studies/event_reaction.py'},forward:{status:'shadow'}},

  {id:'random-side-control',version:'1',title:'Control: a slug-fixed side held to the final',family:'control',sports:['NFL','CFB','MLB','ATP','WTA'],phases:['pregame','live'],
    hypothesis:'Control only: a side fixed by the market slug, to measure what costs alone do to returns.',
    mechanism:'No mechanism by design. Any strategy that cannot beat this control has no demonstrated edge.',
    edgeSource:'winner-identification',basis:{kind:'speculative',support:[],against:[]},
    requiredFeatures:[],entry:{rule:'Buy the slug-hashed side at the ask.',params:{}},
    exits:{primary:[{kind:'settlement'}],alternatives:[]},style:'taker-hold',maxSpread:0.05,latency:{assumedMs:0,note:'Research only.'},
    expectedHold:'settlement',sizing:'paper-fixed',invalidation:['Not applicable: a control.'],minSample:{trades:100,games:100},
    research:{status:'historical-test',study:'scripts/forward-test.ts'},forward:{status:'paper'}},
];

export const SPECS:readonly StrategySpec[]=Object.freeze(RAW.map(spec=>Object.freeze(specSchema.parse(spec))));
const BY_KEY=new Map(SPECS.map(spec=>[specKey(spec),spec]));

export function specOf(id:string,version:string):StrategySpec|undefined {return BY_KEY.get(`${id}@${version}`);}
export function requireSpec(id:string,version:string):StrategySpec {
  const spec=specOf(id,version);
  if(!spec)throw new Error(`No specification for ${id}@${version}. Add it to lib/decision/catalog.ts before it can run.`);
  return spec;
}
/** A spec's entry thresholds, typed by the caller. */
export function paramsOf<T extends Record<string,number|string|boolean>>(id:string,version:string):Readonly<T> {
  return requireSpec(id,version).entry.params as T;
}
