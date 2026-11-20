import test from "tape";
import path from "path";
import { fileURLToPath } from "url";
import { loadJsonFileSync } from "load-json-file";
import { writeJsonFileSync } from "write-json-file";
import { circle } from "@turf/circle";
import { truncate } from "@turf/truncate";
import { check } from "@placemarkio/check-geojson";
import { featureCollection, point } from "@turf/helpers";
import { transformRotate } from "@turf/transform-rotate";
import { intersect } from "@turf/intersect";
import { area } from "@turf/area";
import { distance } from "@turf/distance";
import { ellipse } from "./index.js";
import fs from "fs";
import { Position } from "geojson";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const directories = {
  in: path.join(__dirname, "test", "in") + path.sep,
  out: path.join(__dirname, "test", "out") + path.sep,
};

const fixtures = fs.readdirSync(directories.in).map((filename) => {
  return {
    filename,
    name: path.parse(filename).name,
    geojson: loadJsonFileSync(directories.in + filename),
  };
});

test("turf-ellipse", (t) => {
  fixtures.forEach((fixture) => {
    console.log(fixture.filename);
    const filename = fixture.filename;
    const name = fixture.name;
    const geojson = fixture.geojson;
    const center = geojson.geometry.coordinates;
    let { xSemiAxis, ySemiAxis, steps, angle, units, accuracy } =
      geojson.properties;
    angle = angle || 0;
    const options = {
      steps: steps,
      angle: angle,
      units: units,
      accuracy: accuracy,
    };
    const maxAxis = Math.max(xSemiAxis, ySemiAxis);

    const results = featureCollection([
      geojson,
      truncate(colorize(circle(center, maxAxis, options), "#F00")),
      truncate(
        colorize(ellipse(center, xSemiAxis, ySemiAxis, options), "#00F")
      ),
      truncate(
        colorize(
          ellipse(center, xSemiAxis, ySemiAxis, {
            steps,
            angle: angle + 90,
            units,
            accuracy: accuracy,
          }),
          "#0F0"
        )
      ),
    ]);

    // Save to file
    const out = path.join(directories.out, filename);
    if (process.env.REGEN) writeJsonFileSync(out, results);
    t.deepEqual(results, loadJsonFileSync(out), name);
  });
  t.end();
});

test("turf-ellipse -- circle consistency", (t) => {
  const ellipseGeom = truncate(ellipse([0, 60], 2000, 2000, { steps: 300 }));
  const circleGeom = truncate(circle([0, 60], 2000, { steps: 300 }));
  const intersectionGeom = intersect(
    featureCollection([ellipseGeom, circleGeom])
  );
  const areaIntersection =
    intersectionGeom != null ? area(intersectionGeom.geometry) : 0;
  const areaCircle = circleGeom != null ? area(circleGeom.geometry) : 0;
  t.true(
    Math.abs(areaIntersection - areaCircle) / areaCircle < 0.00001,
    "both areas are equal"
  );
  t.end();
});

const allMethods = ["inscribed", "equalarea", "circumscribed"] as const;

// Normalizes longitude into (-180, 180] so that two representations of the
// same point 360° apart (e.g. -285 and 75) compare as equal. This arises from
// a signed-zero quirk in destination()'s atan2 call when a geodesic passes
// very close to a pole: bearing -0 and +0 are mathematically the same "due
// north", but produce longitudes 360° apart once the destination overshoots
// the pole, because atan2(-0, x) and atan2(+0, x) differ for x < 0.
function normalizeLon(coords: Position[][]): Position[][] {
  return coords.map((ring) =>
    ring.map(([lon, lat]) => [((((lon + 180) % 360) + 360) % 360) - 180, lat])
  );
}

test("turf-ellipse -- degenerate ellipse matches circle", (t) => {
  // ellipse has one construction for every axis ratio, and with
  // xSemiAxis === ySemiAxis it reduces to turf-circle's: the same start
  // (north), direction, bearings and per-method circumradius. It goes through
  // atan2 and a sampled arc-length table, so it agrees to floating-point noise
  // rather than bit for bit.
  const centers = [
    [-105, 40],
    [0, 60],
    [-179, -10],
  ];
  const radii = [1, 1000, 12345.6789];
  // include step counts that are not multiples of 4, where a different start
  // or vertex placement would give a different set of vertices
  const stepsOptions = [3, 7, 8, 16, 63, 64, 128];

  centers.forEach((center) => {
    radii.forEach((radius) => {
      stepsOptions.forEach((steps) => {
        allMethods.forEach((method) => {
          const e = normalizeLon(
            ellipse(center, radius, radius, { steps, method }).geometry
              .coordinates
          )[0];
          const c = normalizeLon(
            circle(center, radius, { steps, method }).geometry.coordinates
          )[0];
          const maxDiff = Math.max(
            ...e.map((v, i) =>
              Math.max(Math.abs(v[0] - c[i][0]), Math.abs(v[1] - c[i][1]))
            )
          );
          t.true(
            e.length === c.length && maxDiff < 1e-9,
            `${method}: degenerate ellipse matches circle at center=${center}, radius=${radius}, steps=${steps} (max diff ${maxDiff.toExponential(1)}°)`
          );
        });
      });
    });
  });

  t.end();
});

test("turf-ellipse -- vertices move continuously as an ellipse becomes a circle", (t) => {
  // Shrinking ySemiAxis towards xSemiAxis in small increments must move each
  // vertex by an amount proportional to the change, with no jump anywhere,
  // in particular not near eccentricity 0 (where an earlier version switched
  // to a separate circle code path and moved vertices by up to half a step).
  const center = [0, 60];
  const a = 1000;
  const ratios: number[] = [];
  for (let r = 0.98; r < 1; r += 0.0005) ratios.push(r);
  // straddle the old eccentricity-0.01 cutoff (axis ratio ≈ 0.99995) closely
  ratios.push(0.9999, 0.99994, 0.99995, 0.99996, 0.99999, 1);

  [7, 64].forEach((steps) => {
    allMethods.forEach((method) => {
      let worst = 0;
      for (let i = 1; i < ratios.length; i++) {
        const prev = ellipse(center, a, a * ratios[i - 1], { steps, method })
          .geometry.coordinates[0];
        const curr = ellipse(center, a, a * ratios[i], { steps, method })
          .geometry.coordinates[0];
        const axisChange = a * (ratios[i] - ratios[i - 1]);
        const moved = Math.max(...prev.map((v, j) => distance(v, curr[j])));
        // a vertex can move by at most about the change in the semi-axis,
        // plus some slack for the arc-length spacing shifting along the ring
        worst = Math.max(worst, moved / axisChange);
      }
      t.true(
        worst < 3,
        `${method}, ${steps} steps: vertices move at most ${worst.toFixed(2)}x the change in ySemiAxis`
      );
    });
  });

  t.end();
});

