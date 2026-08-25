import type { ClientErrorCode, ClientWarning } from "@cellarer/core/client-api";

export class ClientApiError extends Error {
  constructor(
    message: string,
    readonly code: ClientErrorCode,
    readonly httpStatus: number,
    readonly requestId?: string,
    readonly details?: Readonly<Record<string, unknown>>,
    readonly warnings: readonly ClientWarning[] = [],
  ) {
    super(message);
    this.name = "ClientApiError";
  }
}

export async function readApiJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as {
    status?: unknown;
    requestId?: unknown;
    warnings?: unknown;
    data?: unknown;
    error?: { code?: unknown; message?: unknown; details?: unknown };
  } | null;
  const warnings = Array.isArray(body?.warnings) ? (body.warnings as ClientWarning[]) : [];
  if (
    body?.status === "error" &&
    typeof body.error?.code === "string" &&
    typeof body.error.message === "string"
  ) {
    throw new ClientApiError(
      body.error.message,
      body.error.code as ClientErrorCode,
      response.status,
      typeof body.requestId === "string" ? body.requestId : undefined,
      isDetailMap(body.error.details) ? body.error.details : undefined,
      warnings,
    );
  }
  if (body?.status === "success") return body.data as T;
  throw new ClientApiError(
    `API request failed (${response.status})`,
    "INTERNAL_ERROR",
    response.status,
    typeof body?.requestId === "string" ? body.requestId : undefined,
    undefined,
    warnings,
  );
}

export function isClientReplanRequired(error: unknown): boolean {
  return (
    error instanceof ClientApiError &&
    (error.code === "STALE_REVISION" || error.code === "TARGET_CONFLICT") &&
    error.details?.replanRequired === true
  );
}

function isDetailMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
