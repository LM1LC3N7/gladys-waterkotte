// -----------------------------------------------------------------------------
// The heat pump -> one Gladys device and its states (pure).
//
// External id `ext:<selector>:waterkotte:heatpump`: one heat pump per
// integration (the address of the configuration). The controller gives a
// serial number (I114/I115): it is shown in the device params and checked at
// every read and before every command (src/app.js), but it is not in the id,
// so that a serial unreadable on some firmware never makes a second device.
// The feature roles (the last part of their external ids) are frozen.
//
// A feature appears once its tag gave a value; a device published again
// never loses a feature: those of the device already created in Gladys are
// kept as they are.
//
// No switch, no writable binary: a "turn everything off" must never reach
// the heat pump. The commands are the operation of heating and of hot water
// (`text/select`: off, auto, manual) and the hot water setpoint
// (`water-heater/target-temperature`). "Off" is a stop, always allowed;
// "auto", "manual" and the setpoint are refused unless the configuration
// allows the commands (src/app.js). On EasyCon all three are read only.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  DHW_CAP,
  DHW_SETPOINT,
  FEATURES as F,
  OPERATION,
  STATE_BITS,
  SYSTEMS,
} from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, OPERATION_NAMES, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const probe = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.TEMPERATURE_SENSOR.PROBE,
  unit: U.CELSIUS,
  min: -50,
  max: 120,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });

export const MODE_ROLES = [F.HEATING_MODE, F.DHW_MODE];
export const COMMAND_ROLES = [F.HEATING_MODE, F.DHW_MODE, F.DHW_SETPOINT];

/** The definition of a feature, by role; commands are read only on EasyCon. */
export function definitionOf(role, system) {
  const commandable = system === SYSTEMS.ECOTOUCH;
  switch (role) {
    case F.HEATING_MODE:
    case F.DHW_MODE:
      return {
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: !commandable,
        has_feedback: true,
        keep_history: false,
      };
    case F.DHW_SETPOINT:
      return {
        category: C.WATER_HEATER,
        type: T.WATER_HEATER.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        // The slider stops at the hard ceiling; the configured one refuses below it.
        min: DHW_SETPOINT.min,
        max: DHW_CAP.max,
        read_only: !commandable,
        has_feedback: true,
        keep_history: true,
      };
    case F.TEMP_ROOM:
      return sensor({
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: -30,
        max: 60,
      });
    case F.POWER_ELECTRIC:
      return sensor({
        category: C.ENERGY_SENSOR,
        type: T.ENERGY_SENSOR.POWER,
        unit: U.KILOWATT,
        min: 0,
        max: 100,
      });
    case F.POWER_HEATING:
      return sensor({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min: 0, max: 200 });
    case F.COP:
      return sensor({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min: 0, max: 20 });
    case F.DHW_ACTIVE:
      return sensor({ category: C.WATER_HEATER, type: T.WATER_HEATER.HEATING, min: 0, max: 1 });
    case F.COMPRESSOR:
    case F.ALARM:
      return binary;
    default:
      return probe;
  }
}

/** A number within [min, max], else undefined (a sensor missing or a sentinel value). */
const within = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
const bit = (state, n) => (state === undefined ? undefined : (state >> n) & 1);

/**
 * The values of a read (Map tag -> { status, value }, src/protocol.js),
 * checked: what is out of range is unknown, never published.
 */
export function decodeValues(tags, read) {
  const get = (name) => {
    const entry = read.get(tags[name]);
    return entry?.status === 'ok' ? entry.value : undefined;
  };
  const temperature = (name) => within(get(name), -50, 120);
  const mode = (name) => {
    const code = get(name);
    return Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
  };
  const state = within(get('state'), 0, 0xffff);
  const high = get('serialHigh');
  const low = get('serialLow');
  return {
    serial:
      Number.isInteger(high) && Number.isInteger(low) && high >= 0 && low >= 0
        ? `${high}-${low}`
        : undefined,
    outdoor: temperature('outdoor'),
    sourceIn: temperature('sourceIn'),
    sourceOut: temperature('sourceOut'),
    returnTarget: temperature('returnTarget'),
    return: temperature('return'),
    flow: temperature('flow'),
    buffer: temperature('buffer'),
    room: within(get('room'), -30, 60),
    dhw: temperature('dhw'),
    heatingDemand: temperature('heatingDemand'),
    dhwDemand: temperature('dhwDemand'),
    dhwSetpoint: within(get('dhwSetpoint'), 0, 90),
    powerElectric: within(get('powerElectric'), 0, 100),
    powerHeating: within(get('powerHeating'), 0, 200),
    cop: within(get('cop'), 0, 20),
    heatingMode: mode('heatingMode'),
    dhwMode: mode('dhwMode'),
    compressor: bit(state, STATE_BITS.compressor),
    alarm: bit(state, STATE_BITS.alarm),
    dhwActive: bit(state, STATE_BITS.dhwActive),
  };
}

