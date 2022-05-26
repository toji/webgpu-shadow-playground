importScripts('./worker_service.js');
importScripts('https://www.gstatic.com/draco/versioned/decoders/1.5.2/draco_decoder_gltf.js');

const DRACO_DECODER = new Promise((resolve) => {
  DracoDecoderModule({
    onModuleLoaded: (draco) => {
      resolve(draco);
    }
  });
});

class DracoDecoderService extends WorkerService {
  async init() {
    this.draco = await DRACO_DECODER;
    this.decoder = new this.draco.Decoder();
  }

  async onDispatch(args) {
    const dracoBuffer = new Int8Array(args.buffer);
    const dracoAttributes = args.attributes;
    const indexSize = args.indexSize;

    const geometryType = this.decoder.GetEncodedGeometryType(dracoBuffer);

    let geometry;
    let status;
    switch (geometryType) {
      case this.draco.POINT_CLOUD: {
        geometry = new this.draco.PointCloud();
        status = this.decoder.DecodeArrayToPointCloud(dracoBuffer, dracoBuffer.byteLength, geometry);
        break;
      }
      case this.draco.TRIANGULAR_MESH: {
        geometry = new this.draco.Mesh();
        status = this.decoder.DecodeArrayToMesh(dracoBuffer, dracoBuffer.byteLength, geometry);
        break;
      }
      default:
        throw new Error('Unknown Draco geometry type');
    }

    if (!status.ok()) {
      throw new Error('Draco decode failed');
    }

    const bufferViews = {};

    const vertCount = geometry.num_points();

    for (const name in dracoAttributes) {
      const attributeId = dracoAttributes[name];
      const attribute = this.decoder.GetAttributeByUniqueId(geometry, attributeId);
      const stride = attribute.byte_stride();
      const byteLength = vertCount * stride;

      const outPtr = this.draco._malloc(byteLength);
      const success = this.decoder.GetAttributeDataArrayForAllPoints(
          geometry, attribute, attribute.data_type(), byteLength, outPtr);
      if (!success) {
        throw new Error('Failed to get decoded attribute data array');
      }

      bufferViews[name] = {
        // Copy the decoded attribute data out of the WASM heap.
        buffer: new Uint8Array(this.draco.HEAPF32.buffer, outPtr, byteLength).slice().buffer,
        stride,
      };

      this.draco._free(outPtr);
    }

    if (geometryType == this.draco.TRIANGULAR_MESH && indexSize) {
      const indexCount = geometry.num_faces() * 3;
      const byteLength = indexCount * indexSize;

      const outPtr = this.draco._malloc(byteLength);
      let success;
      if (indexSize == 4) {
        success = this.decoder.GetTrianglesUInt32Array(geometry, byteLength, outPtr);
      } else {
        success = this.decoder.GetTrianglesUInt16Array(geometry, byteLength, outPtr);
      }

      if (!success) {
        throw new Error('Failed to get decoded index data array');
      }

      bufferViews.INDICES = {
        // Copy the decoded index data out of the WASM heap.
        buffer: new Uint8Array(this.draco.HEAPF32.buffer, outPtr, byteLength).slice().buffer,
        stride: indexSize,
      };

      this.draco._free(outPtr);
    }

    const transferBuffers = [];
    for (const name in bufferViews) {
      transferBuffers.push(bufferViews[name].buffer);
    }

    return this.transfer(bufferViews, transferBuffers);
  }
}

WorkerService.register(new DracoDecoderService());