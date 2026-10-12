// Smoke test: runs js/app.js in Node against a fake DOM and a fake WebGL context, to catch runtime errors in the
// state machine and every drawing path (it cannot judge how anything looks).
const noop = () => {};
const proxyGL = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({}))) , set: (t, k, v) => { t[k] = v; return true; } });
const stubEl = (id) => {
  const e = {
    id, value: "", checked: true, hidden: false, disabled: false, textContent: "", innerHTML: "", dataset: {}, style: {}, max: "0",
    width: 0, height: 0, children: [], onclick: null, oninput: null, onchange: null,
    addEventListener: noop, setAttribute: noop, setPointerCapture: noop, scrollIntoView: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
    getContext: (k) => (k === "webgl" ? proxyGL() : new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } })),
    matches: () => false,
  };
  return e;
};
const els = {};
globalThis.document = {
  getElementById: (id) => (els[id] ??= stubEl(id)),
  querySelectorAll: () => [], activeElement: null,
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.ResizeObserver = class { constructor(f) { this.f = f; } observe() {} };
globalThis.devicePixelRatio = 2;
globalThis.history = { replaceState: noop };
globalThis.location = { hash: "", pathname: "/", search: "" };
globalThis.addEventListener = noop;
let raf = null;
globalThis.requestAnimationFrame = (f) => { raf = f; };
globalThis.WorkerBlocked = true;     // no Worker in Node -> the app must use its main-thread fallback

await import("../js/app.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let now = 0, frames = 0;
async function run(seconds) {
  for (let i = 0; i < seconds * 60; i++) { now += 1000 / 60; const f = raf; raf = null; if (f) { f(now); frames++; } if (i % 20 === 0) await sleep(5); }
}
await run(3);                        // initial animation
console.log("after 3 s: caption =", JSON.stringify(els.caption.textContent));
for (const id of ["sLen", "sStep", "sBuilt", "sMoves", "sRef"]) console.log(" ", id, "=", els[id].textContent);
await sleep(2500); await run(20);    // let the animation and the reference search finish
console.log("late: caption =", JSON.stringify(els.caption.textContent));
console.log(" ", "sRef =", els.sRef.textContent, "| sGap =", els.sGap.textContent, "| sShared =", els.sShared.textContent);
console.log("frames drawn:", frames);