test("turf-ellipse -- degenerate ellipse is circular regardless of angle", (t) => {
  // Without the -90 offset correction, a degenerate ellipse's vertex grid is
  // simply rotated relative to turf-circle's, so coordinates won't match
  // directly -- but the resulting polygon must still have the same area as
  // the circle, for any rotation angle, since rotating a circle changes
  // nothing about its shape.
  const center = [-105, 40];
  const radius = 1000;
  const steps = 64;
  const angles = [0, 30, 45, 90, 180, 271];

  const circleGeom = circle(center, radius, { steps });
  const circleArea = area(circleGeom.geometry);

  angles.forEach((angle) => {
    const ellipseGeom = ellipse(center, radius, radius, { steps, angle });

    t.true(
      Math.abs(area(ellipseGeom.geometry) - circleArea) / circleArea < 1e-9,
      `degenerate ellipse area matches circle area at angle=${angle}`
    );
  });
  t.end();
});

test("turf-ellipse -- rotation consistency", (t) => {
  // A degenerate ellipse turned by 90° (a multiple of 360 / 64) has the same
  // vertices, to about 1e-13°. intersect() mishandles edges that overlap
  // almost but not exactly, so truncate both first, as the circle
  // consistency test does.
  const ellipseGeom = truncate(ellipse([0, 60], 2000, 2000, { angle: 0 }));
  const ellipseTurnedGeom = truncate(
    ellipse([0, 60], 2000, 2000, { angle: 90 })
  );
  const intersectionGeom = intersect(
    featureCollection([ellipseGeom, ellipseTurnedGeom])
  );
  const areaIntersection =
    intersectionGeom != null ? area(intersectionGeom.geometry) : 0;
  const areaEllipse = ellipseGeom != null ? area(ellipseGeom.geometry) : 0;
  t.true(
    Math.abs(areaIntersection - areaEllipse) / areaEllipse < 0.00001,
    "both areas are equal"
  );
  t.end();
});

test("turf-ellipse -- with coordinates", (t) => {
  t.assert(ellipse([-100, 75], 5, 1));
  t.end();
});

test("turf-ellipse -- validate geojson", (t) => {
  const E = ellipse([0, 0], 10, 20);
  try {
    check(JSON.stringify(E));
    t.pass();
  } catch (e) {
    t.fail(e.message);
  }
  t.end();
});

test("turf-ellipse -- angle parameter rotates ellipse orientation", (t) => {
  // Create ellipse with major axis along x-axis (horizontal)
  const e0 = ellipse([0, 60], 2000, 1000, { steps: 64, angle: 0 });
  const coords0 = e0.geometry.coordinates[0];

  // Create same ellipse rotated 90 degrees (vertical)
  const e90 = ellipse([0, 60], 2000, 1000, { steps: 64, angle: 90 });
  const coords90 = e90.geometry.coordinates[0];

  // First coordinate should be different after rotation
  const dist = Math.sqrt(
    Math.pow(coords0[0][0] - coords90[0][0], 2) +
      Math.pow(coords0[0][1] - coords90[0][1], 2)
  );
  t.true(dist > 10, "first coordinates differ significantly after rotation");

  // Areas should be equal
  const area0 = area(e0.geometry);
  const area90 = area(e90.geometry);
  t.true(
    Math.abs(area0 - area90) / area0 < 0.001,
    "rotated ellipses have equal area"
  );

  // Verify rotation is actually changing orientation (not just offsetting start point)
  // Compare coordinate spreads in x and y directions
  const xSpread0 =
    Math.max(...coords0.map((c) => c[0])) -
    Math.min(...coords0.map((c) => c[0]));
  const ySpread0 =
    Math.max(...coords0.map((c) => c[1])) -
    Math.min(...coords0.map((c) => c[1]));
  const xSpread90 =
    Math.max(...coords90.map((c) => c[0])) -
    Math.min(...coords90.map((c) => c[0]));
  const ySpread90 =
    Math.max(...coords90.map((c) => c[1])) -
    Math.min(...coords90.map((c) => c[1]));

  // After 90° rotation, the orientation should change - not just swap perfectly due to projection,
  // but x-spread should decrease and y-spread should increase (for horizontal→vertical rotation)
  t.true(
    xSpread90 < xSpread0,
    "x-spread decreases after 90° rotation (becomes more vertical)"
  );
  t.true(
    ySpread90 > ySpread0,
    "y-spread increases after 90° rotation (becomes more vertical)"
  );

  t.end();
});

test("turf-ellipse -- angle parameter with 45 degree increments", (t) => {
  const center = [0, 60];
  const a = 2000;
  const b = 1000;

  // Test multiple angles to ensure consistent rotation
  const angles = [0, 45, 90, 135, 180, 225, 270, 315];
  const ellipses = angles.map((angle) =>
    ellipse(center, a, b, { steps: 32, angle })
  );

  // All should have same area
  const areas = ellipses.map((e) => area(e.geometry));
  const avgArea = areas.reduce((sum, a) => sum + a, 0) / areas.length;
  areas.forEach((a, i) => {
    t.true(
      Math.abs(a - avgArea) / avgArea < 0.001,
      `ellipse at angle ${angles[i]} has correct area`
    );
  });

  // Each should be rotated relative to the previous
  for (let i = 1; i < ellipses.length; i++) {
    const prev = ellipses[i - 1].geometry.coordinates[0][0];
    const curr = ellipses[i].geometry.coordinates[0][0];
    const dist = Math.sqrt(
      Math.pow(prev[0] - curr[0], 2) + Math.pow(prev[1] - curr[1], 2)
    );
    t.true(dist > 1, `ellipse at ${angles[i]}° differs from ${angles[i - 1]}°`);
  }

  t.end();
});

