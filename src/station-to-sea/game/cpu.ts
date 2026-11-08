import { GAME_CONFIG } from "./config.ts";
import { getAvailableJunctionOptions } from "./state.ts";
import type { GameAction, GameState } from "./state.ts";
import type { Graph } from "./graph.ts";

export interface CPUMemory {
  target: string | null;
  skipped: string[];
}

export interface CPUDecision {
  action: GameAction;
  reason: string;
  target: string | null;
  distanceWU: number | null;
}

export function createCPUMemory(): CPUMemory {
  return { target: null, skipped: [] };
}

export function legalDistances(graph: Graph, origin: string): Map<string, number> {
  const distances = new Map([[origin, 0]]), pending = new Set(graph.nodes.keys());
  // ponytail: tiny graph O(V² log V) sorted frontier; use a heap if the board grows substantially.
  while (pending.size) {
    const node = [...pending].sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    const distance = distances.get(node) ?? Infinity;
    if (!Number.isFinite(distance)) break;
    pending.delete(node);
    for (const option of graph.getOutgoingEdges(node)) {
      const next = distance + option.edge.worldLength;
      if (next < (distances.get(option.targetNodeId) ?? Infinity)) distances.set(option.targetNodeId, next);
    }
  }
  return distances;
}

export function decideCPU(state: GameState, memory: CPUMemory): CPUDecision | null {
  const player = state.players[state.activePlayerIndex];
  if (state.phase === "GAME_OVER" || player.status !== "ACTIVE") return null;
  const distances = (node: string) => legalDistances(state.graph, node);
  const finishDistance = (node: string) => {
    const costs = distances(node);
    return Math.min(...GAME_CONFIG.finishNodeIds.map(id => costs.get(id) ?? Infinity));
  };
  const turns = (distance: number) => Math.ceil(distance / GAME_CONFIG.stepDistanceWU);
  const decision = (action: GameAction, reason: string, distanceWU: number | null = null): CPUDecision =>
    ({ action, reason, target: memory.target, distanceWU: Number.isFinite(distanceWU) ? distanceWU : null });

  if (state.phase === "TURN_START") {
    if (memory.target && GAME_CONFIG.finishNodeIds.includes(memory.target)) memory.target = null;
    return player.standingAtPOI
      ? decision({ type: "VISIT_POI" }, "履行上次停留承諾：本個人回合參觀，扣 1 體力、不擲骰。")
      : decision({ type: "ROLL_DICE" }, "正常擲 1–3 骰，不預知結果；移動回合扣 1 體力。");
  }
  if (state.phase === "POI_DECISION") {
    const node = state.pendingPOI!;
    const cost = finishDistance(node);
    memory.target = null;
    const safe = !player.visitedPOIs.includes(node) && player.stamina >= turns(cost) + 3;
    if (!safe && !memory.skipped.includes(node)) memory.skipped.push(node);
    return decision({ type: safe ? "STOP_AT_POI" : "PASS_POI" }, safe
      ? "保留以每骰 1 步估算的完賽體力與 2 回合餘裕，停留後下個個人回合參觀。"
      : "完賽體力餘裕不足或已參觀，通過景點。", cost);
  }
  if (state.phase === "RESUPPLY_DECISION") {
    const node = state.pendingShop!, cost = finishDistance(node);
    memory.target = null;
    const canBuy = !player.visitedShops.includes(node) &&
      player.earnedPoints - player.spentPoints >= GAME_CONFIG.resupplyCost && player.stamina < GAME_CONFIG.maxStamina;
    const buy = canBuy && (player.stamina === 0 || player.stamina <= turns(cost) + 2);
    if (!buy && !memory.skipped.includes(node)) memory.skipped.push(node);
    return decision({ type: buy ? "BUY_RECOVERY" : "PASS_SHOP" }, buy
      ? `優先合法補給：花 ${GAME_CONFIG.resupplyCost} 分換最多 ${GAME_CONFIG.resupplyGain} 體力，本回合完成並放棄餘步。`
      : "不需補給、分數不足或已使用；不浪費滿體力購買，繼續移動。", cost);
  }
  if (state.phase !== "JUNCTION_CHOICE") return null;
  const options = getAvailableJunctionOptions(state);
  if (!options.length) return null;
  const node = player.currentNodeId!, costs = distances(node);
  if (memory.target === node || player.visitedPOIs.includes(memory.target ?? "") || player.visitedShops.includes(memory.target ?? "")) memory.target = null;
  if (!memory.target) {
    memory.target = [...GAME_CONFIG.finishNodeIds].sort((a, b) => (costs.get(a) ?? Infinity) - (costs.get(b) ?? Infinity))[0];
    const candidates = Object.keys(GAME_CONFIG.poiScores).filter(id => !player.visitedPOIs.includes(id) && !memory.skipped.includes(id) &&
      turns(costs.get(id) ?? Infinity) + 1 + turns(finishDistance(id)) + 2 <= player.stamina);
    candidates.sort((a, b) => GAME_CONFIG.poiScores[b] / ((costs.get(b) ?? Infinity) + 1) - GAME_CONFIG.poiScores[a] / ((costs.get(a) ?? Infinity) + 1));
    if (candidates.length) memory.target = candidates[0];
    if (player.earnedPoints - player.spentPoints >= GAME_CONFIG.resupplyCost && player.stamina <= turns(finishDistance(node)) + 2) {
      const shops = ["R1", "R2"].filter(id => !player.visitedShops.includes(id) && !memory.skipped.includes(id) &&
        turns(costs.get(id) ?? Infinity) <= player.stamina &&
        (costs.get(id) ?? Infinity) + finishDistance(id) <= finishDistance(node) + GAME_CONFIG.resupplyGain * GAME_CONFIG.stepDistanceWU);
      shops.sort((a, b) => (costs.get(a) ?? Infinity) - (costs.get(b) ?? Infinity));
      if (shops.length) memory.target = shops[0];
    }
  }
  const target = memory.target;
  const routeCost = (option: typeof options[number]) => option.edge.worldLength + (distances(option.targetNodeId).get(target) ?? Infinity);
  const best = [...options].sort((a, b) => routeCost(a) - routeCost(b))[0];
  return decision({ type: "CHOOSE_JUNCTION_EDGE", edgeId: best.edge.id },
    `${GAME_CONFIG.finishNodeIds.includes(target) ? "優先完賽" : target in GAME_CONFIG.poiScores ? "體力餘裕允許，前往景點" : "前往可負擔補給"}：沿合法最短道路前進；必要時可在路口回頭。`, routeCost(best));
}
