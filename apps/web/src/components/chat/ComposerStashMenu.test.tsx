import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashMenu, createComposerStashMenuOwnership } from "./ComposerStashMenu";

describe("ComposerStashMenu", () => {
  it("gives keyboard ownership to the newest open menu and restores the previous one", () => {
    const ownership = createComposerStashMenuOwnership();
    const firstMenu = Symbol("first-menu");
    const secondMenu = Symbol("second-menu");

    ownership.claim(firstMenu);
    expect(ownership.isActive(firstMenu)).toBe(true);
    ownership.claim(secondMenu);
    expect(ownership.isActive(firstMenu)).toBe(false);
    expect(ownership.isActive(secondMenu)).toBe(true);
    ownership.release(secondMenu);
    expect(ownership.isActive(firstMenu)).toBe(true);
  });

  it("shows saved image thumbnails and incomplete image states", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "with-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Compare these screenshots",
            attachments: [
              {
                id: "image-one",
                name: "before.png",
                mimeType: "image/png",
                sizeBytes: 128,
                dataUrl: "data:image/png;base64,AA==",
              },
            ],
            droppedImageNames: ["after.png"],
            unreadableImageNames: [],
            pendingImageCount: 0,
          },
          {
            id: "saving-images",
            createdAt: new Date(0).toISOString(),
            prompt: "Save this image",
            attachments: [],
            droppedImageNames: [],
            unreadableImageNames: [],
            pendingImageCount: 1,
          },
        ]}
        stashShortcutLabel="Ctrl+S"
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('src="data:image/png;base64,AA=="');
    expect(markup).toContain("1 image dropped");
    expect(markup).toContain("saving 1 image");
  });

  it("labels mixed file and image stashes without treating images as files", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[
          {
            id: "mixed-attachments",
            createdAt: new Date(0).toISOString(),
            prompt: "",
            attachments: [
              {
                id: "image-one",
                name: "before.png",
                mimeType: "image/png",
                sizeBytes: 128,
                dataUrl: "data:image/png;base64,AA==",
              },
            ],
            files: [
              {
                id: "file-one",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 42,
                attachmentId: "pending-report-pdf",
                environmentId: EnvironmentId.make("environment-1"),
              },
            ],
            droppedImageNames: [],
          },
        ]}
        stashShortcutLabel={null}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("(2 attachments)");
    expect(markup).not.toContain("(2 files)");
  });
});
