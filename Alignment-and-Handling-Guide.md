# Alignment, Tires, and Handling Balance -- 2008 Exige Club Racer

## Current Alignment (from last track alignment sheet)

| Parameter | Front Left | Front Right | Rear Left | Rear Right |
|-----------|-----------|-------------|-----------|------------|
| Camber | -2.8 deg | -2.7 deg | -2.8 deg | -2.6 deg |
| Toe | 0mm total | | 3.3mm total toe-in | |
| Caster | 3.2 deg | 3.2 deg | -- | -- |
| Ride height | 130mm | | 130mm | |

Springs: 550 lbs/in front, 700 lbs/in rear
Tires: Hoosier A7 -- 205/45/16 front, 225/40/17 rear

---

## Alignment Assessment

Your alignment is already well-dialed. Here's the breakdown:

### Rear Toe-In: 3.3mm total -- GOOD, no change needed

Right in the sweet spot:
- Factory spec: 2.4-3.6mm total
- Community consensus for track use with R-comps: 3-3.5mm
- This is not contributing to your oversteer

### Rear Camber: -2.8L / -2.6R -- GOOD, minor note

Already in the recommended range (-2.5 to -2.8). The slight left/right asymmetry is within normal tolerance. If you get a future alignment, evening these to -2.7 both sides would be ideal, but not a priority.

### Front Camber: -2.8L / -2.7R -- MAXED OUT (shims)

The Exige uses shims for camber adjustment. All shims are currently removed, meaning -2.8/-2.7 is the maximum available without aftermarket parts (offset bushings or machined uprights). Ideally -3.0+ front would help counter oversteer, but this is not available through the stock adjustment method. Not worth pursuing unless you decide to invest in aftermarket camber solutions.

### Front Caster: 3.2 degrees -- STANDARD

Normal range for the Exige. More caster adds straight-line stability and dynamic camber gain in corners, but adjustment range is limited on this platform.

### Front Toe: 0mm -- CORRECT

- Long front straight at VIR rewards low drag
- Turn-in is not the issue (you have oversteer, not understeer)
- If you ever want slightly sharper turn-in, 0.5-1mm toe-out is an option, but address the oversteer first

---

## Recommended Changes

### 1. Lower Ride Height: 130mm -> 120mm front / 125mm rear (HIGHEST PRIORITY)

Your Railer 5-element diffuser needs low ride height to function effectively:
- At 130mm, the diffuser is producing minimal downforce
- Community consensus: diffuser effects become noticeable below 120mm, meaningful below 100mm
- The 340R Track geometry runs 100/110mm (front/rear)

**Recommended approach:** Lower to 120mm front / 125mm rear (5mm positive rake).
- The rake helps the diffuser by creating a Venturi effect under the car
- Positive rake also shifts weight balance slightly rearward at speed, which adds rear grip when you need it most (high-speed corners)

**VIR caution at lower ride heights:**
- Watch the compression at the bottom of the roller coaster (between Oak Tree exit and back straight) -- lowest point on circuit
- Hog Pen bumps + stiff springs + lower ride height = higher risk of bottoming
- Consider running 3-5mm more ride height than your "ideal" as insurance until you know the car's limits at each point

### 2. Front Camber -- MAXED OUT, no change available

All shims are removed on both front and rear. Current values (-2.8/-2.7 front, -2.8/-2.6 rear) are the maximum the stock adjustment allows. More front camber would help counter oversteer, but would require aftermarket parts (offset bushings or machined uprights). Not recommended as a priority given the cost/complexity vs. the gains available from damper tuning and ride height.

---

## Anti-Roll Bars

The Exige has **no rear anti-roll bar from factory** -- only a front bar.

- If your front bar is adjustable (some aftermarket options), stiffening it one position shifts balance toward understeer
- **Do not add a rear bar** to fix oversteer -- a rear ARB will generally make rear oversteer worse by increasing rear lateral load transfer
- The front bar should be left at its current setting until the damper changes are evaluated

---

## Hoosier A7 Tire Management

### Pressure Targets

**Cold starting pressures for VIR:**
- Front: 26 psi
- Rear: 28 psi

**Hot targets:**
- Front: 32-34 psi
- Rear: 34-36 psi

**Handling balance via pressure:**
- To reduce oversteer: raise rear pressure 1-2 psi OR lower front pressure 1-2 psi
- To reduce understeer: lower rear pressure 1-2 psi OR raise front pressure 1-2 psi

