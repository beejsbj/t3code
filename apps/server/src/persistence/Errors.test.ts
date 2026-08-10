import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

const decodeRuntimePayload = Schema.decodeUnknownEffect(
  Schema.Struct({
    runtimePayload: Schema.Struct({
      attempt: Schema.Number,
    }),
  }),
);

it("keeps SQL operation context without a tautological detail", () => {
  const cause = new Error("database unavailable");
  const error = new PersistenceSqlError({
    operation: "AuthSessionRepository.list:query",
    cause,
  });

  assert.equal(error.operation, "AuthSessionRepository.list:query");
  assert.equal(error.detail, undefined);
  assert.equal(error.cause, cause);
  assert.equal(error.message, "SQL error in AuthSessionRepository.list:query");
});

it("surfaces the underlying database failure from shared SQL conversion", () => {
  const driverCause = new Error("table projection_threads has no column named settled_at");
  const cause = new SqlError({
    reason: new UnknownError({
      cause: driverCause,
      message: "Failed to prepare statement",
      operation: "prepare",
    }),
  });

  const error = toPersistenceSqlError("ProjectionThreadRepository.upsert:query")(cause);

  assert.equal(error.operation, "ProjectionThreadRepository.upsert:query");
  assert.equal(
    error.message,
    "SQL error in ProjectionThreadRepository.upsert:query: table projection_threads has no column named settled_at",
  );
  assert.notInclude(error.message, "Failed to execute ProjectionThreadRepository.upsert:query");
  assert.equal(error.cause, cause);
});

it.effect("maps schema errors without copying rejected payloads into diagnostics", () =>
  Effect.gen(function* () {
    const rejectedPayload = "runtime-payload-secret-sentinel";
    const cause = yield* Effect.flip(
      decodeRuntimePayload({
        runtimePayload: {
          attempt: rejectedPayload,
        },
      }),
    );
    const error = PersistenceDecodeError.fromSchemaError(
      "ProviderSessionRuntimeRepository.list:decodeRows",
      cause,
    );

    assert.equal(error.operation, "ProviderSessionRuntimeRepository.list:decodeRows");
    assert.equal(error.cause, cause);
    assert.notInclude(error.issue, rejectedPayload);
    assert.notInclude(error.message, rejectedPayload);
    assert.include(error.issue, "InvalidType");
  }),
);
