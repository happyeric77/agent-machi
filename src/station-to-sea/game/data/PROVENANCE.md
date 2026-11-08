# Graph Data Provenance (G3 v0.8)

## 1. Source Origin
- Copied from: `/private/var/folders/m_/gmgrd20s5xdgkgxn5ztl1hv40000gn/T/opencode/station-g3-v07c/verification/output/`
- Files:
  - `graph-nodes.json` (39 nodes)
  - `graph-edges.json` (42 edges)
- Upstream verification baseline: G3 v0.7c/v0.7d road connectivity & graph audit.

## 2. Node Status & Approval Metadata
- **Owner Accepted (Superseding old candidate metadata)**:
  - `P2`: `(-4.610, -1.400)` — back-alley attraction.
  - `F-W`: `(-5.450, 5.950)` — west beach finish beside posts.
  - `F-E`: `(5.450, 5.950)` — east beach finish beside posts.
- **Candidate Nodes (Pending Owner Approval)**:
  - `S`: `(-0.050, -5.130)` — station plaza start candidate.
  - `P1`: `(-2.568, -3.911)` — Onari street attraction candidate.
  - `P3`: `(3.746, -4.901)` — Wakamiya avenue attraction candidate.
  - `P4`: `(0.100, -3.200)` — Central residential lane attraction candidate.
  - `P5`: `(3.671, 3.530)` — Ichino-torii attraction candidate.
  - `R1`: `(-2.640, -2.622)` — Onari teahouse resupply shop candidate.
  - `R2`: `(3.758, -3.332)` — Wakamiya cafe resupply shop candidate.

## 3. Edge Status & Routing Constraints
- **Usable Edges**: 40 edges have `runtimeCollisionStatus: "FINITE_SAMPLE_PASS"`.
- **Status Integrity**: Any edge with `UNKNOWN` or non-pass status is preserved verbatim as `UNKNOWN`; the loader never auto-upgrades non-blocked edges.
- **Blocked Edges (Permanently Inaccessible)**:
  - `road-6-1`: `from=road-6-N to=J-5-6` (`BLOCKED`).
  - `road-6-2`: `from=J-5-6 to=road-6-S` (`BLOCKED`).
  - Station east shortcut (`gap-station-east`) is blocked / separate diagnostic, not part of the active 42-edge graph.
  - Blocked roads must never be enabled, even in Test Mode.
- **Candidate Link (Default OFF)**:
  - `link-Onari-north-road-1-N`: `from=Onari-north to=road-1-N` (0.2277 WU, finite sample pass, unapproved).
  - Must remain **DEFAULT OFF**; only enabled via explicit UI checkbox or test flag.
- **Prototype / Test Mode**:
  - Unapproved finite-sample pass paths can be traversed in Prototype / Test Mode with clear labelling.
