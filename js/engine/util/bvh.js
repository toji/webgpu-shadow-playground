// Bounding volume hierarchy (BHV)

// Lots of this based on Erin Catto's great doc on dynamic BVHs:
// https://box2d.org/files/ErinCatto_DynamicBVH_Full.pdf

import { vec3 } from 'gl-matrix';

const tmpVec3 = vec3.create();

const tmpBounds = [
  vec3.create(), vec3.create(), vec3.create(), vec3.create(),
  vec3.create(), vec3.create(), vec3.create(), vec3.create()
];

export class AABB {
  min = vec3.create();
  max = vec3.create();

  constructor(aabb) {
    if (aabb) { this.updateBounds(aabb); }
  }

  union(aabb0, aabb1) {
    vec3.min(this.min, aabb0.min, aabb1.min);
    vec3.max(this.max, aabb0.max, aabb1.max);
    return this;
  }

  updateBounds(aabb) {
    vec3.copy(this.min, aabb.min);
    vec3.copy(this.max, aabb.max);
    return this;
  }

  get surfaceArea() {
    vec3.sub(tmpVec3, this.max, this.min);
    return (tmpVec3[0] * tmpVec3[1] +
            tmpVec3[1] * tmpVec3[2] +
            tmpVec3[2] * tmpVec3[0]) * 2;
  }

  // Transform this AABB by a matrix, getting the new AABB. (The new AABB will almost certainly be
  // larger than necessary to fit the transformed contents.)
  transform(mat) {
    if (!mat) { return; }

    vec3.transformMat4(tmpBounds[0], this.min, mat);
    vec3.transformMat4(tmpBounds[1], [this.min[0], this.min[1], this.max[2]], mat);
    vec3.transformMat4(tmpBounds[2], [this.min[0], this.max[1], this.min[2]], mat);
    vec3.transformMat4(tmpBounds[3], [this.min[0], this.max[1], this.max[2]], mat);
    vec3.transformMat4(tmpBounds[4], [this.max[0], this.min[1], this.min[2]], mat);
    vec3.transformMat4(tmpBounds[5], [this.max[0], this.min[1], this.max[2]], mat);
    vec3.transformMat4(tmpBounds[6], [this.max[0], this.max[1], this.min[2]], mat);
    vec3.transformMat4(tmpBounds[7], this.max, mat);

    vec3.copy(this.min, tmpBounds[0]);
    vec3.copy(this.max, tmpBounds[0]);
    for (let i = 1; i < 8; ++i) {
      vec3.min(this.min, this.min, tmpBounds[i]);
      vec3.max(this.max, this.max, tmpBounds[i]);
    }
  }
}

class BVHNode extends AABB {
  parent;
  child0;
  child1;
  value;

  constructor(aabb, value) {
    super(aabb);
    this.value = value;
  }

  setChildren(node0, node1) {
    this.union(node0, node1);
    this.child0 = node0;
    this.child1 = node1;
    node0.parent = this;
    node1.parent = this;
  }
}

const tmpAabb = new AABB();

export class BVH {
  #rootNode;
  visLevel = 0;

  constructor() {

  }

  reset() {
    this.#rootNode = null;
  }

  get rootNode() {
    return this.#rootNode;
  }

  #findBestSibling(node, testNode, parentIndirectCost = 0, bestSibling = null) {
    if (!testNode.child0) {
      // It's a leaf node
      const cost = tmpAabb.union(node, testNode).surfaceArea + parentIndirectCost;

      if (bestSibling && bestSibling.cost < cost) {
        // The current best sibling is already lower cost.
        return bestSibling;
      }

      return { node: testNode, cost: tmpAabb.union(node, testNode).surfaceArea + parentIndirectCost };
    } else {
      const nodeIndirectCost = (tmpAabb.union(node, testNode).surfaceArea - testNode.surfaceArea) + parentIndirectCost;

      if (bestSibling && nodeIndirectCost > bestSibling.cost) {
        // Early-out of searching this branch, since we know that it can't be a better pick than
        // a previously identified sibling.
        return bestSibling;
      }

      bestSibling = this.#findBestSibling(node, testNode.child0, nodeIndirectCost, bestSibling);
      return this.#findBestSibling(node, testNode.child1, nodeIndirectCost, bestSibling);
    }

  }

  insert(aabb, value) {
    const node = new BVHNode(aabb, value);

    if (!this.#rootNode) {
      this.#rootNode = node;
      return;
    }

    // Find best sibling for leaf
    let sibling = this.#findBestSibling(node, this.#rootNode).node;

    // Create new parent
    const prevParent = sibling.parent;
    const newParent = new BVHNode();
    newParent.parent = prevParent;
    newParent.setChildren(node, sibling);

    if (!prevParent) {
      // Sibling was the root node
      this.#rootNode = newParent;
    } else {
      if (prevParent.child0 == sibling) {
        prevParent.child0 = newParent;
      } else {
        prevParent.child1 = newParent;
      }
    }

    // Refit ancestors AABBs
    let parentNode = prevParent;
    while (parentNode) {
      parentNode.union(parentNode.child0, parentNode.child1);
      parentNode = parentNode.parent;
    }
  }
}
