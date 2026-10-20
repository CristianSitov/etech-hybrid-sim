# E-Tech hybrid simulator

An interactive, unofficial model of how Renault's full hybrid E-Tech powertrain works: a combustion engine, the main e-motor, the HSG (high-voltage starter generator) and the clutchless multi-mode dogbox.

**Live:** https://cristiansitov.github.io/etech-hybrid-sim/

You drive it with an accelerator, a brake and four regen paddle levels (0–3). The energy manager picks the drive mode (EV, series, parallel, engine + recharge, regen) and the engine gear. Before every dog clutch engagement, the HSG cranks or speed-matches the engine shaft. You can watch that on the tachometer and in the dog clutch close-up.

## Run locally

It's plain HTML, CSS and JS with no build step.

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk works too.

## Structure

```
index.html     page and the SVG schematic (element ids are used by sim.js)
css/style.css  theme tokens (light and dark), layout, SVG colour classes
js/sim.js      model, strategy, dogbox sync and rendering
```

## Where to tune things

All in `js/sim.js`:

- `CFG`: gear ratios, speed thresholds, battery limits, regen strength per paddle level, and the HSG sync controller (`CFG.sync`).
- `chooseMode()`: the energy-management rules that decide EV, series, parallel and so on.
- `chooseEngineGear()`: which engine gear to use for a given speed and pedal.
- `updateDogbox()`: the release → sync → engage state machine.
- `accelElectric`, `accelEngine`, `regenAvailable`, `drag`: the simple performance model.

In the browser console, `window.etech` exposes `CFG`, the live state `S`, and `setPedal()`, `setRegenLevel()`, `brakeOn()` and `brakeOff()`.

## Simplifications

The numbers are illustrative, not Renault calibration data. The real dogbox has more dog clutches and gear pairs than the single sleeve per shaft drawn here. The e-motor's own two-speed shift happens around 62–72 km/h but isn't animated in detail.

## Ideas

- Animate the e-motor's 2-speed shift with its own sync
- Keyboard and gamepad controls (pedal axis, paddles on shoulder buttons)
- A drive-cycle mode (WLTP-like trace) with fuel and energy totals
- 160 hp / 200 hp variants with their own motor figures
- A time-series strip chart of speed, rpm and battery level

## Sources

- [The dogbox, a key choice for Renault E-Tech full hybrid powertrains (Renault Group)](https://www.renaultgroup.com/en/magazine/our-group-news/the-dogbox-a-key-choice-for-renault-e-tech-full-hybrid-powertrains/)
- [The origins of E-Tech technology, episode 4 (Renault Group)](https://www.renaultgroup.com/en/magazine/our-group-news/the-origins-of-e-tech-technology-4th-episode)
- [Lego plus a touch of boldness, episode 2 (Renault media)](https://media.renault.com/?p=53305)
- [New-generation full hybrid powertrains (Automotive World)](https://www.automotiveworld.com/news/renault-two-new-generation-full-hybrid-powertrains-on-the-road-with-symbioz-and-espace/)

Not affiliated with or endorsed by Renault.
