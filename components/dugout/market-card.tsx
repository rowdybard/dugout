"use client";

import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  Bookmark,
  ChevronRight,
  HelpCircle,
} from "lucide-react";
import type { Market } from "@/lib/market/types";
import { Sparkline } from "./chart";

export const cents = (p: number | null) =>
  p === null ? "—" : `${(p * 100).toFixed(1).replace(/\.0$/, "")}¢`;
export const number = (p: number) => p.toFixed(1).replace(/\.0$/, "");
export function gameTime(start: string) {
  if (!start) return "Time not supplied";
  return new Date(start).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Props = {
  m: Market;
  watched: boolean;
  onWatch: () => void;
  onOpen: () => void;
  onExplain: () => void;
  beginner: boolean;
  watchPrice?: number | null;
};

export function MarketCard({
  m,
  watched,
  onWatch,
  onOpen,
  onExplain,
  beginner,
  watchPrice,
}: Props) {
  const first = m.history[0],
    last = m.history.at(-1);
  const change = first && last ? (last.price - first.price) * 100 : null;
  const down = change !== null && change < -0.05;
  const signal = m.signals[0];
  const spread =
    m.ask !== null && m.bid !== null ? (m.ask - m.bid) * 100 : null;
  const Icon =
    change === null || Math.abs(change) < 0.05
      ? ArrowRight
      : down
        ? ArrowDownRight
        : ArrowUpRight;
  const question = m.kind.endsWith("full_game_winner")
    ? `Will ${m.title.replace(/ win$/, "")} win?`
    : m.question || m.title;

  return (
    <article className={`market-card ${down ? "falling" : ""}`}>
      <div className="card-meta">
        <span className="league-tag">{m.league}</span>
        <span>{gameTime(m.start)}</span>
        <button
          className={`icon-button ${watched ? "saved" : ""}`}
          onClick={onWatch}
          aria-label={
            watched
              ? "Remove this market from watchlist"
              : "Save this market to watchlist"
          }
        >
          <Bookmark size={18} fill={watched ? "currentColor" : "none"} />
        </button>
      </div>
      <button className="matchup-button" onClick={onOpen}>
        <h3>
          {m.teams.length === 2 ? (
            <>
              {m.teams[0].name}
              <span className="versus"> vs </span>
              {m.teams[1].name}
            </>
          ) : (
            m.game
          )}
        </h3>
      </button>
      <div className="outcome-label">
        <span className="question-label">THE MARKET’S QUESTION</span>
        {question}
      </div>
      <div className="price-chart">
        <div>
          <div className="big-price">{cents(m.price)}</div>
          <div className="implied">
            {m.price !== null
              ? `≈ ${number(m.price * 100)}% ${beginner ? "market estimate" : "implied probability"}`
              : "No current offer"}
          </div>
        </div>
        <Sparkline points={m.history} down={down} />
      </div>
      <div
        className={`movement ${down ? "down" : change === null || Math.abs(change) < 0.05 ? "neutral" : "up"}`}
      >
        <Icon size={20} />
        <strong>
          {change === null
            ? "Not enough history yet"
            : `${change >= 0 ? "+" : ""}${number(change)} points`}
        </strong>
        <span>
          {first && last
            ? `in ${Math.max(1, Math.round((last.time - first.time) / 60000))} min`
            : "Collecting"}
        </span>
      </div>
      {watchPrice != null && m.price !== null && (
        <div className="watch-change">
          {number((m.price - watchPrice) * 100)} points since watched
        </div>
      )}
      <div className="card-micro">
        <span>
          Spread <b>{spread === null ? "—" : `${number(spread)}¢`}</b>
          <span className={spread !== null && spread >= 5 ? "amber" : ""}>
            {spread === null
              ? "unavailable"
              : spread >= 5
                ? "wide"
                : spread <= 2
                  ? "tight"
                  : ""}
          </span>
        </span>
        <span>
          Activity{" "}
          <b>
            {m.signals.some((s) => s.type === "UNUSUAL ACTIVITY")
              ? "BURST"
              : "collecting"}
          </b>
        </span>
      </div>
      <div className={`reason-strip ${signal ? "" : "quiet"}`}>
        <span className={`signal-dot ${down ? "red" : ""}`} />
        <span>{signal?.type || "NO UNUSUAL CHANGE"}</span>
        <button
          onClick={onExplain}
          aria-label="Explain why this market was flagged"
        >
          <HelpCircle size={16} />
        </button>
      </div>
      <p className="card-reason">
        {signal?.reason ||
          "No scanner threshold crossed. You can still explore the game and its prices."}
      </p>
      <div className="card-actions">
        <button onClick={onExplain}>
          Why this game? <HelpCircle size={14} />
        </button>
        <button className="understand-action" onClick={onOpen}>
          Understand this game <ChevronRight size={16} />
        </button>
      </div>
    </article>
  );
}
