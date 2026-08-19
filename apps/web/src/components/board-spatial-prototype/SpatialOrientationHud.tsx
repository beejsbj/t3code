import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  RotateCcwIcon,
} from "lucide-react";

import { Button } from "../ui/button.tsx";
import {
  semanticAxisLabel,
  type AxisDirection,
  type SignedSemanticAxis,
  type SpatialOrientation,
} from "./spatialOrientation.ts";

export interface SpatialOrientationHudProps {
  readonly orientation: SpatialOrientation;
  readonly onRotateLeft: () => void;
  readonly onRotateRight: () => void;
  readonly onRotateUp: () => void;
  readonly onRotateDown: () => void;
  readonly onResetOrientation: () => void;
}

function horizontalArrow(direction: AxisDirection): string {
  return direction === 1 ? "\u2192" : "\u2190";
}

function verticalArrow(direction: AxisDirection): string {
  return direction === 1 ? "\u2191" : "\u2193";
}

function depthGlyph(direction: AxisDirection): string {
  return direction === 1 ? "far" : "near";
}

interface OrientationRowProps {
  readonly label: string;
  readonly axis: SignedSemanticAxis;
  readonly glyph: string;
}

function OrientationRow({ label, axis, glyph }: OrientationRowProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-1.5 py-1">
      <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-right text-[10px] font-medium text-foreground">
        {semanticAxisLabel(axis.axis)}
      </span>
      <span className="w-5 text-center text-[10px] text-muted-foreground">{glyph}</span>
    </div>
  );
}

export function SpatialOrientationHud({
  orientation,
  onRotateLeft,
  onRotateRight,
  onRotateUp,
  onRotateDown,
  onResetOrientation,
}: SpatialOrientationHudProps): React.JSX.Element {
  return (
    <div
      data-spatial-hud
      data-testid="spatial-orientation-hud"
      role="group"
      aria-label="Spatial orientation"
      className="spatial-orientation-hud pointer-events-auto w-52 rounded-xl border border-border bg-background/92 p-2.5 shadow-lg backdrop-blur"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Orientation
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Reset orientation"
          data-testid="spatial-orientation-reset"
          onClick={onResetOrientation}
        >
          <RotateCcwIcon className="size-3" />
        </Button>
      </div>

      <div className="mb-2 space-y-1">
        <OrientationRow
          label="Horizontal"
          axis={orientation.right}
          glyph={horizontalArrow(orientation.right.direction)}
        />
        <OrientationRow
          label="Vertical"
          axis={orientation.up}
          glyph={verticalArrow(orientation.up.direction)}
        />
        <OrientationRow
          label="Depth"
          axis={orientation.depth}
          glyph={depthGlyph(orientation.depth.direction)}
        />
      </div>

      <div className="grid grid-cols-3 place-items-center gap-1">
        <div />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Rotate up"
          data-testid="spatial-rotate-up"
          onClick={onRotateUp}
        >
          <ArrowUpIcon className="size-3" />
        </Button>
        <div />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Rotate left"
          data-testid="spatial-rotate-left"
          onClick={onRotateLeft}
        >
          <ArrowLeftIcon className="size-3" />
        </Button>
        <div />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Rotate right"
          data-testid="spatial-rotate-right"
          onClick={onRotateRight}
        >
          <ArrowRightIcon className="size-3" />
        </Button>
        <div />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Rotate down"
          data-testid="spatial-rotate-down"
          onClick={onRotateDown}
        >
          <ArrowDownIcon className="size-3" />
        </Button>
        <div />
      </div>

      <p className="mt-2 text-[9px] text-muted-foreground">Alt-drag empty space to rotate</p>
    </div>
  );
}
