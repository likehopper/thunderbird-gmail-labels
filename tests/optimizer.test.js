const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const readExtension = file => fs.readFileSync(path.join(__dirname, "..", "extension", file), "utf8");
const filter = (id, query, label = "Label_1") => ({
  id,
  criteria: { query },
  action: { addLabelIds: [label] },
});

function optimizerContext(currentFilters, behavior = {}) {
  const calls = { created: [], deleted: [], notified: [] };
  let nextId = 1;
  const context = vm.createContext({
    browser: { storage: { local: { set: async () => {} } } },
    translate: (key, value) => `${key}: ${value}`,
    listFilters: async () => structuredClone(currentFilters),
    createFilter: async (_email, criteria, action) => {
      calls.created.push({ criteria: structuredClone(criteria), action: structuredClone(action) });
      if (behavior.createError?.(criteria)) throw new Error("creation refused");
      return { id: `new-${nextId++}`, criteria, action };
    },
    deleteFilter: async (_email, id) => {
      calls.deleted.push(id);
      if (behavior.deleteError?.(id)) throw new Error("deletion refused");
    },
    notifyFiltersChanged: email => calls.notified.push(email),
    structuredClone,
  });
  vm.runInContext("class AuthError extends Error {}; class OfflineError extends Error {};", context);
  for (const file of ["common/filter-query.js", "common/parallel.js", "background/optimizer.js"]) {
    vm.runInContext(readExtension(file), context, { filename: file });
  }
  return { apply: vm.runInContext("applyOptimizationGroup", context), calls };
}

test("optimizer rolls back newly created filters when a later creation fails", async () => {
  const current = [filter("old-1", "from:a@example.com"), filter("old-2", "from:b@example.com")];
  const { apply, calls } = optimizerContext(current, {
    createError: criteria => criteria.query === "from:fail@example.com",
  });
  await assert.rejects(apply("one@example.com", {
    filterIds: current.map(entry => entry.id),
    queries: ["from:new@example.com", "from:fail@example.com"],
  }), /creation refused/);
  assert.deepEqual(calls.deleted, ["new-1"]);
  assert.equal(calls.deleted.some(id => id.startsWith("old-")), false);
  assert.deepEqual(calls.notified, []);
});

test("optimizer reports an original filter it could not delete", async () => {
  const current = [filter("old-1", "from:a@example.com"), filter("old-2", "from:b@example.com")];
  const { apply, calls } = optimizerContext(current, { deleteError: id => id === "old-2" });
  const result = await apply("one@example.com", {
    filterIds: current.map(entry => entry.id),
    queries: ["{from:a@example.com from:b@example.com}"],
  });
  assert.deepEqual(structuredClone(result), { created: 1, deleted: 1, kept: ["old-2"] });
  assert.deepEqual(calls.notified, ["one@example.com"]);
});

test("optimizer refuses stale filters before creating or deleting anything", async () => {
  const current = [filter("old-1", "from:a@example.com"), filter("old-2", "from:b@example.com", "Label_2")];
  const { apply, calls } = optimizerContext(current);
  await assert.rejects(apply("one@example.com", {
    filterIds: current.map(entry => entry.id),
    queries: ["{from:a@example.com from:b@example.com}"],
  }), /errFilterChanged/);
  assert.deepEqual(calls.created, []);
  assert.deepEqual(calls.deleted, []);
});
