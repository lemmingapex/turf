import {
  polygon,
  isObject,
  isNumber,
  ArcApproximationMethod,
  Coord,
  Units,
  point,
} from "@turf/helpers";
import { destination } from "@turf/destination";
import { transformRotate } from "@turf/transform-rotate";
import { getCoord } from "@turf/invariant";
import { GeoJsonProperties, Feature, Polygon, Position } from "geojson";

/**
 * Takes a {@link Point} and calculates the ellipse polygon given two semi-axes expressed in variable units and steps for precision.
 *
 * @param {Coord} center center point
 * @param {number} xSemiAxis semi (major) axis of the ellipse along the x-axis
 * @param {number} ySemiAxis semi (minor) axis of the ellipse along the y-axis
 * @param {Object} [options={}] Optional parameters
 * @param {number} [options.angle=0] angle of rotation in decimal degrees, positive clockwise
 * @param {Coord} [options.pivot=center] point around which any rotation will be performed
 * @param {number} [options.steps=64] number of steps
 * @param {number} [options.arcTolerance] if provided, will ignore steps and use the fewest steps that keep the returned polygon at most this far from the true ellipse, in the same units as the semi-axes
 * @param {ArcApproximationMethod} [options.method='inscribed'] how the returned polygon approximates the ellipse: 'inscribed' places every vertex on the ellipse, 'circumscribed' places every edge tangent to the ellipse, and 'equalarea' matches the polygon's area to the ellipse's area
 * @param {Units} [options.units='kilometers'] unit of measurement for axes. Supports all valid Turf {@link https://turfjs.org/docs/api/types/Units Units}
 * @param {Object} [options.properties={}] properties
 * @returns {Feature<Polygon>} ellipse polygon
 * @example
 * var center = [-75, 40];
 * var xSemiAxis = 5;
 * var ySemiAxis = 2;
 * var ellipse = turf.ellipse(center, xSemiAxis, ySemiAxis);
 *
 * //addToMap
 * var addToMap = [turf.point(center), ellipse]
 */
function ellipse(
  center: Coord,
  xSemiAxis: number,
  ySemiAxis: number,
  options: {
    steps?: number;
    arcTolerance?: number;
    method?: ArcApproximationMethod;
    units?: Units;
    angle?: number;
    pivot?: Coord;
    properties?: GeoJsonProperties;
  }
): Feature<Polygon> {
  // Optional params
  options = options || {};
  let steps = options.steps ?? 64;
  const method = options.method ?? "inscribed";
  const units = options.units || "kilometers";
  let angle = options.angle || 0;
  const properties = options.properties || {};
  // validation
  if (!center) throw new Error("center is required");
  if (!xSemiAxis) throw new Error("xSemiAxis is required");
  if (!ySemiAxis) throw new Error("ySemiAxis is required");
  if (!isObject(options)) throw new Error("options must be an object");
  if (!["inscribed", "circumscribed", "equalarea"].includes(method))
    throw new Error(
      "method must be one of 'inscribed', 'circumscribed', 'equalarea'"
    );
  // like turf-circle, arcTolerance overrides steps, and an invalid value
  // throws rather than silently falling back to the default steps
  if (options.arcTolerance != null) {
    steps = stepsForArcTolerance(
      xSemiAxis,
      ySemiAxis,
      options.arcTolerance,
      method
    );
  }
  if (!isNumber(steps)) throw new Error("steps must be a number");
  if (!Number.isFinite(steps) || steps <= 0)
    throw new Error("steps must be a positive finite number");
  // a polygon needs whole vertices, and at least three of them
  steps = Math.max(3, Math.ceil(steps));
  if (!isNumber(angle)) throw new Error("angle must be a number");

  // Rotating the ellipse about a pivot other than its own center is the same
  // as rotating it in place and then moving its center about the pivot.
  const centerCoords = options.pivot
    ? getCoord(
        transformRotate(point(getCoord(center)), angle, {
          pivot: options.pivot,
        })
      )
    : getCoord(center);

  const vertices = planarVertices(xSemiAxis, ySemiAxis, steps, method);

  const coords: Position[] = [];
  for (const [x, y] of vertices) {
    // Cartesian angles run counter-clockwise from east, bearings clockwise
    // from north, so bearing = 90° − angle. Rotating the ellipse by `angle`
    // rotates every vertex's bearing.
    const bearing = 90 - (Math.atan2(y, x) * 180) / Math.PI + angle;
    coords.push(
      destination(centerCoords, Math.sqrt(x * x + y * y), bearing, { units })
        .geometry.coordinates
    );
  }
  coords.push(coords[0]);
  return polygon([coords], properties);
}

