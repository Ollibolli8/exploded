/**
 * The teardown's spec against the model it is written for, and the parts module's own sums. A spec that names a node
 * the model doesn't have, or rests a node on one with another parent, isn't an error in the browser: core.ts skips it
 * quietly and the part just doesn't move, or lifts through what sits on it. These catch that before it ships.
 * Run with `npm test` (Node 22.18 or later runs the TypeScript as it is).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { TERNE, autoSpec, measure, mm, type Rail, type Vec3 } from "../src/parts.ts";

// The demo's model: a GLB's first chunk is its JSON, which is all a node name or a parent needs (no meshes decoded).
type Node = { name?: string; children?: number[] };
function nodes(path: string) {
  const b = readFileSync(path);
  assert.equal(b.toString("utf8", 0, 4), "glTF", `${path} is not a GLB`);
  const len = b.readUInt32LE(12);
  assert.equal(b.toString("utf8", 16, 20), "JSON");
  const gltf = JSON.parse(b.toString("utf8", 20, 20 + len)) as { nodes: Node[] };
  const parent = new Map<string, string | null>();
  gltf.nodes.forEach(n => { if (n.name && !parent.has(n.name)) parent.set(n.name, null); });
  gltf.nodes.forEach((n, i) => { for (const c of n.children ?? []) { const name = gltf.nodes[c].name; if (name) parent.set(name, n.name ?? `#${i}`); } });
  return parent;
}
const MODEL = nodes(new URL("../demo/public/terne.glb", import.meta.url).pathname);
const rails = TERNE.parts.flatMap(p => p.pieces.flat().map(r => ({ part: p, rail: r })));
const railOf = new Map(rails.map(r => [r.rail.node, r.rail]));
const length = (r: Rail) => r.to ? Math.hypot(...r.to) : r.dist ?? 0;

test("every node the spec names is in the model", () => {
  const missing = rails.map(r => r.rail.node).filter(n => !MODEL.has(n));
  assert.deepEqual(missing, []);
});

test("parts have their own ids, and the steps run 1, 2, 3… without a gap", () => {
  const ids = TERNE.parts.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const steps = TERNE.parts.map(p => p.step).filter(s => s > 0).sort((a, b) => a - b);
  assert.deepEqual(steps, steps.map((_, i) => i + 1));
});

test("a part that stays has no rails; a part that comes off has one each", () => {
  for (const { part, rail } of rails) {
    if (part.step === 0) assert.ok(!rail.to && !rail.axis, `${rail.node} stays, so it has no rail`);
    else {
      assert.ok(!!rail.to !== !!rail.axis, `${rail.node}: an offset or an axis, not both or neither`);
      assert.ok(length(rail) > 0, `${rail.node} goes somewhere`);
    }
  }
});

test("each number points at a piece the part has", () => {
  for (const p of TERNE.parts) assert.ok((p.label ?? 0) < p.pieces.length, p.id);
});

test("the power part is in the spec", () => {
  assert.ok(TERNE.parts.some(p => p.id === (TERNE.power ?? "battery")));
});

test("a node rests on one with the same parent, along the same rail, never shorter", () => {
  for (const [upper, lower] of TERNE.rests ?? []) {
    const u = railOf.get(upper), l = railOf.get(lower);
    assert.ok(u && l, `${upper} on ${lower}: both move`);
    // core.ts only links the two when they share a parent
    assert.equal(MODEL.get(upper), MODEL.get(lower), `${upper} and ${lower} share a parent`);
    // the upper is pushed along the lower's travel, so the two rails point the same way
    assert.ok(u.to && l.to, `${upper} on ${lower}: offset rails`);
    const dot = (u.to[0] * l.to[0] + u.to[1] * l.to[1] + u.to[2] * l.to[2]) / (length(u) * length(l));
    assert.ok(dot > 0.999, `${upper} and ${lower} move the same way (${dot.toFixed(4)})`);
    // pushed out by the lower, all the way, it shouldn't end past its own end
    assert.ok(length(u) >= length(l), `${upper} goes at least as far as ${lower}`);
  }
});

test("nothing rests on itself through a chain", () => {
  const below = new Map(TERNE.rests ?? []);
  for (const start of below.keys()) {
    const seen = new Set<string>();
    for (let n: string | undefined = start; n; n = below.get(n)) {
      assert.ok(!seen.has(n), `a loop through ${n}`);
      seen.add(n);
    }
  }
});

test("mm: whole millimetres, a tenth under ten", () => {
  assert.equal(mm([69.4, 33.2, 81]), "69 × 33 × 81");
  assert.equal(mm([9.94, 0.5, 120.6]), "9.9 × 0.5 × 121");
  assert.equal(mm([9.96, 10, 0]), "10 × 10 × 0.0");
});

const box = (name: string, size: Vec3, at: Vec3) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size));
  m.name = name; m.position.set(...at);
  return m;
};

test("measure: a part's size in its own frame, less the parts inside it", () => {
  const arm = box("TX_arm", [0.1, 0.02, 0.05], [0.2, 0, 0]);
  arm.rotation.y = Math.PI / 2;   // turned: still measured along its own length
  const motor = box("TX_motor", [0.03, 0.03, 0.03], [0.06, 0.02, 0]);
  arm.add(motor);
  const s = measure([arm], new Set([motor]));
  assert.deepEqual(s.map(x => Math.round(x * 10) / 10), [100, 20, 50]);
  const all = measure([arm], new Set());
  assert.ok(all[1] > 20, "with the motor in, it is taller");
});

test("autoSpec: furthest out comes off first, each straight out from the middle", () => {
  const root = new THREE.Group();
  root.name = "TX_rig";
  root.add(box("TX_core", [0.1, 0.1, 0.1], [0, 0, 0]), box("TX_lid", [0.1, 0.01, 0.1], [0, 0.1, 0]), box("TX_foot", [0.1, 0.01, 0.1], [0, -0.1, 0]),
    box("TX_left_arm", [0.1, 0.02, 0.02], [-0.3, 0, 0]), box("TX_right_arm", [0.1, 0.02, 0.02], [0.3, 0, 0]));
  const spec = autoSpec(root);
  const by = new Map(spec.parts.map(p => [p.id, p]));
  const to = (id: string) => by.get(id)!.pieces[0][0].to!;
  assert.deepEqual(["TX_left_arm", "TX_right_arm"].map(id => by.get(id)!.step).sort(), [1, 2]);
  assert.deepEqual(["TX_lid", "TX_foot"].map(id => by.get(id)!.step).sort(), [3, 4]);
  assert.equal(by.get("TX_core")!.step, 5);
  assert.equal(by.get("TX_left_arm")!.name, "Left arm");
  assert.ok(to("TX_left_arm")[0] < 0 && to("TX_right_arm")[0] > 0, "the arms go out to their sides");
  assert.ok(Math.abs(to("TX_left_arm")[1]) < 1e-9 && Math.abs(to("TX_left_arm")[2]) < 1e-9, "and only sideways");
  assert.ok(to("TX_lid")[1] > 0 && to("TX_foot")[1] < 0, "the lid goes up, the foot down");
  // the one in the middle has nowhere to go out from: it goes up
  assert.ok(to("TX_core")[1] > 0 && Math.abs(to("TX_core")[0]) < 1e-9);
});
