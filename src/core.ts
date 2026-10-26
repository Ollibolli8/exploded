import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { TERNE, autoSpec, measure, type PartSpec, type Spec, type Vec3 } from "./parts";
import { findMotors, navLights, rotors } from "./flight";
import { createProxies } from "./outline";

/**
 * Exploded: a model that comes apart in your hands. Each part slides out along its own rail, in the order it comes
 * off (parts.ts), and can be pulled out or pushed back by itself: drag it, or click it. A part pushes whatever rests
 * on it. The part under the pointer is drawn round in ink, dashed where it runs on behind other parts, and every part
 * that is out carries its number, the way a parts catalogue numbers a drawing.
 *
 * Terne X (terne.glb) also flies, but only when it is whole: with the battery in, its lights come on; with every part
 * back, its rotors spool up and it hovers. Take anything out and it spools down.
 *
 * The page drives the teardown with apart(0..1) (from its scroll, say), lists the parts (onParts), draws the numbers
 * (onCallouts, or callouts.ts) and shows the status (onStatus). Everything else is here.
 */
export type Region = { x0: number; x1: number; y0: number; y1: number };
export type PartInfo = { id: string; n: string; name: string; count: number; size: Vec3; step: number; fixed: boolean };
export type Callout = { id: string; n: string; x: number; y: number; ax: number; ay: number; r: number; a: number; hot: boolean };
/** Pieces out (in all, and by part), whether it has power, is whole, and is flying. */
export type Status = { out: number; total: number; parts: Record<string, number>; power: boolean; whole: boolean; flying: boolean };

export type ExplodedOptions = {
  canvas: HTMLCanvasElement;
  /** A glTF/GLB. terne.glb gets its own spec; any other model comes apart by its shape unless `spec` says how. */
  model: string;
  /** Where DRACOLoader finds its decoder. */
  draco: string;
  spec?: Spec;
  pixelRatio?: number;
  /** Motion off: parts jump to where they go, nothing turns or drifts. */
  still?: boolean;
  /** Where the model sits, from the canvas's size: a box in -1..1 across and up, whole (0) and all the way apart (1). */
  region?: (width: number, height: number, apart: 0 | 1) => Region;
  /** Materials by the model's material names, in place of its own (and of the plain ones for terne.glb here). */
  materials?: Record<string, THREE.Material>;
  /** What the metal reflects, in place of the softbox room here. */
  environment?: (renderer: THREE.WebGLRenderer) => Promise<THREE.Texture>;
  /** Anything else the first compile should wait for: textures the page lays on in onModel or when they arrive (an AO
   *  map, say), which change the shaders. */
  textures?: (renderer: THREE.WebGLRenderer) => Promise<unknown>;
  /** The ink of the numbers and lines, sRGB 0..1. */
  ink?: [number, number, number];
  /** After the model loads and before anything is drawn (to lay an AO map over it, say). */
  onModel?: (root: THREE.Object3D, renderer: THREE.WebGLRenderer) => void;
  onProgress?: (loaded: number) => void;
  onReady?: () => void;
  onFail?: (reason: unknown) => void;
  /** The parts list, once the model is in: each part's number, name, count and size (mm), and the whole's. */
  onParts?: (parts: PartInfo[], whole: { name: string; size: Vec3 }) => void;
  onStatus?: (s: Status) => void;
  /** Every frame: where each part's number goes (CSS px over the canvas) and what it points at. */
  onCallouts?: (c: Callout[]) => void;
  /** A part leaving its seat or going back in. */
  onSeat?: (seated: boolean, part: string) => void;
  /** The part under the pointer (or chosen on a phone), for the page's list. */
  onHot?: (part: string | null) => void;
  /** The rotors' speed, 0..1, as they spool. */
  onSpool?: (spool: number) => void;
  /** After each frame is drawn, with the frame time the loop means to hold (ms). */
  onFrame?: (now: number, target: number) => void;
};
export type Exploded = {
  renderer: THREE.WebGLRenderer;
  /** The teardown: 0 whole, 1 every part off, one after another in their order. A part moved by hand keeps its place
   *  until this passes over it again. */
  apart: (x: number) => void;
  /** Pull a part out, or push it back: every piece, or one (`piece`, in the spec's order). */
  toggle: (part: string, piece?: number) => void;
  /** Draw this part round (the page's list, under the pointer), or none. */
  hot: (part: string | null) => void;
  setStill: (on: boolean) => void;
  setPixelRatio: (dpr: number) => void;
  refit: () => void;
  dispose: () => void;
};

const lin = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const DEG = Math.PI / 180;
const WAIT = 5000;     // ms after the model is in that the first compile waits for the environment and textures
const INK: [number, number, number] = [0.086, 0.094, 0.106];
// the camera: whole, a little above the drone and off its nose; apart, higher, so the stack reads (the case's angles).
// On a tall screen it looks down further, apart, so the drawing takes the height the screen has as well as its width.
const VIEWS = { wide: { whole: { az: -30, el: 12 }, apart: { az: -24, el: 26 } }, tall: { whole: { az: -30, el: 14 }, apart: { az: -12, el: 46 } } };
const DEFAULT_REGION = (w: number, h: number, apart: 0 | 1): Region =>
  h > w ? (apart ? { x0: -0.92, x1: 0.92, y0: -0.6, y1: 0.6 } : { x0: -0.86, x1: 0.86, y0: -0.4, y1: 0.4 })
    : (apart ? { x0: -0.7, x1: 0.7, y0: -0.82, y1: 0.82 } : { x0: -0.62, x1: 0.62, y0: -0.6, y1: 0.6 });

