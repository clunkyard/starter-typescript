// A robot on the Clunkyard core binding supplied by the arena.
// It searches with a broad scan, narrows the beam on a contact, and leads
// shots from a line through its recent sightings.
// Passive cues guide the search; they do not identify a target to fire at.
// Clunkyard robot API 2.0.0: one core under every language, the same
// answers everywhere. Facts (a call shows its arguments):
// match: mode ruleset control robots is_3d tick_rate max_ticks
//   robot_id(slot)
// clock: tick seconds remaining_ticks
// arena: size gravity terrain_kind ground_height(x y)
// me: health position velocity heading pitch roll angular_velocity
//   attitude grounded altitude wall_contact applied hull_mounts
//   to_mount(heading pitch) from_mount(heading pitch) mount_toward(point)
// battery: charge capacity regen sustainable_drive compute
//   drive_cost(fraction)
// drive: hover_lift
// gun: aim_now cooldown_ticks spread max_power damage_scale
//   can_fire(power reserve) shot_speed(power) shot_cost(power)
//   reload_ticks(power) shot_damage(power) power_for_speed(speed)
//   power_for_flight_time(range seconds) lead(contact power)
//   lead_point(position velocity power)
// scanner: last proximity_range reach(arc) arc_for_reach(range) is_on
// sensors: contacts nearest cues contact(slot) position_of(contact)
// tracker: cue nearest_bearing_rate velocity(slot) position(slot)
//   history(slot) last_seen(slot)
// nav: zone zone.margin(point) zone.contains(point margin)
//   zone.distance_from(point) storm storm.margin(point)
//   storm.contains(point margin) storm.distance_from(point) hill
//   hill.margin(point) hill.contains(point margin)
//   hill.distance_from(point) wall_margin() pickups nearest_pickup(kind)
//   field_distance(a b)
// score: me best armour
// angles: normalize(degrees) angle_diff(target current)
//   bearing_to(from to) elevation_to(from to) direction(heading pitch)
//   distance(a b) to_chassis(heading pitch attitude)
//   from_chassis(heading pitch attitude) clamp(value low high)
// raw: number(path) text(path) has(path) flag(path) count(path) line()
// Controls: drive.set(throttle turn pitch_turn)
//   drive.forces(thrust strafe lift yaw_torque pitch_torque roll_torque brake)
//   gun.aim(heading pitch) gun.fire(power) scanner.set(heading arc pitch)
//   scanner.power(on) tracker.configure(smoothing forget_ticks cue_ticks)
//   status.set(text value) debug.log(line) raw.extra(json)
// Every control argument is optional; a second call keeps what the first
// set. Absent facts are your language's none. Names are snake_case here;
// your language cases them its own way. Angles are degrees from the +x
// axis; pitch is positive up.
// Manual: https://clunkyard.com/manual#sdk
import * as cy from 'clunkyard';

const steer = (towards: number, current: number) => cy.angles.clamp(cy.angles.angleDiff(towards, current) / 45);

// Bearing is earned: a scan contact's bearing is off by up to its
// bearingError (degrees, a fixed share of the arc), so a wide beam finds a
// robot and a narrow one aims at it. Contacts within 120 units are exact.
const SEARCH_ARC = 40;  // degrees: sweeps the circle in half a second
const HOLD_WIDTH = 60;  // units across at the target: it stays in the beam from tick to tick
const MIN_ARC = 6;      // degrees: the narrowest the beam holds
const WINDOW = 12;      // ticks of sightings the aim averages
const SIGHTINGS = 8;    // narrow sightings in the window before a shot
const LOOK_EVERY = 40;  // ticks between looks around the target, for a nearer robot
const REACQUIRE = 10;   // ticks to look again where a lost target was

class Starter extends cy.Robot {
  free = false; dodges = 0; dodgeEnd = 0; slot = 0;
  onStart() { this.free = this.match.is3d && this.arena.gravity.z === 0; }

  // A straight line through the narrowest of the last WINDOW ticks'
  // sightings: where the robot is now and how fast it moves. Each sighting
  // is off by its bearingError; the line averages that out.
  fit(slot: number, tick: number): { position: cy.Vec3; velocity: cy.Vec3; count: number } | null {
    const recent = this.tracker.history(slot).filter(s => s.tick > tick - WINDOW);
    if (recent.length < 2) return null;
    const best = Math.min(...recent.map(s => s.bearingError));
    const seen = recent.filter(s => s.bearingError <= 1.5 * best), n = seen.length;
    if (n < 2) return null;
    const t0 = seen.reduce((sum, s) => sum + s.tick, 0) / n;
    const spread = seen.reduce((sum, s) => sum + (s.tick - t0) ** 2, 0);
    const position: cy.Vec3 = { x: 0, y: 0, z: 0 }, velocity: cy.Vec3 = { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z'] as const) {
      const mean = seen.reduce((sum, s) => sum + s.position[axis], 0) / n;
      const slope = seen.reduce((sum, s) => sum + (s.tick - t0) * (s.position[axis] - mean), 0) / spread;
      position[axis] = mean + slope * (tick - t0);
      velocity[axis] = slope * this.match.tickRate;
    }
    return { position, velocity, count: n };
  }

