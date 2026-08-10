import { describe, expect, it } from "vite-plus/test";

import { isPersistedServerRuntimeUnreachable } from "./orchestrationCliRuntime.ts";

describe("isPersistedServerRuntimeUnreachable", () => {
  it("allows offline fallback only for refused connections", () => {
    expect(
      isPersistedServerRuntimeUnreachable({
        _tag: "OrchestrationCliLiveServerRequestError",
        operation: "callLiveServer",
        cause: { cause: { code: "ECONNREFUSED" } },
      }),
    ).toBe(true);

    expect(
      isPersistedServerRuntimeUnreachable({
        _tag: "OrchestrationCliLiveServerRequestError",
        operation: "callLiveServer",
        cause: { name: "TimeoutError" },
      }),
    ).toBe(false);
  });

  it("never clears runtime discovery for server responses", () => {
    expect(
      isPersistedServerRuntimeUnreachable({
        _tag: "OrchestrationCliLiveServerDeclaredResponseError",
        operation: "callLiveServer",
        code: "unauthorized",
        traceId: "trace-1",
        cause: {},
      }),
    ).toBe(false);

    expect(
      isPersistedServerRuntimeUnreachable({
        _tag: "OrchestrationCliLiveServerUndeclaredStatusError",
        operation: "callLiveServer",
        status: 503,
        cause: {},
      }),
    ).toBe(false);
  });
});
