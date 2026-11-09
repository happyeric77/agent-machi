import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

export const TRAILER_START_ZOOM = 0.55;
export const TRAILER_END_ZOOM = 1.8;
export const TRAILER_HOLD_SECONDS = 7;
export const TRAILER_ORBIT_SECONDS = 14;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Fixed camera move for ?trailer=1. It holds the wide front view while the
 * bridge's initial states settle, then zooms in and orbits once around the
 * town. It releases OrbitControls on the original front view at the end.
 */
export class TrailerCamera {
  private readonly spherical: THREE.Spherical;
  private elapsed = 0;
  private phase: "hold" | "orbit" | "done" = "hold";

  constructor(
    private readonly camera: THREE.OrthographicCamera,
    private readonly controls: OrbitControls,
    private readonly target: THREE.Vector3,
    private readonly offset: THREE.Vector3,
    private readonly holdSeconds = TRAILER_HOLD_SECONDS,
    private readonly orbitSeconds = TRAILER_ORBIT_SECONDS,
  ) {
    this.spherical = new THREE.Spherical().setFromVector3(offset);
    this.controls.enabled = false;
    this.camera.zoom = TRAILER_START_ZOOM;
    this.apply(0);
    this.setPhase("hold");
  }

  get active(): boolean {
    return this.phase !== "done";
  }

  update(dtSeconds: number): void {
    if (this.phase === "done") return;
    this.elapsed += dtSeconds;
    if (this.elapsed < this.holdSeconds) {
      this.apply(0);
      return;
    }
    const progress = Math.min(1, (this.elapsed - this.holdSeconds) / this.orbitSeconds);
    this.apply(progress);
    this.setPhase(progress < 1 ? "orbit" : "done");
    if (progress >= 1) {
      this.controls.target.copy(this.target);
      this.controls.enabled = true;
      this.controls.update();
    }
  }

  private apply(progress: number): void {
    const eased = easeInOutCubic(progress);
    this.camera.zoom = TRAILER_START_ZOOM + (TRAILER_END_ZOOM - TRAILER_START_ZOOM) * eased;
    this.camera.position
      .setFromSphericalCoords(
        this.spherical.radius,
        this.spherical.phi,
        this.spherical.theta + Math.PI * 2 * eased,
      )
      .add(this.target);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
  }

  private setPhase(phase: "hold" | "orbit" | "done"): void {
    this.phase = phase;
    document.body.dataset.trailerPhase = phase;
  }
}
