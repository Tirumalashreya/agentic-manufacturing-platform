// §9 "Changeover / Setup Minimisation": sequence N waiting jobs on machine M
// to minimise Σ setup(i→j) from the changeover matrix.
//   N ≤ 10: Held-Karp exact DP
//   N > 10: Nearest Neighbour construction + 2-opt local search
// This is a Hamiltonian-PATH minimization (pick a start, visit every job
// once, no return trip) — there's no "come back to the depot" cost, unlike
// classic cycle-TSP, since a machine just finishes its last job and stops.

export type SequencingJob = { id: string; family: string };
export type ChangeoverLookup = (fromFamily: string, toFamily: string) => number;

export type SequencingResult = {
  order: string[]; // job ids in sequence
  totalChangeoverMin: number;
  method: "HELD_KARP_EXACT" | "NEAREST_NEIGHBOR_2OPT";
};

export function minimizeChangeover(jobs: SequencingJob[], changeover: ChangeoverLookup): SequencingResult {
  if (jobs.length <= 1) {
    return { order: jobs.map((j) => j.id), totalChangeoverMin: 0, method: "HELD_KARP_EXACT" };
  }
  if (jobs.length <= 10) {
    return heldKarpExact(jobs, changeover);
  }
  return nearestNeighborThen2Opt(jobs, changeover);
}

function cost(jobs: SequencingJob[], changeover: ChangeoverLookup, i: number, j: number): number {
  return changeover(jobs[i].family, jobs[j].family);
}

// Held-Karp for the open-path variant: dp[mask][j] = min cost of a path
// visiting exactly the jobs in `mask`, ending at job j (starting anywhere
// in `mask` at zero cost — the first job in a sequence has no changeover).
function heldKarpExact(jobs: SequencingJob[], changeover: ChangeoverLookup): SequencingResult {
  const n = jobs.length;
  const fullMask = (1 << n) - 1;
  const dp: number[][] = Array.from({ length: 1 << n }, () => Array(n).fill(Infinity));
  const parent: number[][] = Array.from({ length: 1 << n }, () => Array(n).fill(-1));

  for (let j = 0; j < n; j++) dp[1 << j][j] = 0;

  for (let mask = 1; mask <= fullMask; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      if (dp[mask][j] === Infinity) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nextMask = mask | (1 << k);
        const candidate = dp[mask][j] + cost(jobs, changeover, j, k);
        if (candidate < dp[nextMask][k]) {
          dp[nextMask][k] = candidate;
          parent[nextMask][k] = j;
        }
      }
    }
  }

  let bestEnd = 0;
  let bestCost = Infinity;
  for (let j = 0; j < n; j++) {
    if (dp[fullMask][j] < bestCost) {
      bestCost = dp[fullMask][j];
      bestEnd = j;
    }
  }

  const order: number[] = [];
  let mask = fullMask;
  let node = bestEnd;
  while (node !== -1) {
    order.push(node);
    const prevNode = parent[mask][node];
    mask ^= 1 << node;
    node = prevNode;
  }
  order.reverse();

  return { order: order.map((i) => jobs[i].id), totalChangeoverMin: bestCost, method: "HELD_KARP_EXACT" };
}

function totalCost(jobs: SequencingJob[], changeover: ChangeoverLookup, order: number[]): number {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += cost(jobs, changeover, order[i], order[i + 1]);
  return total;
}

function nearestNeighborThen2Opt(jobs: SequencingJob[], changeover: ChangeoverLookup): SequencingResult {
  const n = jobs.length;
  const visited = new Array(n).fill(false);
  const order: number[] = [0];
  visited[0] = true;

  while (order.length < n) {
    const last = order[order.length - 1];
    let best = -1;
    let bestCost = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const c = cost(jobs, changeover, last, j);
      if (c < bestCost) {
        bestCost = c;
        best = j;
      }
    }
    order.push(best);
    visited[best] = true;
  }

  // 2-opt: repeatedly reverse a segment if it reduces total cost, until no
  // improving move is found (standard local search, bounded by construction
  // size so it terminates quickly even for large N).
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        const before = totalCost(jobs, changeover, order);
        const reversed = [...order.slice(0, i + 1), ...order.slice(i + 1, j + 1).reverse(), ...order.slice(j + 1)];
        const after = totalCost(jobs, changeover, reversed);
        if (after < before) {
          order.splice(0, order.length, ...reversed);
          improved = true;
        }
      }
    }
  }

  return { order: order.map((i) => jobs[i].id), totalChangeoverMin: totalCost(jobs, changeover, order), method: "NEAREST_NEIGHBOR_2OPT" };
}
