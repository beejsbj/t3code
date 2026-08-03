import { LaneId, type LaneDefinition } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { makeBoardToolkit, renderSetBoardLaneDescription } from "./tools.ts";

const LANES: ReadonlyArray<LaneDefinition> = [
  {
    id: LaneId.make("shaping"),
    name: "Grilling / shaping",
    description: "Working out what this actually is",
    order: 0,
    interrupt: "badge",
  },
  {
    id: LaneId.make("ready"),
    name: "Ready",
    description: "Groomed and ready to pick up",
    order: 1,
    interrupt: "move",
  },
  {
    id: LaneId.make("done"),
    name: "Done",
    description: "Finished, or pinned settled",
    order: 2,
    interrupt: "move",
  },
];

it("carries every lane's authored name and description verbatim", () => {
  const description = renderSetBoardLaneDescription(LANES);
  for (const lane of LANES) {
    expect(description).toContain(`\`${lane.id}\``);
    expect(description).toContain(lane.name);
    expect(description).toContain(lane.description);
  }
});

it("renders the description from the registry, so a rename changes it", () => {
  const before = renderSetBoardLaneDescription(LANES);
  const renamed = LANES.map((lane) =>
    lane.id === "shaping" ? { ...lane, name: "Under the grill" } : lane,
  );
  const after = renderSetBoardLaneDescription(renamed);

  expect(after).not.toEqual(before);
  expect(after).toContain("Under the grill");
  expect(after).not.toContain("Grilling / shaping");
});

it("teaches the interrupt policy rather than just naming it", () => {
  const description = renderSetBoardLaneDescription(LANES);
  expect(description).toContain("stays in this lane and lights up in place");
  expect(description).toContain("leaves this lane for the Needs-you rail");
});

it("orders lanes by the registry order regardless of input order", () => {
  const description = renderSetBoardLaneDescription([...LANES].reverse());
  expect(description.indexOf("`shaping`")).toBeLessThan(description.indexOf("`ready`"));
  expect(description.indexOf("`ready`")).toBeLessThan(description.indexOf("`done`"));
});

it("says there is nowhere to file when the board has no lanes", () => {
  const description = renderSetBoardLaneDescription([]);
  expect(description).toContain("no lanes right now");
});

it("tells the agent to leave the session unplaced when nothing fits", () => {
  const description = renderSetBoardLaneDescription(LANES);
  expect(description).toContain("leave the session unplaced");
  expect(description).toContain("Only the user creates them");
});

it("exposes only laneId and reason — never a session or thread id", () => {
  const tool = Object.values(makeBoardToolkit(LANES).tools)[0];
  if (tool === undefined) throw new Error("Expected the board toolkit to expose a tool");

  const schema = Tool.getJsonSchema(tool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(tool.name).toBe("set_board_lane");
  expect(schema.type).toBe("object");
  // Structural, not advisory: an agent that could name a thread could refile
  // somebody else's session.
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["laneId", "reason"]);
  expect(schema.required).toEqual(["laneId"]);
  expect(Tool.getDescription(tool)).toBe(renderSetBoardLaneDescription(LANES));
});
