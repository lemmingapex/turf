import Benchmark from "benchmark";
import { ellipse } from "./index.js";

/**
 * Benchmark Results (Apple M4 Max, Node 24)
 *
 * turf-ellipse - 8 steps x 418,712 ops/sec ±0.20% (101 runs sampled)
 * turf-ellipse - 64 steps x 116,508 ops/sec ±0.25% (100 runs sampled)
 * turf-ellipse - 256 steps x 30,058 ops/sec ±0.22% (99 runs sampled)
 * turf-ellipse - arcTolerance 1 km x 23,446 ops/sec ±0.18% (98 runs sampled)
 * turf-ellipse - arcTolerance 10 m x 3,725 ops/sec ±0.27% (100 runs sampled)
 * turf-ellipse - arcTolerance 10 m, equalarea x 2,075 ops/sec ±0.13% (98 runs sampled)
 * turf-ellipse - arcTolerance 10 cm x 429 ops/sec ±0.16% (97 runs sampled)
 *
 */
const suite = new Benchmark.Suite("turf-ellipse");
const center = [-73.9975, 40.730833];
const xSemiAxis = 50;
const ySemiAxis = 10;

suite
  .add("turf-ellipse - 8 steps", () =>
    ellipse(center, xSemiAxis, ySemiAxis, { steps: 8 })
  )
  .add("turf-ellipse - 64 steps", () =>
    ellipse(center, xSemiAxis, ySemiAxis, { steps: 64 })
  )
  .add("turf-ellipse - 256 steps", () =>
    ellipse(center, xSemiAxis, ySemiAxis, { steps: 256 })
  )
  // arcTolerance searches for the fewest steps that meet it; on this 5:1
  // ellipse these choose 28, 524 (484 for equalarea) and 5253 steps
  .add("turf-ellipse - arcTolerance 1 km", () =>
    ellipse(center, xSemiAxis, ySemiAxis, { arcTolerance: 1 })
  )
  .add("turf-ellipse - arcTolerance 10 m", () =>
    ellipse(center, xSemiAxis, ySemiAxis, { arcTolerance: 0.01 })
  )
  .add("turf-ellipse - arcTolerance 10 m, equalarea", () =>
    ellipse(center, xSemiAxis, ySemiAxis, {
      arcTolerance: 0.01,
      method: "equalarea",
    })
  )
  .add("turf-ellipse - arcTolerance 10 cm", () =>
    ellipse(center, xSemiAxis, ySemiAxis, { arcTolerance: 0.0001 })
  )
  .on("cycle", (e) => console.log(String(e.target)))
  .run();
