// §6 step 4: "Routing Engine resolves operation DAG; computes EST/EFT/LST/LFT;
// marks critical-path operations (float=0)" — standard Critical Path Method
// over a routing's operations and their RoutingOpDependency edges.

export type CpmNode = {
  id: string;
  durationMin: number;
  predecessorIds: string[];
};

export type CpmResult = {
  est: number; // minutes from routing start
  eft: number;
  lst: number;
  lft: number;
  float: number;
  isCritical: boolean;
};

export function computeCriticalPath(nodes: CpmNode[]): Map<string, CpmResult> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const successors = new Map<string, string[]>();
  for (const n of nodes) {
    for (const pred of n.predecessorIds) {
      successors.set(pred, [...(successors.get(pred) ?? []), n.id]);
    }
  }

  // Forward pass: EST = max(EFT of predecessors), EFT = EST + duration
  const est = new Map<string, number>();
  const eft = new Map<string, number>();
  function resolveForward(id: string): number {
    if (eft.has(id)) return eft.get(id)!;
    const node = byId.get(id)!;
    const startTime = node.predecessorIds.length === 0
      ? 0
      : Math.max(...node.predecessorIds.map((p) => resolveForward(p)));
    est.set(id, startTime);
    const finishTime = startTime + node.durationMin;
    eft.set(id, finishTime);
    return finishTime;
  }
  for (const n of nodes) resolveForward(n.id);

  const projectEnd = Math.max(...Array.from(eft.values()), 0);

  // Backward pass: LFT = min(LST of successors) or projectEnd if none, LST = LFT - duration
  const lft = new Map<string, number>();
  const lst = new Map<string, number>();
  function resolveBackward(id: string): number {
    if (lst.has(id)) return lst.get(id)!;
    const node = byId.get(id)!;
    const succIds = successors.get(id) ?? [];
    const finishTime = succIds.length === 0 ? projectEnd : Math.min(...succIds.map((s) => resolveBackward(s)));
    lft.set(id, finishTime);
    const startTime = finishTime - node.durationMin;
    lst.set(id, startTime);
    return startTime;
  }
  for (const n of nodes) resolveBackward(n.id);

  const results = new Map<string, CpmResult>();
  for (const n of nodes) {
    const nodeEst = est.get(n.id)!;
    const nodeEft = eft.get(n.id)!;
    const nodeLst = lst.get(n.id)!;
    const nodeLft = lft.get(n.id)!;
    const float = nodeLst - nodeEst;
    results.set(n.id, { est: nodeEst, eft: nodeEft, lst: nodeLst, lft: nodeLft, float, isCritical: float === 0 });
  }
  return results;
}
