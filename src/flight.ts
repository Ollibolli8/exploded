import * as THREE from "three";

/**
 * What the drone does once it is whole: its propellers turn and its lights come on. The same two effects as on the
 * Terne X case (work.draindk.tech/work/terne/), for a model whose rotors are nodes named TX_motor_* holding blades
 * named TX_blade_*, and whose arm lights are TX_arm_led_* and TX_arm_light_*.
 *
 *  - rotors: blades the eye can follow. At about eleven turns a second a 1/24 s film shutter smears each blade into a
 *    fan of faint copies trailing behind it, so you see blades going round rather than a disc.
 *  - lights: as on an aircraft: the front pair steady red, the rear pair a green double blink, each with a small halo.
 */
export type Motor = { node: THREE.Object3D; dir: number; blades: THREE.Object3D[] };

const SPEED = 70;                 // rad/s at full spin: about 11 turns a second
const SHUTTER = 1 / 24;
const GHOSTS = 14;
const GHOST_INK = 0.85;           // the fan's total density, shared by its copies
const LEAD = 0.42;                // the real blade's opacity at full blur: the leading edge you follow

export function findMotors(root: THREE.Object3D): Motor[] {
  const motors: Motor[] = [];
  root.traverse(o => {
    if (/^TX_motor_/.test(o.name)) motors.push({ node: o, dir: Number(o.userData.spin ?? 1) >= 0 ? 1 : -1, blades: o.children.filter(c => c.name.startsWith("TX_blade_")) });
  });
  return motors;
}

/** The blades and their trailing copies. spin 0..1 is speed, blur 0..1 how much the shutter shows. The copies are
 *  laid out from where the blades sit now, so build this with every blade seated. */
export function rotors(motors: Motor[]) {
  type Fan = { mesh: THREE.InstancedMesh; base: THREE.Matrix4; dir: number };
  const fans: Fan[] = [];
  const bladeMats = new Map<THREE.Material, THREE.Material>();
  const ghostMats = new Map<THREE.Material, THREE.Material>();
  const inv = new THREE.Matrix4(), rot = new THREE.Matrix4(), m = new THREE.Matrix4();
  const UP = new THREE.Vector3(0, 1, 0);
  for (const motor of motors) {
    motor.node.updateWorldMatrix(true, true);
    inv.copy(motor.node.matrixWorld).invert();
    for (const blade of motor.blades) blade.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const shared = mesh.material as THREE.Material;
      // the blades fade as the shutter opens, so they get their own copy of a material the body may share
      let own = bladeMats.get(shared);
      if (!own) { own = shared.clone(); bladeMats.set(shared, own); }
      mesh.material = own;
      let ghost = ghostMats.get(shared);
      if (!ghost) {
        ghost = shared.clone();
        Object.assign(ghost, { transparent: true, depthWrite: false, opacity: GHOST_INK / (GHOSTS + 1) });
        ghostMats.set(shared, ghost);
      }
      const fan = new THREE.InstancedMesh(mesh.geometry, ghost, GHOSTS);
      fan.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      fan.frustumCulled = false;
      fan.renderOrder = 1;
      fan.visible = false;
      motor.node.add(fan);
      fans.push({ mesh: fan, base: new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld), dir: motor.dir });
    });
  }
  let arcNow = -1;
  return {
    /** The blades' own materials (opaque at rest). */
    materials: [...bladeMats.values()],
    step(dt: number, spin: number, blur: number) {
      for (const motor of motors) motor.node.rotation.y = (motor.node.rotation.y + motor.dir * spin * SPEED * dt) % (Math.PI * 2);
      const b = THREE.MathUtils.clamp(blur * Math.min(1, spin * 1.6), 0, 1);
      for (const mat of bladeMats.values()) { mat.opacity = 1 - (1 - LEAD) * b; mat.transparent = b > 0.001; mat.depthWrite = b < 0.5; }
      for (const mat of ghostMats.values()) mat.opacity = (GHOST_INK / (GHOSTS + 1)) * b;
      const on = b > 0.001;
      for (const f of fans) f.mesh.visible = on;
      if (!on) return;
      const arc = Math.min(Math.PI * 0.95, SPEED * Math.max(spin, 0.35) * SHUTTER);
      if (Math.abs(arc - arcNow) < 1e-3) return;
      arcNow = arc;
      for (const f of fans) {
        for (let i = 0; i < GHOSTS; i++) {
          rot.makeRotationAxis(UP, -f.dir * arc * ((i + 1) / GHOSTS));
          f.mesh.setMatrixAt(i, m.multiplyMatrices(rot, f.base));
        }
        f.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    /** Every blade back where it was built (the fans were laid out from there). */
    rest() { for (const motor of motors) motor.node.rotation.y = 0; },
    dispose() {
      for (const f of fans) { f.mesh.removeFromParent(); f.mesh.dispose(); }
      for (const mat of [...bladeMats.values(), ...ghostMats.values()]) mat.dispose();
    },
  };
}

function glow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.12)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The arm lights. When the power comes on they flash twice together, then run: front steady red, rear a green
 *  double blink every 1.6 s. The materials are the model's own LED materials (each gets its own copy here). */
