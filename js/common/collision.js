import { System } from '../engine/core/ecs.js';
import { Transform } from '../engine/core/transform.js';
import { BoundingVolume, BoundingVolumeType } from '../engine/core/bounding-volume.js';
import { vec3, mat4 } from 'gl-matrix';
import { Collisions } from './impact-damage.js';

export class Collider {
  constructor(...filter) {
    this.filter = filter;
  }
}

const tmpVec = vec3.create();
const tmpVec2 = vec3.create();
const tmpMatrix = mat4.create();

function sphereIntersectsAABB(center, radiusSqr, min, max) {
  tmpVec2[0] = Math.max(min[0], Math.min(center[0], max[0]));
  tmpVec2[1] = Math.max(min[1], Math.min(center[1], max[1]));
  tmpVec2[2] = Math.max(min[2], Math.min(center[2], max[2]));

  // this is the same as isPointInsideSphere
  var distSqr = vec3.sqrDist(center, tmpVec2);

  if (distSqr < radiusSqr) {
    return tmpVec2;
  }
  return null;
}

class FrameCollider {
  constructor(entity, collider, bounds, transform) {
    this.entity = entity;
    this.filters = collider.filter;
    this.bounds = bounds;
    this.worldMatrix = transform.worldMatrix;
    mat4.getScaling(tmpVec, this.worldMatrix);
    const scale = Math.max(tmpVec[0], Math.max(tmpVec[1], tmpVec[2]));
    this.radiusSq = (bounds.radius * scale) * (bounds.radius * scale);

    this.worldPosition = vec3.create();
    transform.getWorldPosition(this.worldPosition, bounds.center);

    this.collisions = null;
    entity.remove(Collisions);
  }

  checkCollision(other) {
    // There's gotta be a faster way to handle this
    for (const filter of this.filters) {
      if (other.entity.has(filter)) {
        return;
      }
    }

    for (const filter of other.filters) {
      if (this.entity.has(filter)) {
        return;
      }
    }

    let sqrDist = vec3.sqrDist(this.worldPosition, other.worldPosition);
    if (sqrDist < this.radiusSq + other.radiusSq) {
      // TODO: Do a more precise check for AABB vs. AABB.
      if (this.bounds.type == BoundingVolumeType.AABB) {
        // Transform the sphere into the space of the AABB to simplify the
        mat4.invert(tmpMatrix, this.worldMatrix);
        vec3.transformMat4(tmpVec, other.worldPosition, tmpMatrix);
        const result = sphereIntersectsAABB(tmpVec, other.radiusSq, this.bounds.min, this.bounds.max);
        if (!result) { return; }
      } else if (other.bounds.type == BoundingVolumeType.AABB) {
        // Transform the sphere into the space of the AABB to simplify the
        mat4.invert(tmpMatrix, other.worldMatrix);
        vec3.transformMat4(tmpVec, this.worldPosition, tmpMatrix);
        const result = sphereIntersectsAABB(tmpVec, this.radiusSq, other.bounds.min, other.bounds.max);
        if (!result) { return; }
      }

      // Collision detected!
      if (!this.collisions) {
        this.collisions = new Collisions();
        this.entity.add(this.collisions);
      }
      this.collisions.entities.add(other.entity);

      if (!other.collisions) {
        other.collisions = new Collisions();
        other.entity.add(other.collisions);
      }
      other.collisions.entities.add(this.entity);
    }
  }
}

export class CollisionSystem extends System {
  init() {
    this.colliderQuery = this.query(Collider, BoundingVolume, Transform);
  }

  execute() {
    const allColliders = [];

    this.colliderQuery.forEach((entity, collider, bounds, transform) => {
      const frameCollider = new FrameCollider(entity, collider, bounds, transform);
      // TODO: You would fail your Silicon Valley job interview with this code.
      // I don't really care. Fix it if it becomes a problem.
      for (const otherCollider of allColliders) {
        frameCollider.checkCollision(otherCollider);
      }
      allColliders.push(frameCollider);
    });
  }
}