/**
 * Build the polygon's vertices in the ellipse's own plane, before rotation and
 * projection: x along xSemiAxis (east), y along ySemiAxis (north), in the
 * semi-axes' units, counter-clockwise and without a closing vertex.
 *
 * @private
 * @param {number} a semi-axis along x
 * @param {number} b semi-axis along y
 * @param {number} steps number of vertices, a whole number of at least 3
 * @param {ArcApproximationMethod} method how the polygon approximates the ellipse
 * @returns {Position[]} steps planar vertices
 */
function planarVertices(
  a: number,
  b: number,
  steps: number,
  method: ArcApproximationMethod
): Position[] {
  // There is deliberately a single construction for every axis ratio, with
  // no special case for near-circles: when a === b each step
  // below reduces to turf-circle's construction (vertices at bearings
  // 0, -360/n, -720/n, ... and the same circumradius for each method), so the
  // output changes continuously as an ellipse is morphed into a circle and a
  // degenerate ellipse matches circle() to within floating-point noise.

  // Parametric angles of the vertices, evenly spaced by arc length and
  // starting at the end of the y semi-axis (north, before rotation), where
  // turf-circle starts. For a circle they are evenly spaced angles.
  const params = adaptiveParams(a, b, steps);
  // the parameter after the last vertex, closing the ring
  const paramAt = (i: number) =>
    i < steps ? params[i] : params[i - steps] + 2 * Math.PI;

  // Each vertex is placed at parametric angle t and scaled by k from the
  // ellipse (x = k·a·cos t, y = k·b·sin t).
  const vertexParams: number[] = [];
  const vertexScales: number[] = [];
  if (method === "circumscribed") {
    // Every edge is tangent to the ellipse at the midpoint m_i of its two
    // vertices' parameters, and each vertex is where the tangents at m_(i-1)
    // and m_i meet. The ellipse is the unit circle stretched by (a, b), which
    // keeps tangents tangent, and on the unit circle the tangents at u and v
    // meet at angle (u + v) / 2, a distance 1 / cos((v − u) / 2) out. For a
    // circle that puts vertex i at its own angle, r / cos(π / n) out, exactly
    // like turf-circle.
    const tangentParam = (i: number) => (paramAt(i) + paramAt(i + 1)) / 2;
    for (let i = 0; i < steps; i++) {
      const before =
        i === 0 ? tangentParam(steps - 1) - 2 * Math.PI : tangentParam(i - 1);
      const after = tangentParam(i);
      vertexParams.push((before + after) / 2);
      vertexScales.push(1 / Math.cos((after - before) / 2));
    }
  } else {
    // 'inscribed' needs no scaling: every vertex lies on the ellipse.
    // 'equalarea' scales both axes by s. Vertices at (a·cos tᵢ, b·sin tᵢ)
    // enclose (a·b/2)·Σ sin(Δtᵢ), and scaling by s multiplies that by s², so
    // s²·(a·b/2)·Σ sin(Δtᵢ) = π·a·b gives s = √(2π / Σ sin(Δtᵢ)). For a
    // circle (Δt = 2π/n) that is turf-circle's equal-area circumradius ratio.
    let scale = 1;
    if (method === "equalarea") {
      let sumSinDelta = 0;
      for (let i = 0; i < steps; i++) {
        sumSinDelta += Math.sin(paramAt(i + 1) - paramAt(i));
      }
      if (sumSinDelta > 0) scale = Math.sqrt((2 * Math.PI) / sumSinDelta);
    }
    for (let i = 0; i < steps; i++) {
      vertexParams.push(params[i]);
      vertexScales.push(scale);
    }
  }

  // Cartesian, with x pointing east and y north
  return vertexParams.map((t, i) => [
    vertexScales[i] * a * Math.cos(t),
    vertexScales[i] * b * Math.sin(t),
  ]);
}

/**
 * The most steps arcTolerance may call for, the same limit turf-circle has.
 *
 * @private
 */
const MAX_ARC_TOLERANCE_STEPS = 20000;

