// Shared content-fingerprint for the generate-from-source pipeline. The bot mirrors the game's `src/sim`
// (mob/item/ability tables AND the hand-copied aggro/social/flee constants in lib/world.mjs). This hashes
// that whole surface so a drifted checkout is caught LOUDLY (scripts/check_gamedata.mjs) instead of the bot
// silently playing on stale data — the documented content-drift risk. Coarse on purpose: a change anywhere
// in src/sim (incl. sim.ts, where SOCIAL_PULL_RADIUS / FLEE_HELP_RADIUS / FLEE_HP_THRESHOLD / FLEEING_FAMILIES
// / the aggro clamp live) re-flags us to re-audit + `npm run gen`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

// Every .ts file under src/sim, relative paths sorted for a stable, OS-independent digest.
function listTsFiles(dir, root, acc) {
  for (const name of readdirSync(dir).sort()) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listTsFiles(full, root, acc);
    else if (name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

// Returns { hash, files, gameCommit } for a game checkout, or null if its src/sim is absent (standalone
// runtime has no game source — callers treat null as "nothing to check").
export function gameHash(gameRoot) {
  const simDir = resolve(gameRoot, 'src/sim');
  if (!existsSync(simDir)) return null;
  const files = listTsFiles(simDir, simDir, []).sort();
  const h = createHash('sha256');
  for (const f of files) {
    const rel = relative(gameRoot, f).split(sep).join('/');   // normalise to forward slashes
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(f));                                 // raw bytes — newline/encoding-faithful
    h.update('\0');
  }
  let gameCommit = null;
  try {
    const head = readFileSync(resolve(gameRoot, '.git/HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref:') ? head.slice(4).trim() : null;
    gameCommit = ref
      ? readFileSync(resolve(gameRoot, '.git', ref), 'utf8').trim().slice(0, 12)
      : head.slice(0, 12);
  } catch { /* not a git checkout — commit stays null, hash still authoritative */ }
  return { hash: h.digest('hex'), files: files.length, gameCommit };
}

// Resolve the game checkout the generators use: GAME_SRC env, else the sibling world-of-claudecraft.
export function resolveGameRoot(botRoot) {
  return process.env.GAME_SRC || resolve(botRoot, '..', 'world-of-claudecraft');
}
