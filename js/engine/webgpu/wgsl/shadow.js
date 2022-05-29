import { wgsl } from 'wgsl-preprocessor';
import { DefaultVertexOutput } from './common.js';

export function ShadowFunctions(group = 0, flags) { return wgsl`
  @group(0) @binding(3) var defaultSampler: sampler;
  @group(${group}) @binding(4) var shadowTexture : texture_depth_2d;
  @group(${group}) @binding(5) var shadowSampler : sampler_comparison;

  struct LightShadowTable {
    light : array<vec2<i32>>,
  };
  @group(${group}) @binding(6) var<storage, read> lightShadowTable : LightShadowTable;

#if ${flags.shadowSamples == 16}
  let sampleWidth = 3.0;
  var<private> shadowSampleOffsets : array<vec2<f32>, 16> = array<vec2<f32>, 16>(
    vec2(-1.5, -1.5), vec2(-1.5, -0.5), vec2(-1.5, 0.5), vec2(-1.5, 1.5),
    vec2(-0.5, -1.5), vec2(-0.5, -0.5), vec2(-0.5, 0.5), vec2(-0.5, 1.5),
    vec2(0.5, -1.5), vec2(0.5, -0.5), vec2(0.5, 0.5), vec2(0.5, 1.5),
    vec2(1.5, -1.5), vec2(1.5, -0.5), vec2(1.5, 0.5), vec2(1.5, 1.5)
  );
#elif ${flags.shadowSamples == 4}
  let sampleWidth = 2.0;
  var<private> shadowSampleOffsets : array<vec2<f32>, 4> = array<vec2<f32>, 4>(
    vec2(-0.5, -0.5), vec2(-0.5, 0.5), vec2(0.5, -0.5), vec2(0.5, 0.5),
  );
#elif ${flags.shadowSamples == 2}
let sampleWidth = 1.0;
  var<private> shadowSampleOffsets : array<vec2<f32>, 2> = array<vec2<f32>, 2>(
    vec2(-0.5, -0.5), vec2(0.5, 0.5)
  );
#elif ${flags.shadowSamples == 1}
  let sampleWidth = 0.0;
  var<private> shadowSampleOffsets : array<vec2<f32>, 1> = array<vec2<f32>, 1>(
    vec2(0.0, 0.0)
  );
#else
  ERROR: Bad flag. shadowSampleCount must be 16, 4, 2, or 1
#endif

  let shadowSampleCount = ${flags.shadowSamples}u;

  struct ShadowProperties {
    viewport: vec4<f32>,
    viewProj: mat4x4<f32>,
  };
  struct LightShadows {
    properties : array<ShadowProperties>
  };
  @group(${group}) @binding(7) var<storage, read> shadow : LightShadows;

  struct CascadeInfo {
    index: i32,
    viewport: vec4<f32>,
    shadowPos: vec3<f32>,
  };

  fn selectCascade(lightIndex : u32, worldPos : vec3<f32>) -> CascadeInfo {
    var cascade : CascadeInfo;
    cascade.index = -1;

    let shadowLookup = lightShadowTable.light[0u];
    let shadowIndex = shadowLookup.x;
    if (shadowIndex == -1) {
      return cascade; // Not a shadow casting light
    }

    let texelSize = 1.0 / vec2<f32>(textureDimensions(shadowTexture, 0));

    let cascadeCount = max(1, shadowLookup.y);

    for (var i = 0; i < cascadeCount; i = i + 1) {
      cascade.viewport = shadow.properties[shadowIndex+i].viewport;
      let lightPos = shadow.properties[shadowIndex+i].viewProj * vec4(worldPos, 1.0);

      // Put into texture coordinates
      cascade.shadowPos = vec3(
        ((lightPos.xy / lightPos.w)) * vec2(0.5, -0.5) + vec2(0.5, 0.5),
        lightPos.z / lightPos.w);

      // If the shadow falls outside the range covered by this cascade, skip it and try the next one up.
      if (all(cascade.shadowPos > vec3(texelSize*sampleWidth,0.0)) && all(cascade.shadowPos < vec3(vec2(1.0)-(texelSize*sampleWidth),1.0))) {
        cascade.index = i;
        return cascade;
      }
    }

    // None of the cascades fit.
    return cascade;
  }

  fn dirLightVisibility(worldPos : vec3<f32>) -> f32 {
    let cascade = selectCascade(0u, worldPos);

    let viewportPos = vec2(cascade.viewport.xy + cascade.shadowPos.xy * cascade.viewport.zw);

    let texelSize = 1.0 / vec2<f32>(textureDimensions(shadowTexture, 0));
    let clampRect = vec4(cascade.viewport.xy - texelSize, (cascade.viewport.xy+cascade.viewport.zw) + texelSize);

    // Percentage Closer Filtering
    var visibility = 0.0;
    for (var i = 0u; i < shadowSampleCount; i = i + 1u) {
      visibility = visibility + textureSampleCompareLevel(
        shadowTexture, shadowSampler,
        clamp(viewportPos + shadowSampleOffsets[i] * texelSize, clampRect.xy, clampRect.zw),
        cascade.shadowPos.z);
    }

    return visibility / f32(shadowSampleCount);
  }

  // First two components of the return value are the texCoord, the third component is the face index.
  fn getCubeFace(v : vec3<f32>) -> i32{
    let vAbs = abs(v);

    if (vAbs.z >= vAbs.x && vAbs.z >= vAbs.y) {
      if (v.z < 0.0) {
        return 5;
      }
      return 4;
    }

    if (vAbs.y >= vAbs.x) {
      if (v.y < 0.0) {
        return 3;
      }
      return 2;
    }

    if (v.x < 0.0) {
      return 1;
    }
    return 0;
  }

  fn pointLightVisibility(lightIndex : u32, worldPos : vec3<f32>, pointToLight : vec3<f32>) -> f32 {
    var shadowIndex = lightShadowTable.light[lightIndex+1u].x;
    if (shadowIndex == -1) {
      return 1.0; // Not a shadow casting light
    }

    // Determine which face of the cubemap we're sampling from
    // TODO: Allow for PBR sampling across seams
    shadowIndex = shadowIndex + getCubeFace(pointToLight * -1.0);

    let viewport = shadow.properties[shadowIndex].viewport;
    let lightPos = shadow.properties[shadowIndex].viewProj * vec4(worldPos, 1.0);

    // Put into texture coordinates
    let shadowPos = vec3(
      ((lightPos.xy / lightPos.w)) * vec2(0.5, -0.5) + vec2(0.5, 0.5),
      lightPos.z / lightPos.w);

    let viewportPos = vec2(viewport.xy + shadowPos.xy * viewport.zw);

    let texelSize = 1.0 / vec2<f32>(textureDimensions(shadowTexture, 0));
    let clampRect = vec4(viewport.xy, (viewport.xy+viewport.zw));

    // Percentage Closer Filtering
    var visibility = 0.0;
    for (var i = 0u; i < shadowSampleCount; i = i + 1u) {
      visibility = visibility + textureSampleCompareLevel(
        shadowTexture, shadowSampler,
        clamp(viewportPos + shadowSampleOffsets[i] * texelSize, clampRect.xy, clampRect.zw),
        shadowPos.z - 0.01);
    }
    return visibility / f32(shadowSampleCount);
  }
`;
}

export function ShadowFragmentSource(layout) { return `
  ${DefaultVertexOutput(layout)}

  @stage(fragment)
  fn fragmentMain(input : VertexOutput) {
  }
`;
}
