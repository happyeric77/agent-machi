// Beach standing spots are agent-machi data, not graph data. The coast is
// authored in local coordinates then scaled x1.65 and moved +2.82 in z by
// main.ts. These points sit on the dry sand band, just inland of the surf.
export interface BeachSpot {
  id: string;
  entrance: "F-W" | "F-E";
  x: number;
  z: number;
}

export const BEACH_SPOTS: readonly BeachSpot[] = [
  { id: "W1", entrance: "F-W", x: -4.35, z: 6.66 },
  { id: "W2", entrance: "F-W", x: -3.25, z: 6.78 },
  { id: "W3", entrance: "F-W", x: -2.15, z: 6.64 },
  { id: "E1", entrance: "F-E", x: 2.15, z: 6.64 },
  { id: "E2", entrance: "F-E", x: 3.25, z: 6.78 },
  { id: "E3", entrance: "F-E", x: 4.35, z: 6.66 },
];

export function beachSpot(id: string): BeachSpot | null {
  return BEACH_SPOTS.find((spot) => spot.id === id) ?? null;
}
