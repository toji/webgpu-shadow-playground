function MakeLookup(table) {
  const lookup = { MASK: 0 };
  for (const key in table) {
    const value = table[key];
    lookup[value] = key;
    lookup.MASK |= value;
  }
  return lookup;
}

const TopologyId = {
  'point-list':     0x00,
  'line-list':      0x01,
  'line-strip':     0x02,
  'triangle-strip': 0x03,
  'triangle-list':  0x04,
};
const TopologyLookup = MakeLookup(TopologyId);

const StripIndexFormatId = {
  uint16: 0x00,
  uint32: 0x08,
};
const StripIndexFormatLookup = MakeLookup(StripIndexFormatId);

const FormatId = {
  uint8x2:   0x00,
  uint8x4:   0x01,
  sint8x2:   0x02,
  sint8x4:   0x03,
  unorm8x2:  0x04,
  unorm8x4:  0x05,
  snorm8x2:  0x06,
  snorm8x4:  0x07,
  uint16x2:  0x08,
  uint16x4:  0x09,
  sint16x2:  0x0A,
  sint16x4:  0x0B,
  unorm16x2: 0x0C,
  unorm16x4: 0x0D,
  snorm16x2: 0x0E,
  snorm16x4: 0x0F,
  float16x2: 0x10,
  float16x4: 0x12,
  float32:   0x13,
  float32x2: 0x14,
  float32x3: 0x15,
  float32x4: 0x16,
  uint32:    0x17,
  uint32x2:  0x18,
  uint32x3:  0x19,
  uint32x4:  0x1A,
  sint32:    0x1B,
  sint32x2:  0x1C,
  sint32x3:  0x1D,
  sint32x4:  0x1E,
};
const FormatLookup = MakeLookup(FormatId);

const StepModeId = {
  vertex:   0x0000,
  instance: 0x8000,
};
const StepModeLookup = MakeLookup(StepModeId);

const Uint8ToHex = new Array(256);
for (let i = 0; i <= 0xFF; ++i) {
    Uint8ToHex[i] = i.toString(16).padStart(2, '0');
}

const HexToUint8 = new Array(256);
for (let i = 0; i <= 0xFF; ++i) {
  HexToUint8[i.toString(16).padStart(2, '0')] = i;
}

class GeometryLayout {
  id = 0;
  #serializedBuffer;
  #serializedString;
  #locationsUsed;

  constructor(buffers, primitive) {
    this.buffers = buffers;
    this.primitive = primitive;
  }

  get locationsUsed() {
    if (!this.#locationsUsed) {
      this.#locationsUsed = [];
      for (const buffer of this.buffers) {
        for (const attrib of buffer.attributes) {
          this.#locationsUsed.push(attrib.shaderLocation);
        }
      }
    }

    return this.#locationsUsed;
  }

  serializeToBuffer() {
    if (this.#serializedBuffer) {
      return this.#serializedBuffer;
    }

    let attribCount = 0;
    for (const buffer of this.buffers) {
      attribCount += buffer.attributes.length;
    }

    // Each buffer takes 2 bytes to encode and each attribute takes 3 bytes.
    // The primitive topology takes 1 byte.
    const byteLength = 1 + (this.buffers.length * 2) + attribCount * 3;
    const outBuffer = new ArrayBuffer(byteLength);
    const dataView = new DataView(outBuffer);

    let topologyData8 = TopologyId[this.primitive.topology];
    topologyData8 += StripIndexFormatId[this.primitive.stripIndexFormat || 'uint16'];
    dataView.setUint8(0, topologyData8);

    let offset = 1;
    for (const buffer of this.buffers) {
      let bufferData16 = buffer.attributes.length; // Lowest 4 bits
      bufferData16 += buffer.arrayStride << 4;          // Middle 11 bits
      bufferData16 += StepModeId[buffer.stepMode || 'vertex']; // Highest bit
      dataView.setUint16(offset, bufferData16, true);
      offset += 2;

      for (const attrib of buffer.attributes) {
        let attribData16 = attrib.offset || 0; // Lowest 12 bits
        attribData16 += attrib.shaderLocation << 12; // Highest 4 bits
        dataView.setUint16(offset, attribData16, true);
        dataView.setUint8(offset+2, FormatId[attrib.format]);

        offset += 3;
      }
    }

    this.#serializedBuffer = outBuffer;
    return outBuffer;
  }