/**
 * The fewest steps for which the polygon planarVertices builds stays within
 * arcTolerance of the ellipse.
 *
 * turf-circle can solve for its step count in closed form, but an ellipse's
 * error is not uniform around the ring: the vertices are evenly spaced by arc
 * length, so the error peaks where the ellipse bends most sharply (the ends of
 * the major axis), and 'equalarea' and 'circumscribed' scale vertices in ways
 * that only balance out exactly for a circle. Instead, this measures the
 * actual error of candidate polygons (planarDeviation) and searches for the
 * smallest step count that meets the tolerance. Only a step count that was
 * measured to meet the tolerance is ever returned.
 *
 * The error does not shrink steadily as steps grows. The ring starts at the
 * end of the y semi-axis, so steps mod 4 decides whether the ends of the x
 * semi-axis fall on a vertex or part way along an edge, and on an elongated
 * ellipse that changes the error at its sharp ends by tens of percent: a
 * circumscribed 25:1 ellipse can meet a tolerance with 482 steps but not 483,
 * 484 or 485. Within one residue mod 4 the vertices sit at the same places
 * relative to the axes and the error does shrink steadily, so each residue is
 * searched on its own and the smallest result wins.
 *
 * @private
 * @param {number} a semi-axis along x
 * @param {number} b semi-axis along y
 * @param {number} arcTolerance the allowable distance between polygon and ellipse
 * @param {ArcApproximationMethod} method how the polygon approximates the ellipse
 * @returns {number} the number of steps, from 3 to MAX_ARC_TOLERANCE_STEPS
 * @throws {Error} if arcTolerance is not positive, or would need more than MAX_ARC_TOLERANCE_STEPS steps
 */
function stepsForArcTolerance(
  a: number,
  b: number,
  arcTolerance: number,
  method: ArcApproximationMethod
): number {
  // written as !(x > 0) so that NaN and non-numbers are rejected too
  if (typeof arcTolerance !== "number" || !(arcTolerance > 0)) {
    throw new Error("arcTolerance must be positive");
  }
  const deviation = (steps: number) =>
    planarDeviation(a, b, planarVertices(a, b, steps, method));

  // The fewest steps among first, first + 4, first + 8, … up to limit that
  // meet the tolerance, or Infinity if none do. The search starts from probe,
  // one of those candidates.
  const fewestFrom = (first: number, limit: number, probe: number): number => {
    if (first > limit) return Infinity;
    // the largest candidate not above limit
    const last = limit - ((limit - first) % 4);
    // lo misses the tolerance and hi meets it; first − 4 stands in for a miss
    // (it is below 3 or another residue's turf), and Infinity for no known hit
    let lo = first - 4;
    let hi = Infinity;
    let steps = Math.min(probe, last);
    let error = deviation(steps);
    if (error <= arcTolerance) hi = steps;
    // the largest candidate misses, so every smaller one does too
    else if (steps === last) return Infinity;
    else lo = steps;

    // Each measurement predicts the next candidate to try. The error shrinks
    // steadily, roughly as 1 / stepsᵖ: p is 2 once the edges are short next
    // to the ellipse's sharpest curve, but can be well off it before then,
    // so p is refitted from the last two measurements. A prediction is kept
    // strictly inside the bracket, so the search always ends; as a guard
    // against an error curve the prediction fits badly, it bisects after
    // a dozen predictions.
    let previousSteps = NaN;
    let previousError = NaN;
    for (let i = 0; hi - lo > 4; i++) {
      let next: number;
      if (i < 12) {
        const fitted =
          Math.log(previousError / error) / Math.log(steps / previousSteps);
        // NaN, on the first prediction or a flat error, falls back to 2
        const p = fitted > 0.5 ? Math.min(fitted, 8) : 2;
        // aim for the candidate where the error would just meet the tolerance
        const target = steps * (error / arcTolerance) ** (1 / p);
        next = first + 4 * Math.ceil((target - first) / 4);
        next = Math.max(lo + 4, Math.min(next, hi - 4, last));
      } else {
        next = hi === Infinity ? last : lo + 4 * Math.floor((hi - lo) / 8);
      }
      previousSteps = steps;
      previousError = error;
      steps = next;
      error = deviation(steps);
      if (error <= arcTolerance) hi = steps;
      else if (steps === last) return Infinity;
      else lo = steps;
    }
    return hi;
  };

  // Search one residue in full, then each of the others only if the largest
  // of its candidates below the best so far meets the tolerance, which a
  // single measurement settles.
  // The first search starts from an estimate. Near the end of the major axis
  // the ellipse follows a circle of radius ρ = minor² / major, and an
  // inscribed edge spanning arc length s strays about s² / (8ρ) from it, so
  // with s = perimeter / steps the tolerance needs about
  // perimeter / √(8ρ · arcTolerance) steps. It is only a starting point: it
  // ignores how the other methods place their vertices, and overestimates
  // badly once arcTolerance is comparable to ρ.
  const major = Math.max(Math.abs(a), Math.abs(b));
  const minor = Math.min(Math.abs(a), Math.abs(b));
  const rho = minor * (minor / major);
  const estimate =
    ellipsePerimeter(major, minor) / Math.sqrt(8 * rho * arcTolerance);
  const probe = Math.min(
    MAX_ARC_TOLERANCE_STEPS,
    3 + 4 * Math.max(0, Math.round((estimate - 3) / 4))
  );
  let best = fewestFrom(3, MAX_ARC_TOLERANCE_STEPS, probe);
  for (let first = 4; first < 7; first++) {
    const limit = Math.min(best - 1, MAX_ARC_TOLERANCE_STEPS);
    best = Math.min(best, fewestFrom(first, limit, limit));
  }
  // Throw rather than silently capping, so callers are never handed a
  // polygon that misses their tolerance.
  if (best === Infinity) {
    throw new Error(
      `arcTolerance ${arcTolerance} is too small for an ellipse with semi-axes ` +
        `${a} and ${b}: it would take more than the maximum of ` +
        `${MAX_ARC_TOLERANCE_STEPS} steps`
    );
  }
  return best;
}

