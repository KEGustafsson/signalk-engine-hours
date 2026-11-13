# Changelog

## 1.7.0

- feat: minimum report interval — runtime values are re-sent to Signal K at
  least every `minReportInterval` hours (default 12h, 0 disables) even when
  unchanged, so a stopped engine no longer goes silent
- fix: values edited in the WebApp (PUT /hours) are published to Signal K
  immediately instead of on the next engine state change
- ci: Signal K plugin CI workflow, changelog and App Store screenshot

## 1.6.0

- fix: accrual clamp, auth, input hardening, UI state

## 1.5.0

- feat: engine hours reporting optimized

## 1.4.1

- fix: engine hours accrual bug

## 1.4.0

- feat: improved time calculation accuracy

## 1.3.1

- chore: clean-up

## 1.3.0

- new UI and fixes to code

## 1.2.0

- feat: option to monitor `propulsion.*.state`

## 1.1.0

- fix: improve error handling and validation for engine data

## 1.0.0

- 1st release

## 0.4.0

- tooltip to show hrs:min

## 0.3.1

- fixes to editor UI

## 0.3.0

- editor UI modifications

## 0.2.1

- fix for runTimeTrip meta

## 0.2.0

- runTimeTrip added and improvements to editor

## 0.1.1

- Improvements to editor

## 0.1.0

- Improvements, custom API and simple hours editor

## 0.0.1

- Initial release
