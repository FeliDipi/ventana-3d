/* Portado de tuxdi-site-webapp/components/common/3D/duckAnimationClips.ts */
import {
  AnimationClip,
  NumberKeyframeTrack,
  Object3D,
  Quaternion,
  Vector3,
} from "three";

/** Names of the body/reaction clips actually shipped in duck.glb. */
export const CLIP_NAMES = {
  JUMP: "jump",
  HAPPY: "happy",
  DANCE: "dance",
  WINGS: "wings",
  STUN: "stun",
  KICK: "kick",
} as const;

/** Crossfade used for hover/global-triggered body reactions. */
export const BODY_CROSSFADE_SECONDS = 0.28;
/** Faster crossfade for a click, to stay snappy alongside the quack/squash. */
export const BODY_CROSSFADE_CLICK_SECONDS = 0.12;

/** The renamed successor of the old single baked clip. Not played directly -
 * only used as the source to slice the face gestures below out of, since
 * it's the one clip that carries morph-target (shape key) data. */
export const MASTER_CLIP_NAME = "Anim_v03C_F1";

export const BLINK_WAIT_MIN = 1.5;
export const BLINK_WAIT_MAX = 4;

/**
 * Tuning for "shake the mouse fast to make the duck dizzy" (see Duck.tsx's
 * shake tracker, in the cursor-tracking block of its useFrame). The gesture
 * is a chain of quick direction changes rather than a distance travelled in
 * a fixed window: a swipe that never comes back doesn't count, and a shake
 * is never missed just because it straddled a window boundary.
 */
/** Minimum travel in one direction for a change of direction to count at
 * all, in the pointer's -1..1 space (~38px on a 1920-wide screen). Below it
 * the movement is jitter, not a swing. */
export const SHAKE_MIN_SWING = 0.04;
/** A pause longer than this breaks the chain and the count starts over. */
export const SHAKE_MAX_GAP_SECONDS = 0.35;
/** Chained direction changes needed - two back-and-forths. */
export const SHAKE_REVERSALS_TO_STUN = 4;
/** Ignore sub-pixel jitter below this per-frame |Δx|. */
export const SHAKE_DEADZONE = 0.004;
export const BLINK_DOUBLE_CHANCE = 0.25;

/**
 * Hit the duck below this height and it answers with the kick instead of
 * the jump. It's a low blow. Measured as a fraction of the duck's own
 * height, 0 at its feet and 1 at the top of its head, so it holds at
 * whatever size a scene draws it and however the duck is turned - the
 * bottom third of the body, well clear of the wings and the head.
 */
export const KICK_HIT_MAX_HEIGHT = 0.3;

const MORPH_TRACK_SUFFIX = ".morphTargetInfluences";
const ACTIVE_THRESHOLD = 0.02;
const PREFERRED_MIN_PEAK = 0.9;
const FALLBACK_MIN_PEAK = 0.5;

interface FaceEnvelopeSpec {
  clipName: string;
  targetNames: string[];
}

const BLINK_SPEC: FaceEnvelopeSpec = {
  clipName: "duck-blink",
  targetNames: [
    "L_UppereyeLid_DownShape",
    "L_LowereyeLid_UpShape",
    "R_UppereyeLid_DownShape",
    "R_LowereyeLid_UpShape",
  ],
};

const MOUTH_SPEC: FaceEnvelopeSpec = {
  clipName: "duck-open-mouth",
  targetNames: ["PicoUp_OpenShape", "PicoDown_OpenShape"],
};

/**
 * The exported `blink`/`open_mouth`/`close_mouth` clips turned out to carry
 * only an incidental neck/chest sway - no eye or mouth joints exist on this
 * rig, and none of those clips touch a morph target. The actual eyelid and
 * beak shape keys are baked as a `morphTargetInfluences` track inside the
 * old master clip instead, at several points along its ~46s timeline (the
 * artist animated one continuous performance, not isolated gestures).
 *
 * This slices the cleanest, snappiest occurrence of each gesture (shortest
 * window that still reaches close to full influence) out of that master
 * track, so it can be played back on its own, on demand, as an ordinary
 * `AnimationAction` alongside everything else - the same machinery a real
 * per-gesture clip would have used, had the export included one.
 */
function findMorphTracks(masterClip: AnimationClip): NumberKeyframeTrack[] {
  return masterClip.tracks.filter(
    (track): track is NumberKeyframeTrack =>
      track instanceof NumberKeyframeTrack &&
      track.name.endsWith(MORPH_TRACK_SUFFIX)
  );
}

