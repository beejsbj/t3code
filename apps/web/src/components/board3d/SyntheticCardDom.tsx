import type * as React from "react";

import type { Board3DCard, Board3DCardState } from "./layout.ts";

/**
 * One board card rendered exactly as it should appear in 3D. This is the DOM
 * that the capture layer snapshots into a texture; the visual style is
 * intentionally self-contained (inline styles, no UI imports) so it renders
 * reliably in the offscreen container regardless of surrounding app chrome.
 */

const CARD_WIDTH_PX = 380;

const STATE_TINTS: Record<Board3DCardState, string> = {
  working: "#4c8dff",
  input: "#ffb224",
  approval: "#a06bff",
  failed: "#ff5c5c",
  idle: "#3a3b42",
  draft: "#2dd4bf",
  snoozed: "#64748b",
  settled: "#2a2b30",
};

const STATE_LABELS: Record<Board3DCardState, string> = {
  working: "Working",
  input: "Input",
  approval: "Approval",
  failed: "Failed",
  idle: "Idle",
  draft: "Draft",
  snoozed: "Snoozed",
  settled: "Settled",
};

/** Turn an id like "in-progress" into a readable label like "In Progress". */
function labelFromId(id: string): string {
  return id
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ");
}

export function SyntheticCardDom({ card }: { card: Board3DCard }): React.JSX.Element {
  const tint = STATE_TINTS[card.state];

  return (
    <div
      data-board3d-card-id={card.id}
      inert
      style={{
        width: CARD_WIDTH_PX,
        borderRadius: 12,
        background: "#1a1b1e",
        border: `1px solid ${tint}`,
        padding: 12,
        boxSizing: "border-box",
        color: "#e8eaed",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        display: "flex",
        flexDirection: "column",
        gap: 8,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            lineHeight: 1,
            letterSpacing: 1,
            textTransform: "uppercase",
            fontWeight: 600,
            color: tint,
            padding: "3px 6px",
            borderRadius: 4,
            background: `${tint}22`,
          }}
        >
          {STATE_LABELS[card.state]}
        </span>
        {card.needsAttention ? (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: tint,
              marginLeft: "auto",
            }}
          />
        ) : null}
      </div>

      <div
        style={{
          fontSize: 14,
          lineHeight: 1.35,
          fontWeight: 500,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          color: "#e8eaed",
        }}
      >
        {card.title}
      </div>

      <div
        style={{
          fontSize: 12,
          lineHeight: 1.2,
          color: "#9aa0a6",
          marginTop: "auto",
        }}
      >
        {labelFromId(card.projectId)} · {labelFromId(card.laneId)}
      </div>
    </div>
  );
}
