import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { loadClerkRuntime } from "./clerkRuntime";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <AppRoot router={router} />;
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

type ClerkProviderComponent = React.ComponentType<{
  readonly children: React.ReactNode;
  readonly passkeys?: unknown;
  readonly publishableKey: string;
}>;

async function renderApp() {
  if (!clerkPublishableKey || !hasCloudPublicConfig()) {
    root.render(<React.StrictMode>{app}</React.StrictMode>);
    return;
  }

  const runtime = await loadClerkRuntime(isElectron);
  const ClerkProvider = runtime.provider as ClerkProviderComponent;
  root.render(
    <React.StrictMode>
      {isElectron ? (
        <ClerkProvider publishableKey={clerkPublishableKey} passkeys={runtime.passkeys}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )}
    </React.StrictMode>,
  );
}

void renderApp();
