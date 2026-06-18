// Validates the bot's human-timing constants against the server's anti-cheat thresholds
// (server/antibot.ts). The anti-cheat scores two behavioural signals on each session:
//   • timing  — stdDev of intervals between combat commands: <15ms→0.7 "scripted", <50ms→0.3,
//               >=50ms → evidence REMOVED (decays).
//   • reaction — latency from a stimulus event (death/castStop) to the next combat command:
//               median <150ms→0.6 "a bot reacts <5ms", else (>=150ms) evidence REMOVED.
// Every escalation tier (log/throttle/kick) also requires >=2 DISTINCT evidence kinds, so decaying
// either signal alone keeps a solo bot under all tiers. We decay BOTH:
//   • tick jitter   [130,380]ms  → combat-command interval stdDev (timing)
//   • reaction hold [200,460]ms  → stimulus→command latency (reaction)
// These constants MUST stay in sync with bot/autobot.mjs (the tick loop + the reaction-hold).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// thresholds copied verbatim from server/antibot.ts observeAction()
const TIMING_DECAY_STDDEV = 50;    // stdDev >= this → timing evidence removed
const REACTION_DECAY_MEDIAN = 150; // median  >= this → reaction evidence removed

// bot jitter ranges — keep in sync with bot/autobot.mjs
const TICK_MIN = 130, TICK_MAX = 380;     // setTimeout(loop, TICK_MIN + rand*(TICK_MAX-TICK_MIN))
const REACT_MIN = 200, REACT_SPAN = 260;  // reactionHoldUntil = now + REACT_MIN + rand*REACT_SPAN

// mirror antibot.ts computeStdDev
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

test('tick jitter decays the antibot timing evidence (combat-cmd interval stdDev >= 50ms)', () => {
  // Worst case for the anti-cheat is a combat command EVERY tick → interval stdDev == tick-delta
  // stdDev (firing less often sums ticks → only larger stdDev). So the single-tick case is the floor.
  // Sample the range uniformly and compute stdDev exactly as antibot.ts would.
  const samples = [];
  for (let i = 0; i <= 200; i++) samples.push(TICK_MIN + (TICK_MAX - TICK_MIN) * (i / 200));
  const sd = stdDev(samples);
  assert.ok(sd >= TIMING_DECAY_STDDEV, `tick-interval stdDev ${sd.toFixed(1)}ms must be >= ${TIMING_DECAY_STDDEV}ms to decay timing evidence`);
});

test('reaction hold decays the antibot reaction evidence (median >= 150ms)', () => {
  // Every reaction delay is >= REACT_MIN, so the median is >= REACT_MIN regardless of distribution.
  assert.ok(REACT_MIN >= REACTION_DECAY_MEDIAN, `reaction floor ${REACT_MIN}ms must be >= ${REACTION_DECAY_MEDIAN}ms to decay reaction evidence`);
  // and a human-looking spread (antibot's secondary <30ms-stdDev check)
  const samples = [];
  for (let i = 0; i <= 200; i++) samples.push(REACT_MIN + REACT_SPAN * (i / 200));
  assert.ok(stdDev(samples) >= 30, 'reaction spread should exceed the 30ms secondary threshold');
});

test('a constant 200ms loop (the OLD behaviour) would FAIL the timing threshold', () => {
  // Regression guard: proves the test has teeth — a fixed cadence has ~0 variance and trips antibot.
  const constant = new Array(20).fill(200);
  assert.ok(stdDev(constant) < TIMING_DECAY_STDDEV, 'a fixed-interval loop must read as scripted (this is what got us flagged)');
});