The rear running 2 psi higher than the front is appropriate for your 40/60 weight distribution. Hoosier recommends 2-3 psi higher rear pressure for mid-engine layouts.

### Pyrometer Targets

Take readings immediately after hot laps (no cool-down lap) with a needle probe pyrometer:

| Reading | Meaning | Action |
|---------|---------|--------|
| Inside hotter than outside | Too much negative camber | Reduce camber 0.25 deg |
| Outside hotter than inside | Not enough negative camber | Add camber 0.25 deg |
| Middle hotter than edges | Over-inflated | Reduce 2 psi |
| Middle cooler than edges | Under-inflated | Add 2 psi |
| Even across all three | Correct | No change needed |

**Optimal operating temps:** The A7 is a multi-compound tire that works across a wide range. On a road course like VIR, expect surface temps of 160-200F. The A7 maintains grip well at these temperatures.

### A7 Behavior at the Limit

- **Less progressive breakaway than street tires.** The transition from grip to slide is more abrupt. This is relevant to your snap oversteer -- R-compounds give less warning
- **Higher peak grip but narrower operating window.** When the A7 lets go, it lets go faster than a 200TW tire
- **Temperature sensitivity is moderate.** The A7 is more forgiving than slicks but will lose grip if overheated (surface temps >220F)
- **Pressure sensitivity is high.** 2 psi makes a noticeable difference in balance and feel

---

## Spring Rate Considerations

Your 550/700 ratio = front is 21% softer than rear.

**Context:**
- Lotus factory setups use the Olley recommendation of ~30% softer front (e.g., 500/700)
- Your 550/700 (21% softer) is stiffer at the front than factory philosophy
- The 500/700 ratio used by many Penske DA track cars would give the front more compliance and grip

**Assessment:** Your springs are fine for now. The 550 front works well with your aero (the diffuser benefits from a stiffer front platform). If you lower the car and the diffuser starts producing meaningful downforce, the stiffer front becomes even more appropriate.

**If you were to change springs:** Going to 500/700 would shift ~0.5% of grip toward the front, reducing oversteer slightly. But this is a much bigger change than alignment or dampers and should only be considered after exhausting those options.

---

## Change Priority and Tracking

### Revised Order of Changes (with correct alignment data)

1. **Damper rebound split** (see Suspension-Tuning-Guide.md) -- Free, reversible, do it first
2. **Tire pressures** -- Start with 26F/28R cold, use pyrometer to dial in
3. **Ride height** -- Lower to 120/125mm to activate the diffuser
4. **Damper compression tuning** -- Fine-tune after ride height is set

Note: Alignment is essentially maxed out with all shims removed. Rear toe (3.3mm) and all camber values are already in the recommended range. No alignment changes are available without aftermarket camber modification parts.

### What to Evaluate After Each Change

Run 6-8 laps at consistent pace (not pushing for PB), then assess:
- [ ] Trail-brake oversteer: better / same / worse?
- [ ] Lift-off oversteer: better / same / worse?
- [ ] Turn-in sharpness: better / same / worse?
- [ ] Mid-corner stability: better / same / worse?
- [ ] Exit traction: better / same / worse?
- [ ] Confidence level: higher / same / lower?

---

## Sources
- [LotusTalk: Camber Setup](https://www.lotustalk.com/threads/camber-set-up.346033/)
- [LotusTalk: Track Tire Pressures Revisited](https://www.lotustalk.com/threads/track-tire-pressures-revisited.11390/)
- [LotusTalk: Hoosier R7 Air Pressure](https://www.lotustalk.com/threads/hoosier-r7-air-pressure.286193/)
- [Hangar 111: Suspension Geometry & Alignment](https://www.hangar111.com/lotus/suspension-geometry-and-alignment/)
- [Hoosier A7/R7 Care and Safety Guidelines (PDF)](https://www.hoosiertire.com/assets/TCTR7_A7.pdf)
- [RS Racing: A7/R7 Tech Guidelines](https://www.rsracing.com/a7r7Tech.aspx)
- [Suspension Secrets: Lotus Exige S2](https://suspensionsecrets.co.uk/lotus-exige-s2-2/)
- [SELOC TechWiki: Damper Settings](https://wiki.seloc.org/a/Damper_Settings)
