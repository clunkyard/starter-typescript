// A robot on the Clunkyard core binding supplied by the arena.
// It searches with a broad scan, follows precise contacts, and leads shots.
// Passive cues guide the search; they do not identify a target to fire at.
// Clunkyard robot API 2.0.0: one core under every language, the same
// answers everywhere. Facts (a call shows its arguments):
// match: mode ruleset control robots is_3d tick_rate max_ticks
//   robot_id(slot)
// clock: tick seconds remaining_ticks
// arena: size gravity terrain_kind ground_height(x y)
// me: health position velocity heading pitch roll angular_velocity
//   attitude grounded altitude applied
// battery: charge capacity regen sustainable_drive compute
//   drive_cost(fraction)
// drive: hover_lift
// gun: aim_now cooldown_ticks spread max_power damage_scale
//   can_fire(power reserve) shot_speed(power) shot_cost(power)
//   reload_ticks(power) shot_damage(power) power_for_speed(speed)
//   power_for_flight_time(range seconds) lead(contact power)
//   lead_point(position velocity power)
// scanner: last proximity_range reach(arc) arc_for_reach(range)
// sensors: contacts nearest cues contact(slot) position_of(contact)
// tracker: cue nearest_bearing_rate velocity(slot) position(slot)
//   last_seen(slot)
// nav: zone zone.margin(point) zone.contains(point margin)
//   zone.distance_from(point) storm storm.margin(point)
//   storm.contains(point margin) storm.distance_from(point) hill
//   hill.margin(point) hill.contains(point margin)
//   hill.distance_from(point) pickups nearest_pickup(kind)
//   field_distance(a b)
// score: me best armour
// angles: normalize(degrees) angle_diff(target current)
//   bearing_to(from to) elevation_to(from to) direction(heading pitch)
//   distance(a b) clamp(value low high)
// raw: number(path) text(path) has(path) flag(path) count(path) line()
// Controls: drive.set(throttle turn pitch_turn)
//   drive.forces(thrust strafe lift yaw_torque pitch_torque roll_torque brake)
//   gun.aim(heading pitch) gun.fire(power) scanner.set(heading arc pitch)
//   tracker.configure(smoothing forget_ticks cue_ticks)
//   status.set(text value) raw.extra(json)
// Every control argument is optional; a second call keeps what the first
// set. Absent facts are your language's none. Names are snake_case here;
// your language cases them its own way. Angles are degrees from the +x
// axis; pitch is positive up.
// Manual: https://clunkyard.com/manual#sdk
import * as cy from 'clunkyard';

const steer = (towards: number, current: number) => cy.angles.clamp(cy.angles.angleDiff(towards, current) / 45);

class Starter extends cy.Robot {
  free = false;
  onStart() { this.free = this.match.is3d && this.arena.gravity.z === 0; }
  onTurn() {
    const me = this.me, gun = this.gun, scanner = this.scanner;
    this.drive.forces({ brake: 0.2 });
    const target = this.sensors.nearest, cue = this.tracker.cue;
    if (target) {
      const throttle = target.range > 350 ? 0.7 : target.range < 200 ? -0.4 : 0.2;
      this.drive.set({ throttle, turn: steer(target.bearing, me.heading), pitchTurn: steer(target.elevation, me.pitch) });
      scanner.set({ heading: target.bearing, arc: 20, pitch: target.elevation });
      const power = gun.powerForFlightTime(target.range, 1), aim = gun.lead(target, power);
      const heading = aim ? aim.heading : target.bearing, pitch = aim ? aim.pitch : target.elevation;
      gun.aim({ heading, pitch });
      const now = gun.aimNow;
      if (Math.abs(cy.angles.angleDiff(heading, now.heading)) < 3 && Math.abs(pitch - now.pitch) < 3 && gun.canFire(power, 10)) gun.fire({ power });
      this.status.set({ text: 'TRACK', value: target.range });
    } else if (cue) {
      const bearing = cy.angles.bearingTo(me.position, cue.position), distance = cy.angles.distance(me.position, cue.position);
      const elevation = this.free ? cy.angles.elevationTo(me.position, cue.position) : 0;
      const error = Math.min(cue.bearingError, 30), tick = this.clock.tick;
      const across = (tick % 5 - 2) / 2 * error, up = this.free ? (Math.floor(tick / 5) % 3 - 1) * error / 2 : 0;
      this.drive.set({ throttle: 0.7, turn: steer(bearing, me.heading), pitchTurn: steer(elevation, me.pitch) });
      scanner.set({ heading: bearing + across, arc: scanner.arcForReach(distance + 100), pitch: elevation + up });
      this.status.set({ text: 'CUE', value: distance });
    } else {
      this.drive.set({ throttle: 0.5, turn: 0.33, pitchTurn: steer(0, me.pitch) });
      const pitch = this.free ? (Math.floor(this.clock.tick / 10) % 3 - 1) * 35 : 0;
      scanner.set({ heading: cy.angles.normalize(scanner.last.heading + 36), arc: 40, pitch });
      this.status.set({ text: 'SEARCH' });
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
