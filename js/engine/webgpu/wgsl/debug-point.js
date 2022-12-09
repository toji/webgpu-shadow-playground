import { CameraStruct, SkinStructs, GetSkinMatrix, DefaultVertexInput, DefaultVertexOutput, GetInstanceMatrix } from './common.js';
import { AttributeLocation } from '../../core/mesh.js';

const SIZE = 0.05;

export const DebugPointVertexSource = `
  var<private> pos : array<vec2<f32>, 4> = array<vec2<f32>, 4>(
    vec2(-${SIZE}, ${SIZE}), vec2(${SIZE}, ${SIZE}), vec2(-${SIZE}, -${SIZE}), vec2(${SIZE}, -${SIZE})
  );

  ${CameraStruct()}
  ${GetInstanceMatrix}

  struct VertexInput {
    @builtin(vertex_index) vertexIndex : u32,
    @builtin(instance_index) instanceIndex : u32,

    @location(${AttributeLocation.maxAttributeLocation}) instance0 : vec4<f32>,
    @location(${AttributeLocation.maxAttributeLocation+1}) instance1 : vec4<f32>,
    @location(${AttributeLocation.maxAttributeLocation+2}) instance2 : vec4<f32>,
    @location(${AttributeLocation.maxAttributeLocation+3}) instance3 : vec4<f32>,
    @location(${AttributeLocation.maxAttributeLocation+4}) instanceColor : vec4<f32>,
  }

  struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) localPos : vec2<f32>,
    @location(1) color: vec4<f32>,
  };

  @vertex
  fn vertexMain(input : VertexInput) -> VertexOutput {
    var output : VertexOutput;

    let modelMatrix = getInstanceMatrix(input);
    output.localPos = pos[input.vertexIndex];
    output.color = input.instanceColor;
    let worldPos = vec3(output.localPos, 0.0); // * modelMatrix;

    // Generate a billboarded model view matrix
    var bbModelViewMatrix : mat4x4<f32>;
    bbModelViewMatrix = camera.view * modelMatrix;
    bbModelViewMatrix[0][0] = 1.0;
    bbModelViewMatrix[0][1] = 0.0;
    bbModelViewMatrix[0][2] = 0.0;

    bbModelViewMatrix[1][0] = 0.0;
    bbModelViewMatrix[1][1] = 1.0;
    bbModelViewMatrix[1][2] = 0.0;

    bbModelViewMatrix[2][0] = 0.0;
    bbModelViewMatrix[2][1] = 0.0;
    bbModelViewMatrix[2][2] = 1.0;

    output.position = camera.projection * bbModelViewMatrix * vec4(worldPos, 1.0);
    //output.position = camera.projection * camera.view * modelMatrix * vec4(worldPos, 1.0);
    return output;
  }
`;

export const DebugPointFragmentSource = `
  struct FragmentInput {
    @location(0) localPos : vec2<f32>,
    @location(1) color: vec4<f32>,
  };

  @fragment
  fn fragmentMain(input : FragmentInput) -> @location(0) vec4<f32> {
    let distToCenter = length(input.localPos * ${(1/SIZE).toFixed(2)});
    let fade = (1.0 - distToCenter) * (1.0 / (distToCenter * distToCenter * distToCenter));
    return vec4(input.color * fade);

    //return vec4(input.color);
  }
`;