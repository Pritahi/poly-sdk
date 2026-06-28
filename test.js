/**
 * Poly SDK — Test Suite (v1.2.0)
 * Run: node test.js
 */
const { Poly, PolyInstance } = require("./dist/index");
const { inferSchema, detectDrift } = require("./dist/schema");
const { applyPatches } = require("./dist/transformer");
const { setCachedPatch, getCachedPatch, configureCache, clearCache, getCacheStats } = require("./dist/cache");

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(v => { (v !== false) ? log("✅", name) : log("❌", name); }).catch(() => log("❌", name));
    } else {
      if (!result) throw 0;
      log("✅", name);
    }
  } catch { log("❌", name); }
}

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
  icon === "✅" ? pass++ : fail++;
}

// ══════════════════════════════════════════
console.log("\n📦 Multi-Instance\n");
const a = Poly.createInstance({ apiKey: "ka" });
const b = Poly.createInstance({ apiKey: "kb" });
test("PolyInstance type", () => a instanceof PolyInstance);
a.analyzeResponse({ url: "https://one.com/a", method: "GET" }, { id: 1, name: "A" });
b.analyzeResponse({ url: "https://two.com/b", method: "GET" }, { sku: "X", price: 10 });
test("isolated baselines", () => a.getBaseline("/a") !== null && b.getBaseline("/b") !== null && a.getBaseline("/b") === null);
a.disable();
test("per-instance disable", () => a.isPolyDisabled() && !b.isPolyDisabled());
a.enable();

// ══════════════════════════════════════════
console.log("\n🔄 Backward Compat\n");
Poly.init({ apiKey: "old" });
test("Poly.init", () => typeof Poly.init === "function");
test("Poly.wrap", () => typeof Poly.wrap === "function");
test("Poly.wrapFetch", () => typeof Poly.wrapFetch === "function");
test("Poly.createFetch", () => typeof Poly.createFetch === "function");
test("not disabled", () => !Poly.isDisabled());
test("cache methods", () => typeof Poly.configureCache === "function" && typeof Poly.getCacheStats === "function");
test("event methods", () => typeof Poly.on === "function" && typeof Poly.off === "function");
test("queue methods", () => typeof Poly.flushQueue === "function" && typeof Poly.pendingQueueSize === "number");

// ══════════════════════════════════════════
console.log("\n🔍 Schema Inference\n");
const schema = inferSchema({ id: 1, name: "Prit", email: "p@t.com", active: true });
test("flat object — 4 fields", () => schema.length === 4);
test("correct types", () =>
  schema.find(x => x.name === "id")?.type === "number" &&
  schema.find(x => x.name === "name")?.type === "string" &&
  schema.find(x => x.name === "active")?.type === "boolean"
);
test("nested object", () => {
  const s = inferSchema({ user: { id: 1, email: "a@b.com" } });
  return s[0]?.type === "object" && s[0]?.children?.length === 2;
});
test("array with items", () => {
  const s = inferSchema({ items: [{ id: 1 }, { id: 2 }] });
  return s[0]?.isArray === true && s[0]?.type === "array";
});
test("nullable field", () => {
  const s = inferSchema({ x: null });
  return s[0]?.nullable === true && s[0]?.type === "null";
});

// ══════════════════════════════════════════
console.log("\n🔍 Drift Detection\n");
const baseline = inferSchema({ id: 1, name: "Prit", email: "p@t.com" });
test("identical schema = 0 drift", () => detectDrift(baseline, inferSchema({ id: 2, name: "X", email: "y" })).length === 0);
test("missing_field", () => detectDrift(baseline, inferSchema({ id: 2, name: "X" })).some(d => d.type === "missing_field"));
test("new_field", () => detectDrift(baseline, inferSchema({ id: 2, name: "X", email: "y", phone: "123" })).some(d => d.type === "new_field"));
test("type_change", () => detectDrift(baseline, inferSchema({ id: "2", name: "X", email: "y" })).some(d => d.type === "type_change" && d.path === "id"));
test("rename same-parent", () => {
  const b = inferSchema({ u: { name: "P" } });
  return detectDrift(b, inferSchema({ u: { full_name: "P" } })).some(d => d.type === "rename");
});
test("rename no cross-parent", () => {
  const b = inferSchema({ u: { name: "P" }, p: { id: 1 } });
  return !detectDrift(b, inferSchema({ u: { id: 1 }, p: { title: "P" } })).some(d => d.type === "rename" && d.path === "u.name");
});
test("nullability change", () => detectDrift(baseline, inferSchema({ id: 2, name: "X", email: null })).some(d => d.type === "nullability"));
test("enum_change (≥2 values)", () => {
  const b = inferSchema([{ s: "a" }, { s: "b" }]);
  b[0].children.find(c => c.name === "s").enumValues = ["a", "b", "c"];
  const a = inferSchema([{ s: "a" }, { s: "b" }, { s: "d" }]);
  a[0].children.find(c => c.name === "s").enumValues = ["a", "b", "c", "d"];
  return detectDrift(b[0].children, a[0].children).some(d => d.type === "enum_change");
});
test("enum no false on 1-value", () => {
  return !detectDrift(inferSchema({ s: "a" }), inferSchema({ s: "b" })).some(d => d.type === "enum_change");
});
test("nested_change", () => {
  const b = inferSchema({ u: { id: 1, name: "P" } });
  return detectDrift(b, inferSchema({ u: { id: 1, name: "P", email: "@" } })).some(d => d.type === "nested_change");
});
test("critical severity on amount", () => {
  const b = inferSchema({ amount: 100 });
  return detectDrift(b, inferSchema({})).find(d => d.path === "amount")?.severity === "critical";
});

