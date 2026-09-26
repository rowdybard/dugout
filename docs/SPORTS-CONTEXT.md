> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# Free game and player context

Dugout can attach MLB and NFL source observations to a Polymarket US market. This is a separate data boundary from quotes, strategy evaluation, paper accounting, and order execution. A player change does not place an order or imply a price adjustment.

## Sources verified on September 23, 2026

Unauthenticated HTTP responses were inspected directly before implementing these adapters. Public access is not a guarantee of a delivery interval or future API stability.

| Purpose | Exact source | Observed fields used |
| --- | --- | --- |
| MLB schedule and matchup | `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-09-23&hydrate=probablePitcher,team` | `dates[].games[]`, `gamePk`, `gameDate`, `status`, `teams.home/away.team`, `score` |
| MLB actual game and substitutions | `https://statsapi.mlb.com/api/v1.1/game/824223/feed/live` and completed game `823543` | `gameData.teams`, `gameData.players`, `probablePitchers`; `liveData.linescore`, `plays.allPlays`, `boxscore.teams` |
| NFL schedule | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260920` | `events[].id/date/competitions`, `competitors[].homeAway/team/score`, `status` |
| NFL names and passing statistics | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401873308` | `header`, `boxscore.players[].team/statistics`; passing `athletes[].athlete/stats` and column `labels/descriptions` |
| NFL typed passing play history | `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/401873308/competitions/401873308/plays?limit=500` | `count/pageCount/items`, `sequenceNumber`, `teamParticipants`, `participants[].type/athlete/position`, `wallclock` |
| QB position identity | `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/positions/8` | `id: "8"`, `name: "Quarterback"`, `abbreviation: "QB"` |
| Explicit availability reports | `https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries` and `/baseball/mlb/injuries` | Team `displayName`, injury `status/date`, athlete `displayName/position`, `details.type` |

MLB sources are MLB-owned first-party feeds. ESPN sources are publicly reachable, undocumented ESPN services, not an officially supported NFL API. No paid subscription or API key is used by these read-only adapters.

## Matching and evidence

`GET /api/sports-context?slug=...` resolves the selected slug inside the current Polymarket feed. Team IDs belong to different providers and are never joined directly. The adapter matches an unordered pair of exact normalized team names or abbreviations and requires the scheduled starts to be within 90 minutes. Multiple nearby candidates require a uniquely close start; ambiguous doubleheaders return `unmatched`. UTC and US Eastern date schedules are checked for late-night games. Context is revalidated against the matched provider game and teams.

MLB alerts require `details.eventType === "pitching_substitution"`. The previous pitcher is tracked separately for each fielding team; rotating from the top to bottom of an inning cannot generate a change. Replacement identity comes from the source player ID, resolved against `gameData.players`; description text is not parsed to invent identity. Innings remain baseball strings such as `6.2`, never decimal workload calculations. Current game workload and season ERA are descriptive facts, not a prediction.

NFL alerts require a `type: "passer"` participant tagged with the independently verified QB position. Each offense is tracked separately in play sequence order. Names and stats must match that same team's passing box score. Wide receiver trick plays, possession changes, unknown athletes, missing typed play data, and incomplete pagination cannot become QB alerts. The actual source is an observed passing play: it does not establish injury, benching, or permanent replacement. A substitution before a subsequent pass may not be observed. The full example contained 167 plays and 67 typed passer observations; five same-team QB changes were recovered from that real preseason game.

ESPN's passing `keys` contained eight entries while the observed `labels` and `stats` contained seven. The parser uses aligned labels and values, refusing mismatched columns instead of shifting passer rating into QBR.

Injury feeds contain ordinary player news marked `Active`, which is excluded. Only explicit Questionable, Doubtful, Out, Injured Reserve, Day-To-Day, and IL statuses are retained. Report time is distinct from injury occurrence time. An empty list never means players are healthy; injury reports are not treated as the cause of a pitching or QB change.

## API and persistence

The public application contract is `SportsContext` in `lib/sports-context/types.ts`:

- `status`: available, unmatched, or unavailable.
- Source name, source URL, support status, and actual retrieval timestamp.
- Matched game, score/period, observed/probable players, and named statistics.
- Changes with stable source-derived identity, previous/replacement players, source event time, first-seen time, and factual context.
- Optional explicit availability reports with their own source links and retrieval time.
- Limitations with no fabricated win-probability change or model score.

Snapshots are stored in the existing D1 cache table; no migration is required. Context is keyed by provider game so multiple market slugs share one fetch. Schedule TTL is 60 seconds; game context TTL is 30 seconds in play, 60 seconds pregame, and five minutes after completion. Injury feeds are shared per league for two minutes and compacted before persistence; repeated logos and long news bodies are not stored. Source response objects are transient; normalized context and stable first-seen evidence are saved. Existing cache retention is seven days.

The endpoint is read-only and independent of user cash/order state. Failures return unavailable or unmatched context, never fabricated players or inferred health. NFL summary availability can survive typed-play failure with an explicit limitation. The UI polls only a selected visible game. There is no all-game background injury collector and no guaranteed provider-to-UI latency.

Development previews may use explicitly marked recorded provider responses because local Worker outbound networking is restricted. Those captures are separate from live production ingestion and carry `replayAt`; production removes the development branch. They do not make captured game context current or enable orders.

## Verification

`node --experimental-strip-types --experimental-specifier-resolution=node --test tests/sports-context.test.ts`

Tests cover reordered team lists, date mismatch, ambiguous doubleheaders, source identity validation, actual substitution requirements, same-team QB changes, exclusion of WR trick plays, malformed references, incomplete history, aligned passing stats, and explicit injury-only filtering. Parser integration was also run against downloaded actual current MLB, completed MLB, and NFL preseason responses; engineering scenarios are not trading-performance evidence.
