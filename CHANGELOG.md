# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: Waterkotte heat pumps (EcoTouch, and EasyCon read only)
  through their local web interface: temperatures, compressor, hot water,
  alarm, electric power, heat output, COP.
- Heating and hot water "Off", always allowed, read back, kept and written
  again when not confirmed.
- Optional commands (off by default): heating and hot water Auto or Manual,
  hot water setpoint from 28 °C to a ceiling of 55 °C by default (60 °C at
  most).
- One session kept with the controller, "too many users" handled as a pause,
  refused credentials never retried by themselves.
