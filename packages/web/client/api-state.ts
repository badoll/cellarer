export async function readApiJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string" ? body.error : `API request failed (${response.status})`,
    );
  }
  return body as T;
}
