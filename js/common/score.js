import { System, Tag } from '../engine/core/ecs.js';
import { Stage } from '../engine/core/stage.js';

export class Points {
  constructor(value = 100) {
    this.value = value;
  }
}

export class Score {
  points = 0;
}

export class ScoreSystem extends System {
  stage = Stage.Last;

  init() {
    this.singleton.add(new Score());

    this.pointsQuery = this.query(Tag('dead'), Points);

    this.scoreElement = document.getElementById('score');
  }

  execute() {
    const score = this.singleton.get(Score);
    this.pointsQuery.forEach((entity, dead, points) => {
      score.points += points.value;
    });
    this.scoreElement.innerText = score.points;
  }
}
