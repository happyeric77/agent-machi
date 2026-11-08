import { GAME_CONFIG } from "./config.ts";
import { LCG } from "./rng.ts";
import { Graph, loadGraph } from "./graph.ts";
import type { OutgoingEdgeOption } from "./graph.ts";

export type PlayerId = "Amber" | "Teal";
export type PlayerStatus = "ACTIVE" | "FINISHED" | "DNF";

export interface PlayerState {
  readonly id: PlayerId;
  readonly name: string;
  readonly color: string;
  status: PlayerStatus;
  stamina: number;
  earnedPoints: number;
  spentPoints: number;
  visitedPOIs: string[];
  visitedShops: string[];
  standingAtPOI: string | null;
  standingAtShop: string | null;
  currentNodeId: string | null;
  currentEdgeId: string | null;
  previousEdgeId: string | null;
  edgeDirection: "FORWARD" | "REVERSE" | null;
  edgeProgressWU: number;
  position: { x: number; z: number; yaw: number };
}

export interface TraversalStep {
  readonly playerId: PlayerId;
  readonly edgeId: string;
  readonly direction: "FORWARD" | "REVERSE";
  readonly fromWU: number;
  readonly toWU: number;
}

export type GamePhase =
  | "TURN_START"
  | "MOVING"
  | "JUNCTION_CHOICE"
  | "POI_DECISION"
  | "RESUPPLY_DECISION"
  | "GAME_OVER";

export interface GameState {
  readonly graph: Graph;
  readonly players: [PlayerState, PlayerState];
  activePlayerIndex: number;
  phase: GamePhase;
  currentRoll: number | null;
  remainingBudgetWU: number;
  pendingJunctionNode: string | null;
  pendingPOI: string | null;
  pendingShop: string | null;
  winner: string | null;
  logs: string[];
  traversalTrace: TraversalStep[];
  rng: LCG;
  enableCandidateOnariLink: boolean;
}

export type GameAction =
  | { type: "ROLL_DICE"; forcedRoll?: number }
  | { type: "CHOOSE_JUNCTION_EDGE"; edgeId: string }
  | { type: "PASS_POI" }
  | { type: "STOP_AT_POI" }
  | { type: "VISIT_POI" }
  | { type: "BUY_RECOVERY" }
  | { type: "DECLINE_RECOVERY" }
  | { type: "PASS_SHOP" }
  | { type: "REACH_FINISH"; finishNode: string };

export function calculateFinalScore(player: {
  earnedPoints: number;
  spentPoints: number;
  stamina: number;
  status: PlayerStatus;
}): number {
  if (player.status === "DNF") return -1;
  return player.earnedPoints - player.spentPoints + player.stamina;
}

export function createInitialGameState(options: {
  rngSeed?: number;
  enableCandidateOnariLink?: boolean;
} = {}): GameState {
  const enableCandidateOnariLink = Boolean(options.enableCandidateOnariLink);
  const graph = loadGraph({ enableCandidateOnariLink });
  const startNode = graph.nodes.get(GAME_CONFIG.startNodeId);
  const startX = startNode ? startNode.worldX : -0.05;
  const startZ = startNode ? startNode.worldZ : -5.13;

  const amber: PlayerState = {
    id: "Amber",
    name: "Amber",
    color: "#e67340",
    status: "ACTIVE",
    stamina: GAME_CONFIG.startingStamina,
    earnedPoints: 0,
    spentPoints: 0,
    visitedPOIs: [],
    visitedShops: [],
    standingAtPOI: null,
    standingAtShop: null,
    currentNodeId: GAME_CONFIG.startNodeId,
    currentEdgeId: null,
    previousEdgeId: null,
    edgeDirection: null,
    edgeProgressWU: 0,
    position: { x: startX, z: startZ, yaw: 0 },
  };

  const teal: PlayerState = {
    id: "Teal",
    name: "Teal",
    color: "#2ea893",
    status: "ACTIVE",
    stamina: GAME_CONFIG.startingStamina,
    earnedPoints: 0,
    spentPoints: 0,
    visitedPOIs: [],
    visitedShops: [],
    standingAtPOI: null,
    standingAtShop: null,
    currentNodeId: GAME_CONFIG.startNodeId,
    currentEdgeId: null,
    previousEdgeId: null,
    edgeDirection: null,
    edgeProgressWU: 0,
    position: { x: startX, z: startZ, yaw: 0 },
  };

  return {
    graph,
    players: [amber, teal],
    activePlayerIndex: 0,
    phase: "TURN_START",
    currentRoll: null,
    remainingBudgetWU: 0,
    pendingJunctionNode: null,
    pendingPOI: null,
    pendingShop: null,
    winner: null,
    logs: ["Game started. Amber's turn."],
    traversalTrace: [],
    rng: new LCG(options.rngSeed ?? Date.now()),
    enableCandidateOnariLink,
  };
}