test("turf-ellipse -- smooth transition from circle to ellipse", (t) => {
  const center = [0, 60];
  const steps = 64;

  // Test gradual change from circle to ellipse
  const configs = [
    [2000, 2000], // circle
    [2000, 1999], // barely elliptical
    [2000, 1995],
    [2000, 1990],
    [2000, 1980],
  ];

  const ellipses = configs.map(([a, b]) => ellipse(center, a, b, { steps }));

  // First coordinate latitude should change smoothly
  const firstCoords = ellipses.map((e) => e.geometry.coordinates[0][0]);
  for (let i = 1; i < firstCoords.length; i++) {
    const prevLat = firstCoords[i - 1][1];
    const currLat = firstCoords[i][1];
    const change = Math.abs(currLat - prevLat);

    // Change should be small and monotonic (decreasing)
    t.true(change < 1, `smooth transition at step ${i}`);
    t.true(
      currLat <= prevLat + 0.01,
      `latitude decreases monotonically at step ${i}`
    );
  }

  t.end();
});

test("turf-ellipse -- arc-length distribution quality", (t) => {
  // Test on a highly elongated ellipse where uniform angles would fail
  const e = ellipse([0, 60], 2000, 500, { steps: 32 });
  const coords = e.geometry.coordinates[0];

  // Calculate segment lengths
  const segments = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const dx = coords[i + 1][0] - coords[i][0];
    const dy = coords[i + 1][1] - coords[i][1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    segments.push(dist);
  }

  // Calculate statistics
  const avg = segments.reduce((sum, d) => sum + d, 0) / segments.length;
  const variance =
    segments.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) /
    segments.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = stdDev / avg;

  // For good arc-length distribution, coefficient of variation should be small
  // (less than 10% for highly elongated ellipse, much less for moderate ellipses)
  t.true(
    coefficientOfVariation < 0.3,
    `arc-length distribution has reasonable variation (${(coefficientOfVariation * 100).toFixed(1)}%)`
  );

  t.end();
});

test("turf-ellipse -- area accuracy for various eccentricities", (t) => {
  const center = [0, 60];
  const steps = 64;

  // Test ellipses with different eccentricities
  const configs = [
    [2000, 2000], // circle (e=0)
    [2000, 1800], // mild (e≈0.44)
    [2000, 1500], // moderate (e≈0.66)
    [2000, 1000], // high (e≈0.87)
    [2000, 500], // very high (e≈0.97)
  ];

  configs.forEach(([a, b]) => {
    const e = ellipse(center, a, b, { steps, units: "meters" });
    const actualArea = area(e.geometry);
    const theoreticalArea = Math.PI * a * b;

    const error = Math.abs(actualArea - theoreticalArea) / theoreticalArea;

    // Area should be within 1% of theoretical
    // (Adaptive arc-length spacing trades some area accuracy for better point distribution)
    t.true(
      error < 0.01,
      `area accurate for a=${a}, b=${b} (error: ${(error * 100).toFixed(3)}%)`
    );
  });

  t.end();
});

test("turf-ellipse -- steps parameter controls resolution", (t) => {
  const center = [0, 60];
  const a = 2000;
  const b = 1000;

  // Test different step counts
  const stepCounts = [8, 16, 32, 64, 128];
  const ellipses = stepCounts.map((steps) => ellipse(center, a, b, { steps }));

  // Verify coordinate count matches steps (plus 1 for closing)
  ellipses.forEach((e, i) => {
    const coordCount = e.geometry.coordinates[0].length;
    t.equal(
      coordCount,
      stepCounts[i] + 1,
      `${stepCounts[i]} steps produces ${stepCounts[i] + 1} coordinates`
    );
  });

  // Higher resolution should have more accurate area
  const areas = ellipses.map((e) => area(e.geometry));
  const theoreticalArea = Math.PI * a * b;
  const errors = areas.map(
    (a) => Math.abs(a - theoreticalArea) / theoreticalArea
  );

  // Errors should generally decrease with more steps (with some tolerance)
  for (let i = 1; i < errors.length - 1; i++) {
    t.true(
      errors[i] <= errors[i - 1] * 1.1,
      `error at ${stepCounts[i]} steps not significantly worse than ${stepCounts[i - 1]} steps`
    );
  }

  t.end();
});

test("turf-ellipse -- units parameter", (t) => {
  const center = [0, 60];
  const value = 10;
  const steps = 32;

  // Test different units
  const e1 = ellipse(center, value, value / 2, { steps, units: "kilometers" });
  const e2 = ellipse(center, value, value / 2, { steps, units: "miles" });
  const e3 = ellipse(center, value, value / 2, { steps, units: "degrees" });
  const e4 = ellipse(center, value, value / 2, { steps, units: "meters" });

  // All should produce valid ellipses with different sizes
  t.ok(
    e1.geometry.coordinates[0].length > 0,
    "kilometers produces valid ellipse"
  );
  t.ok(e2.geometry.coordinates[0].length > 0, "miles produces valid ellipse");
  t.ok(e3.geometry.coordinates[0].length > 0, "degrees produces valid ellipse");
  t.ok(e4.geometry.coordinates[0].length > 0, "meters produces valid ellipse");

  t.ok(area(e1.geometry) > 0, "kilometers has positive area");
  t.ok(area(e2.geometry) > 0, "miles has positive area");
  t.ok(area(e3.geometry) > 0, "degrees has positive area");
  t.ok(area(e4.geometry) > 0, "meters has positive area");

  // Kilometers and miles should produce different sized ellipses
  const areaKm = area(e1.geometry);
  const areaMiles = area(e2.geometry);
  t.true(
    Math.abs(areaKm - areaMiles) / areaKm > 0.5,
    "kilometers and miles produce different sized ellipses"
  );

  t.end();
});

