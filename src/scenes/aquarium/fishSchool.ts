import * as THREE from 'three';
import type { HeadPose } from '../../types';
import { makeRng } from './aquaGeometry';

export interface Species {
  count: number;
  /** Body length range, cm (before the tank-size scale). */
  length: [number, number];
  speed: [number, number];
  colors: number[];
  /** Pattern id understood by the fish shader (0 plain, 1 clown, 2 neon, 3 tang). */
  pattern: number;
  /** How strongly members stick together (0 = loners). */
  cohesion: number;
  /** Preferred height band as fractions of the tank height (0 floor .. 1 surface). */
  band: [number, number];
}

export interface TankBounds {
  hw: number;
  hh: number;
  depth: number;
  /** Sand height at (x, z). */
  floorY: (x: number, z: number) => number;
}

interface Fish {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  fwd: THREE.Vector3;
  group: number;
  len: number;
  cruise: number;
  /** Personal target (glass visits); null = follow the group. */
  visit: THREE.Vector3 | null;
  visitT: number;
  /** 0 = approaching the glass, 1 = cruising along it. */
  visitStage: number;
  /** Personal wander target for loosely-schooling species. */
  wander: THREE.Vector3;
  wanderT: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();
const _m = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Boids-lite: separation + alignment + cohesion within each species, a slowly wandering
 * per-species goal, soft tank walls, occasional visits to the front glass, and a
 * shy reflex when the viewer leans in close.
 */
export class FishSchool {
  readonly mesh: THREE.InstancedMesh;
  private readonly fish: Fish[] = [];
  private readonly species: Species[];
  private readonly goals: THREE.Vector3[] = [];
  private readonly goalTimers: number[] = [];
  private readonly rnd = makeRng(77);
  private bounds: TankBounds = { hw: 15, hh: 10, depth: 40, floorY: () => -10 };
  private scale = 1;
  private visitTimer = 3;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, species: Species[]) {
    this.species = species;
    const total = species.reduce((n, s) => n + s.count, 0);
    this.mesh = new THREE.InstancedMesh(geometry, material, total);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;

    const aFish = new Float32Array(total * 4);
    const color = new THREE.Color();
    let i = 0;
    species.forEach((sp, g) => {
      this.goals.push(new THREE.Vector3());
      this.goalTimers.push(0);
      for (let k = 0; k < sp.count; k++, i++) {
        const len = THREE.MathUtils.lerp(sp.length[0], sp.length[1], this.rnd());
        const cruise = THREE.MathUtils.lerp(sp.speed[0], sp.speed[1], this.rnd());
        this.fish.push({
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(this.rnd() - 0.5, 0, this.rnd() - 0.5).setLength(cruise),
          fwd: new THREE.Vector3(1, 0, 0),
          group: g,
          len,
          cruise,
          visit: null,
          visitT: 0,
          visitStage: 0,
          wander: new THREE.Vector3(),
          wanderT: 0,
        });
        color.set(sp.colors[k % sp.colors.length]);
        // Small per-fish brightness variation.
        color.multiplyScalar(0.85 + this.rnd() * 0.3);
        this.mesh.setColorAt(i, color);
        aFish[i * 4] = this.rnd() * Math.PI * 2;
        aFish[i * 4 + 1] = 7 + cruise * 1.3 + this.rnd() * 2;
        aFish[i * 4 + 2] = sp.pattern;
        aFish[i * 4 + 3] = 0;
      }
    });
    geometry.setAttribute('aFish', new THREE.InstancedBufferAttribute(aFish, 4));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Resize the swimming volume; scatters fish on first call or if they fell outside. */
  setBounds(b: TankBounds, scale: number, reset: boolean): void {
    this.bounds = b;
    this.scale = scale;
    for (let g = 0; g < this.goals.length; g++) this.pickGoal(g);
    for (const f of this.fish) {
      this.randomPoint(f.group, f.wander);
      if (reset || Math.abs(f.pos.x) > b.hw || Math.abs(f.pos.y) > b.hh || f.pos.z < -b.depth || f.pos.z > 0) {
        const goal = this.goals[f.group];
        f.pos.set(
          goal.x + (this.rnd() - 0.5) * b.hw * 0.6,
          goal.y + (this.rnd() - 0.5) * b.hh * 0.4,
          goal.z + (this.rnd() - 0.5) * b.depth * 0.3,
        );
        this.clampInside(f.pos, 1);
      }
    }
    this.writeMatrices();
  }

  private randomPoint(g: number, out: THREE.Vector3): THREE.Vector3 {
    const b = this.bounds;
    const sp = this.species[g];
    const x = (this.rnd() * 2 - 1) * b.hw * 0.75;
    const z = -b.depth * (0.12 + this.rnd() * 0.75);
    const fy = THREE.MathUtils.lerp(sp.band[0], sp.band[1], this.rnd());
    const floor = b.floorY(x, z);
    return out.set(x, THREE.MathUtils.lerp(floor + 2, b.hh - 2, fy), z);
  }

  private pickGoal(g: number): void {
    this.randomPoint(g, this.goals[g]);
    this.goalTimers[g] = 5 + this.rnd() * 7;
  }

  private clampInside(p: THREE.Vector3, margin: number): void {
    const b = this.bounds;
    p.x = THREE.MathUtils.clamp(p.x, -b.hw + margin, b.hw - margin);
    p.z = THREE.MathUtils.clamp(p.z, -b.depth + margin, -1.2);
    const floor = b.floorY(p.x, p.z) + margin;
    p.y = THREE.MathUtils.clamp(p.y, floor, b.hh - margin);
  }

  update(dt: number, pose: HeadPose): void {
    dt = Math.min(dt, 0.05);
    const b = this.bounds;
    const fish = this.fish;

    for (let g = 0; g < this.goals.length; g++) {
      this.goalTimers[g] -= dt;
      if (this.goalTimers[g] <= 0) this.pickGoal(g);
    }

    // Every few seconds, send a fish up to the glass for a close look.
    this.visitTimer -= dt;
    if (this.visitTimer <= 0) {
      this.visitTimer = 3 + this.rnd() * 4;
      const f = fish[Math.floor(this.rnd() * fish.length)];
      if (!f.visit) {
        const x = (this.rnd() * 2 - 1) * b.hw * 0.5;
        const y = THREE.MathUtils.lerp(b.floorY(x, -2) + 3, b.hh - 3, 0.25 + this.rnd() * 0.5);
        f.visit = new THREE.Vector3(x, y, -2.2);
        f.visitT = 7;
        f.visitStage = 0;
      }
    }

    // Shy reflex: the viewer leaning in close scares fish away from the glass.
    const scare = THREE.MathUtils.clamp((35 - pose.z) / 15, 0, 1);

    const steer = _a;
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      steer.set(0, 0, 0);
      const sp = this.species[f.group];
      const sepR = f.len * this.scale * 1.3;
      const viewR = f.len * this.scale * 4;
      let n = 0;
      _b.set(0, 0, 0); // alignment
      _c.set(0, 0, 0); // cohesion
      for (let j = 0; j < fish.length; j++) {
        if (j === i) continue;
        const o = fish[j];
        const dx = f.pos.x - o.pos.x;
        const dy = f.pos.y - o.pos.y;
        const dz = f.pos.z - o.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < sepR * sepR && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          const k = ((sepR - d) / sepR) * 6;
          steer.x += (dx / d) * k;
          steer.y += (dy / d) * k;
          steer.z += (dz / d) * k;
        }
        if (o.group === f.group && d2 < viewR * viewR) {
          _b.add(o.vel);
          _c.add(o.pos);
          n++;
        }
      }
      if (n > 0 && sp.cohesion > 0 && !f.visit) {
        _b.divideScalar(n).sub(f.vel).multiplyScalar(0.6 * sp.cohesion);
        _c.divideScalar(n).sub(f.pos).multiplyScalar(0.35 * sp.cohesion);
        steer.add(_b).add(_c);
      }

      const loner = sp.cohesion < 0.5;
      if (loner) {
        f.wanderT -= dt;
        if (f.wanderT <= 0 || f.pos.distanceToSquared(f.wander) < 4) {
          this.randomPoint(f.group, f.wander);
          f.wanderT = 4 + this.rnd() * 6;
        }
      }
      const target = f.visit ?? (loner ? f.wander : this.goals[f.group]);
      _b.copy(target).sub(f.pos);
      const dist = _b.length();
      if (f.visit) {
        f.visitT -= dt;
        if (dist < 1.8 && f.visitStage === 0) {
          // Arrived at the glass: cruise along it for a bit.
          f.visitStage = 1;
          f.visit.x += (f.pos.x > 0 ? -1 : 1) * b.hw * (0.5 + this.rnd() * 0.4);
          f.visitT = Math.max(f.visitT, 4);
        } else if (f.visitT <= 0 || (dist < 1.8 && f.visitStage === 1)) {
          f.visit = null;
        }
        _b.multiplyScalar(1 / Math.max(dist, 1));
        steer.addScaledVector(_b, f.cruise * 2.2);
      } else {
        steer.addScaledVector(_b, loner ? 0.3 : 0.12);
      }

      // Soft walls.
      const m = Math.max(2.5, f.len * this.scale);
      const wall = 8;
      if (f.pos.x < -b.hw + m) steer.x += wall * (1 - (f.pos.x + b.hw) / m);
      if (f.pos.x > b.hw - m) steer.x -= wall * (1 - (b.hw - f.pos.x) / m);
      if (f.pos.z < -b.depth + m) steer.z += wall * (1 - (f.pos.z + b.depth) / m);
      const front = f.visit ? 0.8 : 1.5;
      if (f.pos.z > -front - m * 0.4) steer.z -= wall * (1 - (-front - f.pos.z) / (m * 0.4));
      const floor = b.floorY(f.pos.x, f.pos.z);
      if (f.pos.y < floor + m) steer.y += wall * (1 - (f.pos.y - floor) / m);
      if (f.pos.y > b.hh - m) steer.y -= wall * (1 - (b.hh - f.pos.y) / m);

      if (scare > 0 && f.pos.z > -14) {
        const dx = f.pos.x - pose.x;
        const dy = f.pos.y - pose.y;
        const r = Math.max(b.hw, b.hh) * 0.8;
        const near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / r);
        const k = scare * (0.4 + near) * 22 * (1 + f.pos.z / 14);
        steer.z -= k;
        steer.x += Math.sign(dx || 1) * k * 0.3;
        if (f.visit) f.visit = null;
      }

