import { createModelSelection } from "@t3tools/shared/model";
import type { ScopedThreadRef, ServerProvider } from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";

import { threadEnvironment } from "../../state/threads.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { Menu, MenuItem, MenuPopup, MenuPortal, MenuTrigger } from "../ui/menu.tsx";

export interface BoardCardModelPickerProps {
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
}

/**
 * Compact provider/model control for a board card.
 *
 * Writes the real `thread.meta.update` command, so a model picked on a card is
 * the model the next turn actually runs on — the same field the full chat
 * view's picker writes.
 */
export function BoardCardModelPicker(props: BoardCardModelPickerProps) {
  const { threadRef, thread, providerStatuses } = props;
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  const available = useMemo(
    () => providerStatuses.filter((provider) => provider.enabled && isProviderAvailable(provider)),
    [providerStatuses],
  );

  const currentLabel = useMemo(() => {
    const provider = providerStatuses.find(
      (entry) => entry.instanceId === thread.modelSelection.instanceId,
    );
    const model = provider?.models.find((entry) => entry.slug === thread.modelSelection.model);
    return model?.name ?? thread.modelSelection.model;
  }, [providerStatuses, thread.modelSelection]);

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            data-testid={`board-card-model-${thread.id}`}
            className="flex min-w-0 items-center gap-0.5 rounded border border-border/70 px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span className="max-w-[110px] truncate">{currentLabel}</span>
            <ChevronDownIcon className="size-2.5 shrink-0" />
          </button>
        }
      />
      <MenuPortal>
        <MenuPopup className="max-h-72 overflow-y-auto">
          {available.flatMap((provider) =>
            provider.models.map((model) => (
              <MenuItem
                key={`${provider.instanceId}:${model.slug}`}
                onClick={() => {
                  void updateMetadata({
                    environmentId: threadRef.environmentId,
                    input: {
                      threadId: threadRef.threadId,
                      modelSelection: createModelSelection(provider.instanceId, model.slug),
                    },
                  });
                }}
              >
                <span className="text-xs">{model.name}</span>
                <span className="ml-2 text-[10px] text-muted-foreground/60">
                  {provider.displayName ?? provider.instanceId}
                </span>
              </MenuItem>
            )),
          )}
        </MenuPopup>
      </MenuPortal>
    </Menu>
  );
}
