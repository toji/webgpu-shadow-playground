import { Geometry } from '../core/mesh.js';
import { WebGPUMaterialPipeline, RenderOrder } from './materials/webgpu-materials.js';
import { DebugPointVertexSource, DebugPointFragmentSource } from './wgsl/debug-point.js';
import { Transform, StaticTransform } from '../core/transform.js';
import { INSTANCE_BUFFER_LAYOUT } from './materials/webgpu-material-factory.js';

export class WebGPUDebugPoint {
  static gpuPipelines = new WeakMap();
  static pointGeometry = new Geometry({ drawCount: 4 });

  static addPoint(gpu, position, color = [1, 1, 1, 1]) {
    const pipeline = WebGPUDebugPoint.getGPUPipeline(gpu);
    gpu.renderBatch.addRenderable(WebGPUDebugPoint.pointGeometry, pipeline, undefined, {
      transform: new StaticTransform({
        position,
      }),
      color
    });
  }

  static getGPUPipeline(gpu) {
    let pointPipeline = WebGPUDebugPoint.gpuPipelines.get(gpu);
    if (!pointPipeline) {
      const vertexModule = gpu.device.createShaderModule({
        code: DebugPointVertexSource,
        label: 'Debug Point Vertex'
      });
      const fragmentModule = gpu.device.createShaderModule({
        code: DebugPointFragmentSource,
        label: 'Debug Point Fragment'
      });

      const fragmentTargets = [{
        format: gpu.renderTargets.format,
        blend: {
          color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one',
          },
          alpha: {
            srcFactor: "one",
            dstFactor: "one",
          },
        },
      }]

      if (gpu.flags.bloomEnabled) {
        fragmentTargets.push({
          format: gpu.renderTargets.format,
          writeMask: 0,
        });
      }

      const pipeline = gpu.device.createRenderPipeline({
        label: `Debug Point Pipeline`,
        layout: gpu.device.createPipelineLayout({
          bindGroupLayouts: [
            gpu.bindGroupLayouts.frame,
          ]
        }),
        vertex: {
          module: vertexModule,
          entryPoint: 'vertexMain',
          buffers: [ INSTANCE_BUFFER_LAYOUT ]
        },
        fragment: {
          module: fragmentModule,
          entryPoint: 'fragmentMain',
          targets: fragmentTargets,
        },
        primitive: {
          topology: 'triangle-strip',
          stripIndexFormat: 'uint32'
        },
        depthStencil: {
          depthWriteEnabled: false,
          depthCompare: 'less',
          format: gpu.renderTargets.depthFormat,
        },
        multisample: {
          count: gpu.renderTargets.sampleCount,
        }
      });

      pointPipeline = new WebGPUMaterialPipeline({
        pipeline,
        renderOrder: RenderOrder.Last,
        instanceSlot: 0,
      });

      WebGPUDebugPoint.gpuPipelines.set(gpu, pointPipeline);
    }

    return pointPipeline;
  }
}