/** Plain materials for terne.glb by its Blender material names (the portfolio passes the case's own). */
function plainMaterials(): Record<string, THREE.Material> {
  const std = (c: THREE.Color, metalness: number, roughness: number) => new THREE.MeshStandardMaterial({ color: c, metalness, roughness });
  const glow = (c: THREE.Color, e: THREE.Color, i: number) => new THREE.MeshStandardMaterial({ color: c, emissive: e, emissiveIntensity: i });
  const dark = std(lin(0.045, 0.047, 0.05), 0.65, 0.42);
  return {
    TX_shell: std(lin(0.4, 0.405, 0.41), 1, 0.44), TX_titanium: std(lin(0.66, 0.64, 0.6), 1, 0.26), TX_hull: dark,
    TX_ball: new THREE.MeshPhysicalMaterial({ color: lin(0.8, 0.8, 0.78), roughness: 0.34, clearcoat: 0.16 }),
    TX_camera: new THREE.MeshPhysicalMaterial({ color: lin(0.028, 0.029, 0.031), roughness: 0.34, clearcoat: 0.3 }),
    TX_prop: new THREE.MeshPhysicalMaterial({ color: lin(0.035, 0.036, 0.038), roughness: 0.4, clearcoat: 0.25 }),
    TX_accent: new THREE.MeshPhysicalMaterial({ color: lin(0.62, 0.035, 0.03), roughness: 0.44, clearcoat: 0.25 }),
    TX_bell: std(lin(0.07, 0.072, 0.076), 1, 0.3), TX_metal_dark: std(lin(0.16, 0.162, 0.168), 1, 0.32), TX_hub: std(lin(0.03, 0.031, 0.033), 0, 0.45),
    TX_rubber: std(lin(0.018, 0.018, 0.019), 0, 0.85), TX_grip: std(lin(0.04, 0.041, 0.043), 0, 0.75), TX_vent: std(lin(0.008, 0.008, 0.009), 0, 0.8),
    TX_copper: std(lin(0.93, 0.52, 0.32), 1, 0.36), TX_stator: std(lin(0.02, 0.02, 0.022), 0, 0.5),
    TX_light: std(lin(0.55, 0.56, 0.57), 0, 0.25), TX_print_dark: std(lin(0.16, 0.162, 0.168), 0, 0.46), TX_print_light: std(lin(0.62, 0.62, 0.61), 0, 0.5),
    TX_pcb: std(lin(0.013, 0.035, 0.025), 0, 0.43), TX_contacts: std(lin(0.63, 0.37, 0.085), 1, 0.25), TX_solder: std(lin(0.44, 0.47, 0.49), 1, 0.29),
    TX_led_red: glow(lin(0.25, 0.02, 0.02), lin(1, 0.06, 0.03), 3), TX_led_green: glow(lin(0.02, 0.2, 0.05), lin(0.15, 1, 0.35), 2.5),
    TX_led_white: glow(lin(0.3, 0.3, 0.3), lin(0.85, 0.95, 1), 1.6),
    TX_visor: new THREE.MeshPhysicalMaterial({ color: lin(0.006, 0.006, 0.007), roughness: 0.05, clearcoat: 1 }),
    TX_chamfer: std(lin(0.9, 0.91, 0.92), 1, 0.09), TX_lens_plate: std(lin(0.03, 0.032, 0.035), 0.9, 0.26),
    TX_glass_sensor: new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.03, clearcoat: 1 }),
    TX_glass_tof: new THREE.MeshPhysicalMaterial({ color: lin(0.03, 0, 0.006), roughness: 0.05, clearcoat: 1 }),
    TX_metalens: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0, transparent: true, opacity: 0.1, depthWrite: false, clearcoat: 1 }),
    TX_metalens_well: std(lin(0.004, 0.004, 0.005), 0, 0.3),
  };
}

/** A softbox room: what the metal reflects until (or unless) the page brings its own. */
function studio() {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(8, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "varying vec3 vP; void main(){ float h = normalize(vP).y; gl_FragColor = vec4(mix(vec3(0.55,0.56,0.57), vec3(0.08,0.08,0.09), smoothstep(-0.1, 0.7, h)), 1.0); }",
  })));
  const box = (w: number, h: number, pos: Vec3, k: THREE.Color) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: k, side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  box(2.4, 1.8, [-1.6, 2.2, 1.4], lin(6, 6, 6));
  box(1.8, 1.2, [1.9, 0.6, 1.6], lin(1.6, 1.6, 1.7));
  box(0.25, 2.6, [1.6, 0.8, -1.4], lin(7, 7, 7));
  box(2.0, 2.0, [0, 3.0, 0], lin(3, 3, 3));
  return env;
}

type RailState = { node: THREE.Object3D; home: THREE.Vector3; unit: THREE.Vector3; dist: number; below: RailState | null; d: number; piece: Piece };
type Piece = {
  part: Part; index: number; rails: RailState[]; meshes: number[];
  p: number; v: number; target: number; scroll: number; override: number | null; eff: number; out: boolean;
  anchor: THREE.Vector3;          // the middle of what it is, in its first node's space
  box: THREE.Box3;                // and its extent there, which the numbers keep clear of
};
type Part = { spec: PartSpec; info: PartInfo; pieces: Piece[]; label: number; a: number; cx: number; cy: number; placed: boolean; turn: readonly [number, number] };
// where a number may go from what it points at: turned off the line out from the model's middle (steps of 24°), and
// further out along it (px)
const TURNS = [0, 1, -1, 2, -2, 3, -3].flatMap(t => [0, 18, 36].map(e => [t, e] as const));