export function checkGameOver(state: GameState): boolean {
  const p0 = state.players[0];
  const p1 = state.players[1];

  const p0Done = p0.status === "FINISHED" || p0.status === "DNF";
  const p1Done = p1.status === "FINISHED" || p1.status === "DNF";

  if (!p0Done || !p1Done) {
    return false;
  }

  state.phase = "GAME_OVER";

  if (p0.status === "DNF" && p1.status === "DNF") {
    state.winner = null;
    state.logs.push("Double DNF! No winner.");
    return true;
  }

  if (p0.status === "FINISHED" && p1.status === "DNF") {
    state.winner = p0.name;
    state.logs.push(`${p0.name} finishes while ${p1.name} suffered DNF. ${p0.name} wins!`);
    return true;
  }

  if (p1.status === "FINISHED" && p0.status === "DNF") {
    state.winner = p1.name;
    state.logs.push(`${p1.name} finishes while ${p0.name} suffered DNF. ${p1.name} wins!`);
    return true;
  }

  // Both finished -> compare final score
  const s0 = calculateFinalScore(p0);
  const s1 = calculateFinalScore(p1);
  state.logs.push(`Both finished. ${p0.name}: ${s0} pts, ${p1.name}: ${s1} pts.`);

  if (s0 > s1) {
    state.winner = p0.name;
    state.logs.push(`${p0.name} wins with higher score!`);
  } else if (s1 > s0) {
    state.winner = p1.name;
    state.logs.push(`${p1.name} wins with higher score!`);
  } else {
    state.winner = "Tie";
    state.logs.push("Equal scores! The match is a tie.");
  }
  return true;
}

function rotateTurn(state: GameState): void {
  if (checkGameOver(state)) return;

  const currentIdx = state.activePlayerIndex;
  const otherIdx = 1 - currentIdx;

  // If the other player is still active, switch to other player
  if (state.players[otherIdx].status === "ACTIVE") {
    state.activePlayerIndex = otherIdx;
    state.phase = "TURN_START";
    state.currentRoll = null;
    state.remainingBudgetWU = 0;
    state.logs.push(`Turn rotated to ${state.players[otherIdx].name}.`);
  } else if (state.players[currentIdx].status === "ACTIVE") {
    // Other player is frozen/DNF, current player continues
    state.phase = "TURN_START";
    state.currentRoll = null;
    state.remainingBudgetWU = 0;
    state.logs.push(`${state.players[currentIdx].name} continues.`);
  } else {
    checkGameOver(state);
  }
}

export function getAvailableJunctionOptions(state: GameState): OutgoingEdgeOption[] {
  const player = state.players[state.activePlayerIndex];
  if (state.phase !== "JUNCTION_CHOICE" || player.status !== "ACTIVE" ||
      player.currentEdgeId || !player.currentNodeId ||
      state.pendingJunctionNode !== player.currentNodeId ||
      !Number.isFinite(state.remainingBudgetWU) || state.remainingBudgetWU <= 1e-6) return [];
  return state.graph.getOutgoingEdges(player.currentNodeId);
}

