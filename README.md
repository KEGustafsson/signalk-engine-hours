# signalk-engine-hours

[![SignalK Plugin CI](https://github.com/KEGustafsson/signalk-engine-hours/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/KEGustafsson/signalk-engine-hours/actions/workflows/signalk-ci.yml)

Signal K engine hours logger keeps engine runtime data in persistent storage. Engines that report revolutions to the Signal K server are logged automatically. Users can change how often engine revolutions are monitored; the current default is 60s. When the Signal K server starts, previously logged data is read from persistent storage. Runtime data is written to persistent storage shortly after changes (debounced). From the WebApp, engine runtimes can be set and changed.

## Screenshots

![Engine Hours Editor](screenshots/engine-hours-editor.png)

## Versions

See [CHANGELOG.md](CHANGELOG.md) for the release history.
