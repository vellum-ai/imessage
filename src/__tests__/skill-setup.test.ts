/**
 * Setup-skill instruction invariants.
 *
 * The assistant follows SKILL.md. These lines keep Photon connect, credential
 * collection, and channel restart on the conversational path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..", "..");
const skill = readFileSync(
  join(ROOT, "skills", "imessage-setup", "SKILL.md"),
  "utf8",
);

describe("imessage-setup skill", () => {
  test("sends the Photon approval URL once, then waits a turn", () => {
    expect(skill).toMatch(
      /Do not run\s+`--finish` in the same turn as `--start`/,
    );
    expect(skill).toContain("markdown link");
    expect(skill).toMatch(/Do not also\s+send/);
  });

  test("prompts for project id and project secret", () => {
    expect(skill).toContain(
      "--field photon_project_id",
    );
    expect(skill).toContain(
      "--field photon_project_secret",
    );
    expect(skill).toContain("assistant credentials prompt");
    expect(skill).not.toMatch(
      /assistant credentials set --service imessage --field photon_project/,
    );
  });

  test("does not tell the assistant to restart", () => {
    expect(skill).toContain("Do not restart the assistant");
    expect(skill).not.toMatch(/restart the daemon/i);
  });

  test("keeps the settings app in the background", () => {
    expect(skill).toContain("Keep the settings panel in the background");
    expect(skill).not.toMatch(/open the iMessage plugin's settings/i);
    expect(skill).not.toMatch(/shortest manual path/i);
  });
});
