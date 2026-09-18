# Chart interaction on phones

Every analysis chart and the track map has an Expand button. Expanded views fill the browser viewport, adapt to portrait/landscape, keep the current zoom when closed, and return focus and page position to the original chart. Close or Escape returns to the dashboard.

| Input | Embedded chart | Expanded distance / G-G chart | Expanded track map |
| --- | --- | --- | --- |
| Tap | Keep a sample readout visible | Keep a sample readout visible | Inspect the closest racing-line sample |
| One-finger drag | Scroll the page | Scrub through sample readouts | Pan the map |
| Two-finger drag | Browser gesture | Pan the visible data | Pan the map |
| Pinch | Browser zoom | Zoom around the midpoint of the fingers | Zoom around the midpoint of the fingers |
| Double-tap | Browser behavior | Reset zoom | Fit the track |

Distance charts zoom only along distance, with vertical bounds adapting to the visible samples. G-G zoom keeps the axes at equal scale so the traction circle stays circular. Corner charts support tap/drag inspection; their categorical rows do not need continuous pan/zoom. The segment table scrolls normally and shows the full lap/segment value when a cell is selected.

Mobile uses multi-finger gestures without +/− controls. A compact Reset action appears in the header after zooming. Desktop also has small +/− actions in that same header. Titles, context, and mode selectors share a consistent layout with no separate zoom toolbar. Touch readouts stay visible after lifting a finger and have a Clear readout button. A pinch suppresses inspection until all fingers are lifted, preventing accidental selections when the first finger comes off. Canceled gestures clear their state. Embedded charts allow normal scrolling and browser pinch zoom; custom gestures take over only on the expanded plotting surface.

Implementation uses [Pointer Events and touch-action](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) for gesture arbitration and a [modal dialog](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal) for focus containment and background isolation. Full-screen mode fills the browser viewport; it does not require the device's Fullscreen API or lock orientation.

## Checks

Run `npm run test:charts` with Node 22+ and Chrome installed. On macOS the test uses the standard Chrome application path; elsewhere it uses `google-chrome`. Set `CHROME_BIN` for another location. Set `CHART_SCREENSHOT` to save a mobile screenshot.

The suite tests range bounds and anchoring, then uses real Chromium touch input against isolated chart fixtures: scrolling, persistent readouts, two-finger pan and pinch, cancellation, double-tap reset, full-screen state preservation, focus, rotation, desktop selection, corner inspection, table cells, and map zoom. Physical-device Safari testing is still useful for browser chrome and safe-area behavior.
