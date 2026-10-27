# gladys-waterkotte

Gladys Assistant external integration for **Waterkotte heat pumps** through
the local web interface of their controller (EcoTouch; EasyCon read only):
temperatures, compressor, hot water, alarm, power, COP, and optionally the
operation of heating and hot water and the hot water setpoint (capped at
55 °C by default, 60 °C at most). "Off" is a stop that does not depend on
the commands option.

Unofficial, not affiliated with Waterkotte. It was **never tested with a real heat pump**: built from [ha-waterkotte](https://github.com/marq24/ha-waterkotte)
(MIT) and tested against a simulated controller. The web interface is plain
HTTP: keep the heat pump on a trusted network.

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test                 # node --test
npm run lint
npm run format:check
npm run cover            # regenerates cover.png
```

See `CLAUDE.md` for the project rules and `TODO.md` for the decisions and
what remains to check on a real heat pump.

## License

Apache-2.0 (`LICENSE`). Third-party notices: `THIRD_PARTY_NOTICES.md`.
