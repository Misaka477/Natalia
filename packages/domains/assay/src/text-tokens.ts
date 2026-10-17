/**
 * The content-token set of a text: lowercased, split on non-alphanumerics,
 * keeping tokens long enough to carry meaning.
 *
 * Shared by the miner's information-density filter and the cheap judge's
 * overlap so the two agree on what a "word" is — two tokenizers in one
 * evaluation path is two answers to the same question.
 */
export function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2),
  );
}
