# Session Review design references

Three illustrative concepts generated with ChatGPT's **built-in image-generation tool** before implementing the React UI. All displayed sessions, advice and figures in these images are mock data. The implemented definitions in [Session Review](../session-review.md) take precedence over image text and chart details.

| Image | Design focus |
| --- | --- |
| [Mobile Session Review](mobile-review.png) | Conditions, pace, gain/loss and populated coaching priorities in phone reading order |
| [Desktop Session Review](desktop-review.png) | Track map, region comparisons, speed detail and session history |
| [Desktop Progress](desktop-progress.png) | Vehicle/layout/surface/temperature filters, long-term trends and selected-corner detail |

## Reproduction prompt set

Shared direction: create an illustrative product design mockup for Catalyst Coach, a motorsport telemetry application. Use charcoal panels, orange primary actions, cyan reference traces, green time improvements and restrained red time regressions. Use condensed headings and monospaced measurements. Keep labels legible, layout purposeful, and include “Illustrative data.” Comparisons are for one driver, car, track layout and matching conditions. Speed changes alone are neutral. These are interface concepts, not photographs of a device.

1. **Mobile Session Review:** show a phone-first post-session dashboard with a single session and condition summary, fast-three pace and best lap, biggest corner/segment gain and loss, and a populated AI coach card. The coach shows strengths, regressions and up to three next-session priorities with evidence, a memorable cue and a measurable success criterion. Include expandable track comparisons, progress history and lap inclusion controls further down the page.
2. **Desktop Session Review:** show the same visual system in a desktop dashboard with navigation, session picker, conditions, four summary metrics, track-map highlights, signed region-time bars, a selected corner's V-min and entry/exit comparisons, lap contributions and history. Keep the Ask Coach / saved-advice area prominent. Distinguish current orange traces and cyan references, with time gains/losses green/red.
3. **Desktop Progress:** show a long-term performance page with vehicle, track/layout, surface and temperature-centre filters using a ±5°C comparison window. Include fast-three pace, best lap and consistency trends, a clearly distinct recent baseline and historical PB, selectable corner/segment time and speed history, and a selected-corner detail panel. Avoid a combined cross-track score.

Saved assets are `docs/session-review-design/mobile-review.png`, `desktop-review.png`, and `desktop-progress.png`. They are design references only; all shipped charts and controls are native React/SVG components.
