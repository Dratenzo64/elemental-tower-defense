const fs = require("fs");
const vm = require("vm");

function makeElStub() {
  return {
    textContent: "", innerHTML: "",
    style: { opacity: "", width: "" },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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

let stallCounter = 0;
let activeDashSteer = null;
const maxFrame = process.argv[3] ? parseInt(process.argv[3], 10) : 1200;
for (let frame = 0; frame < maxFrame; frame++) {
  keys.clear();
  const p = dbg.player;
  let onLadder = null;
  for (const l of lvl.ladders) {
    if (p.x > l.x - 20 && p.x < l.x + l.w + 20 && p.y > l.y - 40 && p.y < l.y + l.h + 40) { onLadder = l; break; }
  }
  if (p.dashTimer <= 0) {
    for (const o of p.dashOrbs) {
      if (!o.taken) {
        const ddx = p.x - o.x, ddy = p.y - o.y;
        if (ddx * ddx + ddy * ddy < (20 + o.r + 30) * (20 + o.r + 30)) activeDashSteer = o.steer || null;
      }
    }
  }
  let ducking = false;
  for (const o of lvl.obstacles) {
    if (o.h <= 60 && p.x < o.x + o.w + 10 && p.x > o.x - 60 && p.y + 20 >= o.y) { ducking = true; }
  }
  if (p.dashTimer > 0) {
    keys.add("d");
    if (ducking || activeDashSteer === "down") keys.add("s");
    else if (activeDashSteer === "up") keys.add("w");
  } else if (onLadder && p.y > onLadder.y + 10) {
    keys.add("w");
  } else {
    keys.add("d");
    if (ducking) keys.add("s");
    if (!ducking && p.grounded && !p.climbing) {
      const orbAhead = [...p.dashOrbs, ...p.ghostOrbs].some((o) => !o.taken && o.x > p.x - 10 && o.x < p.x + 90);
      const nearExit = Math.abs(p.x - lvl.exit.x) < 200 &&
        Math.abs((lvl.exit.y + lvl.exit.h) - (p.y + 20)) < 60;
      const nearLadder = lvl.ladders.some((l) => l.x > p.x - 10 && l.x < p.x + 200);
      const pointCovered = (px) => lvl.platforms.some((pl) => pl.x <= px && pl.x + pl.w >= px);
      const noGroundNear = !pointCovered(p.x + 30);
      const groundWithinJumpRange = pointCovered(p.x + 210);
      const gapAhead = noGroundNear && groundWithinJumpRange;
      if (gapAhead && !orbAhead && !nearExit && !nearLadder) {
        keys.add("w");
      }
      stallCounter = 0;
    }
  }
  const nearUnclaimedOrb = [...p.dashOrbs, ...p.ghostOrbs].some((o) => {
    if (o.taken) return false;
    const ddx = p.x - o.x, ddy = p.y - o.y;
    return ddx * ddx + ddy * ddy < (20 + o.r) * (20 + o.r);
  });
  if (nearUnclaimedOrb) keys.add("w");

  dbg.update(16.6667);
  if (frame % 5 === 0 || frame < 30) {
    console.log(frame, "x=" + p.x.toFixed(1), "y=" + p.y.toFixed(1), "vx=" + p.vx.toFixed(2), "vy=" + p.vy.toFixed(2),
      "grounded=" + p.grounded, "flat=" + p.flat, "ghost=" + p.ghost, "dashT=" + p.dashTimer.toFixed(0),
      "keys=" + [...keys].join(","));
  }
}
