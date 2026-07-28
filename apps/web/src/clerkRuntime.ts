type BrowserClerkRuntime = {
  readonly provider: unknown;
};

type ElectronClerkRuntime = {
  readonly provider: unknown;
};

type ElectronPasskeysRuntime = {
  readonly passkeys: unknown;
};

type ClerkRuntimeLoaders = {
  readonly loadBrowser: () => Promise<BrowserClerkRuntime>;
  readonly loadElectron: () => Promise<ElectronClerkRuntime>;
  readonly loadPasskeys: () => Promise<ElectronPasskeysRuntime>;
};

const defaultLoaders: ClerkRuntimeLoaders = {
  async loadBrowser() {
    const { ClerkProvider } = await import("@clerk/react");
    return { provider: ClerkProvider };
  },
  async loadElectron() {
    const { ClerkProvider } = await import("@clerk/electron/react");
    return { provider: ClerkProvider };
  },
  async loadPasskeys() {
    const { passkeys } = await import("@clerk/electron/passkeys");
    return { passkeys };
  },
};

export async function loadClerkRuntime(
  electron: boolean,
  loaders: ClerkRuntimeLoaders = defaultLoaders,
): Promise<
  | { readonly provider: unknown; readonly passkeys?: never }
  | { readonly provider: unknown; readonly passkeys: unknown }
> {
  if (!electron) {
    return loaders.loadBrowser();
  }

  const [electronModule, passkeysModule] = await Promise.all([
    loaders.loadElectron(),
    loaders.loadPasskeys(),
  ]);
  return {
    provider: electronModule.provider,
    passkeys: passkeysModule.passkeys,
  };
}
