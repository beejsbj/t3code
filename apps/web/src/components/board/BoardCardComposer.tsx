import type {
  ProviderInteractionMode,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { PaperclipIcon, SendIcon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  detectComposerTrigger,
  type ComposerSlashCommand,
  type ComposerTrigger,
} from "../../composer-logic.ts";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  type ComposerImageAttachment,
} from "../../composerDraftStore.ts";
import { newMessageId, randomUUID } from "../../lib/utils.ts";
import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { cn } from "~/lib/utils";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor.tsx";
import { buildThreadTurnInterruptInput, readFileAsDataUrl } from "../ChatView.logic.ts";
import { ComposerCommandMenu, type ComposerCommandItem } from "../chat/ComposerCommandMenu.tsx";
import { searchSlashCommandItems } from "../chat/composerSlashCommandSearch.ts";
import { BoardCardModelPicker } from "./BoardCardModelPicker.tsx";

const BUILT_IN_SLASH_COMMANDS: ReadonlyArray<{
  readonly command: Exclude<ComposerSlashCommand, "model">;
  readonly description: string;
}> = [
  { command: "plan", description: "Switch this session to plan mode" },
  { command: "default", description: "Switch this session back to build mode" },
];

export interface BoardCardComposerProps {
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly resolvedTheme: "light" | "dark";
  readonly isWorking: boolean;
  readonly isFocused: boolean;
}

/**
 * The card's live composer.
 *
 * This is a genuinely separate, small surface rather than an embedded
 * `ChatComposer`: `ChatComposer` takes ~50 props derived inside `ChatView` and
 * assumes it is the page's single composer. What it *does* reuse is every part
 * that is safe to share — the real Lexical `ComposerPromptEditor` (so `@` file
 * mentions and `$` skills behave identically), the real slash-command search
 * and menu, the real per-thread draft store (so text typed on a card is the
 * same draft the full chat view sees), and the real `thread.turn.start`
 * command. Sending from a card starts a real turn on a real session.
 */
