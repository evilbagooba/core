// Fixture projects: golden documents every tool in the suite tests against.
// Here: each one loads, current-version fixtures round-trip unchanged, and
// the ops layer can replay each of them from an empty project.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SCHEMA_VERSION, applyOps, emptyProject, migrateProject, reviewOps, type Op } from "../src/index";

const dir = new URL("../fixtures/", import.meta.url);
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f, doc: JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Record<string, unknown> }));

describe("fixtures", () => {
  it("are present", () => assert.ok(fixtures.length >= 3));

  for (const { name, doc } of fixtures) {
    it(`${name} loads`, () => {
      const p = migrateProject(doc);
      assert.equal(p.schemaVersion, SCHEMA_VERSION);
      assert.ok(p.title.trim());
    });

    if (doc.schemaVersion === SCHEMA_VERSION) {
      it(`${name} round-trips unchanged`, () => {
        assert.deepEqual(migrateProject(doc), doc);
      });

      it(`${name} can be rebuilt with ops`, () => {
        const p = migrateProject(doc);
        const ops: Op[] = [
          ...p.nodes.map((node): Op => ({ type: "add_node", node })),
          ...p.edges.map((edge): Op => ({ type: "add_edge", edge })),
          ...Object.entries(p.legend).map(([key, meaning]): Op => ({ type: "set_legend", key, meaning })),
          ...p.work.map((work): Op => ({ type: "spawn_work", work })),
          ...p.artifacts.map((artifact): Op => ({ type: "add_artifact", artifact })),
          ...p.narratives.map((narrative): Op => ({ type: "create_narrative", narrative })),
        ];
        assert.equal(reviewOps(emptyProject(p.title), ops).error, null);
        assert.deepEqual(applyOps(emptyProject(p.title), ops), p);
      });
    }
  }
});