export function applyAction(state: GameState, action: GameAction): GameState {
  if (state.phase === "GAME_OVER") {
    throw new Error("Game is over; no further actions allowed.");
  }

  const player = state.players[state.activePlayerIndex];
  if (player.status !== "ACTIVE") {
    throw new Error(`Player ${player.name} is ${player.status} and cannot act.`);
  }

  switch (action.type) {
    case "ROLL_DICE": {
      if (state.phase !== "TURN_START") {
        throw new Error(`Cannot roll dice during phase ${state.phase}.`);
      }
      // If player stopped at POI, next turn is committed to VISIT_POI
      if (player.standingAtPOI) {
        throw new Error(`Player is committed to visiting ${player.standingAtPOI} this turn.`);
      }
      // Validate forcedRoll atomically before mutating stamina or state
      if (action.forcedRoll !== undefined) {
        if (!Number.isInteger(action.forcedRoll) || action.forcedRoll < 1 || action.forcedRoll > 3) {
          throw new Error(`Invalid forced dice roll: ${action.forcedRoll}. Must be integer 1, 2, or 3.`);
        }
      }

      if (player.stamina <= 0) {
        player.status = "DNF";
        state.logs.push(`${player.name} has 0 stamina and suffers DNF.`);
        rotateTurn(state);
        return state;
      }

      // Movement costs 1 stamina charged at turn start
      player.stamina -= 1;
      const roll = action.forcedRoll ?? state.rng.rollD3();
      state.currentRoll = roll;
      state.remainingBudgetWU = roll * GAME_CONFIG.stepDistanceWU;
      state.phase = "MOVING";
      state.logs.push(`${player.name} rolled ${roll} (budget: ${state.remainingBudgetWU.toFixed(2)} WU, stamina left: ${player.stamina}).`);

      // Clear standing flags upon rolling
      player.standingAtPOI = null;
      player.standingAtShop = null;

      // Advance player step along graph
      advancePlayerMovement(state);
      return state;
    }

    case "VISIT_POI": {
      if (state.phase !== "TURN_START") {
        throw new Error(`Cannot visit POI during phase ${state.phase}.`);
      }
      const poiId = player.standingAtPOI;
      if (!poiId) {
        throw new Error("Player is not standing at a POI to visit.");
      }
      if (player.stamina <= 0) {
        throw new Error("Insufficient stamina to visit POI.");
      }

      // Consumes 1 stamina, no roll, no move
      player.stamina -= 1;
      const points = GAME_CONFIG.poiScores[poiId] || 0;
      if (!player.visitedPOIs.includes(poiId)) {
        player.visitedPOIs.push(poiId);
        player.earnedPoints += points;
        state.logs.push(`${player.name} visited ${poiId} for ${points} points (cost 1 stamina, remaining: ${player.stamina}).`);
      } else {
        state.logs.push(`${player.name} visited ${poiId} again (no extra points, cost 1 stamina).`);
      }

      player.standingAtPOI = null;
      if (player.stamina === 0) {
        player.status = "DNF";
        state.logs.push(`${player.name} exhausted all stamina visiting ${poiId} and suffered DNF.`);
      }
      rotateTurn(state);
      return state;
    }

    case "PASS_POI": {
      if (state.phase !== "POI_DECISION") {
        throw new Error("Not in POI_DECISION phase.");
      }
      state.logs.push(`${player.name} passes ${state.pendingPOI} without stopping.`);
      state.pendingPOI = null;

      // If budget is exhausted upon passing POI, end move immediately before any junction
      if (state.remainingBudgetWU <= 1e-6) {
        state.remainingBudgetWU = 0;
        if (player.stamina === 0 && player.status === "ACTIVE") {
          player.status = "DNF";
          state.logs.push(`${player.name} has exhausted all stamina and suffers DNF.`);
        }
        rotateTurn(state);
        return state;
      }

      state.phase = "MOVING";
      advancePlayerMovement(state);
      return state;
    }

    case "STOP_AT_POI": {
      if (state.phase !== "POI_DECISION") {
        throw new Error("Not in POI_DECISION phase.");
      }
      const poiId = state.pendingPOI!;
      player.standingAtPOI = poiId;
      state.remainingBudgetWU = 0;
      state.pendingPOI = null;
      state.logs.push(`${player.name} stops at ${poiId}. Remainder discarded.`);

      if (player.stamina === 0) {
        player.status = "DNF";
        state.logs.push(`${player.name} stopped with 0 stamina and suffers DNF.`);
      }
      rotateTurn(state);
      return state;
    }

    case "BUY_RECOVERY": {
      if (state.phase !== "RESUPPLY_DECISION") {
        throw new Error("Not in RESUPPLY_DECISION phase.");
      }
      const shopId = state.pendingShop!;
      const availablePoints = player.earnedPoints - player.spentPoints;
      if (availablePoints < GAME_CONFIG.resupplyCost) {
        throw new Error("Insufficient earned points for recovery.");
      }
      if (player.visitedShops.includes(shopId)) {
        throw new Error(`Already visited shop ${shopId}.`);
      }

      player.spentPoints += GAME_CONFIG.resupplyCost;
      player.stamina = Math.min(GAME_CONFIG.maxStamina, player.stamina + GAME_CONFIG.resupplyGain);
      player.visitedShops.push(shopId);
      player.standingAtShop = shopId;
      state.remainingBudgetWU = 0;
      state.pendingShop = null;
      state.logs.push(`${player.name} purchased recovery at ${shopId} (-${GAME_CONFIG.resupplyCost} pts, +${GAME_CONFIG.resupplyGain} stamina -> ${player.stamina}). Remainder discarded.`);

      rotateTurn(state);
      return state;
    }

    case "DECLINE_RECOVERY": {
      if (state.phase !== "RESUPPLY_DECISION") {
        throw new Error("Not in RESUPPLY_DECISION phase.");
      }
      const shopId = state.pendingShop!;
      state.pendingShop = null;
      state.remainingBudgetWU = 0;
      state.logs.push(`${player.name} declined recovery at ${shopId}.`);

      if (player.stamina === 0) {
        player.status = "DNF";
        state.logs.push(`${player.name} has 0 stamina and suffers DNF.`);
      }
      rotateTurn(state);
      return state;
    }

    case "PASS_SHOP": {
      if (state.phase !== "RESUPPLY_DECISION") {
        throw new Error("Not in RESUPPLY_DECISION phase.");
      }
      const shopId = state.pendingShop!;
      state.logs.push(`${player.name} passes ${shopId} without stopping.`);
      state.pendingShop = null;

      // If budget is exhausted upon passing shop, end move immediately before any junction
      if (state.remainingBudgetWU <= 1e-6) {
        state.remainingBudgetWU = 0;
        if (player.stamina === 0 && player.status === "ACTIVE") {
          player.status = "DNF";
          state.logs.push(`${player.name} has 0 stamina and suffers DNF.`);
        }
        rotateTurn(state);
        return state;
      }

      state.phase = "MOVING";
      advancePlayerMovement(state);
      return state;
    }

    case "CHOOSE_JUNCTION_EDGE": {
      if (state.phase !== "JUNCTION_CHOICE") {
        throw new Error("Not in JUNCTION_CHOICE phase.");
      }
      const option = getAvailableJunctionOptions(state).find(opt => opt.edge.id === action.edgeId);
      if (!option) throw new Error(`Edge ${action.edgeId} is not a legal junction exit.`);
      const { edge, direction } = option;

      player.currentNodeId = null;
      player.currentEdgeId = edge.id;
      player.edgeDirection = direction;
      player.edgeProgressWU = 0;
      state.pendingJunctionNode = null;
      state.phase = "MOVING";
      state.logs.push(`${player.name} chose path ${edge.id} towards ${direction === "FORWARD" ? edge.to : edge.from}.`);

      advancePlayerMovement(state);
      return state;
    }

    case "REACH_FINISH": {
      // Must be a real configured beach finish (F-W or F-E)
      if (!GAME_CONFIG.finishNodeIds.includes(action.finishNode)) {
        throw new Error(`Invalid finish node: ${action.finishNode}. Must be one of configured beach finishes: ${GAME_CONFIG.finishNodeIds.join(", ")}.`);
      }
      // Must actually arrive at finish node; cannot finish remotely
      if (player.currentNodeId !== action.finishNode) {
        throw new Error(`Cannot reach finish remotely from ${player.currentNodeId || "edge"}; must arrive via graph traversal.`);
      }
      player.status = "FINISHED";
      player.currentNodeId = action.finishNode;
      player.currentEdgeId = null;
      player.edgeDirection = null;
      player.edgeProgressWU = 0;
      state.remainingBudgetWU = 0;
      state.logs.push(`${player.name} reached beach finish ${action.finishNode} successfully with ${player.stamina} stamina! Player frozen.`);
      rotateTurn(state);
      return state;
    }
  }
}