function pickEnvelopeWindow(
  referenceTrack: NumberKeyframeTrack,
  numTargets: number,
  targetIndices: number[]
): [number, number] | null {
  const { times, values } = referenceTrack;
  const windows: Array<{ start: number; end: number; peak: number }> = [];
  let runStart = -1;

  for (let frame = 0; frame < times.length; frame++) {
    let envelope = 0;
    for (const index of targetIndices) {
      envelope = Math.max(envelope, values[frame * numTargets + index]);
    }
    const active = envelope > ACTIVE_THRESHOLD;
    if (active && runStart === -1) runStart = frame;
    if (!active && runStart !== -1) {
      windows.push({ start: runStart, end: frame - 1, peak: 0 });
      runStart = -1;
    }
  }
  if (runStart !== -1) windows.push({ start: runStart, end: times.length - 1, peak: 0 });

  // Pad one frame on each side so the envelope reads a clean 0 at both ends
  // instead of cutting off mid-rise, and measure its true peak over that range.
  for (const w of windows) {
    w.start = Math.max(0, w.start - 1);
    w.end = Math.min(times.length - 1, w.end + 1);
    for (let frame = w.start; frame <= w.end; frame++) {
      for (const index of targetIndices) {
        w.peak = Math.max(w.peak, values[frame * numTargets + index]);
      }
    }
  }

  const byShortest = (a: (typeof windows)[number], b: (typeof windows)[number]) =>
    times[a.end] - times[a.start] - (times[b.end] - times[b.start]);

  const strong = windows.filter((w) => w.peak >= PREFERRED_MIN_PEAK).sort(byShortest);
  const usable =
    strong.length > 0
      ? strong
      : windows.filter((w) => w.peak >= FALLBACK_MIN_PEAK).sort(byShortest);

  return usable.length > 0 ? [usable[0].start, usable[0].end] : null;
}

function sliceEnvelopeClip(
  morphTracks: NumberKeyframeTrack[],
  numTargets: number,
  morphTargetDictionary: Record<string, number>,
  spec: FaceEnvelopeSpec
): AnimationClip | null {
  const targetIndices = spec.targetNames
    .map((name) => morphTargetDictionary[name])
    .filter((index): index is number => index !== undefined);
  if (targetIndices.length === 0) return null;

  const window = pickEnvelopeWindow(morphTracks[0], numTargets, targetIndices);
  if (!window) return null;
  const [startFrame, endFrame] = window;

  const tracks: NumberKeyframeTrack[] = [];
  let duration = 0;

  for (const morphTrack of morphTracks) {
    const nodeName = morphTrack.name.slice(0, -MORPH_TRACK_SUFFIX.length);
    const baseTime = morphTrack.times[startFrame];
    const times = morphTrack.times
      .slice(startFrame, endFrame + 1)
      .map((t) => t - baseTime);
    duration = Math.max(duration, times[times.length - 1]);

    for (const targetName of spec.targetNames) {
      const index = morphTargetDictionary[targetName];
      if (index === undefined) continue;

      const values = new Float32Array(times.length);
      for (let frame = startFrame; frame <= endFrame; frame++) {
        values[frame - startFrame] = morphTrack.values[frame * numTargets + index];
      }
      tracks.push(
        new NumberKeyframeTrack(
          `${nodeName}${MORPH_TRACK_SUFFIX}[${targetName}]`,
          times,
          values
        )
      );
    }
  }

  if (tracks.length === 0) return null;
  return new AnimationClip(spec.clipName, duration, tracks);
}

export interface FaceClips {
  blink: AnimationClip;
  mouth: AnimationClip;
}

function extractFaceClips(
  masterClip: AnimationClip,
  morphTargetDictionary: Record<string, number>
): FaceClips | null {
  const morphTracks = findMorphTracks(masterClip);
  if (morphTracks.length === 0) return null;

  const numTargets = morphTracks[0].values.length / morphTracks[0].times.length;
  const blink = sliceEnvelopeClip(morphTracks, numTargets, morphTargetDictionary, BLINK_SPEC);
  const mouth = sliceEnvelopeClip(morphTracks, numTargets, morphTargetDictionary, MOUTH_SPEC);
  if (!blink || !mouth) return null;

  return { blink, mouth };
}

// The master clip and its morph dictionary are identical across every clone
// of the shared, cached `useGLTF` result, so the slicing above only ever
// needs to run once for the app's whole lifetime - every Duck instance's
// mixer reuses the same two resulting clips.
let cachedFaceClips: FaceClips | null | undefined;

export function getFaceClips(
  masterClip: AnimationClip | undefined,
  morphTargetDictionary: Record<string, number> | undefined
): FaceClips | null {
  if (cachedFaceClips !== undefined) return cachedFaceClips;
  if (!masterClip || !morphTargetDictionary) return null;

  cachedFaceClips = extractFaceClips(masterClip, morphTargetDictionary);
  return cachedFaceClips;
}

/** How far the pose has to have left its rest, against the clip's own peak. */
const MOTION_DISPLACEMENT_THRESHOLD = 0.12;
/** Start a hair early, so the first frames of the gesture aren't clipped. */
const MOTION_START_LEAD_SECONDS = 0.15;
/** Never skip so far in that there's no reaction left to watch. */
const MOTION_MIN_REACTION_SECONDS = 1.2;

