/* Portado de tuxdi-site-webapp/components/common/3D/fresnelRim.ts */
import { Color } from "three";

/**
 * The Fresnel rim the site's lit models share.
 *
 * Lives in its own module rather than in `Duck.tsx` because the Duo scene's
 * lamp wants the same edge, and `fresnelRim` must stay ONE function object
 * across every consumer - see `RIM_CACHE_KEY` below for why a second copy of
 * this source would cost a second shader compilation.
 */

/* ------------------------------------------------------------------ *
 *  The rim
 *
 *  A Fresnel edge: bright where the surface turns away from the camera, gone
 *  where it faces it. It follows the silhouette rather than any light, which
 *  is the point — it is view-dependent, so it holds all the way around the
 *  model and moves across it as the camera does.
 *
 *  It is also the one place in this material where a saturated colour is
 *  free. Everywhere else a light's colour *multiplies* the surface, and this
 *  duck's body is a yellow with no blue in it, so a saturated magenta lamp
 *  comes back dark red — the whole difficulty the hero's rig spent two passes
 *  on. This is added emission, not reflected light: nothing multiplies it, so
 *  the site's own `#af2eff` arrives as `#af2eff`.
 * ------------------------------------------------------------------ */

/** `secondary` from the site's palette — the hero's lights and floor glow. */
export const RIM_COLOR = "#AF2EFF";

/**
 * Two Fresnel terms rather than one, because there is no bloom pass anywhere
 * in this project — `@react-three/postprocessing` is installed and entirely
 * unused. A glow is a bright core plus the spill a post-process smears around
 * it, and with nothing doing the smearing the spill has to be drawn by hand.
 * So the core is the hot filament in the last pixels of the outline, and the
 * halo is the wide weak wrap standing in for the bloom that is not there. One
 * exponent cannot be both: tight enough to read as an edge and broad enough to
 * read as light.
 *
 * For a rounded form these land where they sound like they do — on a sphere
 * `dot(N,V)` is `sqrt(1 - (r/R)²)`, so the core only reaches strength in the
 * outermost couple of per cent of the radius, while the halo builds gradually
 * across the outer tenth or so.
 *
 * The two strengths sum to 0.88, a stop short of 1, and that gap is deliberate.
 * The scene that asks for these materials renders with tone mapping off, so
 * nothing rolls off — anything over 1 clips square. And this colour clips
 * unevenly: linear `#af2eff` is (0.43, 0.03, 1.00), so its blue is *already* at
 * the ceiling before the rim adds a thing, while its red has most of the range
 * still to go. Which gives a diagnostic worth remembering: if the brightest
 * part of the rim reads pink-white instead of magenta, that is blue clipping
 * while red is still climbing, and the fix is a *smaller* core strength, not a
 * larger one.
 */
const RIM_CORE_POWER = 6;
const RIM_CORE_STRENGTH = 0.6;
const RIM_HALO_POWER = 2;
const RIM_HALO_STRENGTH = 0.28;

/**
 * Builds the `onBeforeCompile` that adds that rim, patched into three's own
 * physical shader.
 *
 * Two things about the anchor are load-bearing. It is `opaque_fragment` and
 * not the more obvious `totalEmissiveRadiance`, because the emissive term is
 * folded into `outgoingLight` *before* the clearcoat block, and that block
 * does `outgoingLight *= 1.0 - clearcoat * Fcc` — where `Fcc` tends to 1 at
 * grazing angles. A rim added upstream is therefore attenuated hardest at
 * exactly the silhouette it exists to draw. And it is `opaque_fragment`
 * rather than `output_fragment` because the latter was renamed in three 0.152
 * and no longer exists: a `.replace` whose pattern does not match throws
 * nothing and changes nothing, so the wrong name here is a rim that simply
 * never appears, with a clean console.
 *
 * `normal` and `vViewPosition` are both already in scope at that point.
 * `normal` is view-space and has the skeleton's bone matrices folded in
 * upstream, so it stays correct while the duck animates without anything
 * here having to know about that. `vViewPosition` points *from* the fragment
 * *towards* the eye already, so it must not be negated again.
 */
const RIM_ANCHOR = "#include <opaque_fragment>";

/**
 * The rim's colour, in the space the shader actually works in.
 *
 * `Color` holds a hex already converted to linear whenever colour management
 * is on, which is r3f's default — and linear is exactly what `outgoingLight`
 * is, upstream of `<colorspace_fragment>`. So this is read as-is, and calling
 * `convertSRGBToLinear()` on it would be converting the same value twice: the
 * blue component would fall from 1.0 to 0.22 and the rim would come out dark
 * and muddy. Verified rather than assumed — `new Color("#af2eff")` holds
 * (0.4287, 0.0273, 1.0000) and round-trips back to `af2eff`.
 */
const RIM_LINEAR = new Color(RIM_COLOR);

/**
 * The patch itself, built once. A single function object shared by every
 * material that wants the rim, which is not merely tidy — see
 * `RIM_CACHE_KEY`.
 */
export const fresnelRim = (shader: { fragmentShader: string }) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    RIM_ANCHOR,
    /* glsl */ `
        {
          // \`normal\` is view-space and already unit: \`normal_fragment_begin\`
          // normalizes it on every branch it has, and on this skinned mesh
          // \`skinnormal_vertex\` has folded the bone matrices in upstream, so
          // it is the *deforming* model's normal and the rim rides the
          // animation instead of sitting on the rest pose.
          //
          // \`vViewPosition\` is \`-mvPosition.xyz\` — it already points from the
          // fragment towards the eye and must not be negated again. It is not
          // unit, which is the one normalize here that is real work.
          float rimEdge = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
          float rimAmount =
            pow(rimEdge, ${RIM_CORE_POWER.toFixed(1)}) * ${RIM_CORE_STRENGTH.toFixed(3)} +
            pow(rimEdge, ${RIM_HALO_POWER.toFixed(1)}) * ${RIM_HALO_STRENGTH.toFixed(3)};
          outgoingLight += vec3(
            ${RIM_LINEAR.r.toFixed(4)},
            ${RIM_LINEAR.g.toFixed(4)},
            ${RIM_LINEAR.b.toFixed(4)}
          ) * rimAmount;
        }
        ${RIM_ANCHOR}
      `
  );
};

/**
 * Three keys its compiled programs partly on `onBeforeCompile.toString()`, and
 * `WebGLPrograms.acquireProgram` reuses a program across materials on a
 * cache-key match *alone* — it never compares the shader source it was handed.
 *
 * The good half of that: `fresnelRim` above is one shared function object, so
 * its `toString()` is one constant string and this adds no compilations at
 * all. The lit set still splits exactly where it already split — on
 * `USE_CLEARCOAT`, since the mouth interior is the one part with
 * `clearcoat: 0`.
 *
 * The bad half, and the reason this exists: a function's `toString()` is its
 * *source text*, and the numbers above are baked into the shader string rather
 * than into that source, so they do not appear in it. Without a key of their
 * own, editing them and letting Fast Refresh rebuild the materials produces a
 * new material whose key still matches the *old* program — and three hands
 * that old program back. The edit does nothing at all until a hard reload,
 * with no error anywhere. So the numbers go in the key, spelled out.
 */
export const RIM_CACHE_KEY = [
  "duck-rim",
  RIM_COLOR,
  RIM_CORE_POWER,
  RIM_CORE_STRENGTH,
  RIM_HALO_POWER,
  RIM_HALO_STRENGTH,
].join(":");
