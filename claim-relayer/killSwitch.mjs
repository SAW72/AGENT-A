/** In-process pause for quote and claim routes. Health stays up. */

export function createKillSwitch(opts = {}) {
  let on = Boolean(opts.initial);
  return {
    isOn() {
      return on;
    },
    engage() {
      on = true;
      return on;
    },
    release() {
      on = false;
      return on;
    },
  };
}

export const KILL_SWITCH = "kill_switch";