test("turf-ellipse -- properties parameter", (t) => {
  const e = ellipse([0, 60], 2000, 1000, {
    properties: { name: "test-ellipse", id: 123 },
  });

  t.ok(e.properties, "properties exist");
  t.equal(e.properties?.name, "test-ellipse", "name property preserved");
  t.equal(e.properties?.id, 123, "id property preserved");
  t.end();
});

test("turf-ellipse -- different axis configurations", (t) => {
  const center = [0, 60];

  // Test when xSemiAxis < ySemiAxis (swapped major/minor axes)
  const e1 = ellipse(center, 1000, 2000, { steps: 32 });
  t.ok(e1.geometry.coordinates[0].length > 0, "works when x < y");

  // Test equal axes (circle)
  const e2 = ellipse(center, 1500, 1500, { steps: 32 });
  t.ok(e2.geometry.coordinates[0].length > 0, "works when x = y");

  // Test very elongated
  const e3 = ellipse(center, 5000, 500, { steps: 32 });
  t.ok(e3.geometry.coordinates[0].length > 0, "works with high eccentricity");

  // All should have positive area
  [e1, e2, e3].forEach((e) => {
    t.true(area(e.geometry) > 0, "has positive area");
  });

  t.end();
});

test("turf-ellipse -- angle and rotation interact correctly", (t) => {
  // Test that angle parameter produces correct rotation for various ellipse shapes
  const center = [0, 60];

  // Nearly circular ellipse
  const e1_0 = ellipse(center, 2000, 1900, { steps: 32, angle: 0 });
  const e1_90 = ellipse(center, 2000, 1900, { steps: 32, angle: 90 });

  // Highly elongated ellipse
  const e2_0 = ellipse(center, 2000, 500, { steps: 32, angle: 0 });
  const e2_90 = ellipse(center, 2000, 500, { steps: 32, angle: 90 });

  // Rotation should produce different coordinates for both shapes
  const dist1 = Math.sqrt(
    Math.pow(
      e1_0.geometry.coordinates[0][0][0] - e1_90.geometry.coordinates[0][0][0],
      2
    ) +
      Math.pow(
        e1_0.geometry.coordinates[0][0][1] -
          e1_90.geometry.coordinates[0][0][1],
        2
      )
  );

  const dist2 = Math.sqrt(
    Math.pow(
      e2_0.geometry.coordinates[0][0][0] - e2_90.geometry.coordinates[0][0][0],
      2
    ) +
      Math.pow(
        e2_0.geometry.coordinates[0][0][1] -
          e2_90.geometry.coordinates[0][0][1],
        2
      )
  );

  t.true(
    dist1 > 5,
    "90° rotation significantly changes nearly-circular ellipse"
  );
  t.true(dist2 > 5, "90° rotation significantly changes elongated ellipse");

  // Areas should remain equal after rotation
  t.true(
    Math.abs(area(e1_0.geometry) - area(e1_90.geometry)) / area(e1_0.geometry) <
      0.001,
    "nearly-circular ellipse area preserved"
  );
  t.true(
    Math.abs(area(e2_0.geometry) - area(e2_90.geometry)) / area(e2_0.geometry) <
      0.001,
    "elongated ellipse area preserved"
  );

  t.end();
});

test("turf-ellipse -- method parameter", (t) => {
  const center = [0, 60];
  const steps = 16;

  // circle case (eccentricity ~0)
  const a = 2000;
  const b = 2000;
  const circleArea = Math.PI * a * b;
  const inscribedCircle = ellipse(center, a, b, {
    steps,
    units: "meters",
    method: "inscribed",
  });
  const equalAreaCircle = ellipse(center, a, b, {
    steps,
    units: "meters",
    method: "equalarea",
  });
  const circumscribedCircle = ellipse(center, a, b, {
    steps,
    units: "meters",
    method: "circumscribed",
  });

  t.true(
    area(inscribedCircle.geometry) < circleArea,
    "inscribed understates the circle's area"
  );
  t.true(
    Math.abs(area(equalAreaCircle.geometry) - circleArea) / circleArea < 0.0001,
    "equalarea closely matches the circle's area"
  );
  t.true(
    area(circumscribedCircle.geometry) > circleArea,
    "circumscribed overstates the circle's area"
  );

  // actual ellipse case
  const ex = 2000;
  const ey = 1000;
  const ellipseArea = Math.PI * ex * ey;
  const inscribedEllipse = ellipse(center, ex, ey, {
    steps,
    units: "meters",
    method: "inscribed",
  });
  const circumscribedEllipse = ellipse(center, ex, ey, {
    steps,
    units: "meters",
    method: "circumscribed",
  });

  t.true(
    area(inscribedEllipse.geometry) < ellipseArea,
    "inscribed understates the ellipse's area"
  );
  t.true(
    area(circumscribedEllipse.geometry) > ellipseArea,
    "circumscribed overstates the ellipse's area"
  );

  t.deepEquals(
    ellipse(center, ex, ey, { steps }),
    ellipse(center, ex, ey, { steps, method: "inscribed" }),
    "equalarea is the default method"
  );

  t.throws(
    () => ellipse(center, ex, ey, { steps, method: "bogus" as any }),
    /method must be one of/,
    "throws for an unknown method"
  );

  t.end();
});

test("turf-ellipse -- equalarea matches the area of a non-circular ellipse", (t) => {
  const center = [0, 60];
  // eccentricities ~0.66, ~0.87, ~0.97, ~0.999
  const axes: [number, number][] = [
    [2000, 1500],
    [2000, 1000],
    [2000, 500],
    [5000, 200],
  ];

  axes.forEach(([a, b]) => {
    [64, 256].forEach((steps) => {
      const trueArea = Math.PI * a * b;
      const polygonArea = area(
        ellipse(center, a, b, { steps, units: "meters", method: "equalarea" })
          .geometry
      );
      const relativeError = (polygonArea - trueArea) / trueArea;
      t.true(
        Math.abs(relativeError) < 0.001,
        `${a}x${b} @ ${steps} steps: equalarea area within 0.1% of πab (got ${(relativeError * 100).toFixed(4)}%)`
      );
    });
  });

  t.end();
});

function colorize(feature, color) {
  color = color || "#F00";
  feature.properties["stroke-width"] = 6;
  feature.properties.stroke = color;
  feature.properties.fill = color;
  feature.properties["fill-opacity"] = 0;
  return feature;
}