/**
 * The perimeter of an ellipse with semi-axes a and b, by Ramanujan's second
 * approximation, which is within 0.005% of the true perimeter for every axis
 * ratio.
 *
 * @private
 * @param {number} a one semi-axis
 * @param {number} b the other semi-axis
 * @returns {number} the perimeter, in the semi-axes' units
 */
function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/**
 * How far the polygon strays from the ellipse x²/a² + y²/b² = 1, measured in the
 * plane the polygon was built in: the farthest any point of either gets from
 * the other. The polygon is convex and counter-clockwise, and its vertices are
 * on or outside the ellipse.
 *
 * - Outward, a vertex sits outside the ellipse. The distance from a point on an
 *   edge to the (convex) ellipse is a convex function along the edge, so the
 *   farthest any point gets is at a vertex (see distanceOutside).
 * - Inward, the ellipse bulges past an edge. The farthest the ellipse reaches in
 *   the direction of the edge's outward normal n is its support distance
 *   √((a·nx)² + (b·ny)²), so no point of the ellipse is farther past the edge's
 *   line than that minus the edge's own distance from the center. Every point
 *   on the edge is within that distance of the ellipse, measured along n, and
 *   so is every point of the ellipse whose nearest point on the polygon lies
 *   on that edge.
 * - Inward, past a vertex: a point of the ellipse can lie beyond the end of
 *   one edge and before the start of the next, so that its nearest point on
 *   the polygon is the vertex between them. Its distance from the vertex is
 *   then more than its distance past either edge's line, unbounded by the
 *   above, and on an elongated ellipse built with few steps it can be the
 *   largest error of all: the ellipse's sharp end pokes out past a vertex. See
 *   beyondVertex.
 *
 * For a circle these reduce to turf-circle's r·(1 − cos φ) for 'inscribed' and
 * r·(1 / cos φ − 1) for 'circumscribed'.
 *
 * @private
 * @param {number} a semi-axis along x
 * @param {number} b semi-axis along y
 * @param {Position[]} vertices the polygon's planar vertices, from planarVertices
 * @returns {number} the largest distance between polygon and ellipse, in the semi-axes' units
 */
function planarDeviation(a: number, b: number, vertices: Position[]): number {
  const n = vertices.length;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % n];

    // outward: the vertex's distance from the nearest point of the ellipse
    worst = Math.max(worst, distanceOutside(a, b, x1, y1));

    // inward: the ring runs counter-clockwise, so (dy, −dx) points outward
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    const nx = dy / length;
    const ny = -dx / length;
    const support = Math.sqrt(a * nx * (a * nx) + b * ny * (b * ny));
    worst = Math.max(worst, support - (nx * x1 + ny * y1));
  }

  // Inward, past a vertex. Among the points of the ellipse whose nearest point
  // on the polygon is a given vertex, the farthest is either where they meet
  // the points nearest an edge (covered above) or at a local maximum of the
  // distance from the vertex along the ellipse. From a point on or just
  // outside the ellipse, the only such maximum is on the far side, unless the
  // point lies inside the ellipse's evolute, which reaches the ellipse only
  // when the major semi-axis is at least √2 times the minor; the extra maxima
  // then sit near the ends of the major axis. So only the vertices around
  // those ends, which the ring reaches a quarter and three quarters of the
  // way round from its start (or at its start and halfway, if y is the major
  // axis), need checking.
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  if (Math.max(absA, absB) ** 2 >= 2 * Math.min(absA, absB) ** 2) {
    const fractions = absA > absB ? [0.25, 0.75] : [0, 0.5];
    for (const fraction of fractions) {
      // the parametric angle at that end of the major axis
      const tip = Math.PI / 2 + 2 * Math.PI * fraction;
      const nearest = Math.round(n * fraction);
      for (let offset = -2; offset <= 2; offset++) {
        const j = (((nearest + offset) % n) + n) % n;
        worst = Math.max(worst, beyondVertex(a, b, vertices, j, tip));
      }
    }
  }
  return worst;
}

