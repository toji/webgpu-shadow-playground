import { System } from '../engine/core/ecs.js';
import { Transform } from '../engine/core/transform.js';
import { vec3 } from 'gl-matrix';

let orientedVelocity = new vec3.create();

export class Velocity {
  constructor(value) {
    this.velocity = value ? vec3.clone(value) : vec3.create();
    this.maxSpeed = 0;
  }
}

export class VelocitySystem extends System {
  init() {
    this.velocityQuery = this.query(Velocity, Transform);
  }

  execute(delta, time) {
    this.velocityQuery.forEach((entity, velocity, transform) => {
      if (velocity.maxSpeed > 0) {
        const speed = vec3.length(velocity.velocity);
        if (speed > velocity.maxSpeed) {
          vec3.scale(velocity.velocity, velocity.velocity, velocity.maxSpeed / speed);
        }
      }
      vec3.transformQuat(orientedVelocity, velocity.velocity, transform.orientation);
      vec3.scaleAndAdd(transform.position, transform.position, orientedVelocity, delta);
    });
  }
}