import { WebGPUSystem } from './webgpu-system.js';
import { Stage } from '../core/stage.js';
import { Transform } from '../core/transform.js';
import { DirectionalLight, PointLight, ShadowCastingLight } from '../core/light.js';
import { TextureAtlasAllocator } from '../util/texture-atlas-allocator.js';
import { ShadowFragmentSource,  } from './wgsl/shadow.js';
import { WebGPUCamera, WebGPUCameraBase } from './webgpu-camera.js';
import { WebGPUDebugPoint } from './webgpu-debug-point.js';

import { mat4, vec3, vec4 } from 'gl-matrix';

const tmpVec3 = vec3.create();
const lightPos = vec3.create();

// Given in OpenGL Order:
const pointShadowLookDirs = [
  vec3.fromValues(1, 0, 0), // POSITIVE_X
  vec3.fromValues(-1, 0, 0), // NEGATIVE_X
  vec3.fromValues(0, 1, 0), // POSITIVE_Y
  vec3.fromValues(0, -1, 0), // NEGATIVE_Y
  vec3.fromValues(0, 0, 1), // POSITIVE_Z
  vec3.fromValues(0, 0, -1), // NEGATIVE_Z
];

const pointShadowUpDirs = [
  vec3.fromValues(0, 1, 0),
  vec3.fromValues(0, 1, 0),
  vec3.fromValues(0, 0, -1),
  vec3.fromValues(0, 0, -1),
  vec3.fromValues(0, 1, 0),
  vec3.fromValues(0, 1, 0),
];

export class WebGPUShadowCamera extends WebGPUCameraBase {
  frustumCorners;
  frustumCenter;
  min;
  max;

  constructor(gpu) {
    super(gpu)
    const device = gpu.device;

    const dummyStorageBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE
    });

    const dummyShadowTexture = device.createTexture({
      size: [4, 4],
      usage: GPUTextureUsage.TEXTURE_BINDING,
      format: 'depth32float'
    });

    this.bindGroup = gpu.device.createBindGroup({
      layout: gpu.bindGroupLayouts.frame,
      entries: [{
        binding: 0,
        resource: { buffer: this.cameraBuffer, },
      }, {
        binding: 1,
        resource: { buffer: dummyStorageBuffer, },
      }, {
        binding: 2,
        resource: { buffer: dummyStorageBuffer, },
      }, {
        binding: 3,
        resource: gpu.defaultSampler
      }, {
        binding: 4,
        resource: dummyShadowTexture.createView()
      }, {
        binding: 5,
        resource: gpu.shadowDepthSampler
      }, {
        binding: 6,
        resource: { buffer: gpu.lightShadowTableBuffer, },
      }, {
        binding: 7,
        resource: { buffer: gpu.shadowPropertiesBuffer, },
      }],
    });
  }

  updateRect(rect) {
    this.outputSize[0] = rect.width;
    this.outputSize[1] = rect.height;

    // Build a 1px border into the viewport so that we don't get blending artifacts.
    this.viewport = [
      rect.x+1, rect.y+1, rect.width-2, rect.height-2, 0.0, 1.0
    ];
  }
}

export class WebGPUShadowSettings {
  depthBias = 0.1;
  depthBiasSlopeScale = 0.0;
  updated = false;
  lockCascadeFrustum = false;
}

export class WebGPUShadowSystem extends WebGPUSystem {
  stage = Stage.ShadowRender;

  #shadowPipelineCache = new WeakMap();
  #shadowCameraCache = new WeakMap();
  frameCount = 0;

  init(gpu) {
    this.singleton.add(new WebGPUShadowSettings());

    this.shadowCastingLightQuery = this.query(ShadowCastingLight);
    this.shadowCameraQuery = this.query(WebGPUShadowCamera);
    this.shadowUpdateFrequency = gpu.flags.shadowUpdateFrequency;
    this.cameraQuery = this.query(WebGPUCamera);
  }

  getOrCreateShadowPipeline(gpu, webgpuPipeline) {
    let shadowPipeline = this.#shadowPipelineCache.get(webgpuPipeline);
    if (!shadowPipeline) {
      shadowPipeline = this.createShadowPipeline(gpu, webgpuPipeline);
      this.#shadowPipelineCache.set(webgpuPipeline, shadowPipeline);
    }
    return shadowPipeline;
  }