export function BoardCardComposer(props: BoardCardComposerProps) {
  const { threadRef, thread, providerStatuses, skills, resolvedTheme, isWorking } = props;

  const draft = useComposerThreadDraft(threadRef);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addImages = useComposerDraftStore((store) => store.addImages);
  const removeImage = useComposerDraftStore((store) => store.removeImage);
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);

  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });

  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [cursor, setCursor] = useState(0);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const providerSlashCommands = useMemo(() => {
    const instanceId = thread.modelSelection.instanceId;
    return providerStatuses.find((provider) => provider.instanceId === instanceId)?.slashCommands;
  }, [providerStatuses, thread.modelSelection.instanceId]);

  const menuItems = useMemo<ComposerCommandItem[]>(() => {
    if (trigger?.kind !== "slash-command") return [];
    const builtIn = BUILT_IN_SLASH_COMMANDS.map<ComposerCommandItem>((entry) => ({
      id: `slash:${entry.command}`,
      type: "slash-command",
      command: entry.command,
      label: `/${entry.command}`,
      description: entry.description,
    }));
    const provider = (providerSlashCommands ?? []).map<ComposerCommandItem>((command) => ({
      id: `provider-slash:${command.name}`,
      type: "provider-slash-command",
      provider: thread.modelSelection.instanceId as never,
      command,
      label: `/${command.name}`,
      description: command.description ?? "",
    }));
    const all = [...builtIn, ...provider] as Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;
    const query = trigger.query.trim();
    return query.length === 0 ? all : searchSlashCommandItems(all, query);
  }, [providerSlashCommands, thread.modelSelection.instanceId, trigger]);

  const menuOpen = trigger?.kind === "slash-command" && menuItems.length > 0;
  const activeItem = menuItems.find((item) => item.id === activeItemId) ?? menuItems[0];

  const handleChange = useCallback(
    (
      nextValue: string,
      _nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      setPrompt(threadRef, nextValue);
      setCursor(expandedCursor);
      setTrigger(cursorAdjacentToMention ? null : detectComposerTrigger(nextValue, expandedCursor));
    },
    [setPrompt, threadRef],
  );

  const applySlashSelection = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;
      if (item.type === "slash-command") {
        // Built-ins are actions, not text: they switch the session's
        // interaction mode, exactly like the full composer does.
        const nextMode: ProviderInteractionMode = item.command === "plan" ? "plan" : "default";
        void setInteractionMode({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, interactionMode: nextMode },
        });
        const next = `${draft.prompt.slice(0, trigger.rangeStart)}${draft.prompt.slice(trigger.rangeEnd)}`;
        setPrompt(threadRef, next);
        setTrigger(null);
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const next = `${draft.prompt.slice(0, trigger.rangeStart)}${replacement}${draft.prompt.slice(trigger.rangeEnd)}`;
        setPrompt(threadRef, next);
        setCursor(trigger.rangeStart + replacement.length);
        setTrigger(null);
      }
    },
    [draft.prompt, setInteractionMode, setPrompt, threadRef, trigger],
  );

  const send = useCallback(async () => {
    const text = draft.prompt.trim();
    if (text.length === 0 && draft.images.length === 0) return;
    // `sending` is React state, so it has not committed yet when a second
    // Enter arrives in the same tick — the ref is what actually prevents a
    // duplicate turn. And a session that is already working must not be given
    // another turn at all: the card offers Interrupt instead.
    if (isWorking || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        draft.images.map(async (image: ComposerImageAttachment) => ({
          type: "image" as const,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
        })),
      );
      const result = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments,
          },
          modelSelection: thread.modelSelection,
          titleSeed: thread.title,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        setError("Couldn’t send. The session may be busy or disconnected.");
        return;
      }
      // Only clear if the draft is still the one we sent. Reading attachments
      // and awaiting the command takes real time, and silently deleting text
      // typed in that window is worse than leaving a stale line behind.
      const current = useComposerDraftStore.getState().getComposerDraft(threadRef);
      if (current === null || current.prompt === draft.prompt) {
        clearComposerContent(threadRef);
        setCursor(0);
      }
      setTrigger(null);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [
    clearComposerContent,
    draft.images,
    draft.prompt,
    isWorking,
    startThreadTurn,
    thread,
    threadRef,
  ]);

  const handleCommandKey = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab", event: KeyboardEvent): boolean => {
      if (menuOpen) {
        if (key === "ArrowDown" || key === "ArrowUp") {
          const index = menuItems.findIndex((item) => item.id === activeItem?.id);
          const next =
            key === "ArrowDown"
              ? (index + 1) % menuItems.length
              : (index - 1 + menuItems.length) % menuItems.length;
          setActiveItemId(menuItems[next]?.id ?? null);
          return true;
        }
        if ((key === "Enter" || key === "Tab") && activeItem) {
          applySlashSelection(activeItem);
          return true;
        }
      }
      if (key === "Enter" && !event.shiftKey) {
        if (isWorking) return true;
        void send();
        return true;
      }
      return false;
    },
    [activeItem, applySlashSelection, isWorking, menuItems, menuOpen, send],
  );

  const handlePaste = useCallback<React.ClipboardEventHandler<HTMLElement>>(
    (event) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      event.preventDefault();
      addImages(
        threadRef,
        files.map((file) => ({
          id: randomUUID(),
          type: "image" as const,
          name: file.name || "pasted-image.png",
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        })),
      );
    },
    [addImages, threadRef],
  );

  const onPickFiles = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length > 0) {
        addImages(
          threadRef,
          files.map((file) => ({
            id: randomUUID(),
            type: "image" as const,
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: URL.createObjectURL(file),
            file,
          })),
        );
      }
      event.target.value = "";
    },
    [addImages, threadRef],
  );

  return (
    <div className="relative shrink-0 border-t border-border/60 px-2 py-1.5">
      {menuOpen ? (
        <div className="absolute bottom-full left-2 right-2 z-20 mb-1 max-h-56 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <ComposerCommandMenu
            items={menuItems}
            resolvedTheme={resolvedTheme}
            isLoading={false}
            triggerKind="slash-command"
            activeItemId={activeItem?.id ?? null}
            onHighlightedItemChange={setActiveItemId}
            onSelect={applySlashSelection}
          />
        </div>
      ) : null}

      {draft.images.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {draft.images.map((image) => (
            <span
              key={image.id}
              className="flex items-center gap-1 rounded border border-border bg-muted/50 px-1 py-0.5 text-[10px]"
            >
              <span className="max-w-[90px] truncate">{image.name}</span>
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => removeImage(threadRef, image.id)}
              >
                <XIcon className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="rounded-md border border-border/70 bg-background px-1.5 py-1">
        <ComposerPromptEditor
          editorRef={editorRef}
          value={draft.prompt}
          cursor={cursor}
          terminalContexts={draft.terminalContexts}
          skills={skills}
          disabled={sending}
          placeholder="Message this session — / for commands"
          className="max-h-24 text-[11px]"
          onRemoveTerminalContext={() => undefined}
          onChange={handleChange}
          onCommandKeyDown={handleCommandKey}
          onPaste={handlePaste}
        />
      </div>

      {error !== null ? <p className="mt-1 text-[10px] text-red-500">{error}</p> : null}

      <div className="mt-1 flex items-center gap-1">
        <BoardCardModelPicker
          threadRef={threadRef}
          thread={thread}
          providerStatuses={providerStatuses}
        />
        <span
          className={cn(
            "rounded border border-border/70 px-1 py-0.5 text-[9px] uppercase tracking-wide",
            thread.interactionMode === "plan"
              ? "text-amber-600 dark:text-amber-300"
              : "text-muted-foreground/60",
          )}
          title="Interaction mode"
        >
          {thread.interactionMode === "plan" ? "plan" : "build"}
        </span>

        <label className="ml-auto cursor-pointer rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground">
          <PaperclipIcon className="size-3" />
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPickFiles}
            aria-label="Attach images"
          />
        </label>

        {isWorking ? (
          <button
            type="button"
            aria-label="Interrupt turn"
            data-testid={`board-card-interrupt-${thread.id}`}
            onClick={() =>
              void interruptThreadTurn({
                environmentId: threadRef.environmentId,
                input: buildThreadTurnInterruptInput(thread),
              })
            }
            className="rounded border border-border p-1 text-muted-foreground hover:bg-accent"
          >
            <SquareIcon className="size-3" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send message"
            data-testid={`board-card-send-${thread.id}`}
            disabled={sending || (draft.prompt.trim().length === 0 && draft.images.length === 0)}
            onClick={() => void send()}
            className="rounded bg-primary p-1 text-primary-foreground disabled:opacity-40"
          >
            <SendIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