/**
 * How far past vertex j the ellipse reaches near parametric angle `tip`: the
 * distance from the vertex to the local maximum of that distance along the
 * ellipse, found by Newton's method from `tip`, if that point of the ellipse
 * lies beyond the end of the edge into the vertex and before the start of the
 * edge out of it (so the vertex is its nearest point on the polygon), or 0
 * otherwise.
 *
 * @private
 * @param {number} a semi-axis along x
 * @param {number} b semi-axis along y
 * @param {Position[]} vertices the polygon's planar vertices, counter-clockwise
 * @param {number} j the index of the vertex
 * @param {number} tip the parametric angle to start the search from
 * @returns {number} the distance, in the semi-axes' units
 */
function beyondVertex(
  a: number,
  b: number,
  vertices: Position[],
  j: number,
  tip: number
): number {
  const n = vertices.length;
  const [vx, vy] = vertices[j];
  const [px, py] = vertices[(j + n - 1) % n];
  const [qx, qy] = vertices[(j + 1) % n];

  // Maximize g(θ) = |E(θ) − V|² / 2, where E(θ) = (a·cos θ, b·sin θ). With
  // E″ = −E, g′(θ) = (E − V) · E′ and g″(θ) = |E′|² − (E − V) · E.
  let theta = tip;
  for (let i = 0; i < 8; i++) {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ex = a * cos - vx;
    const ey = b * sin - vy;
    const tx = -a * sin;
    const ty = b * cos;
    const g1 = ex * tx + ey * ty;
    const g2 = tx * tx + ty * ty - (ex * a * cos + ey * b * sin);
    // not near a maximum, so stop where we are
    if (!(g2 < 0)) break;
    const delta = g1 / g2;
    theta -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }

  const ox = a * Math.cos(theta) - vx;
  const oy = b * Math.sin(theta) - vy;
  const pastIncoming = ox * (vx - px) + oy * (vy - py) > 0;
  const beforeOutgoing = ox * (qx - vx) + oy * (qy - vy) < 0;
  return pastIncoming && beforeOutgoing ? Math.sqrt(ox * ox + oy * oy) : 0;
}

/**
 * How far the point (x, y) lies outside the ellipse x²/a² + y²/b² = 1, or 0 if
 * it is inside.
 *
 * The distance to any point of the ellipse is an upper bound, so this starts
 * at the point where the ray from the center through (x, y) meets the ellipse,
 * then takes a few Newton steps along the ellipse towards the nearest point
 * (where (x, y) − E(θ) is perpendicular to the tangent E′(θ)), keeping the
 * closest point found. However the steps go, the result never understates
 * the distance. The radial point alone is exact at the ends of the axes, but
 * on an elongated ellipse it can overstate a vertex's distance part way
 * round by more than half, which made 'circumscribed' take around 5% more
 * steps than needed; the polygon's vertices are close to the ellipse, where
 * Newton's method converges in a step or two.
 *
 * @private
 * @param {number} a semi-axis along x
 * @param {number} b semi-axis along y
 * @param {number} x the point's x, in the semi-axes' units
 * @param {number} y the point's y, in the semi-axes' units
 * @returns {number} the point's distance outside the ellipse
 */
