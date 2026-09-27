"""MLB live win-probability features from extracted Stats API data (research/data/mlb/extract/<season>).

One row per plate appearance, describing the situation BEFORE the PA, home-team perspective.
Everything is causal: team Elo and pitcher/batter form use only earlier games; in-game pitcher
workload uses only earlier pitches. The same definitions must be ported to TypeScript (Step 8).

Features
  state      inning, isTop, outs, bases, score diff, extra-innings ghost runner (regular season, 2020+)
  strength   pregame Elo difference (K=4, HFA 30, 67% season carryover: research/mlb-elo selection)
  starters   each starter's shrunk K%, BB%, HR% per batter faced over prior appearances
  fatigue    current pitcher's pitches before this PA, times through the order, starter still in
  batter     shrunk on-base and HR rates of the batter due up
"""
from __future__ import annotations

import numpy as np
import pandas as pd

ELO_K, ELO_HFA, ELO_CARRY = 4.0, 30.0, 0.67
SHRINK_BF = 150.0  # batters-faced prior weight for pitcher rates
SHRINK_PA = 200.0  # plate-appearance prior weight for batter rates
ON_BASE = {"single", "double", "triple", "home_run", "walk", "intent_walk", "hit_by_pitch"}

FEATURES = ["inning", "is_top", "outs", "on1", "on2", "on3", "score_diff", "abs_score_diff", "extra",
            "outs_remaining_home", "outs_remaining_away", "elo_diff",
            "home_sp_k", "home_sp_bb", "home_sp_hr", "away_sp_k", "away_sp_bb", "away_sp_hr",
            "pitcher_pitches", "pitcher_tto", "starter_in", "pitcher_k", "pitcher_bb", "pitcher_hr",
            "batter_obp", "batter_hr", "pitching_team_home"]


def pregame_elo(games: pd.DataFrame) -> pd.DataFrame:
    games = games.dropna(subset=["homeRuns", "awayRuns"]).sort_values("startMs")
    rating: dict[int, float] = {}
    season_seen: dict[int, int] = {}
    out = []
    for g in games.itertuples():
        for team in (g.homeId, g.awayId):
            if team not in rating:
                rating[team] = 1500.0
            elif season_seen.get(team) != g.season:
                rating[team] = 1500 + ELO_CARRY * (rating[team] - 1500)
            season_seen[team] = g.season
        diff = rating[g.homeId] - rating[g.awayId] + ELO_HFA
        out.append((g.gamePk, diff))
        expected = 1 / (1 + 10 ** (-diff / 400))
        won = 1.0 if g.homeRuns > g.awayRuns else 0.0
        rating[g.homeId] += ELO_K * (won - expected)
        rating[g.awayId] -= ELO_K * (won - expected)
    return pd.DataFrame(out, columns=["gamePk", "elo_diff"])


def _shrunk_prior_rates(pas: pd.DataFrame, key: str, prior_n: float, rates: dict[str, pd.Series]) -> pd.DataFrame:
    """Cumulative rates over each player's earlier games only (the current game is excluded)."""
    df = pas[["gamePk", "startMs", key]].copy()
    for name, flag in rates.items():
        df[name] = flag.astype(float).values
    per_game = df.groupby([key, "gamePk"], sort=False).agg(startMs=("startMs", "min"), n=("startMs", "size"),
                                                           **{n: (n, "sum") for n in rates}).reset_index()
    per_game = per_game.sort_values([key, "startMs"])
    league = {n: float(df[n].mean()) for n in rates}
    g = per_game.groupby(key)
    n_before = g.n.cumsum() - per_game.n
    out = per_game[[key, "gamePk"]].copy()
    for n in rates:
        before = g[n].cumsum() - per_game[n]
        out[n] = (before + league[n] * prior_n) / (n_before + prior_n)
    return out


