/**
 * Declarations for the plugin launcher's decisions, which are plain JavaScript
 * because Claude Code runs the launcher with `node` straight from the plugin
 * checkout, where no build step has produced anything.
 */

export declare const SIDES: readonly ['pre', 'post'];

/** Where the package keeps its command, relative to an install. */
export declare const MAIN: readonly string[];

/** The version this checkout carries, or undefined when it cannot be read. */
export declare function pluginVersion(packageJson: string): string | undefined;

/** Whether `name` is an executable file in one of the directories on this path. */
export declare function onPath(
  name: string,
  pathValue: string | undefined,
  platform?: string,
  pathExt?: string,
): boolean;

/** The directory one version is installed into, inside the plugin's data directory. */
export declare function runtimeDir(dataDir: string, version: string): string;

/** The command inside an install. */
export declare function runtimeMain(dir: string): string;

export interface Command {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export type Plan =
  | ({ readonly kind: 'global' | 'npx' } & Command)
  | { readonly kind: 'install' | 'installed'; readonly dir: string; readonly main: string };

/** What to do for one side of the hook, or undefined when there is nothing to do. */
export declare function planFor(
  side: 'pre' | 'post',
  options: {
    readonly version: string | undefined;
    readonly globalInstalled: boolean;
    readonly dataDir: string | undefined;
    readonly installed: boolean;
    readonly platform?: string;
  },
): Plan | undefined;

/** The install command, run with the staging directory as its working directory. */
export declare function installCommand(version: string, platform?: string): Command;

/** The install's environment: quiet, with an npm cache inside the data directory. */
export declare function installEnv(
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): Record<string, string | undefined>;

/** How long a failed install is left alone before it is tried again. */
export declare const RETRY_AFTER_MS: number;

/** The file that records when an install of this version last failed. */
export declare function failureMarker(dataDir: string, version: string): string;

/** Whether a recorded failure is recent enough to skip another attempt. */
export declare function coolingDown(markerText: string, now: number): boolean;

/** npm told to say as little as it can. */
export declare function quietEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;
