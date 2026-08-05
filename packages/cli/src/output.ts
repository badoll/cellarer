import { redactSafeObservableText, serializeSafeObservable } from "@cellarer/core";

type ConsoleMethod = (...data: unknown[]) => void;

export const safeConsole: Pick<Console, "log" | "warn" | "error"> = {
  log: safeMethod((...data) => globalThis.console.log(...data)),
  warn: safeMethod((...data) => globalThis.console.warn(...data)),
  error: safeMethod((...data) => globalThis.console.error(...data)),
};

export function createSafeConsole(context: unknown): Pick<Console, "log" | "warn" | "error"> {
  return {
    log: safeMethod((...data) => globalThis.console.log(...data), context),
    warn: safeMethod((...data) => globalThis.console.warn(...data), context),
    error: safeMethod((...data) => globalThis.console.error(...data), context),
  };
}

export function serializeCliOutput(
  value: unknown,
  pretty = true,
  context: unknown = value,
): string {
  return serializeSafeObservable("cli", value, { pretty, knownValueSources: [context] });
}

export function formatCliOutput(value: unknown, context: unknown = value): unknown {
  if (typeof value !== "string") return serializeCliOutput(value, true, context);
  const parsed = parseJsonOutput(value);
  return parsed === undefined
    ? redactSafeObservableText(context, value)
    : serializeCliOutput(parsed, true, context);
}

function safeMethod(write: ConsoleMethod, context?: unknown): ConsoleMethod {
  return (...data) => write(...data.map((value) => formatCliOutput(value, context)));
}

function parseJsonOutput(value: string): unknown {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