  serializeToString() {
    if (this.#serializedString) { return this.#serializedString; }

    const array = new Uint8Array(this.serializeToBuffer());
    let outStr = '';
    for (let i = 0; i < array.length; ++i) {
      outStr += Uint8ToHex[array[i]];
    }

    this.#serializedString = outStr;
    return outStr;
  }

  static deserializeFromBuffer(inBuffer, bufferOffest, bufferLength) {
    const dataView = new DataView(inBuffer, bufferOffest, bufferLength);

    const topologyData8 = dataView.getUint8(0);
    const primitive = {
      topology: TopologyLookup[topologyData8 & TopologyLookup.MASK],
    };

    switch(primitive.topology) {
      case 'triangle-strip':
      case 'line-strip':
        primitive.stripIndexFormat = StripIndexFormatLookup[topologyData8 & StripIndexFormatLookup.MASK];
    }

    const buffers = [];
    let offset = 1;
    while (offset < dataView.byteLength) {
      const bufferData16 = dataView.getUint16(offset, true);
      const attribCount = bufferData16 & 0x0F;
      let buffer = {
        attributes: new Array(attribCount),
        arrayStride: (bufferData16 >> 4) & 0x08FF,
        stepMode: StepModeLookup[bufferData16 & StepModeLookup.MASK],
      };
      buffers.push(buffer);
      offset += 2;

      for (let i = 0; i < attribCount; ++i) {
        const attribData16 = dataView.getUint16(offset, true);
        buffer.attributes[i] = {
          offset: attribData16 & 0x0FFF,
          shaderLocation: (attribData16 >> 12) & 0x0F,
          format: FormatLookup[dataView.getUint8(offset+2)]
        };
        offset += 3;
      }
    }

    return new GeometryLayout(buffers, primitive);
  }

  static deserializeFromString(value) {
    const array = new Uint8Array(value.length / 2);
    for (let i = 0; i < array.length; ++i) {
      const strOffset = i*2;
      array[i] = HexToUint8[value.substring(strOffset, strOffset+2)];
    }
    const layout = GeometryLayout.deserializeFromBuffer(array.buffer);
    layout.#serializedBuffer = array.buffer;
    layout.#serializedString = value;
    return layout;
  }
};

export class GeometryLayoutCache {
  #nextId = 1;
  #keyMap = new Map(); // Map of the given key to an ID
  #cache = new Map();  // Map of ID to cached resource

  getLayout(id) {
    return this.#cache.get(id);
  }

  createLayout(attribBuffers, topology, indexFormat = 'uint32') {
    const buffers = [];
    for (const buffer of attribBuffers) {
      const attributes = [];
      for (const attrib of buffer.attributes) {
        // Exact offset will be handled when setting the buffer.
        const offset = attrib.offset - buffer.minOffset
        attributes.push({
          shaderLocation: attrib.shaderLocation,
          format: attrib.format,
          offset,
        });
      }

      buffers.push({
        arrayStride: buffer.arrayStride,
        attributes
      });
    }

    const primitive = { topology };
    switch(topology) {
      case 'triangle-strip':
      case 'line-strip':
        primitive.stripIndexFormat = indexFormat;
    }

    const layout = new GeometryLayout(buffers, primitive);

    const key = layout.serializeToString();
    const id = this.#keyMap.get(key);

    if (id !== undefined) {
      return this.#cache.get(id);
    }

    layout.id = this.#nextId++;
    this.#keyMap.set(key, layout.id);
    this.#cache.set(layout.id, layout);
    Object.freeze(layout);

    return layout;
  }
}