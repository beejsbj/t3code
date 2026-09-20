import { act } from "react";
import type { ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useBoardCardStore } from "../../board/boardCardStore.ts";
import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
import { BoardCardTile } from "./SessionBoard.tsx";

vi.mock("./BoardSessionCard.tsx", () => ({ BoardSessionCard: () => null }));
vi.mock("./BoardDraftCard.tsx", () => ({ BoardDraftCard: () => null }));
vi.mock("./BoardCardExpandedSheet.tsx", () => ({ BoardCardExpandedSheet: () => null }));

const ref = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };
const entry = {
  kind: "thread",
  ref,
  environmentId: ref.environmentId,
  key: scopedThreadKey(ref),
  laneId: "lane-1",
  workflowLaneId: "lane-1",
  boardStateId: "working",
  environmentLabel: "Test",
  projectKey: "project-1",
  projectTitle: "Project",
  laneColumnKey: "lane-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  thread: {
    id: ref.threadId,
    environmentId: ref.environmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  },
  environmentConnection: { phase: "connected", error: null, traceId: null },
} satisfies ComponentProps<typeof BoardCardTile>["entry"];

class TestHTMLElement {
  offsetTop = 0;
  parentElement: TestHTMLElement | null = null;
  children: TestHTMLElement[] = [];
  clientWidth = 1000;
  renderedWidth = 496;
  matches() {
    return true;
  }
  getBoundingClientRect() {
    return { width: this.renderedWidth };
  }
}

function pointer(type: string, values: Partial<PointerEvent> = {}): PointerEvent {
  return new PointerEvent(type, { pointerId: 1, clientX: 100, clientY: 100, ...values });
}

describe("BoardCardTile resize interaction", () => {
  let listeners: Record<string, EventListener>;
  let frame: (() => void) | null;
  let renderer: ReactTestRenderer;
  let outer: TestHTMLElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    listeners = {};
    frame = null;
    vi.stubGlobal("HTMLElement", TestHTMLElement);
    const testWindow = {
      addEventListener: (type: string, listener: EventListener) => {
        listeners[type] = listener;
      },
      removeEventListener: (type: string) => {
        delete listeners[type];
      },
      requestAnimationFrame: (callback: () => void) => {
        frame = callback;
        return 1;
      },
      cancelAnimationFrame: () => {
        frame = null;
      },
      getComputedStyle: () => ({ paddingLeft: "0px", paddingRight: "0px" }),
    };
    vi.stubGlobal("window", testWindow);
    vi.stubGlobal(
      "PointerEvent",
      class extends Event {
        pointerId = 1;
        clientX = 100;
        clientY = 100;
        button = 0;
        constructor(type: string, init: Partial<PointerEvent> = {}) {
          super(type);
          Object.assign(this, init);
        }
      },
    );
    vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0px", paddingRight: "0px" }));
    outer = new TestHTMLElement();
    const sibling = new TestHTMLElement();
    const flex = new TestHTMLElement();
    flex.children = [outer, sibling];
    outer.parentElement = flex;
    useBoardCardStore.setState({ byThreadKey: { [scopedThreadKey(ref)]: { widthPx: 340 } } });
    useBoardFocusStore.setState({
      focusedThreadKey: "other",
      request: null,
      acknowledgedFocus: null,
      expandedTarget: null,
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render() {
    const handleNode = {
      parentElement: { parentElement: outer },
      focus: vi.fn(),
      setPointerCapture: vi.fn(),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    act(() => {
      renderer = create(
        <BoardCardTile
          entry={entry}
          draggable
          lanes={[]}
          draggingKey={null}
          onExpandDraft={vi.fn()}
          onDiscardDraft={vi.fn()}
        />,
        {
          createNodeMock: (element) => (element.type === "button" ? handleNode : {}),
        },
      );
    });
    const [handle, corner] = renderer.root.findAllByType("button");
    if (!handle || !corner) throw new Error("Expected edge and corner resize handles");
    return { handle, corner, handleNode };
  }

  function dispatch(type: string, event: PointerEvent) {
    const listener = listeners[type];
    if (!listener) throw new Error(`Missing ${type} listener`);
    listener(event);
  }

  it("focuses the resized card even when another card was focused", () => {
    const { corner, handleNode } = render();
    act(() =>
      corner.props.onPointerDown({
        ...pointer("pointerdown"),
        currentTarget: handleNode,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }),
    );
    expect(useBoardFocusStore.getState().focusedThreadKey).toBe(entry.key);
  });

  it("persists the compensated preferred width only after release", () => {
    const { handle, handleNode } = render();
    act(() =>
      handle.props.onPointerDown({
        ...pointer("pointerdown"),
        currentTarget: handleNode,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }),
    );
    act(() => dispatch("pointermove", pointer("pointermove", { clientX: 150 })));
    act(() => frame?.());
    expect(useBoardCardStore.getState().byThreadKey[scopedThreadKey(ref)]?.widthPx).toBe(340);
    act(() => dispatch("pointerup", pointer("pointerup", { clientX: 150 })));
    expect(useBoardCardStore.getState().byThreadKey[scopedThreadKey(ref)]?.widthPx).toBe(440);
  });

  it("rolls back on pointercancel without persisting", () => {
    const { handle, handleNode } = render();
    act(() =>
      handle.props.onPointerDown({
        ...pointer("pointerdown"),
        currentTarget: handleNode,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }),
    );
    act(() => dispatch("pointermove", pointer("pointermove", { clientX: 150 })));
    act(() => frame?.());
    act(() => dispatch("pointercancel", pointer("pointercancel", { clientX: 150 })));
    expect(useBoardCardStore.getState().byThreadKey[scopedThreadKey(ref)]?.widthPx).toBe(340);
    expect(listeners.pointermove).toBeUndefined();
    expect(listeners.pointerup).toBeUndefined();
  });

  it.each([0, 5])("keeps a clipped preferred width with %ipx of sideways jitter", (deltaX) => {
    useBoardCardStore.setState({ byThreadKey: { [scopedThreadKey(ref)]: { widthPx: 600 } } });
    outer.renderedWidth = 364;
    outer.parentElement!.clientWidth = 364;
    const { corner, handleNode } = render();
    act(() =>
      corner.props.onPointerDown({
        ...pointer("pointerdown"),
        currentTarget: handleNode,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }),
    );
    act(() =>
      dispatch("pointermove", pointer("pointermove", { clientX: 100 + deltaX, clientY: 180 })),
    );
    act(() => dispatch("pointerup", pointer("pointerup", { clientX: 100 + deltaX, clientY: 180 })));
    expect(useBoardCardStore.getState().byThreadKey[scopedThreadKey(ref)]).toEqual({
      widthPx: 600,
      heightPx: 600,
    });
  });
});