function advancePlayerMovement(state: GameState): void {
  const player = state.players[state.activePlayerIndex];

  // If currently at a node without an active edge, choose initial edge
  if (!player.currentEdgeId && player.currentNodeId) {
    const outgoing = state.graph.getOutgoingEdges(player.currentNodeId);
    if (outgoing.length === 0) {
      player.status = "DNF";
      state.logs.push(`${player.name} is at a dead end and suffers DNF.`);
      rotateTurn(state);
      return;
    }
    if (outgoing.length === 1) {
      const opt = outgoing[0];
      player.currentEdgeId = opt.edge.id;
      player.edgeDirection = opt.direction;
      player.edgeProgressWU = 0;
      player.currentNodeId = null;
    } else {
      state.phase = "JUNCTION_CHOICE";
      state.pendingJunctionNode = player.currentNodeId;
      return;
    }
  }

  while (state.remainingBudgetWU > 1e-6 && player.currentEdgeId) {
    const edge = state.graph.edges.get(player.currentEdgeId)!;
    const edgeLen = edge.worldLength;
    const startWU = player.edgeProgressWU;
    const distanceToEdgeEnd = edgeLen - startWU;

    if (state.remainingBudgetWU < distanceToEdgeEnd) {
      // Step finishes inside this edge
      const endWU = startWU + state.remainingBudgetWU;
      state.traversalTrace.push({
        playerId: player.id,
        edgeId: edge.id,
        direction: player.edgeDirection!,
        fromWU: startWU,
        toWU: endWU,
      });
      player.edgeProgressWU = endWU;
      state.remainingBudgetWU = 0;
      const pt = state.graph.samplePointAlongEdge(edge, player.edgeDirection!, endWU);
      player.position = pt;
      break;
    }

    // Travels to the end of the edge
    state.remainingBudgetWU -= distanceToEdgeEnd;
    state.traversalTrace.push({
      playerId: player.id,
      edgeId: edge.id,
      direction: player.edgeDirection!,
      fromWU: startWU,
      toWU: edgeLen,
    });
    player.edgeProgressWU = edgeLen;
    const targetNodeId = player.edgeDirection === "FORWARD" ? edge.to : edge.from;
    const pt = state.graph.samplePointAlongEdge(edge, player.edgeDirection!, edgeLen);
    player.position = pt;
    player.currentNodeId = targetNodeId;
    player.previousEdgeId = player.currentEdgeId;
    player.currentEdgeId = null;
    player.edgeDirection = null;
    player.edgeProgressWU = 0;

    // Check Beach Finish (D6)
    if (GAME_CONFIG.finishNodeIds.includes(targetNodeId)) {
      applyAction(state, { type: "REACH_FINISH", finishNode: targetNodeId });
      return;
    }

    // Check POI Encounter (D3-A)
    if (Object.prototype.hasOwnProperty.call(GAME_CONFIG.poiScores, targetNodeId) && !player.visitedPOIs.includes(targetNodeId)) {
      state.phase = "POI_DECISION";
      state.pendingPOI = targetNodeId;
      return;
    }

    // Check Resupply Shop Encounter (D8, D9)
    if ((targetNodeId === "R1" || targetNodeId === "R2") && !player.visitedShops.includes(targetNodeId)) {
      state.phase = "RESUPPLY_DECISION";
      state.pendingShop = targetNodeId;
      return;
    }

    // Check Outgoing Edges at target node
    const outgoing = state.graph.getOutgoingEdges(targetNodeId);
    if (outgoing.length === 0) {
      // Dead end
      state.remainingBudgetWU = 0;
      break;
    }
    if (outgoing.length === 1 && state.remainingBudgetWU > 1e-6) {
      // Continuous traversal through through-node
      player.currentNodeId = null;
      player.currentEdgeId = outgoing[0].edge.id;
      player.edgeDirection = outgoing[0].direction;
      player.edgeProgressWU = 0;
    } else if (outgoing.length > 1 && state.remainingBudgetWU > 1e-6) {
      // Junction choice needed with remaining budget
      state.phase = "JUNCTION_CHOICE";
      state.pendingJunctionNode = targetNodeId;
      return;
    }
  }

  // Turn finished
  if (state.phase === "MOVING") {
    state.remainingBudgetWU = 0;
    if (player.stamina === 0 && player.status === "ACTIVE") {
      player.status = "DNF";
      state.logs.push(`${player.name} has exhausted all stamina and suffers DNF.`);
    }
    rotateTurn(state);
  }
}
