/**
 * Linear Congruential Generator (LCG) for reproducible, deterministic dice rolls.
 * Parameters from Numerical Recipes (a = 1664525, c = 1013904223, m = 2^32).
 */
export class LCG {
  private state: number;

  constructor(seed: number = 1) {
    this.state = (seed >>> 0);
  }

  /**
   * Generates a 32-bit unsigned pseudo-random integer.
   */
  next(): number {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }

  /**
   * Returns a pseudo-random floating point number in [0, 1).
   */
  random(): number {
    return this.next() / 4294967296;
  }

  /**
   * Rolls a d3 dice: uniform integer in {1, 2, 3}.
   */
  rollD3(): number {
    return Math.floor(this.random() * 3) + 1;
  }
}
