/**
 * The accounts a refused quick update names, in the server's words.
 *
 * The server keys a refusal about one balance to `entries.<i>.amount`, the
 * index of the entry in the request it was sent, so `sent` is the accounts in
 * that same order. A key of any other shape, or an index past the request,
 * names nothing; the refusal's top-level message is still the answer.
 */
export function refusedEntriesOf(
  fieldErrors: Readonly<Record<string, readonly string[]>> | undefined,
  sent: readonly string[],
): ReadonlyMap<string, string> {
  const named = new Map<string, string>();
  for (const [field, messages] of Object.entries(fieldErrors ?? {})) {
    const index = /^entries\.(\d+)\.amount$/u.exec(field)?.[1];
    const positionId = index === undefined ? undefined : sent[Number(index)];
    const message = messages[0];
    if (positionId !== undefined && message !== undefined) named.set(positionId, message);
  }
  return named;
}
