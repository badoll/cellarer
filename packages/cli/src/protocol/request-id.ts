import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class InvalidRequestIdError extends Error {
  readonly code = "INVALID_INPUT" as const;

  constructor() {
    super("request id must use 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen");
    this.name = "InvalidRequestIdError";
  }
}

export function resolveRequestId(
  supplied: string | undefined,
  createUuid: () => string = randomUUID,
): string {
  const requestId = supplied ?? `req-${createUuid()}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new InvalidRequestIdError();
  return requestId;
}
