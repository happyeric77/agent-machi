// Standing spots for the three resident areas: the beach (idle), the station
// platform (blocked) and the town work area (working/done without a house).
// Each spot was probed against the built scene at 0.25 world units: walkable
// ground, clear of props, and a straight unobstructed walk from its entrance
// graph node. Minimum pairwise distance inside an area is 0.559, so characters
// stand apart for any count up to the visible cap.
export type AreaName = "beach" | "station" | "worksite";

export interface AreaSpot {
  id: string;
  area: AreaName;
  entrance: string;
  x: number;
  y: number;
  z: number;
}

export const AREA_SPOTS: readonly AreaSpot[] = [
  // beach
  { id: "beach-01", area: "beach", entrance: "F-W", x: -5.5, y: 0.549, z: 6.25 },
  { id: "beach-02", area: "beach", entrance: "F-W", x: -4.75, y: 0.556, z: 6.25 },
  { id: "beach-03", area: "beach", entrance: "F-W", x: -4, y: 0.59, z: 6.25 },
  { id: "beach-04", area: "beach", entrance: "CJ-C", x: -2.5, y: 0.59, z: 6.25 },
  { id: "beach-05", area: "beach", entrance: "CJ-C", x: -1.5, y: 0.59, z: 6.25 },
  { id: "beach-06", area: "beach", entrance: "CJ-C", x: -0.75, y: 0.59, z: 6.25 },
  { id: "beach-07", area: "beach", entrance: "CJ-C", x: 0.5, y: 0.59, z: 6.25 },
  { id: "beach-08", area: "beach", entrance: "CJ-C", x: 1.25, y: 0.59, z: 6.25 },
  { id: "beach-09", area: "beach", entrance: "CJ-C", x: 2.25, y: 0.59, z: 6.25 },
  { id: "beach-10", area: "beach", entrance: "CJ-E", x: 3.5, y: 0.59, z: 6.25 },
  { id: "beach-11", area: "beach", entrance: "P5", x: 4.25, y: 0.59, z: 6.25 },
  { id: "beach-12", area: "beach", entrance: "F-W", x: -3.5, y: 0.539, z: 6.5 },
  { id: "beach-13", area: "beach", entrance: "CJ-C", x: 0, y: 0.542, z: 6.5 },
  { id: "beach-14", area: "beach", entrance: "CJ-E", x: 3, y: 0.545, z: 6.5 },
  { id: "beach-15", area: "beach", entrance: "F-W", x: -5.25, y: 0.525, z: 6.75 },
  { id: "beach-16", area: "beach", entrance: "CJ-C", x: -0.5, y: 0.525, z: 6.75 },
  { id: "beach-17", area: "beach", entrance: "CJ-C", x: 1.5, y: 0.525, z: 6.75 },
  { id: "beach-18", area: "beach", entrance: "CJ-C", x: 2.5, y: 0.525, z: 6.75 },
  { id: "beach-19", area: "beach", entrance: "F-W", x: -4.25, y: 0.525, z: 7.0 },
  { id: "beach-20", area: "beach", entrance: "F-W", x: -2.75, y: 0.525, z: 7.0 },
  { id: "beach-21", area: "beach", entrance: "CJ-C", x: -2, y: 0.525, z: 7.0 },
  { id: "beach-22", area: "beach", entrance: "CJ-C", x: -1, y: 0.525, z: 7.0 },
  { id: "beach-23", area: "beach", entrance: "CJ-C", x: 0.75, y: 0.525, z: 7.0 },
  { id: "beach-24", area: "beach", entrance: "CJ-C", x: 2, y: 0.525, z: 7.0 },
  // station
  { id: "station-01", area: "station", entrance: "road-2-N", x: 3, y: 0.59, z: -6.75 },
  { id: "station-02", area: "station", entrance: "road-2-N", x: 4, y: 0.59, z: -6.75 },
  { id: "station-03", area: "station", entrance: "road-1-N", x: -2.75, y: 0.59, z: -6.5 },
  { id: "station-04", area: "station", entrance: "road-1-N", x: -1.75, y: 0.59, z: -6.5 },
  { id: "station-05", area: "station", entrance: "road-2-N", x: 2.5, y: 0.59, z: -6.5 },
  { id: "station-06", area: "station", entrance: "road-1-N", x: -2.25, y: 0.59, z: -6.25 },
  { id: "station-07", area: "station", entrance: "road-2-N", x: 3.5, y: 0.59, z: -6.25 },
  { id: "station-08", area: "station", entrance: "Onari-north", x: -2, y: 0.6, z: -5.75 },
  { id: "station-09", area: "station", entrance: "road-2-N", x: 3, y: 0.59, z: -5.75 },
  { id: "station-10", area: "station", entrance: "Onari-north", x: -2.5, y: 0.6, z: -5.5 },
  { id: "station-11", area: "station", entrance: "Onari-north", x: -1.5, y: 0.59, z: -5.5 },
  { id: "station-12", area: "station", entrance: "S-3", x: 1, y: 0.59, z: -5.5 },
  { id: "station-13", area: "station", entrance: "S-3", x: 1.75, y: 0.59, z: -5.5 },
  { id: "station-14", area: "station", entrance: "P3", x: 4, y: 0.602, z: -5.5 },
  { id: "station-15", area: "station", entrance: "S-3", x: 0.5, y: 0.59, z: -5.25 },
  { id: "station-16", area: "station", entrance: "P3", x: 3.25, y: 0.602, z: -5.25 },
  { id: "station-17", area: "station", entrance: "road-7-N", x: -2.25, y: 0.6, z: -5 },
  { id: "station-18", area: "station", entrance: "road-7-S", x: -0.75, y: 0.59, z: -5 },
  { id: "station-19", area: "station", entrance: "P3", x: 3.75, y: 0.602, z: -5 },
  { id: "station-20", area: "station", entrance: "CJ-OW", x: -2.75, y: 0.6, z: -4.5 },
  { id: "station-21", area: "station", entrance: "road-7-N", x: -2, y: 0.614, z: -4.5 },
  { id: "station-22", area: "station", entrance: "road-7-S", x: -1.25, y: 0.614, z: -4.5 },
  { id: "station-23", area: "station", entrance: "road-5-N", x: 0, y: 0.61, z: -4.5 },
  { id: "station-24", area: "station", entrance: "P3", x: 3.5, y: 0.602, z: -4.5 },
  // worksite
  { id: "worksite-01", area: "worksite", entrance: "J-5-6", x: -1, y: 0.59, z: 3.25 },
  { id: "worksite-02", area: "worksite", entrance: "J-5-6", x: 0.25, y: 0.61, z: 3.25 },
  { id: "worksite-03", area: "worksite", entrance: "J-5-6", x: -0.5, y: 0.59, z: 3.75 },
  { id: "worksite-04", area: "worksite", entrance: "road-2-S", x: 4.5, y: 0.59, z: 4 },
  { id: "worksite-05", area: "worksite", entrance: "CF-W", x: -4.5, y: 0.596, z: 4.25 },
  { id: "worksite-06", area: "worksite", entrance: "P5", x: 3.5, y: 0.602, z: 4.25 },
  { id: "worksite-07", area: "worksite", entrance: "road-5-S", x: 0, y: 0.61, z: 4.5 },
  { id: "worksite-08", area: "worksite", entrance: "CF-W", x: -4.25, y: 0.59, z: 4.75 },
  { id: "worksite-09", area: "worksite", entrance: "road-5-S", x: -1, y: 0.59, z: 4.75 },
  { id: "worksite-10", area: "worksite", entrance: "road-2-S", x: 4, y: 0.602, z: 4.75 },
  { id: "worksite-11", area: "worksite", entrance: "road-5-S", x: 0.75, y: 0.606, z: 5 },
  { id: "worksite-12", area: "worksite", entrance: "road-5-S", x: 1.5, y: 0.606, z: 5 },
  { id: "worksite-13", area: "worksite", entrance: "road-2-S", x: 2.75, y: 0.606, z: 5 },
  { id: "worksite-14", area: "worksite", entrance: "CF-W", x: -4.75, y: 0.606, z: 5.25 },
  { id: "worksite-15", area: "worksite", entrance: "CJ-C", x: -1.5, y: 0.606, z: 5.25 },
  { id: "worksite-16", area: "worksite", entrance: "CJ-C", x: -0.25, y: 0.606, z: 5.25 },
  { id: "worksite-17", area: "worksite", entrance: "CF-E", x: 4.75, y: 0.606, z: 5.25 },
  { id: "worksite-18", area: "worksite", entrance: "CF-W", x: -3.75, y: 0.606, z: 5.5 },
  { id: "worksite-19", area: "worksite", entrance: "CJ-E", x: 3.5, y: 0.606, z: 5.5 },
  { id: "worksite-20", area: "worksite", entrance: "CJ-C", x: -1, y: 0.59, z: 5.75 },
  { id: "worksite-21", area: "worksite", entrance: "CJ-C", x: 0.75, y: 0.59, z: 5.75 },
  { id: "worksite-22", area: "worksite", entrance: "CJ-C", x: 1.5, y: 0.59, z: 5.75 },
  { id: "worksite-23", area: "worksite", entrance: "CJ-E", x: 2.25, y: 0.59, z: 5.75 },
  { id: "worksite-24", area: "worksite", entrance: "CJ-E", x: 4.25, y: 0.59, z: 5.75 },
];

export function spotById(id: string): AreaSpot | null {
  return AREA_SPOTS.find((spot) => spot.id === id) ?? null;
}

/** First free spot from the resident's hash offset, so neighbours scatter. */
export function pickAreaSpot(
  area: AreaName,
  seed: number,
  taken: ReadonlySet<string>,
): AreaSpot | null {
  const spots = AREA_SPOTS.filter((spot) => spot.area === area);
  if (spots.length === 0) return null;
  const start = Math.abs(Math.trunc(seed)) % spots.length;
  for (let step = 0; step < spots.length; step += 1) {
    const spot = spots[(start + step) % spots.length];
    if (!taken.has(spot.id)) return spot;
  }
  return null;
}
