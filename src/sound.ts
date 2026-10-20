/**
 * The drone, heard. A part clicks as it leaves its seat and knocks as it goes back in: a short burst of noise rung
 * through two resonances (a small plastic or metal part), lower and fuller for a seat. Whole, the rotors hum: their
 * blade-pass frequency (two blades, twice the turns a second), the harmonics of a sawtooth and the rush of the air.
 */
export type Sound = { start: () => void; stop: () => void; click: (seated: boolean) => void; spool: (s: number) => void; close: () => void };

const RPM = 6300;

export function createSound(): Sound {
  let ctx: AudioContext | null = null, on = false, level = 0, lastClick = 0;
  let nodes: { master: GainNode; tone: GainNode; oscs: OscillatorNode[]; air: GainNode; noise: AudioBuffer } | null = null;

  function build(c: AudioContext) {
    const master = c.createGain();
    master.gain.value = 0;
    master.connect(c.destination);
    const tone = c.createGain();
    tone.gain.value = 0;
    const soft = c.createBiquadFilter();
    soft.type = "lowpass"; soft.frequency.value = 1400; soft.Q.value = 0.7;
    tone.connect(soft).connect(master);
    // four rotors never turn at quite one speed
    const oscs = [0.996, 1.004].map(k => {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = 0;
      (o as OscillatorNode & { k: number }).k = k;
      o.connect(tone);
      o.start();
      return o;
    });
    const len = c.sampleRate * 2, noise = c.createBuffer(1, len, c.sampleRate), d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = noise; src.loop = true;
    const band = c.createBiquadFilter();
    band.type = "bandpass"; band.frequency.value = 900; band.Q.value = 0.6;
    const air = c.createGain();
    air.gain.value = 0;
    src.connect(band).connect(air).connect(master);
    src.start();
    return { master, tone, oscs, air, noise };
  }

  function apply(fade = 0.08) {
    if (!ctx || !nodes) return;
    const t = ctx.currentTime;
    const bpf = (2 * RPM * level) / 60;
    for (const o of nodes.oscs) o.frequency.setTargetAtTime(bpf * (o as OscillatorNode & { k: number }).k, t, fade / 2);
    const audible = Math.min(1, Math.max(0, (bpf - 25) / 40));
    nodes.tone.gain.setTargetAtTime(0.1 * Math.pow(level, 1.4) * audible, t, fade);
    nodes.air.gain.setTargetAtTime(0.06 * Math.pow(level, 1.4), t, fade);
    nodes.master.gain.setTargetAtTime(on ? 0.9 : 0, t, on ? 0.12 : 0.06);
  }

  return {
    start() {
      if (!ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AC();
        nodes = build(ctx);
      }
      void ctx.resume();
      on = true;
      apply(0.02);
    },
    stop() { on = false; apply(); },
    spool(s) { level = s; if (on) apply(); },
    click(seated) {
      if (!ctx || !nodes || !on) return;
      const t = ctx.currentTime;
      if (t - lastClick < 0.03) return;          // a run of them (the teardown at speed) reads as a ratchet, not a roar
      lastClick = t;
      const src = ctx.createBufferSource();
      src.buffer = nodes.noise;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(seated ? 0.5 : 0.32, t + 0.0015);
      env.gain.exponentialRampToValueAtTime(0.0005, t + (seated ? 0.07 : 0.045));
      const out = ctx.createGain();
      out.gain.value = 1;
      for (const [f, q, g] of seated ? [[1150, 9, 0.9], [2900, 14, 0.5]] : [[2400, 12, 0.7], [5200, 16, 0.4]]) {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = f * (0.96 + Math.random() * 0.08); bp.Q.value = q;
        const k = ctx.createGain();
        k.gain.value = g;
        env.connect(bp).connect(k).connect(out);
      }
      src.connect(env);
      out.connect(nodes.master);
      src.start(t, Math.random() * 1.5, 0.09);
      src.onended = () => { src.disconnect(); out.disconnect(); };
    },
    close() { void ctx?.close(); ctx = null; nodes = null; },
  };
}
