import * as THREE from "three";

/**
 * What comes apart, and how. A part (a row of the parts list) is one kind of thing: the battery, a propeller blade,
 * an arm. It comes off at its step (1 first), and it has one or more pieces, the actual objects: the drone has eight
 * blades and four arms. A piece moves one or more nodes, each along its own rail, all together.
 *
 * A rail is where the node goes when the piece is all the way out: an offset in the node's parent's space (metres), or
 * a distance along one of the node's own axes. A node can rest on another (the deck on the heat sink under it): it is
 * then never less far out than the one it rests on, so pulling the lower one lifts the upper one with it, the way a
 * hand would find it.
 */
export type Vec3 = [number, number, number];
export type Rail = { node: string; to?: Vec3; axis?: "x" | "y" | "z" | "-x" | "-y" | "-z"; dist?: number };
export type PartSpec = {
  id: string;
  name: string;
  /** The order it comes off in, from 1. 0: it stays (the frame everything else comes off). */
  step: number;
  /** Each piece: the nodes it moves, all at once. A part that stays lists its nodes as one piece with no rails. */
  pieces: Rail[][];
  /** The piece its number points at (default the first). */
  label?: number;
};
export type Spec = {
  parts: PartSpec[];
  /** A node and the node it rests on, along the same rail direction. */
  rests?: [string, string][];
  /** The model as one assembly, for the top row: its name. */
  name?: string;
  /** The part that powers it (default "battery"): with it out, nothing lights or turns. */
  power?: string;
};

const CORNERS = ["FL", "FR", "RL", "RR"] as const;
const each = (f: (c: string) => Rail[]) => CORNERS.map(f);

/**
 * Terne X, in the order a technician takes it down (the case's own teardown, taken further: the bells come off the
 * stators, the camera out of its yoke). glTF axes: Y up, the nose faces +Z. Node names are terne.glb's.
 */
export const TERNE: Spec = {
  name: "Terne X",
  power: "battery",
  parts: [
    { id: "battery", name: "Battery", step: 1, pieces: [[{ node: "TX_battery", to: [0, 0.006, -0.09] }]] },
    { id: "blade", name: "Propeller blade", step: 2, label: 2, pieces: CORNERS.flatMap(c => [0, 1].map(i => [{ node: `TX_blade_${c}_${i}`, to: [0, 0.024, 0] as Vec3 }])) },
    { id: "deck", name: "Deck", step: 3, pieces: [[{ node: "TX_shell_front", to: [0, 0.115, 0] }]] },
    { id: "heatsink", name: "Heat sink", step: 4, pieces: [[{ node: "TX_heat_sink", to: [0, 0.075, 0] }]] },
    { id: "board", name: "Flight board", step: 5, pieces: [[{ node: "TX_flight_board", to: [0, 0.036, 0] }]] },
    { id: "gimbal", name: "Gimbal", step: 6, pieces: [[
      { node: "TX_gimbal_yaw", to: [0, -0.045, 0.06] }, { node: "TX_gimbal_plate", to: [0, -0.02, 0.03] },
      { node: "TX_gimbal_dampers", to: [0, -0.01, 0.015] }, { node: "TX_ribbon", to: [0, -0.03, 0.045] },
    ]] },
    { id: "camera", name: "Metalens camera", step: 7, pieces: [[{ node: "TX_gimbal_pitch", to: [0, 0, 0.034] }]] },
    { id: "arm", name: "Arm", step: 8, label: 1, pieces: each(c => [{ node: `TX_arm_${c}`, axis: "x", dist: 0.05 }]) },
    { id: "bell", name: "Motor bell", step: 9, label: 1, pieces: each(c => [{ node: `TX_bell_${c}`, to: [0, 0.016, 0] }, { node: `TX_hub_${c}`, to: [0, 0.016, 0] }]) },
    { id: "stator", name: "Stator", step: 10, label: 1, pieces: each(c => [{ node: `TX_motor_${c}`, to: [0, 0.035, 0] }]) },
    { id: "leg", name: "Leg", step: 11, label: 1, pieces: each(c => [{ node: `TX_leg_${c}`, to: [0, -0.03, 0] }]) },
    { id: "airframe", name: "Airframe", step: 0, pieces: [[
      "TX_keel", "TX_spine", "TX_wishbones", "TX_knuckles", "TX_pins", "TX_keel_mount", "TX_fairings",
    ].map(node => ({ node }))] },
  ],
  rests: [
    ["TX_shell_front", "TX_heat_sink"], ["TX_heat_sink", "TX_flight_board"],
    ...CORNERS.flatMap(c => [0, 1].map(i => [`TX_blade_${c}_${i}`, `TX_bell_${c}`] as [string, string])),
  ],
};

