// Camera pose source: converts MediaPipe Pose landmarks into a canonical
// observation. The landmark math is unchanged from the original prototype —
// only the packaging moved so the agent loop can consume it.
//
// Landmark indices (MediaPipe Pose, 33 points):
//   11/12 shoulders, 23/24 hips, 25/26 knees, 27/28 ankles.

import { angleFromVertical, measuredCoverage } from '../core/features.js';

export function poseObservation(points, previous, dt, t) {
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const shoulders = mid(points[11], points[12]);
  const hips = mid(points[23], points[24]);
  const ankles = mid(points[27], points[28]);

  const torsoLean = angleFromVertical(hips, shoulders);
  const baseWidth = Math.max(Math.abs(points[27].x - points[28].x), 0.025);
  const lateralOffset = Math.abs(shoulders.x - ankles.x) / baseWidth;
  const hipDropSpeed = previous ? Math.max(0, (hips.y - previous.hips.y) / Math.max(dt, 0.016)) : 0;
  const kneeAsymmetry = Math.abs(points[25].y - points[26].y);

  return {
    t,
    features: { torsoLean, lateralOffset, hipDropSpeed, kneeAsymmetry },
    coverage: measuredCoverage(),
    debug: { hips },
  };
}
