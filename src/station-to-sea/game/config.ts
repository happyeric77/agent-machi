export interface GameConfig {
  readonly startingStamina: number;
  readonly maxStamina: number;
  readonly stepDistanceWU: number;
  readonly poiScores: Readonly<Record<string, number>>;
  readonly resupplyCost: number;
  readonly resupplyGain: number;
  readonly startNodeId: string;
  readonly finishNodeIds: readonly string[];
}

export const GAME_CONFIG: GameConfig = {
  startingStamina: 18,
  maxStamina: 18,
  stepDistanceWU: 1.0,
  poiScores: {
    P1: 6,
    P2: 12,
    P3: 8,
    P4: 4,
    P5: 7,
  },
  resupplyCost: 3,
  resupplyGain: 2,
  startNodeId: "S",
  finishNodeIds: ["F-W", "F-E"],
};
