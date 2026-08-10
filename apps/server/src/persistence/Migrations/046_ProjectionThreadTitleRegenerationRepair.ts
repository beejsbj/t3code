import * as Effect from "effect/Effect";

import Migration0035 from "./035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./036_ProjectionThreadsPinned.ts";
import Migration0037 from "./037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./040_ProjectionProjectFaviconPath.ts";

export default Effect.gen(function* () {
  // Board nightlies once occupied upstream migration IDs 35-40. Re-run the
  // upstream migrations idempotently so those databases converge on main.
  yield* Migration0035;
  yield* Migration0036;
  yield* Migration0037;
  yield* Migration0038;
  yield* Migration0039;
  yield* Migration0040;
});