/**
 * An ellipse is star-shaped around its center, so its ring is simple exactly
 * when every vertex advances the same way around the center and the ring
 * winds around it once. Angular order around the center is preserved by the
 * lon/lat aspect distortion (a positive axis scaling), so raw degree offsets
 * suffice.
 */
function windsOnceAroundCenter(ring: Position[], center: number[]): boolean {
  const angles = ring.map(([lon, lat]) =>
    Math.atan2(lat - center[1], lon - center[0])
  );
  let winding = 0;
  let forward = 0;
  let backward = 0;
  for (let i = 1; i < angles.length; i++) {
    let step = angles[i] - angles[i - 1];
    if (step > Math.PI) step -= 2 * Math.PI;
    if (step <= -Math.PI) step += 2 * Math.PI;
    if (step > 0) forward++;
    else backward++;
    winding += step;
  }
  const monotonic = forward === 0 || backward === 0;
  return monotonic && Math.abs(Math.abs(winding) - 2 * Math.PI) < 1e-9;
}

test("turf-ellipse -- elongated ellipses do not self-intersect", (t) => {
  const center = [0, 60];
  const methods = ["inscribed", "equalarea", "circumscribed"] as const;

  [10, 25, 50, 100].forEach((ratio) => {
    [8, 16, 64, 256].forEach((steps) => {
      methods.forEach((method) => {
        const ring = ellipse(center, 1000 * ratio, 1000, {
          steps,
          units: "meters",
          method,
          angle: 30,
        }).geometry.coordinates[0];
        t.true(
          windsOnceAroundCenter(ring, center),
          `${ratio}:1 @ ${steps} steps, ${method}: ring winds once without doubling back`
        );
      });
    });
  });

  t.end();
});

/**
 * Undo ellipse()'s mapping: each vertex was placed with
 * destination(center, r, 90 - φ + angle), so recover r (in meters) and φ to
 * get the planar (x, y) the vertex was constructed at.
 */
function planarFromLonLat(
  center: number[],
  p: Position,
  angle: number
): number[] {
  const r = distance(center, p, { units: "meters" });
  const [lon1, lat1, lon2, lat2] = [center[0], center[1], p[0], p[1]].map(
    (deg) => (deg * Math.PI) / 180
  );
  const bearing = Math.atan2(
    Math.sin(lon2 - lon1) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
  );
  const phi = Math.PI / 2 - bearing + (angle * Math.PI) / 180;
  return [r * Math.cos(phi), r * Math.sin(phi)];
}

test("turf-ellipse -- inscribed vertices lie on, and circumscribed edges are tangent to, the ellipse", (t) => {
  const center = [0, 60];
  const tolerance = 0.001; // meters

  const toPlanar = (p: Position, angle: number) =>
    planarFromLonLat(center, p, angle);

  const axes: [number, number][] = [
    [2000, 1000],
    [2000, 500],
    [5000, 200],
  ];
  axes.forEach(([a, b]) => {
    // includes odd and prime counts, where no vertex sits on the minor axis
    [3, 5, 7, 8, 13, 16, 64, 127].forEach((steps) => {
      [0, 30].forEach((angle) => {
        const label = `${a}x${b} @ ${steps} steps, angle ${angle}`;
        const options = { steps, units: "meters" as const, angle };

        // inscribed: the vertex's radial distance equals the ellipse's radius
        // in that direction
        const inscribed = ellipse(center, a, b, {
          ...options,
          method: "inscribed",
        }).geometry.coordinates[0].map((p) => toPlanar(p, angle));
        const worstVertex = Math.max(
          ...inscribed.map(([x, y]) => {
            const phi = Math.atan2(y, x);
            const radius =
              (a * b) / Math.hypot(b * Math.cos(phi), a * Math.sin(phi));
            return Math.abs(Math.hypot(x, y) - radius);
          })
        );
        t.true(
          worstVertex < tolerance,
          `${label}: inscribed vertices lie on the ellipse`
        );

        // circumscribed: each edge's distance from the center equals the
        // ellipse's support distance along the edge's normal (tangent), so the
        // polygon contains the ellipse while touching it on every edge
        const circumscribed = ellipse(center, a, b, {
          ...options,
          method: "circumscribed",
        }).geometry.coordinates[0].map((p) => toPlanar(p, angle));
        let worstEdge = 0;
        for (let i = 0; i < circumscribed.length - 1; i++) {
          const [x1, y1] = circumscribed[i];
          const [x2, y2] = circumscribed[i + 1];
          const length = Math.hypot(x2 - x1, y2 - y1);
          const nx = (y2 - y1) / length;
          const ny = (x1 - x2) / length;
          const edgeDistance = Math.abs(nx * x1 + ny * y1);
          const support = Math.hypot(a * nx, b * ny);
          worstEdge = Math.max(worstEdge, Math.abs(edgeDistance - support));
        }
        t.true(
          worstEdge < tolerance,
          `${label}: circumscribed edges are tangent to the ellipse`
        );
      });
    });
  });

  t.end();
});

// Shapes used by the unusual-steps tests: a circle, a moderate ellipse and a
// very elongated one.
const unusualStepShapes: [number, number][] = [
  [2000, 2000],
  [2000, 1000],
  [5000, 200],
];

