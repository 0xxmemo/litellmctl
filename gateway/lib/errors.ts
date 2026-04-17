/** Safe string for logging / JSON from unknown thrown values (avoids null.message crashes). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err != null && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}