/** Where each feature comes from in the decoded values. */
const VALUES = {
  [F.HEATING_MODE]: (v) => v.heatingMode,
  [F.DHW_MODE]: (v) => v.dhwMode,
  [F.DHW_SETPOINT]: (v) => v.dhwSetpoint,
  [F.TEMP_OUTDOOR]: (v) => v.outdoor,
  [F.TEMP_FLOW]: (v) => v.flow,
  [F.TEMP_RETURN]: (v) => v.return,
  [F.TEMP_RETURN_TARGET]: (v) => v.returnTarget,
  [F.TEMP_HEATING_DEMAND]: (v) => v.heatingDemand,
  [F.TEMP_SOURCE_IN]: (v) => v.sourceIn,
  [F.TEMP_SOURCE_OUT]: (v) => v.sourceOut,
  [F.TEMP_BUFFER]: (v) => v.buffer,
  [F.TEMP_ROOM]: (v) => v.room,
  [F.TEMP_DHW]: (v) => v.dhw,
  [F.TEMP_DHW_DEMAND]: (v) => v.dhwDemand,
  [F.POWER_ELECTRIC]: (v) => v.powerElectric,
  [F.POWER_HEATING]: (v) => v.powerHeating,
  [F.COP]: (v) => v.cop,
  [F.COMPRESSOR]: (v) => v.compressor,
  [F.DHW_ACTIVE]: (v) => v.dhwActive,
  [F.ALARM]: (v) => v.alarm,
};

export const ROLES = Object.keys(VALUES);

const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys) => gladys.externalIds('waterkotte', 'heatpump');

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(gladys, externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const prefix = `${deviceIds(gladys).device}:`;
  if (!externalId.startsWith(prefix)) {
    return undefined;
  }
  const role = externalId.slice(prefix.length);
  return ROLES.includes(role) ? role : undefined;
}

/** The roles the values of one read report (a value read and in range). */
export function reportedRoles(values) {
  const roles = new Set();
  for (const [role, valueOf] of Object.entries(VALUES)) {
    if (valueOf(values) !== undefined) {
      roles.add(role);
    }
  }
  return roles;
}

/** The options of a mode select: strings for `label`, as the core stores them. */
export function operationOptions(language) {
  return Object.values(OPERATION).map((key, index) => ({
    value: key,
    label: word(OPERATION_NAMES[key], language),
    sort_order: index,
  }));
}

/** The serial kept in the params of a created device, if any. */
export function serialOf(device) {
  const param = (device?.params ?? []).find((p) => p?.name === 'serial');
  return typeof param?.value === 'string' && /^\d{1,7}-\d{1,7}$/.test(param.value)
    ? param.value
    : undefined;
}

/** The Gladys device of the heat pump; `created` keeps the features the new build lacks. */
export function buildDevice(gladys, { roles, system, serial, language, created }) {
  const ids = deviceIds(gladys);
  const params = [{ name: 'system', value: system }];
  if (serial) {
    params.push({ name: 'serial', value: serial });
  }
  const built = {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: system === SYSTEMS.EASYCON ? 'Waterkotte EasyCon' : 'Waterkotte EcoTouch',
    should_poll: false,
    features: ROLES.filter((role) => roles.has(role)).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role, system),
      ...(MODE_ROLES.includes(role) ? { supported_options: operationOptions(language) } : {}),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** The states of one read: modes as their option key (unknown codes not published). */
export function deviceStates(ids, values) {
  const states = [];
  for (const [role, valueOf] of Object.entries(VALUES)) {
    const value = valueOf(values);
    if (value === undefined) {
      continue;
    }
    if (MODE_ROLES.includes(role)) {
      if (Object.hasOwn(OPERATION, value)) {
        states.push({ device_feature_external_id: ids.feature(role), text: OPERATION[value] });
      }
    } else if (Number.isFinite(value)) {
      states.push({ device_feature_external_id: ids.feature(role), state: value });
    }
  }
  return states;
}