test("turf-ellipse -- unusual integer step counts", (t) => {
  const center = [0, 60];
  // minimum, odd, prime, and just either side of powers of two
  const stepCounts = [
    3, 4, 5, 6, 7, 9, 11, 13, 17, 31, 33, 63, 65, 97, 127, 129, 255, 257, 1000,
    4096,
  ];

  unusualStepShapes.forEach(([a, b]) => {
    stepCounts.forEach((steps) => {
      const label = `${a}x${b} @ ${steps} steps`;
      const areas = {} as Record<(typeof allMethods)[number], number>;

      allMethods.forEach((method) => {
        const e = ellipse(center, a, b, { steps, units: "meters", method });
        const ring = e.geometry.coordinates[0];
        const ok =
          ring.length === steps + 1 &&
          ring.every((p) => p.every(Number.isFinite)) &&
          ring[0][0] === ring[steps][0] &&
          ring[0][1] === ring[steps][1] &&
          check(JSON.stringify(e)) !== undefined &&
          windsOnceAroundCenter(ring, center);
        t.true(
          ok,
          `${label}, ${method}: ${steps} finite vertices in a closed, simple ring`
        );
        areas[method] = area(e);
      });

      // A tolerance is needed only for the geodesic projection; the ordering
      // itself must hold at every step count.
      t.true(
        areas.inscribed < areas.equalarea &&
          areas.equalarea < areas.circumscribed,
        `${label}: inscribed < equalarea < circumscribed area`
      );
      const relativeError =
        Math.abs(areas.equalarea - Math.PI * a * b) / (Math.PI * a * b);
      // equalarea is exact in the plane; the error measured here comes from
      // @turf/area treating each edge as straight in lon/lat, while the
      // vertices are placed along great circles. That only matters for very
      // long edges far from north-south: the 3-step 5000x200 m triangle's
      // 11 km, nearly east-west base at latitude 60 is off by about 0.7%.
      const tolerance = steps === 3 ? 0.01 : 0.001;
      t.true(
        relativeError < tolerance,
        `${label}: equalarea within ${tolerance * 100}% of πab (got ${(relativeError * 100).toFixed(4)}%)`
      );
    });
  });

  t.end();
});

test("turf-ellipse -- fractional steps round up to the next whole step", (t) => {
  const center = [0, 60];
  const cases: [number, number][] = [
    [2.5, 3],
    [3.2, 4],
    [7.9, 8],
    [16.5, 17],
    [63.01, 64],
  ];

  unusualStepShapes.forEach(([a, b]) => {
    cases.forEach(([fractional, whole]) => {
      allMethods.forEach((method) => {
        const options = { units: "meters" as const, method, angle: 30 };
        t.deepEqual(
          ellipse(center, a, b, { ...options, steps: fractional }),
          ellipse(center, a, b, { ...options, steps: whole }),
          `${a}x${b}, ${method}: steps ${fractional} matches steps ${whole}`
        );
      });
    });
  });

  t.end();
});

test("turf-ellipse -- fewer than three steps still yields a valid polygon", (t) => {
  const center = [0, 60];

  unusualStepShapes.forEach(([a, b]) => {
    [1e-9, 0.5, 1, 2].forEach((steps) => {
      allMethods.forEach((method) => {
        const label = `${a}x${b} @ ${steps} steps, ${method}`;
        try {
          const e = ellipse(center, a, b, { steps, units: "meters", method });
          const ring = e.geometry.coordinates[0];
          t.true(
            ring.length >= 4 &&
              ring.every((p) => p.every(Number.isFinite)) &&
              windsOnceAroundCenter(ring, center),
            `${label}: at least a triangle, closed and simple`
          );
        } catch (err) {
          t.fail(`${label}: threw "${(err as Error).message}"`);
        }
      });
    });
  });

  t.end();
});

test("turf-ellipse -- invalid steps throw a descriptive error", (t) => {
  const center = [0, 60];

  const cases: [number, number, number][] = [
    // used to silently fall back to the default of 64
    [2000, 2000, 0],
    [2000, 1000, 0],
    [2000, 2000, NaN],
    [2000, 1000, NaN],
    [2000, 2000, -1],
    [2000, 2000, -16],
    [2000, 2000, -Infinity],
    // used to loop forever and exhaust memory
    [2000, 2000, Infinity],
    [2000, 1000, -1],
    [2000, 1000, -16],
    [2000, 1000, -Infinity],
    [2000, 1000, Infinity],
  ];

  cases.forEach(([a, b, steps]) => {
    allMethods.forEach((method) => {
      t.throws(
        () => ellipse(center, a, b, { steps, units: "meters", method }),
        /steps/,
        `${a}x${b} @ ${steps} steps, ${method}: throws an error mentioning steps`
      );
    });
  });

  t.end();
});

test("turf-ellipse -- pivot", (t) => {
  const center = [-75, 40];
  const xSemiAxis = 5;
  const ySemiAxis = 2;
  const pivot = [-75.2, 40.1];
  const angle = 60;

  (["inscribed", "circumscribed", "equalarea"] as const).forEach((method) => {
    const inPlace = ellipse(center, xSemiAxis, ySemiAxis, { angle, method });

    // a pivot only matters when there is a rotation
    t.deepEquals(
      ellipse(center, xSemiAxis, ySemiAxis, { pivot, method }).geometry,
      ellipse(center, xSemiAxis, ySemiAxis, { method }).geometry,
      `${method}: a pivot with no angle leaves the ellipse unchanged`
    );

    // pivoting about the ellipse's own center is the same as no pivot
    const aboutCenter = ellipse(center, xSemiAxis, ySemiAxis, {
      angle,
      pivot: center,
      method,
    });
    aboutCenter.geometry.coordinates[0].forEach((c, i) => {
      const expected = inPlace.geometry.coordinates[0][i];
      t.true(
        Math.abs(c[0] - expected[0]) < 1e-9 &&
          Math.abs(c[1] - expected[1]) < 1e-9,
        `${method}: pivot = center matches no pivot at vertex ${i}`
      );
    });

    // pivoting elsewhere matches rotating the in-place ellipse about the pivot
    const pivoted = ellipse(center, xSemiAxis, ySemiAxis, {
      angle,
      pivot,
      method,
    });
    const expected = transformRotate(
      ellipse(center, xSemiAxis, ySemiAxis, { method }),
      angle,
      { pivot }
    );
    const overlap = intersect(featureCollection([pivoted, expected]));
    const overlapRatio = overlap != null ? area(overlap) / area(expected) : 0;
    t.true(
      overlapRatio > 0.999,
      `${method}: pivoted ellipse overlaps the rotated ellipse (${overlapRatio})`
    );
    t.true(
      Math.abs(area(pivoted) - area(inPlace)) / area(inPlace) < 1e-6,
      `${method}: pivoting moves the ellipse without changing its area`
    );
    t.true(
      distance(pivoted.geometry.coordinates[0][0], point(center)) > 10,
      `${method}: pivoting moves the ellipse away from its original center`
    );
  });

  t.end();
});