  createShadowPipeline(gpu, webgpuPipeline) {
    const shadowSettings = this.singleton.get(WebGPUShadowSettings);
    return gpu.device.createRenderPipeline({
      label: `Shadow Pipeline For PipelineID: ${webgpuPipeline.pipelineId})`,
      layout: webgpuPipeline.pipelineLayout,
      vertex: webgpuPipeline.vertex,
      fragment: {
        module: gpu.device.createShaderModule({
          label: `Shadow Fragment shader module (Layout: ${webgpuPipeline.layout.id})`,
          code: ShadowFragmentSource(webgpuPipeline.layout)
        }),
        entryPoint: 'fragmentMain',
        targets: []
      },
      primitive: webgpuPipeline.layout.primitive,
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: gpu.shadowFormat,

        depthBias: shadowSettings.depthBias,
        depthBiasSlopeScale: shadowSettings.depthBiasSlopeScale,
      },
    });
  }

  execute(delta, time, gpu) {
    const shadowSettings = this.singleton.get(WebGPUShadowSettings);
    if (shadowSettings.updated) {
      this.#shadowPipelineCache = new WeakMap();
      shadowSettings.updated = false;
    }

    // This is silly, but for the moment it shouldn't give us too much trouble.
    // TODO: Find a better way to track when texture atlas rects are no longer
    // in use.
    this.allocator = new TextureAtlasAllocator(gpu.shadowAtlasSize);

    this.frameCount++;
    if (this.frameCount % gpu.flags.shadowUpdateFrequency != 0) {
      // Skip shadow updates this frame.
      return;
    }

    const lightShadowTable = new Int32Array(gpu.maxLightCount * 2);
    lightShadowTable.fill(-1);

    const shadowProperties = new Float32Array(gpu.maxShadowCasters * 20);

    const frameShadowCameras = [];

    let shadowIndex = 1;
    this.shadowCastingLightQuery.forEach((entity, shadowCaster) => {
      const directionalLight = entity.get(DirectionalLight);
      if (directionalLight) {
        const shadowMapSize = shadowCaster.textureSize * gpu.flags.shadowResolutionMultiplier;

        if (shadowCaster.cascades > 0) {
          // Cascading shadow map
          let shadowCameras = this.#shadowCameraCache.get(directionalLight);
          if (!shadowCameras || !Array.isArray(shadowCameras) || shadowCameras.length != shadowCaster.cascades) {
            shadowCameras = [];
            for (let i = 0; i < shadowCaster.cascades; ++i) {
              shadowCameras.push(new WebGPUShadowCamera(gpu));
            }
            this.#shadowCameraCache.set(directionalLight, shadowCameras);
          }

          const logIt = (performance.now() - this.lastTime > 5000);
          if (logIt) {
            this.lastTime = performance.now();
          }

          // Get the inverse proj*view matrix for the camera.
          const invViewProj = mat4.create();
          let proj, zNear, zFar;
          this.cameraQuery.forEach((entity, camera) => {
            proj = camera.projection;
            zNear = camera.zRange[0];
            zFar = camera.zRange[1];
            mat4.multiply(invViewProj, camera.projection, camera.view);
            mat4.invert(invViewProj, invViewProj);
            return false;
          });

          const zSpan = (zFar - zNear)/shadowCaster.cascades;
          const zRatio = zFar / zNear;
          const zPt = vec4.create();

          for (let i = 0; i < shadowCaster.cascades; ++i) {
            const shadowAtlasRect = this.allocator.allocate(shadowMapSize);
            const shadowCamera = shadowCameras[i];
            shadowCamera.updateRect(shadowAtlasRect);
            frameShadowCameras.push(shadowCamera);

            if (!shadowSettings.lockCascadeFrustum) {
              //let near = (i * -zSpan) - zNear
              //let far = ((i+1) * -zSpan) - zNear

              let near = -zNear * Math.pow(zRatio, ((i == 0 ? 0 : i + 1) / (shadowCaster.cascades + 1)));
              let far = -zNear * Math.pow(zRatio, ((i + 2) / (shadowCaster.cascades + 1)));

              vec4.set(zPt, 0, 0, near, 1);
              vec4.transformMat4(zPt, zPt, proj);
              near = zPt[2] / zPt[3];

              vec4.set(zPt, 0, 0, far, 1);
              vec4.transformMat4(zPt, zPt, proj);
              far = zPt[2] / zPt[3];

              // Compute the world-space corners of this chunk of the frustum
              shadowCamera.frustumCorners = [
                vec4.transformMat4(vec4.create(), [-1,  1, near, 1], invViewProj),
                vec4.transformMat4(vec4.create(), [ 1,  1, near, 1], invViewProj),
                vec4.transformMat4(vec4.create(), [-1, -1, near, 1], invViewProj),
                vec4.transformMat4(vec4.create(), [ 1, -1, near, 1], invViewProj),
                vec4.transformMat4(vec4.create(), [-1,  1, far , 1], invViewProj),
                vec4.transformMat4(vec4.create(), [ 1,  1, far , 1], invViewProj),
                vec4.transformMat4(vec4.create(), [-1, -1, far , 1], invViewProj),
                vec4.transformMat4(vec4.create(), [ 1, -1, far , 1], invViewProj),
              ];

              // Get the world-space center of the frustum
              shadowCamera.frustumCenter = vec3.create();
              for (const corner of shadowCamera.frustumCorners) {
                vec4.scale(corner, corner, 1/corner[3]);
                vec3.add(shadowCamera.frustumCenter, shadowCamera.frustumCenter, corner);
              }
              vec3.div(shadowCamera.frustumCenter, shadowCamera.frustumCenter, [8, 8, 8]);

              // Compute the light's view matrix to point at the frustum center
              vec3.add(shadowCamera.position, shadowCamera.frustumCenter, directionalLight.direction);
              mat4.lookAt(shadowCamera.view, shadowCamera.position, shadowCamera.frustumCenter, shadowCaster.up);

              // Generate a light-space bounding box for the frustum
              const lightSpaceVec = vec3.create();
              shadowCamera.min = vec3.fromValues(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
              shadowCamera.max = vec3.fromValues(Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE);
              for (const corner of shadowCamera.frustumCorners) {
                vec3.transformMat4(lightSpaceVec, corner, shadowCamera.view);
                vec3.min(shadowCamera.min, shadowCamera.min, lightSpaceVec);
                vec3.max(shadowCamera.max, shadowCamera.max, lightSpaceVec);
              }

              // Adjust the zNear/Far to ensure we don't miss scene geometry that's not in the
              // frustum but still may casts shadows.
              const zMult = 7.0;
              if (shadowCamera.min[2] < 0) {
                shadowCamera.min[2] *= zMult;
              } else {
                shadowCamera.min[2] /= zMult;
              }
              if (shadowCamera.max[2] < 0) {
                shadowCamera.max[2] /= zMult;
              } else {
                shadowCamera.max[2] *= zMult;
              }

              mat4.orthoZO(shadowCamera.projection,
                shadowCamera.min[0], shadowCamera.max[0],
                shadowCamera.min[1], shadowCamera.max[1],
                shadowCamera.min[2], shadowCamera.max[2]);
              mat4.invert(shadowCamera.inverseProjection, shadowCamera.projection);

              shadowCamera.time[0] = time;
              shadowCamera.zRange[0] = shadowCamera.min[2];
              shadowCamera.zRange[1] = shadowCamera.max[2];
            }

            // Debugging visualization
            /*for (const corner of shadowCamera.frustumCorners) {
              WebGPUDebugPoint.addPoint(gpu, corner);
            }
            WebGPUDebugPoint.addPoint(gpu, shadowCamera.frustumCenter, [1, 0, 0, 1]);*/

            gpu.device.queue.writeBuffer(shadowCamera.cameraBuffer, 0, shadowCamera.arrayBuffer);

            const propertyOffset = i * 20 * Float32Array.BYTES_PER_ELEMENT;
            const shadowViewport = new Float32Array(shadowProperties.buffer, propertyOffset, 4);
            const viewProjMat = new Float32Array(shadowProperties.buffer, propertyOffset + 4 * Float32Array.BYTES_PER_ELEMENT, 16);

            vec4.scale(shadowViewport, shadowCamera.viewport, 1.0/gpu.shadowAtlasSize);
            mat4.multiply(viewProjMat, shadowCamera.projection, shadowCamera.view);
          }
        } else {
          // Standard directional shadow map
          const transform = entity.get(Transform);
          if (!transform) {
            throw new Error('Shadow casting directional lights must have a transform to indicate where the shadow map' +
              'originates. (Only the position will be considered.)');
          }

          let shadowCamera = this.#shadowCameraCache.get(directionalLight);
          if (!shadowCamera || Array.isArray(shadowCamera)) {
            shadowCamera = new WebGPUShadowCamera(gpu);
            this.#shadowCameraCache.set(directionalLight, shadowCamera);
          }

          const shadowAtlasRect = this.allocator.allocate(shadowMapSize);
          shadowCamera.updateRect(shadowAtlasRect);
          frameShadowCameras.push(shadowCamera);

          // Update the shadow camera's properties
          transform.getWorldPosition(shadowCamera.position);
          vec3.sub(tmpVec3, shadowCamera.position, directionalLight.direction);
          mat4.lookAt(shadowCamera.view, shadowCamera.position, tmpVec3, shadowCaster.up);

          mat4.orthoZO(shadowCamera.projection,
            shadowCaster.width * -0.5, shadowCaster.width * 0.5,
            shadowCaster.height * -0.5, shadowCaster.height * 0.5,
            shadowCaster.zNear, shadowCaster.zFar);
          mat4.invert(shadowCamera.inverseProjection, shadowCamera.projection);

          shadowCamera.time[0] = time;
          shadowCamera.zRange[0] = shadowCaster.zNear;
          shadowCamera.zRange[1] = shadowCaster.zFar;

          gpu.device.queue.writeBuffer(shadowCamera.cameraBuffer, 0, shadowCamera.arrayBuffer);

          const propertyOffset = 0; // Directional light is always shadow index 0
          const shadowViewport = new Float32Array(shadowProperties.buffer, propertyOffset, 4);
          const viewProjMat = new Float32Array(shadowProperties.buffer, propertyOffset + 4 * Float32Array.BYTES_PER_ELEMENT, 16);

          vec4.scale(shadowViewport, shadowCamera.viewport, 1.0/gpu.shadowAtlasSize);
          mat4.multiply(viewProjMat, shadowCamera.projection, shadowCamera.view);
        }

        lightShadowTable[0] = 0; // Directional light is always considered light 0
        lightShadowTable[1] = shadowCaster.cascades;
        shadowIndex+=shadowCaster.cascades
      }

      const pointLight = entity.get(PointLight);
      if (pointLight) {
        // Point lights are made up of 6 shadow cameras, one pointing down each axis.
        let shadowCameras = this.#shadowCameraCache.get(pointLight);

        const shadowMapSize = shadowCaster.textureSize * gpu.flags.shadowResolutionMultiplier;
        if (!shadowCameras) {
          shadowCameras = [];
          for (let i = 0; i < 6; ++i) {
            const shadowAtlasRect = this.allocator.allocate(shadowMapSize);
            shadowCameras.push(new WebGPUShadowCamera(gpu, shadowAtlasRect));
          }
          this.#shadowCameraCache.set(pointLight, shadowCameras);
        } else {
          for (let i = 0; i < 6; ++i) {
            const shadowAtlasRect = this.allocator.allocate(shadowMapSize);
            shadowCameras[i].updateRect(shadowAtlasRect);
          }
        }

        const transform = entity.get(Transform);
        if (transform) {
          transform.getWorldPosition(lightPos);
        } else {
          vec3.set(lightPos, 0, 0, 0);
        }

        for (let i = 0; i < 6; ++i) {
          const shadowCamera = shadowCameras[i];
          const lookDir = pointShadowLookDirs[i];

          vec3.copy(shadowCamera.position, lightPos);
          vec3.add(tmpVec3, shadowCamera.position, lookDir);
          mat4.lookAt(shadowCamera.view, shadowCamera.position, tmpVec3, pointShadowUpDirs[i]);

          // TODO: Can the far plane at least be derived from the light range?
          mat4.perspectiveZO(shadowCamera.projection, Math.PI * 0.5, 1, shadowCaster.zNear, shadowCaster.zFar);
          mat4.invert(shadowCamera.inverseProjection, shadowCamera.projection);

          shadowCamera.time[0] = time;
          shadowCamera.zRange[0] = shadowCaster.zNear;
          shadowCamera.zRange[1] = shadowCaster.zFar;

          gpu.device.queue.writeBuffer(shadowCamera.cameraBuffer, 0, shadowCamera.arrayBuffer);

          const propertyOffset = (shadowIndex+i) * 20 * Float32Array.BYTES_PER_ELEMENT;
          const shadowViewport = new Float32Array(shadowProperties.buffer, propertyOffset, 4);
          const viewProjMat = new Float32Array(shadowProperties.buffer, propertyOffset + 4 * Float32Array.BYTES_PER_ELEMENT, 16);

          vec4.scale(shadowViewport, shadowCamera.viewport, 1.0/gpu.shadowAtlasSize);
          mat4.multiply(viewProjMat, shadowCamera.projection, shadowCamera.view);
        }

        frameShadowCameras.push(...shadowCameras);

        lightShadowTable[(pointLight.lightIndex+1)*2] = shadowIndex;
        shadowIndex+=6;
      }
    });

    if (!frameShadowCameras.length) { return; }

    // TODO: Do spot lights as well

    gpu.device.queue.writeBuffer(gpu.lightShadowTableBuffer, 0, lightShadowTable);
    gpu.device.queue.writeBuffer(gpu.shadowPropertiesBuffer, 0, shadowProperties);

    // TODO: Should be able to have a single command encoder for all render passes
    const commandEncoder = gpu.device.createCommandEncoder({});

    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: gpu.shadowDepthTextureView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      }
    });

    const instanceBuffer = gpu.renderBatch.instanceBuffer;

    // Loop through all the renderable entities and store them by pipeline.
    for (const pipeline of gpu.renderBatch.sortedPipelines) {
      if (!pipeline.layout) { continue; }

      const shadowPipeline = this.getOrCreateShadowPipeline(gpu, pipeline);

      passEncoder.setPipeline(shadowPipeline);

      const geometryList = gpu.renderBatch.pipelineGeometries.get(pipeline);
      for (const [geometry, materialList] of geometryList) {

        for (const vb of geometry.vertexBuffers) {
          passEncoder.setVertexBuffer(vb.slot, vb.buffer.gpuBuffer, vb.offset);
        }
        const ib = geometry.indexBuffer;
        if (ib) {
          passEncoder.setIndexBuffer(ib.buffer.gpuBuffer, ib.format, ib.offset);
        }

        for (const [material, instances] of materialList) {
          if (material) {
            if (!material.castsShadow) { continue; }

            if (material.firstBindGroupIndex == 0) { continue; }

            let i = material.firstBindGroupIndex;
            for (const bindGroup of material.bindGroups) {
              passEncoder.setBindGroup(i++, bindGroup);
            }
          }

          if (pipeline.instanceSlot >= 0) {
            passEncoder.setVertexBuffer(pipeline.instanceSlot, instanceBuffer, instances.bufferOffset);
          }

          // Because we're rendering all the shadows into a single atlas it's more efficient to
          // bind then render once for each light's viewport.
          for (const shadowCamera of frameShadowCameras) {
            // Render a shadow pass
            passEncoder.setViewport(...shadowCamera.viewport);
            passEncoder.setBindGroup(0, shadowCamera.bindGroup);

            if (ib) {
              passEncoder.drawIndexed(geometry.drawCount, instances.instanceCount);
            } else {
              passEncoder.draw(geometry.drawCount, instances.instanceCount);
            }
          }

          // Restore the camera binding if needed
          /*if (material?.firstBindGroupIndex == 0) {
            passEncoder.setBindGroup(0, camera.bindGroup);
          }*/
        }
      }
    }

    passEncoder.end();

    gpu.device.queue.submit([commandEncoder.finish()]);
  }
}
