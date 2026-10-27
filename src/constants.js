// -----------------------------------------------------------------------------
// Constants: the tags of the Waterkotte web interface, feature roles, limits
// and timings.
//
// The tags (A = analog, a tenth of the unit; I = integer; D = digital) are
// those of ha-waterkotte 2026.10.7 (marq24, MIT, pywaterkotte_ha/tags.py),
// which reads the same web interface as the Waterkotte web page. Waterkotte
// publishes no list of them: they are to be checked on a real heat pump
// (TODO.md "To check").
// -----------------------------------------------------------------------------

export const SYSTEMS = {
  /** EcoTouch (and the newer web page that shows "EasyCon" with a login form): /cgi/*. */
  ECOTOUCH: 'ecotouch',
  /** The older EasyCon controller: /config/xml.cgi with HTTP Basic auth, read only here. */
  EASYCON: 'easycon',
};

export const DEFAULT_PORT = 80;
/** The built-in user of the EcoTouch web interface (only its password can change). */
export const DEFAULT_USERNAME = 'waterkotte';

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  HEATING_MODE: 'heating-mode',
  DHW_MODE: 'dhw-mode',
  DHW_SETPOINT: 'dhw-setpoint',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_FLOW: 'temperature-flow',
  TEMP_RETURN: 'temperature-return',
  TEMP_RETURN_TARGET: 'temperature-return-target',
  TEMP_HEATING_DEMAND: 'temperature-heating-demand',
  TEMP_SOURCE_IN: 'temperature-source-in',
  TEMP_SOURCE_OUT: 'temperature-source-out',
  TEMP_BUFFER: 'temperature-buffer',
  TEMP_ROOM: 'temperature-room',
  TEMP_DHW: 'temperature-dhw',
  TEMP_DHW_DEMAND: 'temperature-dhw-demand',
  POWER_ELECTRIC: 'power-electric',
  POWER_HEATING: 'power-heating',
  COP: 'cop',
  COMPRESSOR: 'compressor',
  DHW_ACTIVE: 'dhw-active',
  ALARM: 'alarm',
};

/** The tags read at every poll, by value name. */
export const TAGS = {
  serialHigh: 'I114',
  serialLow: 'I115',
  outdoor: 'A1',
  sourceIn: 'A4',
  sourceOut: 'A5',
  returnTarget: 'A10',
  return: 'A11',
  flow: 'A12',
  buffer: 'A16',
  room: 'A17',
  dhw: 'A19',
  powerElectric: 'A25',
  powerHeating: 'A26',
  cop: 'A28',
  heatingDemand: 'A31',
  dhwDemand: 'A37',
  dhwSetpoint: 'A38',
  heatingMode: 'I30',
  dhwMode: 'I32',
  state: 'I51',
};

/** I51 bits (ha-waterkotte STATE_*). */
export const STATE_BITS = {
  compressor: 3,
  alarm: 6,
  dhwActive: 8,
};

/** I30 / I32: the operation of heating and hot water (ha-waterkotte _decode_state). */
export const OPERATION = { 0: 'off', 1: 'auto', 2: 'manual' };
export const OPERATION_CODES = { off: 0, auto: 1, manual: 2 };

/** The commands: tag and kind. `off` of a mode is the protective command. */
export const COMMANDS = {
  [FEATURES.HEATING_MODE]: { tag: TAGS.heatingMode, kind: 'mode', key: 'heatingMode' },
  [FEATURES.DHW_MODE]: { tag: TAGS.dhwMode, kind: 'mode', key: 'dhwMode' },
  [FEATURES.DHW_SETPOINT]: { tag: TAGS.dhwSetpoint, kind: 'setpoint', key: 'dhwSetpoint' },
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds (Home Assistant: 60 s). */
export const POLL_INTERVAL = {
  min: 30,
  max: 600,
  default: 60,
};

/**
 * The hot water setpoint the commands may set, in °C. The low end is the
 * one ha-waterkotte offers (28 °C); the configuration chooses the ceiling
 * between `min` and `max`, 55 °C by default; nothing above 60 °C is ever
 * written, whatever the configuration or the controller would accept (70 °C).
 */
export const DHW_SETPOINT = { min: 28 };
export const DHW_CAP = {
  min: 40,
  max: 60,
  default: 55,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** An answer of the heat pump (the poll answer is about 1 KB). */
  bodyBytes: 64 * 1024,
  headerBytes: 8 * 1024,
  /** A Set-Cookie value kept (the IDALToken is short). */
  cookieBytes: 512,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  connectTimeout: 3 * SECOND,
  /** One request of the polling. */
  requestTimeout: 5 * SECOND,
  /** A request silent this long is cut by an arriving stop (it does not count as a failure). */
  stalled: SECOND,
  /** Failed polls: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** "Too many users" or an HTTP 5xx: a pause, doubled each time, 1 minute to 6 hours. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button: at most one login attempt this often. */
  testCooldown: 10 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the write must leave by 3 s
   * after the click, or the command is refused unsent; its answer is awaited
   * until 3.8 s and the read back until 4.6 s, after which the command is
   * "sent, without confirmation".
   */
  commandSendBy: 3_000,
  commandAnswerBy: 3_800,
  commandConfirmBy: 4_600,
  /** The fresh read of a command keeps at least this much for the write. */
  commandMinSend: 300,
  /** A stop retries a write that did not leave every 250 ms within its budget. */
  stopRetry: 250,
  /** Reads after a command: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** Rounds of the stops between polls: 10 s after an Off not written, then every minute. */
  stopQuick: 10 * SECOND,
  stopRound: MINUTE,
  /** A stop not confirmed is written again by the next reads, 3 times at most, for 15 minutes. */
  stopResends: 3,
  stopKeep: 15 * MINUTE,
};
