import * as THREE from "three";

/**
 * The part under the pointer, drawn as a technical drawing draws it: a solid ink line round what you can see of it,
 * dashed where it runs on behind other parts (a hidden line). It also finds that part: every mesh has a stand-in here
 * in a flat colour of its own, and the one pixel under the pointer, drawn in those colours, names it.
 *
 * The line is a mask at the canvas's own pixels, multisampled as the drawing is, over only the box the part fills on
 * the screen: the scene's depth, then the part drawn twice, once where it is in front (red) and once everywhere
 * (green). A pass over that box draws ink along the mask's edges, half outside and half in, as a pen would (the mask
 * grown by half the line, less the mask shrunk by half), so both sides of the line keep the samples' smoothing and
 * it covers the part's own soft edge; where only green ends, the edge is behind something, and the ink is dashed.
 */
const INK_VERT = /* glsl */`
uniform vec4 uRect;          // the box drawn over, in clip space: left, bottom, right, top
void main() { gl_Position = vec4(mix(uRect.xy, uRect.zw, position.xy), 0.0, 1.0); }`;
const INK_FRAG = /* glsl */`
uniform sampler2D tMask;
uniform vec2 uOrigin, uTexel, uLo, uHi;
uniform vec3 uInk;
uniform float uHalf, uDash, uOpacity;
vec2 at(vec2 uv) { return texture2D(tMask, clamp(uv, uLo, uHi)).rg; }   // what the mask has drawn, nothing older
void main() {
  vec2 uv = (gl_FragCoord.xy - uOrigin) * uTexel;
  vec2 c = at(uv), grown = c, shrunk = c;
  // the most and least of the mask half a line out: on a circle that far (12 ways) and halfway (6)
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.523599;
    vec2 n = at(uv + vec2(cos(a), sin(a)) * uHalf * uTexel);
    grown = max(grown, n); shrunk = min(shrunk, n);
  }
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.047198 + 0.261799;
    vec2 n = at(uv + vec2(cos(a), sin(a)) * 0.5 * uHalf * uTexel);
    grown = max(grown, n); shrunk = min(shrunk, n);
  }
  vec2 e = grown - shrunk;
  // the dash: stripes across the screen, each end smoothed over a pixel
  float t = mod(gl_FragCoord.x + gl_FragCoord.y, uDash), on = 0.42 * uDash;
  float dash = clamp(0.5 + 0.5 * (t >= on ? min(t - on, uDash - t) : -min(on - t, t)), 0.0, 1.0);
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
  // Two channels, grown to the largest box drawn yet (in steps of 256 px, at most the canvas), never per frame; its
  // depth is only for the passes, neither resolved nor kept. The three passes are one render, since three resolves a
  // multisampled target after each and lets its samples go.
  const mask = Object.assign(new THREE.WebGLRenderTarget(512, 512, { format: THREE.RGFormat, depthBuffer: true, samples: Math.min(4, renderer.capabilities.maxSamples),
    resolveDepthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }), { scissorTest: true, storeMultisampledDepthBuffer: false });
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  const front = new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  const whole = new THREE.MeshBasicMaterial({ color: 0x00ff00, toneMapped: false, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  // every stand-in thrice: its depth (opaque, so drawn first), and for the lit ones the two transparent passes
  const maskScene = new THREE.Scene();
  maskScene.matrixWorldAutoUpdate = false;
  const passes = proxies.map(p => [depthOnly, front, whole].map(m => {
    const x = new THREE.Mesh(p.geometry, m);
    x.matrixAutoUpdate = false;
    x.frustumCulled = false;
    x.matrixWorld = p.matrixWorld;          // the same matrix, synced once
    maskScene.add(x);
    return x;
  }));
  const inkMat = new THREE.ShaderMaterial({
    vertexShader: INK_VERT, fragmentShader: INK_FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { tMask: { value: mask.texture }, uRect: { value: new THREE.Vector4() }, uOrigin: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() }, uLo: { value: new THREE.Vector2() }, uHi: { value: new THREE.Vector2() },
      uInk: { value: new THREE.Vector3(...ink) }, uHalf: { value: 1 }, uDash: { value: 9 }, uOpacity: { value: 1 } },
  });
  const quad = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], 3)), inkMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const lit = new Set<number>();
  const size = new THREE.Vector2();
  const clear = new THREE.Color();
  const corner = new THREE.Vector4();
  const mvp = new THREE.Matrix4();

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

  /** The box the lit stand-ins fill on the canvas (drawing-buffer px from the top left), all of it if one reaches
   *  behind the camera, or null if none is shown. */
  function bounds(cam: THREE.Camera, w: number, h: number) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of lit) {
      const p = proxies[i];
      if (!p?.userData.on) continue;
      const g = p.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox!;
      mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(p.matrixWorld);
      for (let k = 0; k < 8; k++) {
        corner.set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z, 1).applyMatrix4(mvp);
        if (corner.w < 1e-6) return { x0: 0, y0: 0, x1: w, y1: h };
        const x = (corner.x / corner.w + 1) / 2 * w, y = (1 - corner.y / corner.w) / 2 * h;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return x1 < x0 ? null : { x0, y0, x1, y1 };
  }

  return {
    /** Index of the mesh at this point of the canvas (CSS px), or -1; `view` sets the camera to look at one pixel. */
    pick(cam: THREE.PerspectiveCamera, view: (cam: THREE.PerspectiveCamera, x: number, y: number) => void, x: number, y: number): Promise<number> | null {
      if (busy) return null;
      busy = true;
      sync();
      for (const p of proxies) p.visible = p.userData.on;
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
    draw(cam: THREE.PerspectiveCamera) {
      if (!lit.size) return;
      sync();
      renderer.getDrawingBufferSize(size);
      const w = size.x, h = size.y, dpr = renderer.getPixelRatio();
      const box = bounds(cam, w, h);
      if (!box) return;
      // the box, with room round it for the line, its smoothing and the samples it reads
      const m = 2 * Math.ceil(dpr) + 2;
      const x0 = Math.max(0, Math.floor(box.x0) - m), y0 = Math.max(0, Math.floor(box.y0) - m);
      const x1 = Math.min(w, Math.ceil(box.x1) + m), y1 = Math.min(h, Math.ceil(box.y1) + m);
      const rw = x1 - x0, rh = y1 - y0;
      if (rw <= 0 || rh <= 0) return;
      const step = (n: number, max: number) => Math.min(max, Math.ceil(n / 256) * 256);
      if (rw > mask.width || rh > mask.height) mask.setSize(Math.max(mask.width, step(rw, w)), Math.max(mask.height, step(rh, h)));
      mask.viewport.set(0, 0, rw, rh);
      mask.scissor.set(0, 0, rw, rh);
      for (let i = 0; i < proxies.length; i++) {
        const on = proxies[i].userData.on as boolean, l = on && lit.has(i);
        passes[i][0].visible = on; passes[i][1].visible = l; passes[i][2].visible = l;
      }
      // the camera looks at the box alone, a mask pixel to a canvas pixel
      const v = cam.view?.enabled ? { ...cam.view } : null, aspect = cam.aspect;
      const sx = (v ? v.width : w) / w, sy = (v ? v.height : h) / h;
      const a = renderer.getClearAlpha(), auto = renderer.autoClear;
      renderer.getClearColor(clear);
      try {
        cam.setViewOffset(v ? v.fullWidth : w, v ? v.fullHeight : h, (v?.offsetX ?? 0) + x0 * sx, (v?.offsetY ?? 0) + y0 * sy, rw * sx, rh * sy);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = false;
        renderer.setRenderTarget(mask);
        renderer.clear();
        renderer.render(maskScene, cam);
      } finally {
        if (v) cam.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height);
        else cam.clearViewOffset();
        cam.aspect = aspect;
        cam.updateProjectionMatrix();
        renderer.setRenderTarget(null);
        renderer.setClearColor(clear, a);
        renderer.autoClear = auto;
      }
      const u = inkMat.uniforms, tw = mask.width, th = mask.height;
      u.uRect.value.set(2 * x0 / w - 1, 1 - 2 * y1 / h, 2 * x1 / w - 1, 1 - 2 * y0 / h);
      u.uOrigin.value.set(x0, h - y1);
      u.uTexel.value.set(1 / tw, 1 / th);
      u.uLo.value.set(0.5 / tw, 0.5 / th);
      u.uHi.value.set((rw - 0.5) / tw, (rh - 0.5) / th);
      u.uHalf.value = Math.max(2, dpr) / 2;   // two canvas pixels wide, or a CSS pixel on a denser screen: the weight it always had
      u.uDash.value = 9 * dpr;
      renderer.autoClear = false;
      renderer.render(quadScene, cam);
      renderer.autoClear = auto;
    },
    /** Builds every program here before the first use. */
    compile(cam: THREE.Camera) {
      // a program depends on the target it draws into (compile reads the one bound now); binding the mask also makes
      // its buffers, so the first hover doesn't
      const jobs: Promise<unknown>[] = [];
      const was = renderer.getRenderTarget();
      renderer.setRenderTarget(mask);
      jobs.push(renderer.compileAsync(maskScene, cam));
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
