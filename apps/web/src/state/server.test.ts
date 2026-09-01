import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "../keybindings";
import { resolvePrimaryServerKeybindings } from "./server";

describe("primary server keybindings", () => {
  it("keeps the default Board shortcut for older servers without permitting writes", () => {
    const legacyKeybindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (keybinding) => keybinding.command !== "board.open",
    );
    const effectiveKeybindings = resolvePrimaryServerKeybindings(legacyKeybindings, false);

    expect(
      resolveShortcutCommand(
        {
          key: "b",
          metaKey: false,
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
        },
        effectiveKeybindings,
        { platform: "Linux", context: { terminalFocus: false } },
      ),
    ).toBe("board.open");
  });

  it("preserves a removed Board shortcut when the server advertises support", () => {
    const keybindingsWithoutBoard = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (keybinding) => keybinding.command !== "board.open",
    );

    expect(resolvePrimaryServerKeybindings(keybindingsWithoutBoard, true)).toBe(
      keybindingsWithoutBoard,
    );
  });
});