/**
 * Rails for any model, from its shape: each top-level part moves straight out from the middle of the whole, the
 * furthest out first. Good enough for a first look at a model nobody has written a spec for.
 */
export function autoSpec(root: THREE.Object3D): Spec {
  // the level that holds the parts: past any wrapper with a single child
  let top = root;
  while (top.children.length === 1 && !(top as THREE.Mesh).isMesh) top = top.children[0];
  root.updateMatrixWorld(true);
  const whole = new THREE.Box3().setFromObject(top);
  const centre = whole.getCenter(new THREE.Vector3()), size = whole.getSize(new THREE.Vector3()).length();
  const kids = top.children.filter(c => !new THREE.Box3().setFromObject(c).isEmpty());
  const named = new Map<string, number>();
  const parts = kids.map((c, i) => {
    if (!c.name) c.name = `part_${i + 1}`;
    if (named.has(c.name)) c.name = `${c.name}_${i + 1}`;
    named.set(c.name, i);
    const box = new THREE.Box3().setFromObject(c);
    const mid = box.getCenter(new THREE.Vector3());
    const out = mid.clone().sub(centre);
    if (out.length() < size * 0.02) out.set(0, 1, 0);
    out.normalize();
    // far enough to clear its own size along the way out, and a little more
    const reach = box.getSize(new THREE.Vector3()).dot(new THREE.Vector3(Math.abs(out.x), Math.abs(out.y), Math.abs(out.z))) * 0.7 + size * 0.12;
    // the rail in the parent's space
    const inv = new THREE.Matrix3().setFromMatrix4(c.parent!.matrixWorld).invert();
    const to = out.clone().multiplyScalar(reach).applyMatrix3(inv);
    return { c, d: mid.distanceTo(centre), part: { id: c.name, name: pretty(c.name), step: 0, pieces: [[{ node: c.name, to: to.toArray() as Vec3 }]] } };
  });
  parts.sort((a, b) => b.d - a.d).forEach((p, i) => (p.part.step = i + 1));
  return { parts: parts.map(p => p.part), name: pretty(root.name || top.name || "Model") };
}

const pretty = (name: string) => {
  const s = name.replace(/^[A-Z]{1,3}_/, "").replace(/[_.]+/g, " ").replace(/\s+\d+$/, "").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
};

/** A part's size in millimetres, measured in its first node's own frame (so an arm reads along its length), leaving
 *  out what belongs to other parts (`others`: an arm's motor and leg are parts of their own). */
export function measure(nodes: THREE.Object3D[], others: Set<THREE.Object3D>): Vec3 {
  const ref = nodes[0];
  ref.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(ref.matrixWorld).invert();
  const box = new THREE.Box3(), m = new THREE.Matrix4(), v = new THREE.Vector3();
  const walk = (o: THREE.Object3D) => {
    if (others.has(o)) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.visible) {
      m.multiplyMatrices(inv, mesh.matrixWorld);
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    }
    for (const c of o.children) walk(c);
  };
  for (const n of nodes) walk(n);
  if (box.isEmpty()) return [0, 0, 0];
  const s = box.getSize(v);
  return [s.x * 1000, s.y * 1000, s.z * 1000];
}

/** 69 × 33 × 81: whole millimetres, a tenth where a dimension is under ten. */
export const mm = (s: Vec3) => s.map(x => (x < 9.95 ? x.toFixed(1) : Math.round(x).toString())).join(" × ");
