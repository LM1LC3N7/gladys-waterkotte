# TODO — Waterkotte v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-10-27): EcoTouch web interface (login,
      one session, readTags, writeTags, logout), EasyCon read only, one
      device, temperatures, compressor, hot water, alarm, power, COP; Off of
      heating and hot water (stop, always sent, kept in /data); Auto, Manual
      and the hot water setpoint behind `allow_commands` (off), hot water
      ceiling 55 °C (40–60, never above 60); pause on "too many users",
      refused credentials kept; docs en/fr, cover. Tested against a fake
      controller only.
- [ ] **Milestone 2 — real heat pump**: run against a real EcoTouch (see
      "To check"), turn the answers (no address, no cookie) into fixtures.
- [ ] **Milestone 3 — more**: heating curve and heating adjust (I263),
      cooling, pool, mixing circuits, alarms as text, energy counters (only
      with the approved guard of gladys-p1-monitor, never an index without
      it), EasyCon commands once its write format is confirmed.

## To check on a real heat pump

- The tags (ha-waterkotte 2026.10.7, `pywaterkotte_ha/tags.py`): Waterkotte
  publishes no list for the web interface; compare each value with the web
  page (A1 outside, A11/A12 return/flow, A19 hot water, A38 hot water
  setpoint, I30/I32 operation, I51 bits 3 compressor, 6 alarm, 8 hot water).
- I30/I32 codes: 0 off, 1 auto, 2 manual (ha-waterkotte `_decode_state`);
  any other code is shown as unknown and blocks Auto/Manual.
- The serial number (I114, I115): readable on every firmware? Constant?
- A17 (room): -3276.8 °C without a sensor here (filtered as out of range).
- Whether "#E_NEED_LOGIN" also comes as HTTP 500 (ha-waterkotte logs in
  again on a 500): here a 5xx is a pause, not a login.
- The delay between a write and its read back (here at once, then 5 and
  20 s).
- How many sessions the controller accepts, and how long it keeps one idle.
- EasyCon: the XML format, the ranges, whether Basic auth is needed.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-waterkotte:0.1.0`); the first patch release gives
  0.1.1. `test/manifest.test.js` checks the four agree, without pinning one.
- **Reference**: ha-waterkotte 2026.10.7 (MIT, Matthias Marquardt), commit
  311382f, cloned read only in `~/code/ref/lot17/ha-waterkotte`; full notice
  in `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE`.
- **Own HTTP client, no dependency** (`src/http.js`, node:net): `beforeSend`
  right before the first byte, `sent` exact, answers bounded (8 KB headers,
  64 KB body) and cut before read whole, one request per connection, the time
  of the last byte for the stall check. Runtime dependency: the SDK only.
- **One gate per heat pump** (`src/client.js`): one request at a time; stops
  first, then commands, then polls. A waiting stop makes a poll give the
  gate back before its next request and cuts a read silent for 1 s or more
  (not counted as a failure). A command keeps the gate from its fresh read
  to its read back.
- **Session**: one login, the cookie kept; "#E_NEED_LOGIN" logs in again at
  most once per poll, command or stop; "#E_TOO_MANY_USERS" or an HTTP 5xx is a
  pause (1 min doubled to 6 h, in /data, not applied to stops);
  "#E_PASS_DONT_MATCH" (EasyCon: HTTP 401) is a refusal: no automatic try,
  8 bits of a salted hash of the refused credentials in /data, lifted by new
  credentials or a successful click on "Test the connection" (one login per
  click, 10 s apart). The session is ended at shutdown and on a new
  configuration (logout, 1 s).
- **Device**: `waterkotte:heatpump`, one per integration. The serial number
  (I114-I115) is in the params, not in the id (a firmware that does not give
  it never makes a second device); it is pinned by the created device's
  param and checked at every read (another serial: nothing published;
  unreadable: nothing published, not "another") and in the fresh read of
  every sensitive command (refused when different or unreadable). Stops do
  not check it.
- **Features** (core units): temperatures `temperature-sensor/probe` °C,
  room `temperature-sensor/decimal`; electric power `energy-sensor/power`
  kW (a power, never an index); heat output and COP `unknown/decimal`;
  compressor and alarm `unknown/binary` read only; hot water heating
  `water-heater/heating`; heating and hot water `text/select` (off, auto,
  manual: string labels); hot water setpoint
  `water-heater/target-temperature` 28–60 °C. On EasyCon the three commands
  are read only. A feature appears once its tag gave a value in range; the
  created device's features are kept (no lost feature).
- **Off = stop** (lot 16 lesson 1): independent of the option, the bounds,
  a previous read, the identity, a pause, a command or poll in progress;
  retried every 250 ms within 3 s; read back. Not confirmed: kept in /data
  (role, value before, date, deadline 15 min, sends) and written by the next
  reads (all at once, a send counted only when it left, 3 at most); dropped
  when a read shows Off, when the value changed to another one than before
  the stop (someone set it), at its deadline, or after 3 sends; a /data date
  in the future is invalid. At start, the kept stops go before the first
  poll (a read of I30/I32 then the writes). Refused only: EasyCon, no
  configuration (kept), credentials refused before (kept, never sent with the
  refused password), nothing sent in 3 s (kept). With `getConfig()` failing
  the address and password are unknown (never kept in /data): the stop waits
  for the configuration.
- **Sensitive commands**: option checked on arrival and in `beforeSend`;
  values strict (`'' `, `null`, `'1e2'`, fractions refused); setpoint
  28 °C to the ceiling (55 by default, 40–60, rounded down, never above 60)
  checked again in `beforeSend`; refused while a hot water stop is kept;
  one command per target at a time; fresh read of the target and the serial
  (decided on it, never on memory); /data saved before the first byte
  (failed or unreadable /data: refused); a stop arrived later cancels it
  (checked in `beforeSend`); a stop arrived earlier is replaced only when the
  command leaves (restored otherwise). Outcomes: read back = asked →
  success; read back = before → "sent, not applied yet"; no answer →
  "sent, without confirmation"; never left → "nothing sent". Guard 90 s
  after a sent command (no "already so" while it holds). Follow-up reads at
  5 and 20 s.
- **Deadlines** (Gladys waits 5 s): write leaves by 3 s, answered by 3.8 s,
  read back by 4.6 s.
- **Polling**: 60 s by default (Home Assistant's), 30 s – 10 min; failures
  30 s, 1, 2, 5 min, never shorter than the interval; the time of the attempt
  is in /data before the read: a restart never reads sooner. The test button
  and Discovery never read sooner than the interval.
- **Known limit**: one request at a time on a slow controller: a scene
  changing the three values at once with more than about 0.5 s per request
  may see the last ones refused "nothing sent" (the deadlines of Gladys);
  stops jump ahead and are not affected.
- **EasyCon read only**: the write format of ha-waterkotte for EasyCon
  (`/config/query.cgi`, value scale unclear) is not confirmed; no commands
  there, not even Off.
- **gladys_version >= 5.1.0**, **category `climate`**, transport `local`; no
  `keywords` nor `countries` (Germany mainly; to add when the store asks).
- **Template demo files** removed.
- **Not checked here**: duplicates (checked when the lot was chosen, see
  `_lots/lot17/proposition.md`), a real heat pump, the store validator with
  image (at publication).
