// Tests of the Gmail search logic that decides which filters get merged then deleted.
// Run from the repository root: node --test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// The extension scripts are plain browser scripts: load them into one shared context
const context = vm.createContext({});
for (const file of ["common/filter-query.js", "common/parallel.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "extension", file), "utf8"), context);
}
const run = code => vm.runInContext(code, context);
const isOrSearch = run("isOrSearch");
const orSearchItems = run("orSearchItems");
const parseSimpleQuery = run("parseSimpleQuery");
const searchKey = run("searchKey");
const optimizationGroups = run("optimizationGroups");
const concurrentFilters = run("concurrentFilters");
const splitOrSearch = run("splitOrSearch");
const inParallel = run("inParallel");

// Plain copies: values from the vm context have their own Array prototype
const plain = value => JSON.parse(JSON.stringify(value));
const labelFilter = (id, query, labelId = "Label_1") => ({ id, criteria: { query }, action: { addLabelIds: [labelId] } });

test("OR searches are recognized", () => {
  for (const query of ["{from:a@x.fr to:a@x.fr}", "from:a@x.fr OR to:a@x.fr", "from:(a@x.fr OR b@x.fr)",
    "(from:a@x.fr)", "from:a@x.fr", "{from:(a@x.fr OR b@x.fr) to:c@x.fr}"]) {
    assert.equal(isOrSearch(query), true, query);
  }
});

test("searches needing several terms at once are not OR searches", () => {
  for (const query of ["from:a@x.fr to:b@x.fr", "subject:(facture edf)", "{subject:(facture edf) from:x@y.fr}",
    "{from:a@x.fr -from:b@x.fr}", "from:a@x.fr OR", ""]) {
    assert.equal(isOrSearch(query), false, query);
  }
});

test("OR searches split into one item per term", () => {
  assert.deepEqual(plain(orSearchItems("from:(a@x.fr OR b@x.fr) OR to:c@x.fr")), ["from:a@x.fr", "from:b@x.fr", "to:c@x.fr"]);
  assert.deepEqual(plain(orSearchItems('{subject:"two words" x.fr}')), ['subject:"two words"', "x.fr"]);
});

test("the form shows a search only when each value has the same fields", () => {
  assert.deepEqual(plain(parseSimpleQuery("{from:a@x.fr cc:a@x.fr to:a@x.fr}")), { values: ["a@x.fr"], fields: ["from", "to"] });
  assert.equal(parseSimpleQuery("{from:a@x.fr to:b@x.fr}"), null);
  assert.equal(parseSimpleQuery("{to:a@x.fr}"), null); // to without cc
});

test("the same OR terms in another order are the same search", () => {
  assert.equal(searchKey("{from:b@x.fr from:a@x.fr}"), searchKey("from:a@x.fr OR from:b@x.fr"));
  assert.notEqual(searchKey("from:a@x.fr to:b@x.fr"), searchKey("from:a@x.fr OR to:b@x.fr"));
});

test("filters with the same action merge, without the terms covered by a domain", () => {
  const groups = plain(optimizationGroups([
    labelFilter("1", "from:a@x.fr"),
    labelFilter("2", "{from:x.fr from:b@y.fr}"),
    labelFilter("3", "from:c@z.fr", "Label_2"),
  ], 1500));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].filters.map(filter => filter.id), ["1", "2"]);
  assert.deepEqual(groups[0].queries, ["{from:x.fr from:b@y.fr}"]);
  assert.equal(groups[0].removedItems, 1);
});

test("a filter whose search needs several terms is never merged", () => {
  const groups = optimizationGroups([labelFilter("1", "{subject:(facture edf) from:x@y.fr}"), labelFilter("2", "from:z@w.fr")], 1500);
  assert.equal(groups.length, 0);
});

test("merged searches stay under the maximum length", () => {
  const items = Array.from({ length: 50 }, (_, index) => `from:sender${index}@example.com`);
  const queries = splitOrSearch(items, 200);
  assert.ok(queries.length > 1);
  assert.ok(queries.every(query => query.length <= 200));
  assert.deepEqual(plain(queries.flatMap(query => orSearchItems(query))), items);
});

test("filters sharing a term but doing different things are concurrent", () => {
  const pairs = plain(concurrentFilters([
    labelFilter("1", "from:x.fr"),
    labelFilter("2", "from:a@x.fr", "Label_2"),
    labelFilter("3", "from:a@x.fr"),
  ]));
  assert.deepEqual(pairs.map(pair => pair.filters.map(filter => filter.id).sort().join("|")).sort(), ["1|2", "2|3"]);
});

test("inParallel runs each item once, never more than the limit at once", async () => {
  let running = 0;
  let maxRunning = 0;
  const done = [];
  await inParallel([1, 2, 3, 4, 5, 6, 7], 3, async item => {
    maxRunning = Math.max(maxRunning, ++running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--;
    done.push(item);
  });
  assert.equal(maxRunning, 3);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
});
