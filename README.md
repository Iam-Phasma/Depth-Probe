# DEPTH-PROBE // Vector Edition

A minimalist browser game. You pilot a deep-sea drone down a procedurally generated hadal trench, collecting bioluminescent nodes to recharge your battery while the canyon walls close in around you.

## Play

Open `index.html` directly in any modern browser, or host via [GitHub Pages](https://pages.github.com/) — no build step, no dependencies.

## Controls

| Input         | Action          |
| ------------- | --------------- |
| `A` / `←`     | Rotate left     |
| `D` / `→`     | Rotate right    |
| `W` / `↑`     | Thrust          |
| `Space`       | Brake           |
| Click / Touch | Start / Restart |

## Mechanics

- **Buoyancy** constantly pushes the probe upward — you must fight to descend
- **Battery** drains over time and faster when thrusting; depletes faster with depth
- **Bio-nodes** restore battery — but spacing between them grows the deeper you go
- **Canyon walls** meander and narrow with depth; collision is instant death

## Tech

- HTML5 Canvas 2D — all rendering is vector/procedural, no images
- Web Audio API — fully synthesised sound (ambient drone, thruster, collect chime, death crunch)
- 1D Perlin noise + fBm for canyon wall roughness and centerline curvature
- Zero dependencies, zero build tooling
