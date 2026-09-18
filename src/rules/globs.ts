/**
 * Matching a tool name against the allow and deny lists in the policy file.
 *
 * Deliberately not a regular expression. A pattern like `*a*a*a*b` compiled
 * naively backtracks catastrophically, and these patterns come from a file the
 * user edits, so a typo should not be able to stall the proxy. The algorithm
 * below is the standard greedy scan with one backtrack point, which is linear
 * on every input.
 */

/** `*` matches any run of characters, `?` matches exactly one. Nothing else is special. */
export function matchesGlob(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let starAt = -1;
  let matchAt = 0;

  while (v < value.length) {
    const patternChar = pattern[p];
    // The wildcard is tested first. Testing literal equality first would let a
    // `*` in the pattern consume exactly one character whenever the value also
    // holds a `*`, so a deny list of `*` would fail to deny a tool named
    // `*danger`, which is precisely the name an evasive server would pick.
    if (p < pattern.length && patternChar === '*') {
      starAt = p;
      matchAt = v;
      p += 1;
    } else if (p < pattern.length && (patternChar === '?' || patternChar === value[v])) {
      p += 1;
      v += 1;
    } else if (starAt !== -1) {
      p = starAt + 1;
      matchAt += 1;
      v = matchAt;
    } else {
      return false;
    }
  }

  while (pattern[p] === '*') {
    p += 1;
  }
  return p === pattern.length;
}

/** The first pattern in the list that matches, or undefined when none does. */
export function firstMatch(patterns: readonly string[], value: string): string | undefined {
  return patterns.find((pattern) => matchesGlob(pattern, value));
}
