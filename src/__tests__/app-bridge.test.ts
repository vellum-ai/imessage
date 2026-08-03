import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * Guard against a plugin app calling the bare global `fetch`.
 *
 * Apps under `apps/` are served in a sandboxed iframe whose origin is not the
 * assistant's. A direct `fetch` to a plugin route is cross-origin and carries
 * no session, so it fails before it reaches the route — and the browser
 * reports that as "Failed to fetch" with no status, no body, and nothing
 * pointing at the actual cause. Requests have to go through the bridge the
 * host injects, `window.vellum.fetch`.
 *
 * This is a source check rather than a behavioral one because the failure only
 * reproduces inside the sandbox: `fetch` type-checks, and it works fine from
 * any test or dev server serving the app same-origin.
 */

const ROOT = join(import.meta.dir, "..", "..");
const APPS_DIR = join(ROOT, "apps");
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** `fetch(` that is not a member call — `x.fetch(` and `myFetch(` are fine. */
const BARE_FETCH = /(?<![\w.$])fetch\s*\(/;

function appSources(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...appSources(path));
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(path);
    }
  }
  return out;
}

describe("plugin apps talk to the host bridge", () => {
  const files = appSources(APPS_DIR);

  test("finds app sources to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no app source calls the bare global fetch", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (BARE_FETCH.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test("the settings app reaches its routes through the bridge", () => {
    const api = readFileSync(
      join(APPS_DIR, "imessage-settings", "src", "api.ts"),
      "utf8",
    );
    expect(api).toMatch(/window[^\n]*vellum/);
  });
});
