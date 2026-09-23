const fs = require("fs");
const vm = require("vm");

function makeElStub() {
  return {
    textContent: "", innerHTML: "",
    style: { opacity: "", width: "" },
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
  };
}
function makeCtxStub() {
  return new Proxy({}, {
    get(t, p) {
      if (p === "createRadialGradient" || p === "createLinearGradient") return () => ({ addColorStop() {} });
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

const src = fs.readFileSync("/tmp/game_hooked.js", "utf8");
const windowObj = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener() {} };
const canvasStub = { getContext() { return makeCtxStub(); }, style: {}, width: 1280, height: 720 };
const documentStub = {
  getElementById(id) { return id === "game-canvas" ? canvasStub : makeElStub(); },
  createElement() { return makeElStub(); },
  addEventListener() {},
};
const sandbox = {
  window: windowObj, document: documentStub, devicePixelRatio: 1,
  requestAnimationFrame: () => 0, performance: { now: () => Date.now() },
  console, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, Math,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "bounceorb.js" });
const dbg = sandbox.window.__dbg;

const levelName = process.argv[2];
const idx = dbg.LEVELS.findIndex(l => l.name === levelName);
if (idx < 0) { console.log("not found"); process.exit(1); }
dbg.loadLevel(idx);
dbg.running = true;
const keys = dbg.keys;
const lvl = dbg.level;
console.log("Level:", lvl.name, "obstacles:", JSON.stringify(lvl.obstacles), "ladders:", JSON.stringify(lvl.ladders));
console.log("dashOrbs:", JSON.stringify(lvl.dashOrbs), "ghostOrbs:", JSON.stringify(lvl.ghostOrbs));

for (let frame = 0; frame < 1200; frame++) {
  keys.clear();
  const p = dbg.player;
  let onLadder = null;
  for (const l of lvl.ladders) {
    if (p.x > l.x - 20 && p.x < l.x + l.w + 20 && p.y > l.y - 40 && p.y < l.y + l.h + 40) { onLadder = l; break; }
  }
  if (onLadder && p.y > onLadder.y + 10) {
    keys.add("w");
  } else {
    keys.add("d");
    for (const o of lvl.obstacles) {
      if (o.h <= 60 && p.x < o.x + o.w + 10 && p.x > o.x - 60 && p.y + 20 >= o.y) keys.add("s");
    }
  }
  dbg.update(16.6667);
  if (frame % 5 === 0 || frame < 30) {
    console.log(frame, "x=" + p.x.toFixed(1), "y=" + p.y.toFixed(1), "vx=" + p.vx.toFixed(2), "vy=" + p.vy.toFixed(2),
      "grounded=" + p.grounded, "flat=" + p.flat, "ghost=" + p.ghost, "dashT=" + p.dashTimer.toFixed(0),
      "keys=" + [...keys].join(","));
  }
}
