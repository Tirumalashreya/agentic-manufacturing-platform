// §9 "Load Balancing" — local search (swap): move eligible ops from an
// over-loaded machine to an under-loaded machine in the same work centre;
// repeat until imbalance < threshold.

export type MovableOp = { id: string; durationMin: number; machineId: string; eligibleMachineIds: string[] };

export type LoadBalanceMove = { opId: string; fromMachineId: string; toMachineId: string };

export type LoadBalanceResult = {
  moves: LoadBalanceMove[];
  finalLoadByMachine: Map<string, number>;
};

export function localSearchLoadBalance(
  initialLoadByMachine: Map<string, number>,
  movableOps: MovableOp[],
  imbalanceThresholdMin: number
): LoadBalanceResult {
  const load = new Map(initialLoadByMachine);
  const ops = movableOps.map((op) => ({ ...op }));
  const moves: LoadBalanceMove[] = [];

  function imbalance(): number {
    const values = Array.from(load.values());
    return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
  }

  let guard = 0;
  while (imbalance() > imbalanceThresholdMin && guard < ops.length * 4) {
    guard++;
    const entries = Array.from(load.entries());
    const [mostLoadedMachine] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    const [leastLoadedMachine] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (mostLoadedMachine === leastLoadedMachine) break;

    const movable = ops.find(
      (op) => op.machineId === mostLoadedMachine && op.eligibleMachineIds.includes(leastLoadedMachine)
    );
    if (!movable) break; // no eligible op can rebalance further — stop rather than loop forever

    load.set(mostLoadedMachine, (load.get(mostLoadedMachine) ?? 0) - movable.durationMin);
    load.set(leastLoadedMachine, (load.get(leastLoadedMachine) ?? 0) + movable.durationMin);
    movable.machineId = leastLoadedMachine;
    moves.push({ opId: movable.id, fromMachineId: mostLoadedMachine, toMachineId: leastLoadedMachine });
  }

  return { moves, finalLoadByMachine: load };
}
