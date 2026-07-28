import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * Guard against raw control bytes in source.
 *
 * A single NUL or other C0 byte makes git classify the file as binary, and a
 * binary file shows up in review as "Bin 4669 -> 4852 bytes" with no diff at
 * all — the change becomes invisible to reviewers. That happened once here,
 * from a control character typed directly into a template literal. Control
 * characters that are genuinely needed must be written as escapes
 * (`"\u001f"`), which keeps the source ASCII and the diff readable.
 */

const ROOT = join(import.meta.dir, "..", "..");
const SCANNED_DIRS = ["src", "hooks", "routes", "channels", "skills"];
const SCANNED_EXTENSIONS = [".ts", ".json", ".md"];

function sourceFiles(dir: string): string[] {
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
      out.push(...sourceFiles(path));
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(path);
    }
  }
  return out;
}

describe("source hygiene", () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));

  test("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test("no source file contains a raw control byte", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        // Tab, newline, and carriage return are the only C0 bytes allowed.
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
          offenders.push(
            `${file.slice(ROOT.length + 1)}: U+${code.toString(16).padStart(4, "0")} at offset ${i}`,
          );
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
