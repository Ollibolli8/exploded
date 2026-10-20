import type { Callout } from "./core";

/**
 * The numbers on the drawing: for each part out, a circle with its number and a leader line to what it names, drawn
 * into an SVG laid over the canvas (it takes the page's own type). Style it by class: `xp-callout` (the group, with
 * `data-hot` on the one under the pointer), and its `line`, `circle` (the end of the leader is a small circle too) and
 * `text`.
 */
export function createCallouts(svg: SVGSVGElement) {
  const NS = "http://www.w3.org/2000/svg";
  const groups = new Map<string, { g: SVGGElement; line: SVGLineElement; dot: SVGCircleElement; ring: SVGCircleElement; text: SVGTextElement; seen: boolean }>();
  return {
    update(list: Callout[]) {
      for (const it of groups.values()) it.seen = false;
      for (const c of list) {
        let it = groups.get(c.id);
        if (!it) {
          const g = document.createElementNS(NS, "g");
          g.setAttribute("class", "xp-callout");
          const line = document.createElementNS(NS, "line"), dot = document.createElementNS(NS, "circle"), ring = document.createElementNS(NS, "circle"), text = document.createElementNS(NS, "text");
          dot.setAttribute("class", "xp-callout-dot");
          dot.setAttribute("r", "1.75");
          ring.setAttribute("class", "xp-callout-ring");
          text.setAttribute("text-anchor", "middle");
          text.setAttribute("dominant-baseline", "central");
          text.textContent = c.n;
          g.append(line, dot, ring, text);
          svg.append(g);
          it = { g, line, dot, ring, text, seen: true };
          groups.set(c.id, it);
        }
        it.seen = true;
        const dx = c.x - c.ax, dy = c.y - c.ay, l = Math.hypot(dx, dy) || 1;
        it.line.setAttribute("x1", c.ax.toFixed(1)); it.line.setAttribute("y1", c.ay.toFixed(1));
        it.line.setAttribute("x2", (c.x - (dx / l) * c.r).toFixed(1)); it.line.setAttribute("y2", (c.y - (dy / l) * c.r).toFixed(1));
        it.dot.setAttribute("cx", c.ax.toFixed(1)); it.dot.setAttribute("cy", c.ay.toFixed(1));
        it.ring.setAttribute("cx", c.x.toFixed(1)); it.ring.setAttribute("cy", c.y.toFixed(1)); it.ring.setAttribute("r", String(c.r));
        it.text.setAttribute("x", c.x.toFixed(1)); it.text.setAttribute("y", c.y.toFixed(1));
        it.g.style.opacity = c.a.toFixed(3);
        if (c.hot) it.g.setAttribute("data-hot", ""); else it.g.removeAttribute("data-hot");
        it.g.style.display = "";
      }
      for (const it of groups.values()) if (!it.seen) it.g.style.display = "none";
    },
    clear() { for (const it of groups.values()) it.g.remove(); groups.clear(); },
  };
}