// ══════════════════════════════════════════
console.log("\n🔧 Patch Transformer\n");
test("rename field", () => {
  const r = applyPatches({ old: "v" }, [{ type: "rename", from: "old", to: "new", confidence: 99, reason: "r" }]);
  return r.new === "v" && !("old" in r);
});
test("remove field", () => {
  const r = applyPatches({ keep: 1, del: 2 }, [{ type: "remove", from: "del", to: "", confidence: 99, reason: "r" }]);
  return !("del" in r) && r.keep === 1;
});
test("add default", () => {
  const r = applyPatches({ x: 1 }, [{ type: "add_default", from: "s", to: "s", value: "v", confidence: 99, reason: "r" }]);
  return r.s === "v";
});
test("type conversion num→str", () => {
  const r = applyPatches({ n: 42 }, [{ type: "type_conversion", from: "n", to: "n", confidence: 99, reason: "r" }]);
  return typeof r.n === "string" && r.n === "42";
});
test("type conversion str→num", () => {
  const r = applyPatches({ n: "100" }, [{ type: "type_conversion", from: "n", to: "n", confidence: 99, reason: "r" }]);
  return typeof r.n === "number" && r.n === 100;
});
test("compound patches", () => {
  const r = applyPatches({ o: "v", t: "x" }, [
    { type: "rename", from: "o", to: "n", confidence: 99, reason: "r" },
    { type: "remove", from: "t", to: "", confidence: 99, reason: "r" },
    { type: "add_default", from: "r", to: "r", value: "u", confidence: 99, reason: "r" },
  ]);
  return r.n === "v" && !("o" in r) && !("t" in r) && r.r === "u";
});
test("original immutable", () => {
  const d = { x: 1 };
  applyPatches(d, [{ type: "rename", from: "x", to: "y", confidence: 99, reason: "r" }]);
  return "x" in d && d.x === 1;
});

// ══════════════════════════════════════════
console.log("\n⏱️  Cache TTL + LRU\n");
configureCache({ maxSize: 3, ttlMs: 60000 });
clearCache();
const patch = [{ type: "rename", from: "a", to: "b", confidence: 99, reason: "x" }];
for (let i = 0; i < 3; i++) setCachedPatch("k" + i, "t", "/x", patch, 99);
getCachedPatch("k0");
setCachedPatch("k3", "t", "/x", patch, 99);
test("LRU evicts oldest", () => getCachedPatch("k1") === null);
test("LRU keeps touched", () => getCachedPatch("k0") !== null);
test("LRU keeps new", () => getCachedPatch("k3") !== null);
test("LRU stays at max size", () => getCacheStats().size === 3);
clearCache();
configureCache({ maxSize: 10, ttlMs: 20 });
setCachedPatch("ttl", "t", "/x", patch, 99);
test("TTL hit before expiry", () => getCachedPatch("ttl") !== null);

// ══════════════════════════════════════════
console.log("\n🛡️  Safety\n");
Poly.enable();
test("Poly.disable()", () => { Poly.disable(); const d = Poly.isDisabled(); Poly.enable(); return d; });
test("Poly.enable() after disable", () => { Poly.disable(); Poly.enable(); return !Poly.isDisabled(); });
test("POLY_DISABLE env", () => {
  process.env.POLY_DISABLE = "1";
  Poly.init({ apiKey: "t" });
  const d = Poly.isDisabled();
  delete process.env.POLY_DISABLE;
  Poly.enable();
  return d;
});

// ══════════════════════════════════════════
console.log("\n📮 Offline Queue\n");
const q = Poly.createInstance({ apiKey: "q" });
test("starts empty", () => q.pendingQueueSize === 0);
q.analyzeResponse({ url: "https://api.q.com/v1", method: "GET" }, { x: 1, y: "a" });
test("no queue on baseline learn", () => q.pendingQueueSize === 0);
test("flush returns 0 when empty", async () => (await q.flushQueue()) === 0);

// ══════════════════════════════════════════
setTimeout(() => {
  const total = pass + fail;
  console.log("\n" + "=".repeat(45));
  console.log(`  Results: ${pass} passed, ${fail} failed, ${total} total`);
  console.log(`  ${fail === 0 ? "🎉 ALL " + total + " TESTS PASSED!" : "⚠️  " + fail + " FAILED!"}`);
  console.log("=".repeat(45) + "\n");
  process.exit(fail === 0 ? 0 : 1);
}, 100);