      // Keep pitch modest.
      steer.y -= f.vel.y * 0.6;

      f.vel.addScaledVector(steer, dt);
      const maxSpeed = f.cruise * (1.6 + scare * 1.5);
      const sp2 = f.vel.length();
      if (sp2 > maxSpeed) f.vel.multiplyScalar(maxSpeed / sp2);
      else if (sp2 < f.cruise * 0.45) f.vel.setLength(f.cruise * 0.45);
      f.pos.addScaledVector(f.vel, dt);
      this.clampInside(f.pos, 0.6);

      // Smooth heading so turns look like swimming, not snapping.
      _c.copy(f.vel).normalize();
      _c.y = THREE.MathUtils.clamp(_c.y, -0.45, 0.45);
      f.fwd.lerp(_c, 1 - Math.exp(-dt * 5)).normalize();
    }
    this.writeMatrices();
  }

  private writeMatrices(): void {
    const s = this.scale;
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      _side.crossVectors(f.fwd, WORLD_UP);
      if (_side.lengthSq() < 1e-6) _side.set(0, 0, 1);
      _side.normalize();
      _up.crossVectors(_side, f.fwd).normalize();
      // Local axes: x = forward, y = up, z = x × y.
      _side.crossVectors(f.fwd, _up);
      const L = f.len * s;
      _m.makeBasis(_a.copy(f.fwd).multiplyScalar(L), _b.copy(_up).multiplyScalar(L), _c.copy(_side).multiplyScalar(L));
      _m.setPosition(f.pos);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
