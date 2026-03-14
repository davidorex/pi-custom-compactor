import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAndValidateSpec } from "./spec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedsDir = path.join(__dirname, "..", "seeds");

const seedFiles = fs
  .readdirSync(seedsDir)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

describe("seed specs", () => {
  it("seeds directory contains expected files", () => {
    assert.ok(seedFiles.includes("default.yaml"), "missing default.yaml");
    assert.ok(seedFiles.includes("debugging.yaml"), "missing debugging.yaml");
    assert.ok(
      seedFiles.includes("implementing.yaml"),
      "missing implementing.yaml",
    );
    assert.ok(seedFiles.includes("reviewing.yaml"), "missing reviewing.yaml");
  });

  for (const file of seedFiles) {
    const name = file.replace(/\.yaml$/, "");

    describe(`seeds/${file}`, () => {
      it("parses and validates successfully", () => {
        const content = fs.readFileSync(path.join(seedsDir, file), "utf-8");
        const spec = parseAndValidateSpec(content);
        assert.ok(spec, `${file} should parse to a valid spec`);
        assert.ok(
          Object.keys(spec.extracts).length > 0,
          `${file} should have at least one extract`,
        );
      });

      it("has a reassemble section with sources", () => {
        const content = fs.readFileSync(path.join(seedsDir, file), "utf-8");
        const spec = parseAndValidateSpec(content);
        assert.ok(spec.reassemble, `${file} should have a reassemble section`);
        assert.ok(
          spec.reassemble!.sources.length > 0,
          `${file} should have at least one reassemble source`,
        );
      });

      it("has a budget defined", () => {
        const content = fs.readFileSync(path.join(seedsDir, file), "utf-8");
        const spec = parseAndValidateSpec(content);
        assert.ok(
          spec.reassemble!.budget != null && spec.reassemble!.budget > 0,
          `${file} should have a positive budget`,
        );
      });

      it("has at least one critical-priority extract", () => {
        const content = fs.readFileSync(path.join(seedsDir, file), "utf-8");
        const spec = parseAndValidateSpec(content);
        const hasCritical = Object.values(spec.extracts).some(
          (e) => e.priority === "critical",
        );
        assert.ok(hasCritical, `${file} should have at least one critical extract`);
      });

      it("has file-awareness extract", () => {
        const content = fs.readFileSync(path.join(seedsDir, file), "utf-8");
        const spec = parseAndValidateSpec(content);
        assert.ok(
          spec.extracts["file-awareness"],
          `${file} should have a file-awareness extract`,
        );
        assert.equal(
          spec.extracts["file-awareness"].strategy,
          "mechanical",
          `${file} file-awareness should be mechanical`,
        );
      });

      it("all reassemble sources reference valid persist paths", () => {
        const content = fs.readFileSync(path.join(seedsDir, file), "utf-8");
        const spec = parseAndValidateSpec(content);
        const persistPaths = new Set(
          Object.values(spec.extracts).map((e) => e.source ?? e.persist),
        );
        for (const src of spec.reassemble!.sources) {
          assert.ok(
            persistPaths.has(src.source),
            `${file}: reassemble source '${src.source}' not found in extracts persist paths. Available: ${[...persistPaths].join(", ")}`,
          );
        }
      });
    });
  }
});
