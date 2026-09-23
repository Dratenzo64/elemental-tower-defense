// Headless bot harness for bounceorb.html — verifies every level is completable.
const fs = require("fs");
const vm = require("vm");

function makeElStub() {
  const listeners = {};
  return {
    textContent: "", innerHTML: "",
    style: { opacity: "", width: "" },
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener(ev, fn) { listeners[ev] = fn; },
    click() { if (listeners.click) listeners.click(); },
  };
}

function makeCtxStub() {
  const noop = () => {};
  return new Proxy({}, {
    get(target, prop) {
      if (prop === "setTransform" || prop === "save" || prop === "restore" ||
          prop === "translate" || prop === "scale" || prop === "rotate" ||
          prop === "fillRect" || prop === "strokeRect" || prop === "beginPath" ||
          prop === "arc" || prop === "fill" || prop === "stroke" || prop === "clearRect" ||
          prop === "moveTo" || prop === "lineTo" || prop === "closePath" ||
          prop === "createRadialGradient" || prop === "createLinearGradient" ||
          prop === "fillText" || prop === "clip" || prop === "ellipse") {
        if (prop === "createRadialGradient" || prop === "createLinearGradient") {
          return () => ({ addColorStop() {} });
        }
        return noop;
      }
      return target[prop];
    },
    set(target, prop, val) { target[prop] = val; return true; },
  });
}

function runLevel(levelIdx, ctx, maxFrames) {
  const dbg = ctx.window.__dbg;
  dbg.loadLevel(levelIdx);
  dbg.running = true;
  const level = dbg.level;
  const startLevel = dbg.levelIndex;
  const keys = dbg.keys;

  let frame = 0;
  let stuckCounter = 0;
  let lastX = dbg.player.x, lastY = dbg.player.y;
  const DT = 16.6667;

  // Simple scripted-ish autoplay: always hold right + jump periodically,
  // use dash/ghost orbs automatically via pickup (handled by game itself),
  // and climb ladders by holding up when overlapping one, duck under
  // overhangs when blocked, and jump when stuck against a wall.
  while (frame < maxFrames) {
    keys.clear();
    const p = dbg.player;
    const lvl = dbg.level;

    if (dbg.levelIndex !== startLevel) break; // advanced to next level = success
    if (!dbg.running) break; // final level cleared: nextLevel() sets running=false instead

    // decide ladder usage: if standing at foot of a ladder, climb up
    let onLadder = null;
    for (const l of lvl.ladders) {
      if (p.x > l.x - 20 && p.x < l.x + l.w + 20 && p.y > l.y - 40 && p.y < l.y + l.h + 40) {
        onLadder = l; break;
      }
    }

    if (onLadder && p.y > onLadder.y + 10) {
      keys.add("w");
    } else {
      keys.add("d"); // always move right — all levels are left-to-right
      // duck if there's an obstacle overhead-ish within short range ahead
      for (const o of lvl.obstacles) {
        if (o.h <= 60 && p.x < o.x + o.w + 10 && p.x > o.x - 60 && p.y + 20 >= o.y) {
          keys.add("s");
        }
      }
      // No blind periodic jumping: every gap in this game is crossed via a
      // dash orb (never a raw jump — gaps exceed jump range by design),
      // every wall via a ghost orb, every overhang via ducking, and every
      // height change via a ladder. Jumping at the wrong moment overshoots
      // orbs, so the bot only walks/ducks/climbs and lets pickups happen
      // naturally at ground level.
    }

    dbg.update(DT);
    frame++;

    // stuck detection (not counting brief pauses during ducking)
    const dx = Math.abs(dbg.player.x - lastX), dy = Math.abs(dbg.player.y - lastY);
    if (dx < 0.05 && dy < 0.05) stuckCounter++; else stuckCounter = 0;
    lastX = dbg.player.x; lastY = dbg.player.y;
    if (stuckCounter > 240) {
      return { ok: false, reason: `stuck at x=${p.x.toFixed(1)},y=${p.y.toFixed(1)} frame=${frame}` };
    }
  }

  if (dbg.levelIndex !== startLevel || !dbg.running) return { ok: true, frames: frame };
  return { ok: false, reason: `did not reach exit within ${maxFrames} frames (x=${dbg.player.x.toFixed(1)}, y=${dbg.player.y.toFixed(1)})` };
}

function main() {
  const src = fs.readFileSync("/tmp/game_hooked.js", "utf8");

  const windowObj = {};
  const documentStub = {
    getElementById(id) { return makeElStub(); },
    createElement() { return makeElStub(); },
    addEventListener() {},
  };
  const canvasStub = {
    getContext() { return makeCtxStub(); },
    style: {}, width: 1280, height: 720,
  };
  documentStub.getElementById = (id) => {
    if (id === "game-canvas") return canvasStub;
    return makeElStub();
  };

  windowObj.innerWidth = 1280;
  windowObj.innerHeight = 720;
  windowObj.devicePixelRatio = 1;
  windowObj.addEventListener = () => {};
  windowObj.AudioContext = undefined;
  windowObj.webkitAudioContext = undefined;

  const sandbox = {
    window: windowObj,
    document: documentStub,
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    performance: { now: () => Date.now() },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "bounceorb.js" });

  const dbg = sandbox.window.__dbg;
  const total = dbg.LEVELS.length;
  console.log(`Total levels: ${total}`);
  let allOk = true;
  for (let i = 0; i < total; i++) {
    const res = runLevel(i, sandbox, 3000);
    const name = dbg.LEVELS[i].name;
    if (res.ok) {
      console.log(`[PASS] Level ${i + 1}/${total} "${name}" — cleared in ${res.frames} frames`);
    } else {
      allOk = false;
      console.log(`[FAIL] Level ${i + 1}/${total} "${name}" — ${res.reason}`);
    }
  }
  console.log(allOk ? "\nALL LEVELS PASSED" : "\nSOME LEVELS FAILED");
  process.exit(allOk ? 0 : 1);
}

main();