function distanceOutside(a: number, b: number, x: number, y: number): number {
  if ((x / a) * (x / a) + (y / b) * (y / b) <= 1) return 0;
  // the radial point has parametric angle atan2(y / b, x / a)
  let theta = Math.atan2(y / b, x / a);
  let closest = Infinity;
  for (let i = 0; ; i++) {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // offset from E(θ) = (a·cos θ, b·sin θ), and the tangent E′(θ)
    const ox = x - a * cos;
    const oy = y - b * sin;
    closest = Math.min(closest, Math.sqrt(ox * ox + oy * oy));
    if (i === 4) return closest;
    const tx = -a * sin;
    const ty = b * cos;
    // f(θ) = offset · E′(θ) is 0 at the nearest point, and since E″ = −E,
    // f′(θ) = −|E′(θ)|² + offset · E″(θ) = −|E′(θ)|² − offset · E(θ)
    const f = ox * tx + oy * ty;
    const fPrime = -(tx * tx + ty * ty) - (ox * a * cos + oy * b * sin);
    if (!(fPrime < 0)) return closest;
    const delta = f / fPrime;
    // converged: another step would not move the point found
    if (Math.abs(delta) < 1e-12) return closest;
    theta -= delta;
  }
}

/**
 * Generate parametric angles π/2 = t₀ < t₁ < … < tₙ₋₁ < π/2 + 2π for an ellipse with
 * semi-axes a and b, spaced so that consecutive vertices are an equal arc length apart.
 * They start at the end of the b semi-axis (t = π/2) and run counter-clockwise, the
 * same start and direction as turf-circle; for a circle they are evenly spaced.
 *
 * The ellipse is densely sampled to build a cumulative arc-length table s(t), which is
 * then inverted at evenly spaced lengths. The angles are therefore strictly increasing
 * and always span exactly one revolution, so the resulting ring never self-intersects.
 * The spacing depends only on the ratio of a to b, so uniformly scaling both axes
 * afterwards leaves it unchanged.
 *
 * @private
 * @param {number} a semi-axis along x
 * @param {number} b semi-axis along y
 * @param {number} numPoints number of vertices (not including the closing point)
 * @returns {number[]} numPoints parametric angles in radians, starting at π/2
 */
function adaptiveParams(a: number, b: number, numPoints: number): number[] {
  // cumulative[j] is the arc length from t = π/2 to t = π/2 + 2πj / samples,
  // measured along the polyline through the dense samples. Four samples per
  // vertex (and at least 256) moves vertices by under 0.1% of a segment length
  // compared with much denser sampling. numPoints is a whole number, so
  // samples is always a multiple of 4 whatever numPoints is.
  const samples = Math.max(256, numPoints * 4);
  const start = Math.PI / 2;

  // The ellipse is symmetric about both axes, and with samples a multiple of 4
  // the sample grid lands exactly on the quadrant boundaries, so every sample
  // in the other three quadrants mirrors one in the first. Measure only the
  // first quadrant (t from π/2 to π), then mirror it, saving three quarters of
  // the trig calls. quadrant[r] is the arc length from π/2 to π/2 + 2πr / samples.
  // Preallocated typed arrays rather than push(): building the tables is the
  // hot loop here, and growing plain arrays roughly doubled its cost.
  const perQuadrant = samples / 4;
  const quadrant = new Float64Array(perQuadrant + 1);
  let prevX = 0;
  let prevY = b;
  for (let r = 1; r <= perQuadrant; r++) {
    const t = start + (2 * Math.PI * r) / samples;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    // Math.sqrt rather than Math.hypot: hypot is markedly slower in V8
    const dx = x - prevX;
    const dy = y - prevY;
    quadrant[r] = quadrant[r - 1] + Math.sqrt(dx * dx + dy * dy);
    prevX = x;
    prevY = y;
  }
  const quarter = quadrant[perQuadrant];
  // Quadrants 0 and 2 repeat the first quadrant's lengths. Quadrants 1 and 3
  // trace it in reverse (mirrored across an axis), so the length covered r
  // samples into them is what remains of the first quadrant after
  // perQuadrant − r samples.
  const cumulative = new Float64Array(samples + 1);
  for (let k = 0; k < 4; k++) {
    const offset = k * quarter;
    for (let r = 0; r < perQuadrant; r++) {
      cumulative[k * perQuadrant + r] =
        offset +
        (k % 2 === 0 ? quadrant[r] : quarter - quadrant[perQuadrant - r]);
    }
  }
  const perimeter = 4 * quarter;
  cumulative[samples] = perimeter;

  // invert s(t) at i/numPoints of the perimeter, interpolating within a sample
  const params: number[] = [start];
  let j = 0;
  for (let i = 1; i < numPoints; i++) {
    const target = (perimeter * i) / numPoints;
    while (cumulative[j + 1] < target) j++;
    const fraction =
      (target - cumulative[j]) / (cumulative[j + 1] - cumulative[j]);
    params.push(start + (2 * Math.PI * (j + fraction)) / samples);
  }

  return params;
}

export { ellipse };
export default ellipse;
