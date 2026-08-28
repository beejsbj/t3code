import type { KeybindingCommand } from "@t3tools/contracts";

export type BoardNavigationCommand = Extract<
  KeybindingCommand,
  | "board.focusLeft"
  | "board.focusRight"
  | "board.focusUp"
  | "board.focusDown"
  | "board.toggleExpanded"
>;

const BOARD_NAVIGATION_EVENT = "t3code:board-navigation";

export function dispatchBoardNavigation(command: BoardNavigationCommand): void {
  window.dispatchEvent(
    new CustomEvent<BoardNavigationCommand>(BOARD_NAVIGATION_EVENT, { detail: command }),
  );
}

export function onBoardNavigation(listener: (command: BoardNavigationCommand) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<BoardNavigationCommand>).detail);
  };
  window.addEventListener(BOARD_NAVIGATION_EVENT, handler);
  return () => window.removeEventListener(BOARD_NAVIGATION_EVENT, handler);
}
