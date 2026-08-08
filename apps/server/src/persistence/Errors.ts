import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { isSqlError } from "effect/unstable/sql/SqlError";

function summarizeSchemaIssue(issue: SchemaIssue.Issue): string {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return `${issue._tag}(${summarizeSchemaIssue(issue.issue)})`;
    case "Composite":
    case "AnyOf":
      return `${issue._tag}(${issue.issues.map(summarizeSchemaIssue).join(",")})`;
    default:
      return issue._tag;
  }
}

// ===============================
// Core Persistence Errors
// ===============================

export const PersistenceErrorCorrelation = Schema.Union([
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ currentSessionId: Schema.String }),
  Schema.Struct({ pairingLinkId: Schema.String }),
  Schema.Struct({ threadId: Schema.String }),
]);
export type PersistenceErrorCorrelation = typeof PersistenceErrorCorrelation.Type;

function sqlDriverFailureDetail(cause: unknown): string | undefined {
  if (!isSqlError(cause)) {
    return undefined;
  }

  const driverCause = cause.reason.cause;
  if (typeof driverCause === "string") {
    return driverCause;
  }
  if (Predicate.hasProperty(driverCause, "message") && typeof driverCause.message === "string") {
    return driverCause.message;
  }
  return cause.reason.message;
}

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail ?? sqlDriverFailureDetail(this.cause);
    return detail === undefined
      ? `SQL error in ${this.operation}`
      : `SQL error in ${this.operation}: ${detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    correlation: Schema.optional(PersistenceErrorCorrelation),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  static fromSchemaError(
    operation: string,
    cause: Schema.SchemaError,
    correlation?: PersistenceErrorCorrelation,
  ): PersistenceDecodeError {
    return new PersistenceDecodeError({
      operation,
      issue: summarizeSchemaIssue(cause.issue),
      ...(correlation === undefined ? {} : { correlation }),
      cause,
    });
  }

  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

// Kept for orchestration/projection call sites, which are being revamped separately.
export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({
      operation,
      cause,
    });
}

// Kept for orchestration/projection call sites, which are being revamped separately.
export function toPersistenceDecodeError(operation: string) {
  return (cause: Schema.SchemaError): PersistenceDecodeError =>
    PersistenceDecodeError.fromSchemaError(operation, cause);
}

export const isPersistenceError = (u: unknown) =>
  isPersistenceSqlError(u) || isPersistenceDecodeError(u);

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  "ProviderSessionRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError;
export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