export function createExploded(o: ExplodedOptions): Exploded {
  const { canvas } = o;
  const ink = o.ink ?? INK;
  // the context asked for here, so a browser without WebGL 2 throws a plain error for the page's still (three would
  // log its own console error first)
  const context = canvas.getContext("webgl2", { antialias: true, alpha: true, stencil: false, powerPreference: "high-performance" });
  if (!context) throw new Error("no WebGL 2");
  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(o.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.01, 30);
  camera.layers.enable(1);
  let alive = true, ready = false, still = !!o.still, raf = 0, prev = 0, drawn = 0, pace = 1000 / 60;

  // ------------------------------------------------------------------------------------------ light
  // What the metal reflects: the page's (o.environment), or the softbox room here without one or if it fails. The
  // first compile waits for it and for o.textures (up to WAIT after the model is in), since a texture that changes the
  // shaders after it would have every material built again on the main thread mid-scroll; one later than that is
  // compiled off the frame first, the last frame held meanwhile.
  const pmrem = new THREE.PMREMGenerator(renderer);
  let env: THREE.Texture | null = null, compiled = false, holding = 0;
  const room = () => pmrem.fromScene(studio(), 0.03).texture;
  const setEnv = (t: THREE.Texture) => { const old = env; env = t; scene.environment = t; old?.dispose(); };
  const late = (change: () => void) => {
    if (!alive) return;
    change();
    if (!compiled) return;
    holding++;
    compileAll().catch(() => {}).then(warm).finally(() => { holding--; kick(); });
  };
  const waits: Promise<unknown>[] = [];
  if (o.environment) waits.push(o.environment(renderer).then(t => { if (!alive) t.dispose(); else late(() => setEnv(t)); },
    () => { if (!env) late(() => setEnv(room())); }));
  else setEnv(room());
  if (o.textures) waits.push(o.textures(renderer).then(() => late(() => {}), () => {}));
  const ENV_YAW = -60 * DEG;
  scene.environmentRotation.set(0, ENV_YAW, 0);
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(-1.2, 2.0, 1.4);
  scene.add(key);

  // ------------------------------------------------------------------------------------------ the model
  const drone = new THREE.Group();
  drone.rotation.order = "YXZ";
  scene.add(drone);
  const parts: Part[] = [];
  const pieces: Piece[] = [];
  const rails: RailState[] = [];          // in the order they are worked out: a rail after the one it rests on
  const meshes: THREE.Mesh[] = [];
  const owner: (Piece | null)[] = [];
  let proxies: ReturnType<typeof createProxies> | null = null;
  let flight: ReturnType<typeof rotors> | null = null;
  let lights: ReturnType<typeof navLights> | null = null;
  let power: Piece[] = [];
  const outline = { whole: [] as THREE.Vector3[], apart: [] as THREE.Vector3[] };
  const draco = new DRACOLoader().setDecoderPath(o.draco);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const mats: Record<string, THREE.Material> = { ...plainMaterials(), ...o.materials };

  loader.load(o.model, gltf => {
    if (!alive) return;
    try { build(gltf.scene); } catch (err) { o.onFail?.(err); }
  }, e => { if (e.total) o.onProgress?.(e.loaded / e.total); }, err => { if (alive) o.onFail?.(err); });

  function build(root: THREE.Object3D) {
    const terne = !!root.getObjectByName("TX_battery");
    root.traverse(n => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mats[(mesh.material as THREE.Material).name];
      if (terne || m) mesh.material = m ?? mats.TX_hull;
    });
    // centre it on the origin
    const box = new THREE.Box3().setFromObject(root);
    root.position.sub(box.getCenter(new THREE.Vector3()));
    drone.add(root);
    drone.updateMatrixWorld(true);
    o.onModel?.(root, renderer);
    const spec = o.spec ?? (terne ? TERNE : autoSpec(root));
    drone.updateMatrixWorld(true);

    // parts, pieces and rails
    const byNode = new Map<string, RailState>();
    const railNode = new Map<THREE.Object3D, Piece>();
    const steps = Math.max(0, ...spec.parts.map(p => p.step));
    let extra = steps;
    for (const ps of spec.parts) {
      const part: Part = { spec: ps, pieces: [], label: ps.label ?? 0, a: 0, cx: 0, cy: 0, placed: false, turn: TURNS[0],
        info: { id: ps.id, n: String(ps.step || ++extra).padStart(2, "0"), name: ps.name, count: 0, size: [0, 0, 0], step: ps.step, fixed: !ps.step } };
      for (const railSpecs of ps.pieces) {
        const piece: Piece = { part, index: part.pieces.length, rails: [], meshes: [], p: 0, v: 0, target: 0, scroll: 0, override: null, eff: 0, out: false, anchor: new THREE.Vector3(), box: new THREE.Box3() };
        for (const r of railSpecs) {
          const node = root.getObjectByName(r.node);
          if (!node) continue;
          let to = new THREE.Vector3();
          if (r.to) to.set(...r.to);
          else if (r.axis) {
            const s = r.axis[0] === "-" ? -1 : 1, ax = r.axis.slice(-1) as "x" | "y" | "z";
            to.set(ax === "x" ? s : 0, ax === "y" ? s : 0, ax === "z" ? s : 0).applyQuaternion(node.quaternion).multiplyScalar(r.dist ?? 0);
          }
          const dist = to.length();
          const rail: RailState = { node, home: node.position.clone(), unit: dist ? to.divideScalar(dist) : to, dist, below: null, d: 0, piece };
          piece.rails.push(rail);
          byNode.set(r.node, rail);
          railNode.set(node, piece);
        }
        if (!piece.rails.length) continue;
        part.pieces.push(piece);
        if (ps.step) pieces.push(piece);
      }
      if (!part.pieces.length) continue;
      part.label = Math.min(part.label, part.pieces.length - 1);
      part.info.count = part.pieces.length;
      parts.push(part);
    }
    for (const [upper, lower] of spec.rests ?? []) {
      const u = byNode.get(upper), l = byNode.get(lower);
      if (u && l && u.node.parent === l.node.parent) u.below = l;
    }
    // worked out in order: a rail after the one it rests on
    const depth = (r: RailState): number => (r.below ? 1 + depth(r.below) : 0);
    rails.push(...[...byNode.values()].sort((a, b) => depth(a) - depth(b)));

    // every mesh belongs to the nearest piece above it
    root.traverse(n => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      let up: THREE.Object3D | null = mesh, own: Piece | null = null;
      while (up && !own) { own = railNode.get(up) ?? null; up = up.parent; }
      own?.meshes.push(meshes.length);
      meshes.push(mesh);
      owner.push(own);
    });

    // sizes, measured; and each piece's middle, for its number to point at
    const allRails = new Set(railNode.keys());
    for (const part of parts) {
      const own = new Set(part.pieces.flatMap(p => p.rails.map(r => r.node)));
      const others = new Set([...allRails].filter(n => !own.has(n)));
      part.info.size = measure(part.pieces[0].rails.map(r => r.node), others);
      for (const piece of part.pieces) {
        const b = new THREE.Box3();
        // its own meshes only (expandByObject would take in the pieces nested under them: the camera in the gimbal)
        const ref = piece.rails[0].node, toRef = new THREE.Matrix4().copy(ref.matrixWorld).invert(), m = new THREE.Matrix4();
        for (const i of piece.meshes) {
          const g = meshes[i].geometry;
          if (!g.boundingBox) g.computeBoundingBox();
          b.union(g.boundingBox!.clone().applyMatrix4(meshes[i].matrixWorld));
          piece.box.union(g.boundingBox!.clone().applyMatrix4(m.multiplyMatrices(toRef, meshes[i].matrixWorld)));
        }
        piece.anchor.copy(b.isEmpty() ? new THREE.Vector3().setFromMatrixPosition(ref.matrixWorld) : b.getCenter(new THREE.Vector3()));
        ref.worldToLocal(piece.anchor);
      }
    }
    power = parts.filter(p => p.spec.id === (spec.power ?? "battery")).flatMap(p => p.pieces);
    const motors = findMotors(root);
    flight = motors.length ? rotors(motors) : null;
    lights = navLights(root);
    for (const n of drone.children) n.traverse(c => { if ((c as THREE.Sprite).isSprite || (c as THREE.InstancedMesh).isInstancedMesh) c.layers.set(1); });
    proxies = createProxies(renderer, meshes, ink);
    boxes = new Float32Array(parts.reduce((n, p) => n + p.pieces.length, 0) * 4);

    // the outline the framing fits: every eighth vertex, whole (with the circles the rotors sweep) and all apart
    const inv = new THREE.Matrix4().copy(drone.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
    const collect = (into: THREE.Vector3[]) => {
      drone.updateMatrixWorld(true);
      for (const mesh of meshes) {
        m.multiplyMatrices(inv, mesh.matrixWorld);
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i += 8) into.push(v.fromBufferAttribute(pos, i).applyMatrix4(m).clone());
      }
    };
    collect(outline.whole);
    for (const motor of motors) {
      const b = new THREE.Box3();
      for (const bl of motor.blades) b.expandByObject(bl);
      const c = b.getCenter(new THREE.Vector3()), R = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;
      for (let i = 0; i < 24; i++) outline.whole.push(new THREE.Vector3(c.x + Math.cos(i / 24 * Math.PI * 2) * R, c.y, c.z + Math.sin(i / 24 * Math.PI * 2) * R).applyMatrix4(inv));
    }
    for (const p of pieces) p.p = 1;
    place();
    collect(outline.apart);
    for (const p of pieces) p.p = 0;
    place();
    drone.updateMatrixWorld(true);

    o.onParts?.(parts.map(p => p.info), { name: spec.name ?? "Model", size: measure([root], new Set()) });
    resize();
    status(true);
    Promise.race([Promise.all(waits), new Promise(r => setTimeout(r, WAIT))]).then(() => {
      if (!alive) return;
      if (!env) setEnv(room());
      compiled = true;
      return compileAll();
    }).catch(() => {}).then(warm).finally(() => {
      draco.dispose();
      if (!alive) return;
      // the first frame is drawn while the page still hides the canvas, and the page told a frame after that
      ready = true;
      kick();
      requestAnimationFrame(() => requestAnimationFrame(() => { if (alive) o.onReady?.(); }));
    });
  }

  /** Each program's first use, a few between frames: three reads its log and its uniforms then, and on a cold shader
   *  cache each one waits on the GPU (30-70 ms a program), which in the first frame drawn adds up to a stall. */
  function warm() {
    const programs = [...(renderer.info.programs ?? [])];
    return new Promise<void>(done => {
      const step = () => {
        if (!alive) return done();
        const t = performance.now();
        while (programs.length && performance.now() - t < 6) programs.shift()!.getUniforms();
        if (programs.length) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }

  /** Every program built before it is drawn, the fans and halos too (hidden, they'd be skipped and built mid-flight). */
  function compileAll() {
    const shown: THREE.Object3D[] = [];
    drone.traverse(c => { if ((c as THREE.InstancedMesh).isInstancedMesh && !c.visible) { c.visible = true; shown.push(c); } });
    return Promise.all([renderer.compileAsync(scene, camera), proxies?.compile(camera)]).finally(() => { for (const c of shown) c.visible = false; });
  }

  /** The rails, from where each piece is: a node rests at least as far out as the one under it. */
  function place() {
    for (const r of rails) {
      r.d = Math.max(r.piece.p * r.dist, r.below ? r.below.d : 0);
      r.node.position.copy(r.home).addScaledVector(r.unit, r.d);
    }
    for (const p of pieces) {
      let e = 0;
      for (const r of p.rails) if (r.dist) e = Math.max(e, r.d / r.dist);
      p.eff = e;
    }
  }

  // ------------------------------------------------------------------------------------------ framing
  // Fitted twice, by the model's outline: whole, and all apart (each from its own angle). The camera goes between the
  // two as the teardown runs; a part pulled by hand doesn't move it.
  type Fit = { d: number; ox: number; oy: number };
  const fits = { whole: { d: 1, ox: 0, oy: 0 } as Fit, apart: { d: 1, ox: 0, oy: 0 } as Fit };
  let width = 1, height = 1, VIEW = VIEWS.wide;
  const dirOf = (az: number, el: number) => new THREE.Vector3(Math.cos(el * DEG) * Math.sin(az * DEG), Math.sin(el * DEG), Math.cos(el * DEG) * Math.cos(az * DEG));
  const q = new THREE.Vector3();
  function fit(points: THREE.Vector3[], view: { az: number; el: number }, r: Region): Fit {
    const dir = dirOf(view.az, view.el);
    camera.clearViewOffset();
    let d = 1;
    const bounds = () => {
      camera.position.copy(dir).multiplyScalar(d);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of points) {
        q.copy(p).project(camera);
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      }
      return { x0, x1, y0, y1 };
    };
    for (let pass = 0; pass < 4 && points.length; pass++) {
      const b = bounds();
      d *= Math.max((b.x1 - b.x0) / (r.x1 - r.x0), (b.y1 - b.y0) / (r.y1 - r.y0));
    }
    const b = bounds();
    // slide the view so the outline's centre lands on the region's (half the NDC difference, in pixels)
    return { d, ox: ((b.x0 + b.x1) / 2 - (r.x0 + r.x1) / 2) * width / 2, oy: -((b.y0 + b.y1) / 2 - (r.y0 + r.y1) / 2) * height / 2 };
  }
  function resize() {
    width = canvas.clientWidth || 1; height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.fov = height > width ? 30 : 26;
    const region = o.region ?? DEFAULT_REGION;
    if (outline.whole.length) {
      VIEW = height > width * 1.1 ? VIEWS.tall : VIEWS.wide;
      fits.whole = fit(outline.whole, VIEW.whole, region(width, height, 0));
      fits.apart = fit(outline.apart, VIEW.apart, region(width, height, 1));
    }
  }
  const ro = new ResizeObserver(() => { resize(); kick(); });
  ro.observe(canvas);
  const lost = (e: Event) => { e.preventDefault(); if (!alive) return; alive = false; cancelAnimationFrame(raf); o.onFail?.(new Error("WebGL context lost")); };
  canvas.addEventListener("webglcontextlost", lost);
  resize();

  // ------------------------------------------------------------------------------------------ hands
  // A mouse: hover draws a part round, drag pulls it along its rail (or turns the model, off a part), click takes it
  // out or puts it back. A finger: tap takes a part out or puts it back, a sideways drag turns the model, and an up
  // or down drag is the page's (the canvas lets the browser scroll: touch-action pan-y).
  let hotPiece: Piece | null = null, hotPart: Part | null = null, listHot: Part | null = null;
  const orbit = { yaw: 0, pitch: 0, vy: 0, vp: 0 };
  type Grab = { id: number; kind: "piece" | "orbit" | "pending"; x: number; y: number; t: number; lx: number; ly: number; lt: number;
    moved: number; touch: boolean; piece: Piece | null; axis: THREE.Vector2; p0: number };
  let grab: Grab | null = null;
  let hoverAt: { x: number; y: number } | null = null, picking = false;
  const local = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const pieceAt = (x: number, y: number) => {
    if (!proxies || !ready) return Promise.resolve(null);
    const job = proxies.pick(camera, (cam, px, py) => {
      const v = cam.view?.enabled ? cam.view : null;
      cam.setViewOffset(width, height, (v?.offsetX ?? 0) + px, (v?.offsetY ?? 0) + py, 1, 1);
      cam.updateProjectionMatrix();
    }, x, y);
    return job ? job.then(i => (alive && i >= 0 && i < owner.length ? owner[i] : null)) : null;
  };
  function setHot(piece: Piece | null) {
    if (piece === hotPiece) return;
    hotPiece = piece;
    const part = piece?.part ?? null;
    if (part !== hotPart) { hotPart = part; o.onHot?.(part?.info.id ?? null); }
    canvas.style.cursor = piece ? (piece.part.info.fixed ? "var(--o-rest, default)" : "grab") : "";
    lit();
  }
  function lit() {
    const set = listHot ? listHot.pieces.flatMap(p => p.meshes) : hotPiece ? hotPiece.meshes : [];
    proxies?.set(set);
    kick();
  }
  function hover() {
    if (!hoverAt || picking || grab) return;
    const at = hoverAt;
    hoverAt = null;
    const job = pieceAt(at.x, at.y);
    if (!job) { hoverAt = at; return; }
    picking = true;
    void job.then(p => { picking = false; if (!grab) setHot(p); if (hoverAt) hover(); });
  }
  function railAxis(piece: Piece) {
    const r = piece.rails.find(x => x.dist) ?? piece.rails[0];
    const parent = r.node.parent!;
    const a = parent.localToWorld(r.home.clone()).project(camera), b = parent.localToWorld(r.home.clone().addScaledVector(r.unit, r.dist)).project(camera);
    const axis = new THREE.Vector2((b.x - a.x) * width / 2, -(b.y - a.y) * height / 2);
    return axis.lengthSq() < 24 * 24 ? new THREE.Vector2(0, -90) : axis;
  }
  const onDown = (e: PointerEvent) => {
    if (!ready || e.button > 0 || grab) return;
    const { x, y } = local(e);
    const touch = e.pointerType !== "mouse";
    const piece = !touch && hotPiece && !hotPiece.part.info.fixed ? hotPiece : null;
    grab = { id: e.pointerId, kind: touch ? "pending" : piece ? "piece" : "orbit", x, y, lx: x, ly: y, lt: performance.now(), t: performance.now(), moved: 0, touch,
      piece, axis: piece ? railAxis(piece) : new THREE.Vector2(), p0: piece ? piece.target : 0 };
    if (!touch) { canvas.setPointerCapture(e.pointerId); canvas.style.cursor = piece ? "grabbing" : "move"; }
  };
  const onMove = (e: PointerEvent) => {
    const { x, y } = local(e);
    if (!grab || grab.id !== e.pointerId) {
      if (e.pointerType === "mouse" && !e.buttons) { hoverAt = { x, y }; kick(); }
      return;
    }
    const dx = x - grab.lx, dy = y - grab.ly, now = performance.now(), gap = Math.max(8, now - grab.lt) / 1000;
    grab.lx = x; grab.ly = y; grab.lt = now;
    grab.moved = Math.max(grab.moved, Math.hypot(x - grab.x, y - grab.y));
    if (grab.kind === "pending" && grab.moved > 8) {
      // a sideways finger turns it; anything else was the page's scroll, which the browser has by now
      if (Math.abs(x - grab.x) > Math.abs(y - grab.y)) { grab.kind = "orbit"; canvas.setPointerCapture(e.pointerId); }
      else { grab = null; return; }
    }
    if (grab.kind === "orbit") {
      orbit.vy = THREE.MathUtils.clamp(dx * 0.0085 / gap, -6, 6); orbit.vp = THREE.MathUtils.clamp(dy * 0.004 / gap, -3, 3);
      orbit.yaw += dx * 0.0085;
      orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + dy * 0.004, -0.45, 0.6);
      kick();
    } else if (grab.kind === "piece" && grab.piece) {
      const a = grab.axis, t = ((x - grab.x) * a.x + (y - grab.y) * a.y) / a.lengthSq();
      let v = clamp01(grab.p0 + t);
      if (v < 0.05) v = 0; else if (v > 0.95) v = 1;          // detents at the seat and at the end of the rail
      grab.piece.override = v;
      grab.piece.target = v;
      kick();
    }
  };
  const onUp = (e: PointerEvent) => {
    const g = grab;
    if (!g || g.id !== e.pointerId) return;
    grab = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = hotPiece ? (hotPiece.part.info.fixed ? "var(--o-rest, default)" : "grab") : "";
    const click = g.moved < 6 && performance.now() - g.t < 600;
    if (performance.now() - g.lt > 90) orbit.vy = orbit.vp = 0;     // held still before letting go: no throw
    if (g.kind === "piece" && g.piece) {
      if (click) flip(g.piece);
      else if (g.piece.target < 0.15 || g.piece.target > 0.85) { g.piece.target = g.piece.override = g.piece.target < 0.5 ? 0 : 1; }
    } else if (click && g.touch) {
      // a tap: find what is under the finger, then take it out or put it back
      const job = pieceAt(g.x, g.y);
      void job?.then(p => {
        if (!alive) return;
        setHot(p);
        if (p && !p.part.info.fixed) flip(p);
      });
    } else if (click && !g.touch) setHot(null);
    kick();
  };
  const onCancel = (e: PointerEvent) => { if (grab?.id === e.pointerId) grab = null; };
  const onLeave = (e: PointerEvent) => { if (e.pointerType === "mouse" && !grab) { hoverAt = null; setHot(null); } };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  function flip(piece: Piece) {
    const v = piece.target > 0.5 ? 0 : 1;
    piece.override = v;
    piece.target = v;
    kick();
  }

  // ------------------------------------------------------------------------------------------ status
  let last: Status | null = null, lastKey = "", powerOn = -1, clock = 0;
  function status(force = false) {
    const byPart: Record<string, number> = {};
    let out = 0;
    for (const p of pieces) if (p.out) { out++; byPart[p.part.info.id] = (byPart[p.part.info.id] ?? 0) + 1; }
    const hasPower = power.every(p => !p.out);
    const whole = out === 0;
    const s: Status = { out, total: pieces.length, parts: byPart, power: hasPower, whole, flying: whole && hasPower && !!flight && !still };
    if (hasPower && powerOn < 0) powerOn = clock;
    if (!hasPower) powerOn = -1;
    const key = `${s.power}${s.flying}${JSON.stringify(byPart)}`;
    if (force || !last || key !== lastKey) { last = s; lastKey = key; o.onStatus?.(s); }
    return s;
  }

  // ------------------------------------------------------------------------------------------ frames
  let apartTarget = 0, apartShown = 0, spool = 0, drift = 0;
  const callouts: Callout[] = [];
  let boxes = new Float32Array(0);
  const v = new THREE.Vector3();
  function draw(now: number) {
    raf = 0;
    if (!alive) return;
    // at most 60 frames a second (a 120 Hz screen gets every other one), 30 while only the lights blink
    if (drawn && now - drawn < pace - 3) { raf = requestAnimationFrame(draw); return; }
    const dt = prev ? Math.min(0.05, (now - prev) / 1000) : 1 / 60;
    prev = now;
    if (!ready || holding) return;
    clock += dt;
    let moving = false;

    // the pieces: a critically damped spring towards where each is meant to be (a little weight, no overshoot),
    // solved exactly, so a long frame can't throw a part off; straight there when still
    for (const p of pieces) {
      if (still) { p.p = p.target; p.v = 0; continue; }
      const w = grab?.piece === p ? 30 : 15;
      const e0 = p.p - p.target, c = p.v + w * e0, k = Math.exp(-w * dt);
      p.p = p.target + (e0 + c * dt) * k;
      p.v = (p.v - w * c * dt) * k;
      if (Math.abs(p.target - p.p) < 1e-4 && Math.abs(p.v) < 1e-3) { p.p = p.target; p.v = 0; } else moving = true;
    }
    place();
    for (const p of pieces) {
      const out = p.out ? p.eff > 0.006 : p.eff > 0.016;
      if (out !== p.out) { p.out = out; o.onSeat?.(!out, p.part.info.id); }
    }
    const s = status();

    // flight: spool up when whole, down otherwise; it hovers while the rotors turn
    const goal = s.flying ? 1 : 0;
    const before = spool;
    spool = still ? 0 : spool + (goal - spool) * (1 - Math.exp(-dt / (goal ? 0.5 : 0.32)));
    if (Math.abs(spool - goal) < 0.002) spool = goal;
    if (Math.abs(spool - before) > 1e-4) o.onSpool?.(spool);
    flight?.step(still ? 0 : dt, spool, s.whole ? 1 : 0);
    lights?.step(s.power ? (still ? 1.2 : clock - powerOn) : -1);
    drift += ((s.flying ? 1 : 0) - drift) * (still ? 1 : 1 - Math.exp(-dt * 1.5));
    if (spool > 0.001 || Math.abs(spool - goal) > 0) moving = true;

    // turning it by hand, with a little inertia
    if (!grab && !still && (Math.abs(orbit.vy) > 0.01 || Math.abs(orbit.vp) > 0.01)) {
      orbit.yaw += orbit.vy * dt;
      orbit.pitch = THREE.MathUtils.clamp(orbit.pitch + orbit.vp * dt, -0.45, 0.6);
      const k = Math.exp(-dt * 5);
      orbit.vy *= k; orbit.vp *= k;
      moving = true;
    } else if (!grab) { orbit.vy = orbit.vp = 0; }
    const h = drift, t = clock;
    drone.position.set(Math.sin(t * 0.37) * 0.004 * h, (Math.sin(t * 1.3) * 0.004 + Math.sin(t * 0.47 + 2) * 0.0025) * h, Math.sin(t * 0.29 + 1) * 0.003 * h);
    drone.rotation.set(orbit.pitch + Math.sin(t * 1.1 + 1) * 0.011 * h, orbit.yaw + Math.sin(t * 0.19) * 0.02 * h, Math.sin(t * 0.9) * 0.016 * h);

    // the camera, between its two framings
    apartShown += (apartTarget - apartShown) * (still ? 1 : 1 - Math.exp(-dt * 6));
    if (Math.abs(apartTarget - apartShown) < 1e-4) apartShown = apartTarget; else moving = true;
    const f = smooth(clamp01(apartShown * 1.6));
    const A = fits.whole, B = fits.apart;
    const az = THREE.MathUtils.lerp(VIEW.whole.az, VIEW.apart.az, f), el = THREE.MathUtils.lerp(VIEW.whole.el, VIEW.apart.el, f);
    const d = A.d * Math.pow(B.d / A.d, f);
    camera.position.copy(dirOf(az, el)).multiplyScalar(d);
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(width, height, THREE.MathUtils.lerp(A.ox, B.ox, f), THREE.MathUtils.lerp(A.oy, B.oy, f), width, height);
    camera.updateProjectionMatrix();
    scene.environmentRotation.y = ENV_YAW + f * 24 * DEG + orbit.yaw * 0.3;
    drone.updateMatrixWorld(true);
    hover();          // picked through this frame's camera

    renderer.render(scene, camera);
    if (proxies?.on) proxies.draw(camera);
    layout(dt) && (moving = true);
    o.onFrame?.(now, pace);
    drawn = now;
    // keep going while anything moves; the lights alone blink at 30 frames a second
    if (moving || grab) { pace = 1000 / 60; raf = requestAnimationFrame(draw); }
    else if (s.power && lights?.count && !still) { pace = 1000 / 30; raf = requestAnimationFrame(draw); }
  }

  /** Each part's number: beside what it points at, out from the middle of the model, clear of the others. */
  function layout(dt: number) {
    callouts.length = 0;
    v.copy(drone.position).applyMatrix4(drone.parent!.matrixWorld).project(camera);
    const cx = (v.x + 1) / 2 * width, cy = (1 - v.y) / 2 * height;
    const narrow = width < 700, R = narrow ? 9 : 11, OFF = narrow ? 22 : 30;
    let fading = false;
    // where each piece is on the screen (its box's corners, projected), for the numbers to keep off the drawing
    let k = 0;
    for (const part of parts) for (const piece of part.pieces) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const b = piece.box, w = piece.rails[0].node.matrixWorld;
      if (b.isEmpty()) { boxes[k++] = 1; boxes[k++] = 1; boxes[k++] = 0; boxes[k++] = 0; continue; }
      for (let c = 0; c < 8; c++) {
        v.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z).applyMatrix4(w).project(camera);
        const px = (v.x + 1) / 2 * width, py = (1 - v.y) / 2 * height;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      boxes[k++] = x0; boxes[k++] = y0; boxes[k++] = x1; boxes[k++] = y1;
    }
    const covered = (x: number, y: number) => {
      let n = 0;
      for (let i = 0; i < k; i += 4) if (x > boxes[i] - R && x < boxes[i + 2] + R && y > boxes[i + 1] - R && y < boxes[i + 3] + R) n++;
      return n;
    };
    for (const part of parts) {
      const hot = part === listHot || part === hotPart;
      let anchor: Piece | null = hot ? (hotPiece?.part === part ? hotPiece : part.pieces[part.label]) : null;
      if (!anchor && !part.info.fixed) anchor = part.pieces[part.label].eff > 0.3 ? part.pieces[part.label] : part.pieces.find(p => p.eff > 0.3) ?? null;
      const want = anchor ? (hot ? 1 : smooth(clamp01((anchor.eff - 0.3) / 0.4))) : 0;
      part.a += (want - part.a) * (still ? 1 : 1 - Math.exp(-dt * 12));
      if (Math.abs(want - part.a) > 0.002) fading = true; else part.a = want;
      if (part.a < 0.01 && !anchor) { part.placed = false; continue; }
      const piece = anchor ?? part.pieces[part.label];
      v.copy(piece.anchor).applyMatrix4(piece.rails[0].node.matrixWorld).project(camera);
      const ax = (v.x + 1) / 2 * width, ay = (1 - v.y) / 2 * height;
      // out from the middle of the model, or turned off that line, or further out, whichever covers fewest pieces
      // (it keeps its last choice unless another is clearly better, so a number doesn't flick between two)
      const base = Math.atan2(ay - cy, ax - cx);
      let best = part.turn, bestScore = Infinity;
      for (const turn of TURNS) {
        const a = base + turn[0] * 0.42, d = OFF + R + turn[1];
        const x = ax + Math.cos(a) * d, y = ay + Math.sin(a) * d;
        let score = covered(x, y) + Math.abs(turn[0]) * 0.3 + turn[1] * 0.012;
        if (x < R + 6 || x > width - R - 6 || y < R + 6 || y > height - R - 6) score += 4;
        if (turn === part.turn) score -= 0.6;
        if (score < bestScore) { bestScore = score; best = turn; }
      }
      part.turn = best;
      const a = base + best[0] * 0.42, d = OFF + R + best[1];
      callouts.push({ id: part.info.id, n: part.info.n, ax, ay, x: ax + Math.cos(a) * d, y: ay + Math.sin(a) * d, r: R, a: part.a, hot });
    }
    // push apart any two that touch, then keep them on the canvas
    const gap = 2 * R + 5;
    for (let it = 0; it < 10; it++) {
      for (let i = 0; i < callouts.length; i++) for (let j = i + 1; j < callouts.length; j++) {
        const a = callouts[i], b = callouts[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const dd = Math.hypot(dx, dy);
        if (dd >= gap) continue;
        if (dd < 1e-3) { dx = 1; dy = 0; } else { dx /= dd; dy /= dd; }
        const push = (gap - dd) / 2;
        a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push;
      }
      for (const c of callouts) { c.x = THREE.MathUtils.clamp(c.x, R + 6, width - R - 6); c.y = THREE.MathUtils.clamp(c.y, R + 6, height - R - 6); }
    }
    // and ease each towards its place, so a crossing glides
    for (const c of callouts) {
      const part = parts.find(p => p.info.id === c.id)!;
      if (!part.placed || still) { part.cx = c.x; part.cy = c.y; part.placed = true; }
      else { const k = 1 - Math.exp(-dt * 16); part.cx += (c.x - part.cx) * k; part.cy += (c.y - part.cy) * k; }
      if (Math.abs(c.x - part.cx) > 0.3 || Math.abs(c.y - part.cy) > 0.3) fading = true;
      c.x = part.cx; c.y = part.cy;
    }
    o.onCallouts?.(callouts);
    return fading;
  }

  function kick() { pace = 1000 / 60; if (!raf && alive) raf = requestAnimationFrame(draw); }
  const onVisible = () => { prev = 0; if (!document.hidden) kick(); };
  document.addEventListener("visibilitychange", onVisible);

  /** Where the teardown puts each piece: part by part in order, a part's pieces one after another. */
  function teardown(x: number) {
    const steps = Math.max(1, ...pieces.map(p => p.part.info.step));
    const u = clamp01(x) * steps;
    for (const p of pieces) {
      const k = p.part.info.step - 1, n = p.part.pieces.length;
      const start = k + (n > 1 ? (p.index / (n - 1)) * 0.4 : 0), len = n > 1 ? 0.6 : 1;
      const s = smooth(clamp01((u - start) / len));
      if (Math.abs(s - p.scroll) > 1e-5) {
        p.scroll = s;
        p.override = null;
      }
      p.target = p.override ?? p.scroll;
    }
  }

  return {
    renderer,
    apart(x) { apartTarget = clamp01(x); teardown(x); kick(); },
    toggle(id, index) {
      const part = parts.find(p => p.info.id === id);
      if (!part || part.info.fixed) return;
      const list = index === undefined ? part.pieces : [part.pieces[index]].filter(Boolean);
      const v = list.some(p => p.target > 0.5) ? 0 : 1;
      for (const p of list) { p.override = v; p.target = v; }
      kick();
    },
    hot(id) { listHot = parts.find(p => p.info.id === id) ?? null; lit(); },
    setStill(on) { still = on; prev = 0; status(true); kick(); },
    setPixelRatio(dpr) { renderer.setPixelRatio(dpr); resize(); kick(); },
    refit() { resize(); kick(); },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisible);
      flight?.dispose();
      lights?.dispose();
      proxies?.dispose();
      scene.traverse(n => { const m = n as THREE.Mesh; if (m.isMesh) m.geometry?.dispose(); });
      for (const m of Object.values(mats)) m.dispose();
      env?.dispose();
      pmrem.dispose();
      draco.dispose();
      renderer.dispose();
      renderer.forceContextLoss();    // dispose() keeps the context until the canvas is collected
    },
  };
}
