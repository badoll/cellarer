import { redactSafeObservableText } from "@cellarer/core";

export const INTERNAL_FAILURE_DIAGNOSTIC = "Unexpected internal failure";

export function safeInternalFailureDiagnostic(error: unknown): string {
  try {
    const diagnostic = diagnosticTextFromUnknown(error);
    const context = safeDiagnosticContext(error, diagnostic);
    return redactSafeObservableText(context, diagnostic);
  } catch {
    return INTERNAL_FAILURE_DIAGNOSTIC;
  }
}

function diagnosticTextFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack;
    if (typeof stack === "string" && stack.length > 0) return stack;
    const message = error.message;
    return typeof message === "string" && message.length > 0
      ? message
      : INTERNAL_FAILURE_DIAGNOSTIC;
  }
  const diagnostic = String(error);
  return diagnostic.length > 0 ? diagnostic : INTERNAL_FAILURE_DIAGNOSTIC;
}

function safeDiagnosticContext(error: unknown, diagnostic: string): unknown {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return diagnostic;
  }
  const context: Record<PropertyKey, unknown> = {};
  for (const key of Object.getOwnPropertySymbols(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(context, key, { value: descriptor.value });
  }
  return context;
}