const motionStartCache = new Map<string, number>();

let rigLeverage: Map<string, number> | null = null;

/**
 * How far each node can throw the rest of the rig: the summed distance from
 * it to everything hanging off it.
 *
 * Weighting a bone's rotation by this is what tells the duck swinging a
 * whole leg apart from a feather twitching - both are one bone turning, and
 * only one of them is worth starting a reaction on.
 *
 * Measure it on the freshly cloned model, before it is attached to
 * anything: with no parent above it the clone's world space is its own, so
 * the distances come out in the same space the animation tracks are
 * authored in, with no scene's scale baked in. Every duck shares the one
 * skeleton, so this only ever runs once.
 */
export function measureRigLeverage(model: Object3D) {
  if (rigLeverage) return;

  const leverage = new Map<string, number>();
  const from = new Vector3();
  const to = new Vector3();

  model.updateMatrixWorld(true);
  model.traverse((node) => {
    from.setFromMatrixPosition(node.matrixWorld);
    let reach = 0;
    node.traverse((descendant) => {
      if (descendant === node) return;
      to.setFromMatrixPosition(descendant.matrixWorld);
      reach += from.distanceTo(to);
    });
    leverage.set(node.name, reach);
  });

  rigLeverage = leverage;
}

/**
 * Where a clip's actual gesture begins.
 *
 * Every body clip in this model was exported keeping its place on the
 * original timeline, so each one opens with a long stretch of the duck
 * standing perfectly still and only performs at the very end - `stun` holds
 * for 22 of its 26 seconds, `kick` for 37 of 44. Played from zero they read
 * as nothing happening at all, which is exactly how they read on screen
 * until this existed.
 *
 * What's measured is how far the pose has been carried from the one the
 * clip rests in, weighted by how much of the rig each bone moves - not how
 * fast anything is going. Speed misses a gesture that holds: `kick` winds
 * up, stands still for over a second with its leg cocked, then swings, and
 * anything hunting for movement treats that hold as the end of one gesture
 * and the start of another, so the reaction begins on the swing alone and
 * the duck plays half a kick. Displacement stays high right through a hold,
 * which makes a gesture one continuous thing by construction.
 *
 * The threshold is a share of the clip's own peak, which keeps the test
 * free of any assumption about units and of any hardcoded offset per clip -
 * this model has already been re-exported twice with everything renamed and
 * retimed.
 */
export function getClipMotionStart(clip: AnimationClip): number {
  const cached = motionStartCache.get(clip.name);
  if (cached !== undefined) return cached;
  // Without the leverage there is no way to weigh one bone against another,
  // and caching the answer would keep the wrong one. See measureRigLeverage.
  if (!rigLeverage) return 0;

  const displacementByTime = new Map<number, number>();
  const rest = new Quaternion();
  const posed = new Quaternion();

  for (const track of clip.tracks) {
    const separator = track.name.lastIndexOf(".");
    const property = track.name.slice(separator + 1);
    // Scale carries no gesture on this rig, and morph weights are the face's
    // own business - see the blink and mouth clips above.
    if (property !== "quaternion" && property !== "position") continue;

    const { times, values } = track;
    if (times.length < 2) continue;

    const stride = values.length / times.length;
    const leverage = rigLeverage.get(track.name.slice(0, separator)) ?? 0;
    if (property === "quaternion") rest.fromArray(values, 0);

    for (let frame = 1; frame < times.length; frame++) {
      const offset = frame * stride;
      let displaced = 0;

      if (property === "quaternion") {
        posed.fromArray(values, offset);
        // Negated quaternions are the same rotation, hence the abs.
        const alignment = Math.min(1, Math.abs(posed.dot(rest)));
        displaced = 2 * Math.acos(alignment) * leverage;
      } else {
        let squared = 0;
        for (let component = 0; component < stride; component++) {
          const drift = values[offset + component] - values[component];
          squared += drift * drift;
        }
        displaced = Math.sqrt(squared);
      }

      const at = Math.round(times[frame] * 1000) / 1000;
      displacementByTime.set(
        at,
        (displacementByTime.get(at) ?? 0) + displaced
      );
    }
  }

  let peak = 0;
  for (const displaced of displacementByTime.values()) {
    if (displaced > peak) peak = displaced;
  }

  let onset = Infinity;
  const threshold = peak * MOTION_DISPLACEMENT_THRESHOLD;
  for (const [at, displaced] of displacementByTime) {
    if (displaced >= threshold && at < onset) onset = at;
  }

  const start = onset === Infinity ? 0 : onset - MOTION_START_LEAD_SECONDS;
  const latest = clip.duration - MOTION_MIN_REACTION_SECONDS;
  const clamped = Math.max(0, Math.min(start, latest));

  motionStartCache.set(clip.name, clamped);
  return clamped;
}
