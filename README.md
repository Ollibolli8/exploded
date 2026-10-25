# Exploded

A drone that comes apart in your hands. Terne X is drawn the way a parts catalogue draws a machine: thirty parts, each
numbered in the order it comes off the airframe and sized from the model. Scroll and it comes apart part by part; pull
any part out or push it back yourself. It only flies when every part is back.

**[Live demo](https://ollibolli8.github.io/exploded/)** · Maquette 05 on [work.draindk.tech](https://work.draindk.tech/lab/exploded/)

three.js in six TypeScript files (the engine, the parts, the flight, the ink, the numbers, the sound), about 30 KB
minified on top of three.js. Drop any `.glb` on the demo and it comes apart by its shape.

## How it works

- **Parts and rails** (`src/parts.ts`): a part is one row of the list (the battery, a propeller blade, an arm), with
  one or more pieces (the drone has eight blades). Each piece slides on a rail in its parent's space, an offset or an
  axis of its own node and a distance, so an arm pulls straight out of its socket. A part can rest on another: the
  deck sits on the heat sink, which sits on the flight board, so pulling the board pushes both (`d = max(own, below)`).
  Sizes are measured, not typed: every vertex of the part in its own frame, in whole millimetres, one decimal under 10.
  Any other model gets a spec from its shape (`autoSpec`): each mesh moves straight out from the middle, the furthest
  out first.
- **The teardown** (`apart(0..1)`, from the page's scroll): parts come off in their order, a part's pieces one after
  another. A part moved by hand keeps its place until the scroll passes over it again. Each piece follows a critically
  damped spring, solved exactly, so a long frame can't throw a part off the page.
- **Hands:** a mouse hovers (a GPU pick: each mesh has a stand-in drawn in an id colour into a one-pixel target, read
  back without stalling), drags a part along its rail's line on the screen (detents at both ends) or clicks it out and
  back. A finger taps a part out or back, drags sideways to turn the drone, and an up or down drag scrolls the page.
- **Ink** (`src/outline.ts`): the part under the pointer is drawn round. Its stand-ins go into a mask at the canvas's
  own pixels, multisampled as the drawing is and only over the box the part fills, twice, depth-tested against the
  rest and not, and one pass draws the edge as a pen would, half outside and half in: solid where it shows, dashed
  where it runs on behind other parts.
- **Numbers** (`src/callouts.ts`): every part that is out carries its number on a leader, out from the middle of the
  drawing, turned off that line or further out if that covers fewer parts, then pushed clear of the other numbers.
  They are SVG over the canvas, so they take the page's type.
- **Flight** (`src/flight.ts`): with the battery in, the navigation lights boot and blink; with every part in, the
  rotors spool up (blades drawn as ghosts over a 1/24 s exposure) and it hovers. Take anything out and it spools down.
- **Sound** (`src/sound.ts`, off until turned on): synthesized, no samples. A part clicks as it leaves its seat and
  knocks as it goes back (noise rung through two resonances); the rotors hum at their blade-pass frequency.

Two framings are fitted to the model's outline (whole, a little above the nose; apart, higher, so the stack reads; on
a tall screen higher still), each into a region the page gives, and the camera moves between them as it comes apart.
Capped at 60 fps, 30 while only the lights blink, nothing drawn while nothing moves; parts jump straight to their
places when motion is reduced. Without WebGL 2 `createExploded` throws, and a model that won't load or a lost context
calls `onFail`: either way the page shows its still.

## Use it

```ts
import { createExploded } from "./src/core";
import { createCallouts } from "./src/callouts";

const numbers = createCallouts(document.querySelector("svg"));
const drone = createExploded({
  canvas: document.querySelector("canvas"),
  model: "terne.glb",           // any glTF; terne.glb comes with its spec
  draco: "draco/",              // DRACOLoader's decoder
  still: matchMedia("(prefers-reduced-motion: reduce)").matches,
  onParts: (parts, whole) => { /* the list: number, name, count, size in mm */ },
  onStatus: s => { /* parts out, power, whole, flying */ },
  onCallouts: c => numbers.update(c),
});
addEventListener("scroll", () => drone.apart(scrollY / (document.body.scrollHeight - innerHeight)));
```

`toggle(part)` pulls a part out or pushes it back (the list's buttons), `hot(part)` draws it round (the list's rows),
`region` tells it where on the canvas the drawing goes, whole and apart. For a model of your own, pass a `spec`;
for your own light, `environment` (and `textures` for maps you lay on, such as baked AO): the first compile waits for
both, so no material is built again once it is live.

## Build the demo

```sh
npm install
npm run build   # docs/ (GitHub Pages)
npm run dev     # build and serve
npm run check   # types
npm test        # the spec against the model (Node 22.18 or later)
```

The tests read `terne.glb`'s node tree and check the spec against it: every node it names is in the model, a node
rests only on one with the same parent and along the same rail (or core.ts would quietly skip it), the steps run
without a gap; and the parts module's measuring and naming. GitHub runs them on every push, with the types, the build
and a check that `docs/` is the build of this source (`.github/workflows/check.yml`).

## Licence

MIT, Oliver Kure Olsen, 2026. Terne X (`demo/public/terne.glb`) is Oliver's own model from the Terne X case on
work.draindk.tech, under the same licence. The Draco decoder in `docs/draco/` is Google's, Apache 2.0.
