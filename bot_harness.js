// Headless bot harness for bounceorb.html — verifies every level is completable.
const fs = require("fs");
const vm = require("vm");

function makeElStub() {
  const listeners = {};
  return {
    textContent: "", innerHTML: "",
    style: { opacity: "", width: "" },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
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
  let stallCounter = 0;
  let activeDashSteer = null; // "up" | "down" | null — set on pickup, held for the dash's duration
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

    // Predict an about-to-happen dash-orb pickup so we know whether to
    // steer this dash — orbs can carry an optional `steer: "up"|"down"`
    // hint. Checked with a generous margin (not the exact touch radius):
    // this runs on last frame's (pre-movement) position, one frame before
    // update() itself checks the post-movement position and registers the
    // real pickup, so a tight radius here can miss it by a hair and only
    // pick it up a frame late (after dashTimer is already >0, i.e. too
    // late to steer that dash at all).
    if (p.dashTimer <= 0) {
      for (const o of p.dashOrbs) {
        if (!o.taken) {
          const ddx = p.x - o.x, ddy = p.y - o.y;
          if (ddx * ddx + ddy * ddy < (20 + o.r + 30) * (20 + o.r + 30)) activeDashSteer = o.steer || null;
        }
      }
    }

    // Duck-obstacle proximity check runs regardless of dash state — a dash
    // can carry the player through a low-overhang zone (e.g. a dash orb
    // placed just past a duck), and un-flattening the instant a dash
    // starts while still inside that obstacle's x-range triggers the
    // minimum-penetration X resolver and teleports the player sideways
    // (the same class of bug documented on resolveAxis/playerBoxHeight).
    // So obstacle-avoidance ducking always takes priority over anything
    // else, dash or not.
    let ducking = false;
    for (const o of lvl.obstacles) {
      if (o.h <= 60 && p.x < o.x + o.w + 10 && p.x > o.x - 60 && p.y + 20 >= o.y) {
        ducking = true;
      }
    }

    if (p.dashTimer > 0) {
      // Mid-dash: hold the steer key (if any) on top of obstacle-avoidance
      // ducking — don't let the ladder/gap-jump logic below interfere with
      // an active dash, since it now responds to W/S too (Geometry-Dash
      // style steering).
      keys.add("d");
      if (ducking || activeDashSteer === "down") keys.add("s");
      else if (activeDashSteer === "up") keys.add("w");
    } else if (onLadder && p.y > onLadder.y + 10) {
      keys.add("w");
    } else {
      keys.add("d"); // always move right — all levels are left-to-right
      if (ducking) keys.add("s");
      // Most gaps/walls/overhangs are crossed via dash/ghost/duck orbs, not
      // raw jumps — but a couple of simple tutorial-style levels (and the
      // new floating-island levels) use a plain gap/step that just needs a
      // jump. Only jump when there's genuinely a short gap directly ahead
      // (no platform covering the next ~90px) that's still within jump
      // range (something solid reappears within ~140-230px) — never a
      // blind/periodic jump, since that can overshoot an orb or launch
      // clean off a platform's edge.
      if (!ducking && p.grounded && !p.climbing) {
        const orbAhead = [...p.dashOrbs, ...p.ghostOrbs].some(
          (o) => !o.taken && o.x > p.x - 10 && o.x < p.x + 90
        );
        // Only suppress the gap-jump for a ground-level exit close by (the
        // classic overshoot-past-the-edge risk) — a ceiling exit sits far
        // above the current standing height and is often the very thing a
        // gap-jump is trying to reach, so it must not block that jump.
        const nearExit = Math.abs(p.x - lvl.exit.x) < 200 &&
          Math.abs((lvl.exit.y + lvl.exit.h) - (p.y + 20)) < 60;
        const nearLadder = lvl.ladders.some((l) => l.x > p.x - 10 && l.x < p.x + 200);
        // Point checks (not range-overlap) — a platform simply *starting*
        // somewhere inside the lookahead window would otherwise look like
        // "ground is there" even when the exact spot is still open air.
        const pointCovered = (px) => lvl.platforms.some((pl) => pl.x <= px && pl.x + pl.w >= px);
        const noGroundNear = !pointCovered(p.x + 30);
        const groundWithinJumpRange = pointCovered(p.x + 210);
        const gapAhead = noGroundNear && groundWithinJumpRange;
        // Jump the instant a real gap is detected — no delay. A gap can be
        // up to ~210px, and waiting even a few frames to "confirm" the
        // stall eats into the ~30px of runway left before the edge,
        // sometimes right off it before the jump ever fires.
        if (gapAhead && !orbAhead && !nearExit && !nearLadder) {
          keys.add("w");
        }
        stallCounter = 0;
      }
    }

    // Orbs only fire while jump is held at the moment of contact now, so
    // hold "w" whenever within actual pickup range of ANY unclaimed orb —
    // on top of whatever else this frame decided — regardless of branch
    // (dash, ladder, gap-jump, or plain walking). Deliberately a TIGHT
    // margin (not the generous +30 used for steer prediction above): if
    // this fires too early, while the player is still grounded and well
    // short of the orb, it triggers a premature ordinary jump (grounded +
    // jumpHeld fires a real jump, not a dash) that arcs the player up and
    // away before they ever reach the orb's actual touch radius, missing
    // the pickup entirely. A small +6 buffer covers one frame of movement
    // without jumping the gun.
    // Safe to hold alongside "s" now — dash direction is locked in by the
    // orb itself at pickup (see the game's dashSteerY), not read from live
    // W/S input during the burst, so there's no more risk of an orb's
    // activation key accidentally steering a dash just because it overlaps
    // a duck obstacle's proximity window.
    const nearUnclaimedOrb = [...p.dashOrbs, ...p.ghostOrbs].some((o) => {
      if (o.taken) return false;
      const ddx = p.x - o.x, ddy = p.y - o.y;
      return ddx * ddx + ddy * ddy < (20 + o.r) * (20 + o.r);
    });
    if (nearUnclaimedOrb) keys.add("w");

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