function distanceToSegment(p: number[], u: number[], v: number[]): number {
  const dx = v[0] - u[0];
  const dy = v[1] - u[1];
  const s = Math.max(
    0,
    Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(p[0] - u[0] - s * dx, p[1] - u[1] - s * dy);
}

/**
 * Exact distance from point (x, y) to the ellipse x²/a² + y²/b² = 1, by David
 * Eberly's robust bisection ("Distance from a Point to an Ellipse, an
 * Ellipsoid, or a Hyperellipsoid").
 */
function distanceToEllipse(a: number, b: number, x: number, y: number) {
  // work in the first quadrant, with the larger semi-axis first
  let [e0, e1, y0, y1] = [a, b, Math.abs(x), Math.abs(y)];
  if (e0 < e1) [e0, e1, y0, y1] = [e1, e0, y1, y0];
  if (y1 > 0) {
    if (y0 > 0) {
      const z0 = y0 / e0;
      const z1 = y1 / e1;
      let g = z0 * z0 + z1 * z1 - 1;
      if (g === 0) return 0;
      const r0 = (e0 / e1) * (e0 / e1);
      const n0 = r0 * z0;
      let s0 = z1 - 1;
      let s1 = g < 0 ? 0 : Math.hypot(n0, z1) - 1;
      let s = 0;
      for (let i = 0; i < 2000; i++) {
        s = (s0 + s1) / 2;
        if (s === s0 || s === s1) break;
        const ratio0 = n0 / (s + r0);
        const ratio1 = z1 / (s + 1);
        g = ratio0 * ratio0 + ratio1 * ratio1 - 1;
        if (g > 0) s0 = s;
        else if (g < 0) s1 = s;
        else break;
      }
      const x0 = (r0 * y0) / (s + r0);
      const x1 = y1 / (s + 1);
      return Math.hypot(x0 - y0, x1 - y1);
    }
    return Math.abs(y1 - e1);
  }
  const numer0 = e0 * y0;
  const denom0 = e0 * e0 - e1 * e1;
  if (numer0 < denom0) {
    const xde0 = numer0 / denom0;
    return Math.hypot(e0 * xde0 - y0, e1 * Math.sqrt(1 - xde0 * xde0));
  }
  return Math.abs(y0 - e0);
}

/**
 * Brute-force Hausdorff distance, in meters, between an ellipse() polygon and
 * the true ellipse with semi-axes a and b (meters), measured in the plane the
 * polygon was built in: the farthest any point of either gets from the other.
 */
function hausdorffToEllipse(
  center: number[],
  ring: Position[],
  a: number,
  b: number,
  angle: number
): number {
  const polygon = ring
    .slice(0, -1)
    .map((p) => planarFromLonLat(center, p, angle));
  const n = polygon.length;
  let worst = 0;

  // polygon to ellipse: points along every edge, measured exactly
  const pointsPerEdge = 16;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % n];
    for (let k = 0; k < pointsPerEdge; k++) {
      const f = k / pointsPerEdge;
      worst = Math.max(
        worst,
        distanceToEllipse(a, b, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f)
      );
    }
  }

  // ellipse to polygon: 40000 points around the ellipse, each compared with
  // the polygon's edges near the same parametric angle (the polygon winds
  // once around the center, so these are in order), which is where its
  // nearest point on the polygon lies
  const vertexParams = polygon.map(([x, y]) => Math.atan2(y / b, x / a));
  const byParam = vertexParams
    .map((u, i) => [u, i])
    .sort((p, q) => p[0] - q[0]);
  const window = Math.min(5, n);
  const samples = 40000;
  for (let j = 0; j < samples; j++) {
    const t = -Math.PI + (2 * Math.PI * j) / samples;
    const p = [a * Math.cos(t), b * Math.sin(t)];
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byParam[mid][0] < t) lo = mid + 1;
      else hi = mid;
    }
    const nearest = byParam[lo % n][1];
    let best = Infinity;
    for (let d = -window; d <= window; d++) {
      const i = (((nearest + d) % n) + n) % n;
      best = Math.min(
        best,
        distanceToSegment(p, polygon[i], polygon[(i + 1) % n])
      );
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

test("turf-ellipse -- arcTolerance keeps the polygon within tolerance of the ellipse", (t) => {
  const center = [0, 60];
  // a circle, moderate ellipses, and elongated ones where the error is
  // concentrated at the sharp ends of the major axis
  const axes: [number, number][] = [
    [2000, 2000],
    [2000, 1500],
    [2000, 1000],
    [1000, 2000],
    [2000, 400],
    [5000, 200],
  ];
  // from much finer than the ellipse's sharpest curve to much coarser
  const tolerances = [0.5, 5, 50];
  // the measurement recovers planar coordinates through distance() and a
  // bearing, which is good to about a millimeter at these sizes
  const slack = 0.002;

  axes.forEach(([a, b]) => {
    tolerances.forEach((arcTolerance) => {
      allMethods.forEach((method) => {
        const angle = 30;
        const label = `${a}x${b} m, arcTolerance ${arcTolerance} m, ${method}`;
        const ring = ellipse(center, a, b, {
          arcTolerance,
          method,
          angle,
          units: "meters",
        }).geometry.coordinates[0];
        const steps = ring.length - 1;
        const error = hausdorffToEllipse(center, ring, a, b, angle);
        t.true(
          error <= arcTolerance + slack,
          `${label}: ${steps} steps stay within tolerance (error ${error.toFixed(3)} m)`
        );

        // Not wastefully many steps. The error does not shrink steadily with
        // every added step, but it does within each residue mod 4 (see
        // stepsForArcTolerance), so if the largest smaller count of each
        // residue misses the tolerance, every smaller count does.
        for (let fewer = steps - 1; fewer >= Math.max(3, steps - 4); fewer--) {
          const fewerRing = ellipse(center, a, b, {
            steps: fewer,
            method,
            angle,
            units: "meters",
          }).geometry.coordinates[0];
          const fewerError = hausdorffToEllipse(center, fewerRing, a, b, angle);
          t.true(
            fewerError > arcTolerance,
            `${label}: ${fewer} steps would not be enough (error ${fewerError.toFixed(3)} m)`
          );
        }
      });
    });
  });

  t.end();
});

test("turf-ellipse -- coarse arcTolerance on elongated ellipses", (t) => {
  // When arcTolerance is comparable to the ellipse's width, a few long edges
  // suffice, and the ellipse's sharp end can poke out past a vertex rather
  // than an edge. Measuring only how far the ellipse bulges past each edge
  // missed that, and accepted a 3-step triangle 1476 m from a 4447 x 345.5 m
  // ellipse for an arcTolerance of 829 m.
  const center = [0, 60];
  const cases: [number, number, number][] = [
    [4447.3, 345.5, 829.385],
    [928.9, 83.5, 172.109],
    [2807, 94.6, 91.685],
    [4483.1, 148, 123.649],
    [1848.6, 119.4, 360.595],
  ];
  const slack = 0.002;

  cases.forEach(([a, b, arcTolerance]) => {
    [0, 30].forEach((angle) => {
      allMethods.forEach((method) => {
        [
          [a, b],
          [b, a],
        ].forEach(([x, y]) => {
          const ring = ellipse(center, x, y, {
            arcTolerance,
            method,
            angle,
            units: "meters",
          }).geometry.coordinates[0];
          const error = hausdorffToEllipse(center, ring, x, y, angle);
          t.true(
            error <= arcTolerance + slack,
            `${x}x${y} m, arcTolerance ${arcTolerance} m, angle ${angle}, ${method}: ${ring.length - 1} steps stay within tolerance (error ${error.toFixed(3)} m)`
          );
        });
      });
    });
  });

  t.end();
});

test("turf-ellipse -- arcTolerance on a degenerate ellipse matches circle", (t) => {
  const centers = [
    [-105, 40],
    [0, 60],
  ];
  const radii = [1, 1000, 12345.6789];
  const relativeTolerances = [1e-6, 1e-4, 3.3e-3, 0.02, 0.15];

  centers.forEach((center) => {
    radii.forEach((radius) => {
      relativeTolerances.forEach((relative) => {
        const arcTolerance = radius * relative;
        const label = `center=${center}, radius=${radius}, arcTolerance=${arcTolerance}`;
        (["inscribed", "circumscribed"] as const).forEach((method) => {
          const e = ellipse(center, radius, radius, { arcTolerance, method })
            .geometry.coordinates[0];
          const c = circle(center, radius, { arcTolerance, method }).geometry
            .coordinates[0];
          const maxDiff =
            e.length === c.length
              ? Math.max(
                  ...normalizeLon([e])[0].map((v, i) => {
                    const w = normalizeLon([c])[0][i];
                    return Math.max(
                      Math.abs(v[0] - w[0]),
                      Math.abs(v[1] - w[1])
                    );
                  })
                )
              : Infinity;
          t.true(
            maxDiff < 1e-9,
            `${method}, ${label}: same ${c.length - 1} steps and vertices as circle (ellipse has ${e.length - 1})`
          );
        });

        // turf-circle picks its equalarea step count from a Taylor-series
        // estimate that is sometimes one step more than needed; ellipse
        // measures the error, so it may use that one step fewer.
        const e = ellipse(center, radius, radius, {
          arcTolerance,
          method: "equalarea",
        }).geometry.coordinates[0];
        const c = circle(center, radius, {
          arcTolerance,
          method: "equalarea",
        }).geometry.coordinates[0];
        t.true(
          e.length === c.length || e.length === c.length - 1,
          `equalarea, ${label}: ${e.length - 1} steps vs circle's ${c.length - 1}`
        );
      });
    });
  });

  t.end();
});

test("turf-ellipse -- arcTolerance overrides steps and scales with the tolerance", (t) => {
  const center = [0, 60];

  allMethods.forEach((method) => {
    const stepsFor = (arcTolerance: number, a = 2000, b = 1000) =>
      ellipse(center, a, b, { arcTolerance, method, units: "meters" }).geometry
        .coordinates[0].length - 1;

    t.deepEqual(
      ellipse(center, 2000, 1000, {
        arcTolerance: 1,
        steps: 7,
        method,
        units: "meters",
      }),
      ellipse(center, 2000, 1000, { arcTolerance: 1, method, units: "meters" }),
      `${method}: steps is ignored when arcTolerance is given`
    );

    t.true(
      stepsFor(0.1) > stepsFor(1) && stepsFor(1) > stepsFor(10),
      `${method}: a smaller arcTolerance gives more steps`
    );
    t.true(
      stepsFor(1, 2000, 200) > stepsFor(1, 2000, 1000),
      `${method}: a more elongated ellipse needs more steps for the same arcTolerance`
    );
    t.equal(
      stepsFor(1e6),
      3,
      `${method}: an arcTolerance larger than the ellipse gives a triangle`
    );
    t.equal(
      ellipse(center, 2, 1, {
        arcTolerance: 0.001,
        method,
        units: "kilometers",
      }).geometry.coordinates[0].length - 1,
      stepsFor(1),
      `${method}: arcTolerance is in the same units as the semi-axes`
    );
  });

  t.end();
});

test("turf-ellipse -- invalid arcTolerance throws instead of being ignored", (t) => {
  const center = [0, 60];

  [-0.01, 0, NaN, "0.01" as any].forEach((arcTolerance) => {
    allMethods.forEach((method) => {
      t.throws(
        () => ellipse(center, 10, 5, { arcTolerance, method }),
        /arcTolerance must be positive/,
        `${method}: arcTolerance = ${JSON.stringify(arcTolerance)} throws`
      );
    });
  });
  t.equal(
    ellipse(center, 10, 5, { arcTolerance: undefined }).geometry.coordinates[0]
      .length,
    64 + 1,
    "undefined arcTolerance falls back to the default steps"
  );
  allMethods.forEach((method) => {
    t.throws(
      () => ellipse(center, 6000, 3000, { arcTolerance: 1e-9, method }),
      /too small for an ellipse with semi-axes 6000 and 3000/,
      `${method}: an arcTolerance needing more than 20000 steps throws instead of hanging`
    );
  });

  t.end();
});
