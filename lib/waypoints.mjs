// Static travel graph mirroring the game's own road network (src/sim/content/zone*.ts
// ROADS). The roads are dry, tree-free lanes that skirt the lakes and — crucially —
// thread the mountain-ridge passes at the zone boundaries (z=180 and z=540, pierced at
// x≈0). Routing along them lets the bot cross zones instead of dead-reckoning into the
// ridge wall and getting wedged. Pure data + a tiny Dijkstra; no server access.

const ROADS = [
  // zone 1 — Eastbrook (z -180..180)
  [[0, 8], [-8, 30], [-15, 55], [-2, 78]],
  [[8, 2], [30, 8], [55, 12]],
  [[6, -6], [30, -30], [50, -50], [65, -65]],
  [[-8, 6], [-35, 25], [-58, 48], [-66, 58]],
  [[-6, -6], [-30, -28], [-55, -45], [-70, -55]],
  [[6, 8], [35, 35], [60, 60], [78, 74]],
  // zone 2 — Fenbridge (z 180..540). Road 0 bridges the z=180 pass from zone 1.
  [[0, 80], [0, 180], [-8, 240], [0, 300]],
  [[4, 308], [45, 336], [92, 350], [102, 392], [90, 420]],
  [[-6, 308], [-40, 370], [-80, 420]],
  [[2, 312], [10, 400], [20, 470], [45, 515]],
  // zone 3 — Highwatch (z 540..900). Road 0 bridges the z=540 pass from zone 2.
  [[0, 320], [10, 450], [0, 540], [0, 660]],
  [[-6, 666], [-60, 700], [-110, 735]],
  [[6, 668], [70, 720], [110, 760]],
  [[0, 676], [0, 780], [0, 860]],
];
const HUBS = [[0, 0], [0, 300], [0, 660]];
const PROX = 24;   // stitch nearby on-road nodes (roads meet at hubs/junctions on a lane)
const LOCAL = 18;  // hops shorter than this just go straight (can't span a boundary anyway)
const NEAR = 4;    // # of graph nodes a temp endpoint connects to

const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// ---- build the graph once ----
const NODES = [];
const ADJ = [];
const addNode = (x, z) => { NODES.push({ x, z }); ADJ.push([]); return NODES.length - 1; };
function link(i, j) {
  if (i === j) return;
  const w = d2(NODES[i], NODES[j]);
  if (!ADJ[i].some((e) => e.to === j)) ADJ[i].push({ to: j, w });
  if (!ADJ[j].some((e) => e.to === i)) ADJ[j].push({ to: i, w });
}
for (const road of ROADS) {
  let prev = -1;
  for (const [x, z] of road) { const i = addNode(x, z); if (prev >= 0) link(prev, i); prev = i; }
}
for (const [x, z] of HUBS) addNode(x, z);
for (let i = 0; i < NODES.length; i++) for (let j = i + 1; j < NODES.length; j++) if (d2(NODES[i], NODES[j]) <= PROX) link(i, j);

const nearestN = (p, k) => NODES.map((n, i) => ({ i, d: d2(p, n) })).sort((a, b) => a.d - b.d).slice(0, k);
export function nearestRoadNode(p) { const n = nearestN(p, 1)[0]; return n ? NODES[n.i] : null; }

// Next waypoint toward `goal` along the road graph (Dijkstra with from/goal as temp nodes).
// Returns the first lane point that's meaningfully ahead, or `goal` itself for local hops.
export function routeTo(from, goal) {
  if (d2(from, goal) < LOCAL) return goal;
  const N = NODES.length, FROM = N, GOAL = N + 1;
  const adj = ADJ.map((e) => e.slice()); adj.push([]); adj.push([]);
  for (const { i, d } of nearestN(from, NEAR)) { adj[FROM].push({ to: i, w: d }); adj[i].push({ to: FROM, w: d }); }
  for (const { i, d } of nearestN(goal, NEAR)) { adj[GOAL].push({ to: i, w: d }); adj[i].push({ to: GOAL, w: d }); }
  const at = (i) => i < N ? NODES[i] : (i === FROM ? from : goal);
  const dist = new Array(N + 2).fill(Infinity), prev = new Array(N + 2).fill(-1), done = new Array(N + 2).fill(false);
  dist[FROM] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < N + 2; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u === -1 || u === GOAL) break;
    done[u] = true;
    for (const e of adj[u]) if (dist[u] + e.w < dist[e.to]) { dist[e.to] = dist[u] + e.w; prev[e.to] = u; }
  }
  if (dist[GOAL] === Infinity) return goal;                   // disconnected -> straight line
  const path = [];
  for (let v = GOAL; v !== -1; v = prev[v]) path.push(v);
  path.reverse();                                             // [FROM, ..., GOAL]
  // Return the first waypoint that's genuinely AHEAD. Skip nodes we're basically on (<4yd)
  // AND nodes we're already past — i.e. we're closer to the NEXT node than this node is.
  // Without the "past" check the bot flip-flops across a node it straddles (e.g. standing on
  // a hub node: just-south → skip & head to next; drift north of 4yd → routed back to the
  // node), pinning it in a tiny oscillation that never escapes.
  for (let k = 1; k < path.length; k++) {
    const here = at(path[k]);
    if (d2(from, here) <= 4) continue;
    const nxt = path[k + 1] != null ? at(path[k + 1]) : null;
    if (nxt && d2(from, nxt) <= d2(here, nxt) + 1) continue;  // already past `here` -> aim further
    return here;
  }
  return goal;
}