  onTurn() {
    const me = this.me, gun = this.gun, scanner = this.scanner, tick = this.clock.tick;
    this.drive.forces({ brake: 0.2 });
    const target = this.sensors.nearest, cue = this.tracker.cue;
    const lastSeen = this.slot ? this.tracker.lastSeen(this.slot) : null;
    if (target) {
      this.slot = target.slot;
      const throttle = target.range > 350 ? 0.7 : target.range < 200 ? -0.4 : 0.2;
      this.drive.set({ throttle, turn: steer(target.bearing, me.heading), pitchTurn: steer(target.elevation, me.pitch) });
      // Halve the beam each tick until it is HOLD_WIDTH across at the target:
      // narrow enough for a precise bearing, wide enough to keep it in.
      const hold = Math.max(MIN_ARC, 2 * Math.atan2(HOLD_WIDTH / 2, target.range) * 180 / Math.PI);
      // In a crowd a narrow beam sees one robot. Every LOOK_EVERY ticks,
      // widen it for a tick: a nearer robot it finds becomes the target.
      const arc = tick % LOOK_EVERY === 0 ? SEARCH_ARC : Math.max(hold, Math.min(SEARCH_ARC, scanner.last.arc / 2));
      scanner.set({ heading: target.bearing, arc, pitch: target.elevation });
      const power = gun.powerForFlightTime(target.range, 1);
      // An exact contact: gun.lead is the intercept if the target holds
      // course. A noisy one: lead the fitted line, and fire only once it
      // rests on enough sightings.
      let aim: cy.Solution | null, ready = true;
      if (target.bearingError > 0) {
        const fit = this.fit(target.slot, tick);
        aim = fit ? gun.leadPoint(fit.position, fit.velocity, power) : null;
        ready = fit !== null && fit.count >= SIGHTINGS;
      } else aim = gun.lead(target, power);
      const heading = aim ? aim.heading : target.bearing, pitch = aim ? aim.pitch : target.elevation;
      gun.aim({ heading, pitch });
      const now = gun.aimNow;
      if (ready && Math.abs(cy.angles.angleDiff(heading, now.heading)) < 3 && Math.abs(pitch - now.pitch) < 3 && gun.canFire(power, 10)) gun.fire({ power });
      this.status.set({ text: ready ? 'TRACK' : 'NARROW', value: target.range });
    } else if (lastSeen !== null && tick - lastSeen <= REACQUIRE) {
      // Lost it: look again where it was last seen, widening the beam, before searching.
      const where = this.tracker.position(this.slot) as cy.Vec3;
      const bearing = cy.angles.bearingTo(me.position, where), elevation = this.free ? cy.angles.elevationTo(me.position, where) : 0;
      this.drive.set({ throttle: 0.5, turn: steer(bearing, me.heading), pitchTurn: steer(elevation, me.pitch) });
      scanner.set({ heading: bearing, arc: Math.min(SEARCH_ARC, scanner.last.arc * 2), pitch: elevation });
      this.status.set({ text: 'REACQUIRE' });
    } else if (cue) {
      const bearing = cy.angles.bearingTo(me.position, cue.position), distance = cy.angles.distance(me.position, cue.position);
      const elevation = this.free ? cy.angles.elevationTo(me.position, cue.position) : 0;
      const error = Math.min(cue.bearingError, 30);
      const across = (tick % 5 - 2) / 2 * error, up = this.free ? (Math.floor(tick / 5) % 3 - 1) * error / 2 : 0;
      this.drive.set({ throttle: 0.7, turn: steer(bearing, me.heading), pitchTurn: steer(elevation, me.pitch) });
      scanner.set({ heading: bearing + across, arc: scanner.arcForReach(distance + 100), pitch: elevation + up });
      this.status.set({ text: 'CUE', value: distance });
    } else {
      this.drive.set({ throttle: 0.5, turn: 0.33, pitchTurn: steer(0, me.pitch) });
      const pitch = this.free ? (Math.floor(tick / 10) % 3 - 1) * 35 : 0;
      scanner.set({ heading: cy.angles.normalize(scanner.last.heading + 36), arc: SEARCH_ARC, pitch });
      this.status.set({ text: 'SEARCH' });
    }
    // A simple dodge: vary it, or predict the shooter.
    if (tick >= this.dodgeEnd && this.sensors.cues.some(c => c.source === 'muzzle')) {
      this.dodges++;
      this.dodgeEnd = tick + 10;
    }
    if (tick < this.dodgeEnd) {
      // Off the line of fire: left, then right next time (turn and strafe are positive left and right).
      const left = this.dodges % 2 === 1;
      if (this.match.control === 'forces') { this.drive.set({ throttle: 0.5 }); this.drive.forces({ strafe: left ? -1 : 1 }); }
      else this.drive.set({ throttle: 1, turn: left ? 1 : -1 });
      this.status.set({ text: left ? 'dodge:left' : 'dodge:right', value: this.dodges });
    }
    if (this.battery.charge < this.battery.capacity / 4) this.drive.set({ throttle: Number(this.drive.get('throttle')) * 0.5 });
    const storm = this.nav.storm;
    if (storm && (storm.margin(me.position) ?? -Infinity) > -60) {
      const away = cy.angles.bearingTo(storm.center, me.position);
      this.drive.set({ throttle: 0.8, turn: cy.angles.clamp(cy.angles.angleDiff(away, me.heading) / 30) });
    }
    const zone = this.nav.zone;
    if (zone && (zone.margin(me.position) ?? Infinity) < 60) {
      const bearing = cy.angles.bearingTo(me.position, zone.center);
      const climb = zone.shape === 'sphere' ? cy.angles.elevationTo(me.position, zone.center) : 0;
      this.drive.set({ throttle: 0.8, turn: cy.angles.clamp(cy.angles.angleDiff(bearing, me.heading) / 30), pitchTurn: cy.angles.clamp((climb - me.pitch) / 30) });
    }
  }
}

cy.run(new Starter());