def build(games: pd.DataFrame, pas: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    games = games.copy()
    pas = pas.sort_values(["gamePk", "atBatIndex"]).reset_index(drop=True)
    gi = games.set_index("gamePk")
    pas["season"] = pas.gamePk.map(gi.season)
    pas["gameType"] = pas.gamePk.map(gi.gameType)
    pas["home_win"] = pas.gamePk.map(gi.homeWin) if "homeWin" in gi else np.nan
    et = pas.eventType.fillna("")
    pitcher_rates = _shrunk_prior_rates(pas, "pitcherId", SHRINK_BF, {
        "k": et.isin(["strikeout", "strikeout_double_play"]), "bb": et.isin(["walk", "intent_walk", "hit_by_pitch"]),
        "hr": et.eq("home_run")})
    batter_rates = _shrunk_prior_rates(pas, "batterId", SHRINK_PA, {"obp": et.isin(ON_BASE), "hr": et.eq("home_run")})

    df = pd.DataFrame({"gamePk": pas.gamePk, "atBatIndex": pas.atBatIndex, "startMs": pas.startMs, "season": pas.season,
                       "home_win": pas.home_win, "inning": pas.inning, "is_top": pas.isTop.astype(int),
                       "outs": pas.outsPre, "on1": pas.on1Pre, "on2": pas.on2Pre, "on3": pas.on3Pre,
                       "pitcherId": pas.pitcherId, "batterId": pas.batterId})
    first_of_half = pas.groupby(["gamePk", "inning", "isTop"]).cumcount() == 0
    ghost = first_of_half & (pas.inning >= 10) & (pas.gameType == "R") & (pas.season >= 2020)
    df.loc[ghost, "on2"] = 1
    df["score_diff"] = pas.homeScorePre - pas.awayScorePre
    df["abs_score_diff"] = df.score_diff.abs()
    df["extra"] = (df.inning >= 10).astype(int)
    # Outs left for each side to bat in regulation (9 innings), a compact clock.
    inn = df.inning.clip(upper=9)
    df["outs_remaining_away"] = np.where(df.is_top == 1, (9 - inn) * 3 + (3 - df.outs), (9 - inn) * 3).clip(min=0)
    df["outs_remaining_home"] = np.where(df.is_top == 1, (10 - inn) * 3, (9 - inn) * 3 + (3 - df.outs)).clip(min=0)
    df = df.merge(pregame_elo(games), on="gamePk", how="left")

    # Starters: first pitcher each defence used. Home pitches in the top half.
    starters = pas.groupby(["gamePk", "isTop"]).pitcherId.first().unstack()
    home_sp = starters.get(True).rename("home_sp") if True in starters else pd.Series(dtype=float, name="home_sp")
    away_sp = starters.get(False).rename("away_sp") if False in starters else pd.Series(dtype=float, name="away_sp")
    df = df.join(home_sp, on="gamePk").join(away_sp, on="gamePk")
    pr = pitcher_rates.rename(columns={"pitcherId": "pid"})
    for side in ("home", "away"):
        df = df.merge(pr.rename(columns={"pid": f"{side}_sp", "k": f"{side}_sp_k", "bb": f"{side}_sp_bb", "hr": f"{side}_sp_hr"}),
                      on=[f"{side}_sp", "gamePk"], how="left")
    df = df.merge(pr.rename(columns={"pid": "pitcherId", "k": "pitcher_k", "bb": "pitcher_bb", "hr": "pitcher_hr"}),
                  on=["pitcherId", "gamePk"], how="left")
    df = df.merge(batter_rates.rename(columns={"obp": "batter_obp", "hr": "batter_hr"}), on=["batterId", "gamePk"], how="left")

    # In-game workload before this PA.
    pitches = events[events.isPitch].groupby(["gamePk", "atBatIndex"]).size().rename("n_pitches").reset_index()
    df = df.merge(pitches, on=["gamePk", "atBatIndex"], how="left").fillna({"n_pitches": 0})
    df = df.sort_values(["gamePk", "atBatIndex"])
    by_pitcher = df.groupby(["gamePk", "pitcherId"])
    df["pitcher_pitches"] = by_pitcher.n_pitches.cumsum() - df.n_pitches
    df["pitcher_tto"] = by_pitcher.cumcount() // 9 + 1
    df["pitching_team_home"] = df.is_top
    df["starter_in"] = np.where(df.is_top == 1, df.pitcherId == df.home_sp, df.pitcherId == df.away_sp).astype(int)
    return df.drop(columns=["n_pitches"]).reset_index(drop=True)
