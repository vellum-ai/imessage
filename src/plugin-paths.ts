/**
 * Filesystem locations inside the installed plugin, and the plugin's own name.
 *
 * This module lives at `<plugin-root>/src/`, so the plugin root is its parent
 * and the writable data directory is a sibling. Resolving from this module's
 * own location (rather than a caller's) keeps the answer stable no matter
 * which surface asks: hooks, routes, or the worker process.
 */

import { basename, join } from "node:path";

/** Absolute path to `<plugin-root>/`. */
function pluginRootDir(): string {
  // `new URL(".", import.meta.url).pathname` is this file's directory
  // (`<plugin-root>/src/`, trailing slash); its parent is the plugin root.
  return join(new URL(".", import.meta.url).pathname, "..");
}

/** Absolute path to `<plugin-root>/data/`. */
export function pluginDataDir(): string {
  return join(pluginRootDir(), "data");
}

/**
 * Absolute path to `<plugin-root>/config.json`, the host-owned plugin config
 * the configuration app edits.
 */
export function pluginConfigPath(): string {
  return join(pluginRootDir(), "config.json");
}

/** The plugin's installed directory name. */
export function pluginName(): string {
  return basename(pluginRootDir());
}

/**
 * The registered channel id.
 *
 * Derived from the plugin's directory name rather than declared, because the
 * two are the same thing: the host serves this plugin's routes under
 * `/x/plugins/<name>/` and its ingress under `/webhooks/plugins/<name>/`, so a
 * separate hardcoded id could only ever agree with the directory name or be a
 * bug.
 */
export const CHANNEL_ID = pluginName();