export function navLights(root: THREE.Object3D) {
  const tex = glow();
  const halos: { sprite: THREE.Sprite; rear: boolean }[] = [];
  const mats: { mat: THREE.MeshStandardMaterial; base: number; rear: boolean }[] = [];
  const own = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const box = new THREE.Box3(), c = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse(o => {
    const m = /^TX_arm_(led|light)_(FL|FR|RL|RR)$/.exec(o.name);       // the window under the arm and the light bar on its end
    if (!m || !o.parent) return;
    const rear = m[2][0] === "R";
    const mesh = o as THREE.Mesh;
    const src = mesh.material as THREE.MeshStandardMaterial;
    if (mesh.isMesh && src?.isMeshStandardMaterial && src.emissiveIntensity > 0) {
      let mat = own.get(src);
      if (!mat) { mat = src.clone(); own.set(src, mat); mats.push({ mat, base: src.emissiveIntensity, rear }); }
      mesh.material = mat;
    }
    box.setFromObject(o).getCenter(c);
    o.parent.worldToLocal(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: rear ? 0x3dff7a : 0xff2a1c, transparent: true, depthWrite: false, toneMapped: false, opacity: 0,
    }));
    sprite.position.copy(c);
    sprite.scale.setScalar(0.019);
    sprite.renderOrder = 3;
    sprite.raycast = () => {};
    o.parent.add(sprite);
    halos.push({ sprite, rear });
  });
  const pulse = (t: number, at: number) => THREE.MathUtils.smoothstep(t, at, at + 0.025) * (1 - THREE.MathUtils.smoothstep(t, at + 0.11, at + 0.16));
  return {
    /** t: seconds since the power came on (negative: off). */
    step(t: number) {
      const on = t >= 0;
      // the boot: two flashes of everything, then the run
      const boot = on && t < 0.62 ? Math.max(pulse(t, 0), pulse(t, 0.3)) : 0;
      const run = on && t >= 0.62;
      const k = (t - 0.62) % 1.6;
      const blink = run ? Math.max(pulse(k, 0), pulse(k, 0.26)) : 0;
      for (const m of mats) m.mat.emissiveIntensity = m.base * (boot || (run ? (m.rear ? 0.06 + 0.94 * blink : 1) : 0));
      for (const h of halos) (h.sprite.material as THREE.SpriteMaterial).opacity = boot * 0.8 || (run ? (h.rear ? 0.7 * blink : 0.34) : 0);
    },
    get count() { return halos.length; },
    dispose() {
      tex.dispose();
      for (const m of mats) m.mat.dispose();
      for (const h of halos) { h.sprite.removeFromParent(); h.sprite.material.dispose(); }
    },
  };
}
