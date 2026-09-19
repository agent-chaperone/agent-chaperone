/**
 * Declarations for the release script, which is plain JavaScript because the
 * release workflow runs it with `node` and must not depend on a build step
 * having produced anything.
 */

/** The body under `## <version>`, or undefined when there is no such section. */
export declare function sectionFor(changelog: string, version: string): string | undefined;
