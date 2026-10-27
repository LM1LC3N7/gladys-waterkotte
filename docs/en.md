# Waterkotte

Shows a Waterkotte heat pump in Gladys through the local web interface of its
controller (EcoTouch, or the older EasyCon), without any cloud. Unofficial:
not affiliated with Waterkotte. **Never tested with a real heat pump**: it was
written from the open source Home Assistant integration
[ha-waterkotte](https://github.com/marq24/ha-waterkotte) and tested against a
simulated controller. Please report what you see on yours.

## What you get

One device, "Waterkotte heat pump", with what its controller gives:

- temperatures: outside, flow, return and return target, heating demand,
  source inlet and outlet, buffer tank, room (when a sensor is connected),
  hot water and hot water demand;
- compressor running, heating hot water, alarm;
- electric power (kW), heat output (kW), COP;
- **Heating** and **Hot water**: Off, Auto or Manual;
- **Hot water setpoint** (°C).

The values are read every 60 seconds (30 to 600, in the configuration).

## Setting up

1. Find the IP address of the heat pump (its web page) and give it a fixed
   address in your router.
2. In Gladys, open the integration's configuration: enter the address, choose
   the controller (**EcoTouch** when the web page asks for a password, even
   when it shows "EasyCon"; **EasyCon** for the older controllers without a
   login page), the user name (`waterkotte` unless your installer changed it)
   and the password of the web page. Save.
3. Add the heat pump from the **Discovery** tab.

The password is kept by Gladys in its database, never shown again, sent only
to the heat pump. The web page is plain HTTP: keep the heat pump on a trusted
network.

### Sessions

The controller accepts few sessions at once (its web page open in a browser
uses one). Gladys keeps a single session open and logs in again at most once
per read or per command, never in a loop. When the controller answers "too
many users", Gladys pauses for 1 minute, then 2, 4... up to 6 hours, and says
so in the configuration screen. When it refuses the user name or the
password, Gladys stops trying: correct them and save, or click **Test the
connection** (one try per click).

## Commands

**Off** (heating or hot water) is a stop: it does not depend on the "Allow
the commands" option, a pause or a read in progress. It is written, then read
back:

- read back Off: done;
- otherwise Gladys answers "sent, without confirmation" or "not applied yet",
  keeps the stop (also across a restart) and writes it again with the next
  reads, 3 times at most and for 15 minutes at most; it is not written again
  over a value set since by someone else (on the controller, its web page).

Off is refused, nothing sent, in these cases only:

- the controller is EasyCon (read only in this integration);
- the address or the password is missing: the stop is kept and written as
  soon as the configuration is complete (15 minutes at most);
- the heat pump refused the credentials before: the stop is kept and written
  once they are corrected (15 minutes at most);
- nothing could be sent within 3 seconds (no answer, network down): the stop
  is kept and written by the next reads.

**Auto**, **Manual** and the **hot water setpoint** are refused unless you
turn on **Allow the commands** (off by default). Then:

- the hot water setpoint takes whole degrees from 28 °C to the ceiling of
  the configuration, **55 °C by default**, 40 to 60 °C (never more than
  60 °C, whatever is typed): scalding risk;
- each command reads the value and the serial number of the heat pump just
  before writing, and succeeds only when a read back shows the value asked;
- a command refused or cancelled says "nothing sent"; one sent without an
  answer says "sent, without confirmation" and the value is read again 5 and
  20 seconds later;
- a command clicked before an Off of the same value (or a hot water setpoint
  clicked before a hot water Off) never leaves after it.

The integration has no switch: a "turn everything off" of a voice assistant
or a scene never reaches the heat pump.

## Limits

- One heat pump per integration. Its serial number is checked at every read
  and before every command: when another heat pump answers at the address,
  nothing is published and the commands other than Off are refused.
- The controller answers one request at a time: when it is slow (more than
  about half a second per request), a scene changing several values at once
  may see the last ones refused "did not answer in time, nothing sent".
- EasyCon: read only, and its tags are those of EcoTouch (unchecked).
- The tag list comes from ha-waterkotte; Waterkotte publishes none.

## Credits

Built on the work of Matthias Marquardt and the contributors of
[ha-waterkotte](https://github.com/marq24/ha-waterkotte) (MIT).
