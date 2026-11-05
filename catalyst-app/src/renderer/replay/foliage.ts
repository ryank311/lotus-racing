// Cut-out (alpha-tested) world materials of a converted Assetto Corsa track:
// leaves, bushes, fences. They draw the way AC draws them, lit by the scene's
// own sun, sky and haze (surfaces.ts patches them like the rest of the world).
//
// Sides. AC draws every face one-sided, so a tree seen from all round is
// faces back to back: each of a tree's fins twice, the copy behind with its
// UVs mirrored (each side shows its own half of the picture). Drawn
// double-sided, both copies show from either side at the same depth and
// fight, and three flips the normal of the copy seen from behind: canopies of
// bright and black patches that crawl as the camera moves. Foliage draws
// one-sided (the converter also leaves such materials one-sided); its
// shadow is cast from both sides.
//
// Light. AC's trees carry normals made for this: a dome over each tree,
// mostly up and out, the same on both copies, so a canopy shades as one
// rounded mass from wherever it is seen. The sun wraps a little round it
// (light scatters through leaves) and glows through it towards a camera
// looking into the sun; the sky and ground light it through the
// environment. A leaf's shadow test is lifted towards the sun by about a
// metre, so a fin never shadows itself (acne on faces edge-on to the sun)
// while one side of the canopy still shades the other.
//
// Edges. Alpha to coverage on a one-pixel edge, the alpha scaled back up by
// the mip level so distant leaves keep their body (after Ben Golus,
// "Anti-aliased Alpha Test", 2017). It needs a multisampled target: the
// canvas (antialias) and the Garmin lens pass (4×) both are.

import * as THREE from 'three'
import { patchWorldMaterial, type SurfaceKind } from './surfaces'

// Three's alpha to coverage fades the edge from the cut-off up, and smaller
// mips average a leaf's alpha away, so foliage thins and sparkles as it
// moves. Instead: alpha kept by mip level, then cut to a one-pixel edge
// that multisampling smooths.
const CUTOUT_ALPHA = /* glsl */`
#ifdef USE_ALPHATEST
  #ifdef USE_MAP
    vec2 texel = vMapUv * vec2( textureSize( map, 0 ) );
    float mipLevel = max( 0.0, 0.5 * log2( max( dot( dFdx( texel ), dFdx( texel ) ), dot( dFdy( texel ), dFdy( texel ) ) ) ) );
    diffuseColor.a *= 1.0 + mipLevel * 0.25;
  #endif
  #ifdef ALPHA_TO_COVERAGE
    diffuseColor.a = clamp( ( diffuseColor.a - alphaTest ) / max( fwidth( diffuseColor.a ), 0.0001 ) + 0.5, 0.0, 1.0 );
    if ( diffuseColor.a == 0.0 ) discard;
  #else
    if ( diffuseColor.a < alphaTest ) discard;
  #endif
#endif
`

// The sun on leaves (replaces Lambert's direct term). The shadow is already
// in directLight.color.
const FOLIAGE_LIGHT = /* glsl */`
// How far the sun wraps round the canopy (0: Lambert), and how strongly it
// shines through the leaves towards a camera looking into it.
#define FOLIAGE_WRAP 0.5
#define FOLIAGE_THROUGH 0.45
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float wrap = saturate( ( dot( geometryNormal, directLight.direction ) + FOLIAGE_WRAP ) / ( 1.0 + FOLIAGE_WRAP ) );
  float through = FOLIAGE_THROUGH * pow( saturate( dot( -geometryViewDir, directLight.direction ) ), 4.0 );
  reflectedLight.directDiffuse += directLight.color * ( wrap + through ) * BRDF_Lambert( material.diffuseColor );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage
`

// Wet leaves are darker.
const FOLIAGE_WET = /* glsl */`
  diffuseColor.rgb *= 1.0 - 0.2 * uWet;
`

// Shadow lookup lifted towards the sun past the tree's own fins (world
// metres; at least a few texels of the map).
const FOLIAGE_SHADOW_VERTEX = '#define FOLIAGE_SHADOW_LIFT 5.0\n' + THREE.ShaderChunk.shadowmap_vertex.replace(
  /shadowWorldPosition = worldPosition \+ vec4\( shadowWorldNormal \* directionalLightShadows\[ i \]\.shadowNormalBias, 0 \);/,
  'shadowWorldPosition = worldPosition + vec4( uSunDir * max( FOLIAGE_SHADOW_LIFT, 3.0 * directionalLightShadows[ i ].shadowNormalBias ), 0.0 );',
)

/**
 * Sets up an alpha-tested world material (alpha to coverage, sides, foliage
 * light) and patches it with the world's shading (patchWorldMaterial).
 */
export function patchCutoutMaterial(material: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial, kind: SurfaceKind) {
  material.alphaToCoverage = true
  if (kind !== 'foliage') {
    patchWorldMaterial(material, kind, f => f.replace('#include <alphatest_fragment>', CUTOUT_ALPHA), 'cutout')
    return
  }
  // AC's own sides (foliage is AC's ksTree; see surfaceKindOf), even in a
  // model converted before the converter left it one-sided.
  material.side = THREE.FrontSide
  material.shadowSide = THREE.DoubleSide
  const lambert = (material as THREE.MeshLambertMaterial).isMeshLambertMaterial === true
  patchWorldMaterial(material, kind, f => {
    f = f.replace('#include <alphatest_fragment>', `${CUTOUT_ALPHA}\n${FOLIAGE_WET}`)
    return lambert ? f.replace('#include <lights_lambert_pars_fragment>', `#include <lights_lambert_pars_fragment>\n${FOLIAGE_LIGHT}`) : f
  }, 'foliage')
  const world = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    world.call(material, shader, renderer)
    let v = shader.vertexShader
    if (!/uniform\s+vec3\s+uSunDir\s*;/.test(v)) v = v.replace('#include <common>', '#include <common>\nuniform vec3 uSunDir;')
    shader.vertexShader = v.replace('#include <shadowmap_vertex>', FOLIAGE_SHADOW_VERTEX)
  }
}
