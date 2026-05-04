# signalk-engine-hours

Signal K engine hours logger keeps engine runtime data in persistent storage. Engines that report revolutions to the Signal K server are logged automatically. Users can change how often engine revolutions are monitored; the current default is 60s. When the Signal K server starts, previously logged data is read from persistent storage. All runtime data is written immediately. From the WebApp, engine runtimes can be set and changed.

## Versions

- v0.0.1 Initial release
- v0.1.0 Improvements, custom API and simple hours editor
- v0.1.1 Improvements to editor
- v0.2.0 runTimeTrip added and improvements to editor
- v0.2.1 fix for runTimeTrip meta
- v0.3.0 editor UI modifications
- v0.3.1 fixes to editor UI
- v0.4.0 tooltip to show hrs:min
- v1.0.0 1st release
- v1.1.0 fix: improve error handling and validation for engine data
- v1.2.0 feat: option to monitor propulsion.*.state
- v1.3.0 new UI and fixes to code
- v1.3.1 chroe: clean-up
