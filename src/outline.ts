import * as THREE from "three";

/**
 * The part under the pointer, drawn as a technical drawing draws it: a solid ink line round what you can see of it,
 * dashed where it runs on behind other parts (a hidden line). It also finds that part: every mesh has a stand-in here
 * in a flat colour of its own, and the one pixel under the pointer, drawn in those colours, names it.
 *
 * The line is a mask a CSS pixel a texel (half the canvas or less): the scene's depth, then the part drawn twice, once where it is in
 * front (red) and once everywhere (green). A pass over the screen draws ink where either channel changes; where only
 * green changes, the edge is behind something, and the ink is dashed.
 */
const FULL_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const INK_FRAG = /* glsl */`
uniform sampler2D tMask;
uniform vec2 uTexel;
uniform vec3 uInk;
uniform float uDash, uOpacity;
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tMask, vUv).rg;
  vec2 e = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 n = texture2D(tMask, vUv + vec2(cos(a), sin(a)) * uTexel).rg;
    e = max(e, n - c);        // just outside the shape, so the line is one texel wide
  }
  float dash = step(0.42, fract((gl_FragCoord.x + gl_FragCoord.y) / uDash));
  float a = max(e.r, e.g * (1.0 - e.r) * dash * 0.7);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uInk, a * uOpacity);
}`;

export type Proxies = ReturnType<typeof createProxies>;

/** `ink`: the line's colour, sRGB 0..1. */
export function createProxies(renderer: THREE.WebGLRenderer, meshes: THREE.Mesh[], ink: [number, number, number]) {
  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;
  const proxies = meshes.map((src, i) => {
    const id = i + 1;
    // written to the target as is (linear in, linear out), so the pixel's bytes are the id
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255, THREE.LinearSRGBColorSpace), toneMapped: false });
    const p = new THREE.Mesh(src.geometry, mat);
    p.matrixAutoUpdate = false;
    p.frustumCulled = false;
    scene.add(p);
    return p;
  });
  const shown = (o: THREE.Object3D | null): boolean => !o || (o.visible && shown(o.parent));
  const sync = () => {
    for (let i = 0; i < proxies.length; i++) { proxies[i].matrixWorld.copy(meshes[i].matrixWorld); proxies[i].userData.on = shown(meshes[i]); }
  };

  // ------------------------------------------------------------------------------------------ picking
  const pickTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  const px = new Uint8Array(4);
  let busy = false;

  // ------------------------------------------------------------------------------------------ the line
  const mask = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  const front = new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const whole = new THREE.MeshBasicMaterial({ color: 0x00ff00, toneMapped: false, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const inkMat = new THREE.ShaderMaterial({
    vertexShader: FULL_VERT, fragmentShader: INK_FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { tMask: { value: mask.texture }, uTexel: { value: new THREE.Vector2() }, uInk: { value: new THREE.Vector3(...ink) }, uDash: { value: 9 }, uOpacity: { value: 1 } },
  });
  const quad = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)), inkMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const lit = new Set<number>();
  const size = new THREE.Vector2();
  const clear = new THREE.Color();

  function draw(target: THREE.WebGLRenderTarget | null, cam: THREE.Camera) {
    const a = renderer.getClearAlpha();
    renderer.getClearColor(clear);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, a);
  }

  return {
    /** Index of the mesh at this point of the canvas (CSS px), or -1; `view` sets the camera to look at one pixel. */
    pick(cam: THREE.PerspectiveCamera, view: (cam: THREE.PerspectiveCamera, x: number, y: number) => void, x: number, y: number): Promise<number> | null {
      if (busy) return null;
      busy = true;
      sync();
      for (const p of proxies) p.visible = p.userData.on;
      scene.overrideMaterial = null;
      const saved = cam.view?.enabled ? { ...cam.view } : null;
      try {
        view(cam, x, y);
        draw(pickTarget, cam);
      } catch {
        busy = false;          // a pick that fails leaves the next one free to run
        return null;
      } finally {
        if (saved) cam.setViewOffset(saved.fullWidth, saved.fullHeight, saved.offsetX, saved.offsetY, saved.width, saved.height);
        else cam.clearViewOffset();
        cam.updateProjectionMatrix();
      }
      return renderer.readRenderTargetPixelsAsync(pickTarget, 0, 0, 1, 1, px)
        .then(() => ((px[0] << 16) | (px[1] << 8) | px[2]) - 1)
        .catch(() => -1)
        .finally(() => { busy = false; });
    },
    /** The meshes to draw the line round (indices), or none. */
    set(indices: Iterable<number>) { lit.clear(); for (const i of indices) lit.add(i); },
    get on() { return lit.size > 0; },
    set opacity(o: number) { inkMat.uniforms.uOpacity.value = o; },
    /** Draws the line over what is on the screen. */
    draw(cam: THREE.Camera) {
      if (!lit.size) return;
      renderer.getDrawingBufferSize(size);
      // a texel a CSS pixel (at most half the canvas): the line is a pixel wide at any density
      const k = Math.max(2, renderer.getPixelRatio());
      const w = Math.max(1, Math.round(size.x / k)), h = Math.max(1, Math.round(size.y / k));
      if (mask.width !== w || mask.height !== h) mask.setSize(w, h);
      inkMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      inkMat.uniforms.uDash.value = 9 * renderer.getPixelRatio();
      sync();
      // the depth of everything, then the part where it is in front, then all of it
      for (const p of proxies) p.visible = p.userData.on;
      scene.overrideMaterial = depthOnly;
      draw(mask, cam);
      proxies.forEach((p, i) => (p.visible = p.userData.on && lit.has(i)));
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(mask);
      scene.overrideMaterial = front;
      renderer.render(scene, cam);
      scene.overrideMaterial = whole;
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      renderer.render(quadScene, cam);
      renderer.autoClear = auto;
      scene.overrideMaterial = null;
    },
    /** Builds every program here before the first use. */
    compile(cam: THREE.Camera) {
      // a program depends on the target it draws into (compile reads the one bound now), and compile ignores a
      // scene's override material, so the mask's three are compiled on stand-ins of their own
      const jobs: Promise<unknown>[] = [];
      const passes = new THREE.Scene();
      if (proxies[0]) for (const m of [depthOnly, front, whole]) { const x = new THREE.Mesh(proxies[0].geometry, m); x.frustumCulled = false; passes.add(x); }
      const was = renderer.getRenderTarget();
      renderer.setRenderTarget(mask);
      jobs.push(renderer.compileAsync(passes, cam));
      renderer.setRenderTarget(pickTarget);
      jobs.push(renderer.compileAsync(scene, cam));
      renderer.setRenderTarget(null);
      jobs.push(renderer.compileAsync(quadScene, cam));
      renderer.setRenderTarget(was);
      return Promise.all(jobs.map(j => j.catch(() => {})));
    },
    dispose() {
      for (const p of proxies) (p.material as THREE.Material).dispose();
      pickTarget.dispose(); mask.dispose(); depthOnly.dispose(); front.dispose(); whole.dispose(); inkMat.dispose(); quad.geometry.dispose();
    },
  };
}
