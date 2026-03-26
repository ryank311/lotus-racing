# Nitron 3-Way Damper Tuning Guide -- 2008 Exige Club Racer

## Current Setup (Baseline)
All settings are clicks from full hard (CW to stop, then count CCW clicks).

| Corner | Rebound | Hi-Speed Comp | Lo-Speed Comp |
|--------|---------|---------------|---------------|
| Front  | 10      | 8             | 8             |
| Rear   | 10      | 8             | 8             |

Springs: 550 lbs/in front, 700 lbs/in rear
Weight distribution: 40/60 front/rear (~2150 lbs with driver)

**Problem:** These are Nitron's factory shipping defaults -- identical front/rear. Every published fast Exige setup differentiates front from rear.

---

## Why Identical Settings Are Wrong

Your 40/60 weight distribution means the rear axle carries 50% more weight than the front. Under braking, weight transfers forward aggressively due to the pendulum effect of the rear-mounted engine. Running identical damper settings means:

- **Rear rebound is effectively too soft** relative to the spring rate and weight it controls
- **Under trail braking:** the rear extends (unloading the tires) while the front compresses (loading them). Equal rebound settings let the rear extend too quickly, causing snap oversteer
- **On lift-off:** engine braking decelerates the rear wheels, weight shifts forward. Low rotational inertia means once the rear starts rotating, it happens fast with little warning

---

## Published Fast Exige Settings (550/700 springs)

| Source | Aero Level | Front R/Hi/Lo | Rear R/Hi/Lo |
|--------|------------|---------------|--------------|
| Nitron factory preset | Any | 10/8/8 | 10/8/8 |
| Sector 111 (S111) | Big aero | 12/11/12 | 8/4/9 |
| Craig Stanton | Wing+splitter | 14/8/2 | 14/7/4 |
| LotusTalk (Inertia Labs revalve, 550/750) | Aero, 225 Toyo RR | 12/11/12 | 8/4/9 |
| LotusTalk evolved (450/600) | Moderate aero | 13/12/13 | 11/10/11 |

**Pattern across ALL published setups:**
- Front rebound 2-6 clicks stiffer than rear
- Front compression generally stiffer than rear
- Rear hi-speed compression significantly softer than front

---

## Recommended Starting Point

For your car with the Railer diffuser (moderate aero):

| Corner | Rebound | Hi-Speed Comp | Lo-Speed Comp |
|--------|---------|---------------|---------------|
| Front  | **12**  | **10**        | **10**        |
| Rear   | **8**   | **6**         | **8**         |

This creates a 4-click rebound split and softens rear compression, which should significantly reduce both trail-brake and lift-off oversteer.

---

## Step-by-Step Tuning Protocol

### Important Nitron Notes
- **Always count from full hard** (CW to stop, then CCW). Nitron dynos and matches shocks at full hard
- **Hold one knob while turning the other.** On 3-way reservoirs, the hi-speed and lo-speed knobs rotate together. Physically hold one still while adjusting the other
- **Beyond 20 clicks from full hard**, the adjuster has negligible effect
- **Never run full hard or full soft**

### Session 1: Establish Rebound Split
Change from baseline:
- Front rebound: 10 -> **12** (+2 clicks stiffer)
- Rear rebound: 10 -> **8** (-2 clicks softer)
- All compression: unchanged at 8/8

Drive 6-8 laps. Evaluate:
- [ ] Trail-brake oversteer reduced?
- [ ] Lift-off oversteer reduced?
- [ ] Turn-in rotation feels controlled?
- [ ] Car doesn't feel "stuck" or understeery on entry?

**If oversteer is still present:** move to Session 2
**If car now understeers on entry:** reduce front rebound to 11, or increase rear rebound to 9

### Session 2: Adjust Compression Balance
Starting from Session 1 result:
- Front lo-speed compression: 8 -> **10** (+2 clicks stiffer)
- Rear hi-speed compression: 8 -> **6** (-2 clicks softer)

Drive 6-8 laps. Evaluate:
- [ ] Better platform over bumps/curbs?
- [ ] Car more stable under trail braking?
- [ ] Rear doesn't skip over surface imperfections on corner entry?

### Session 3: Fine-Tune
Adjust in **1-click increments only**. Drive 3-4 laps between each change.

**Target behavior:** Neutral balance at corner entry with slight trailing-throttle understeer (which is safer and faster for most drivers).

---

## Damper Adjustment Quick Reference

### To Reduce Trail-Brake Oversteer
| Action | Clicks | Why |
|--------|--------|-----|
| Stiffen front rebound | +2 to +4 | Keeps front loaded longer through braking transition |
| Soften rear rebound | -2 to -3 | Lets rear extend gently, keeps rubber on pavement |
| Stiffen front lo-speed compression | +1 to +2 | Resists forward pitch under braking |
| Soften rear hi-speed compression | -1 to -2 | Helps rear absorb bumps while loaded |

### To Reduce Lift-Off Oversteer
| Action | Clicks | Why |
|--------|--------|-----|
| Stiffen front lo-speed compression | +2 | Resists forward pitch when throttle is lifted |
| Ensure front rebound > rear by 2-4 clicks | -- | Controls weight snap-back rate |

### To Increase Turn-In Rotation (If Car Becomes Too Understeery)
| Action | Clicks | Why |
|--------|--------|-----|
| Soften front compression | -1 to -2 | Allows front to load faster on entry |
| Stiffen rear rebound | +1 | Slows rear from settling, promotes rotation |

---

## Common Mistakes to Avoid

1. **Running identical front/rear settings** -- Your current situation. The factory preset is a safe starting point, not an optimized one
2. **Too much rebound (jacking down)** -- If rebound is too stiff relative to springs, the shock can't fully extend between bumps, progressively compressing onto bump stops. Causes sudden, violent oversteer or understeer
3. **Changing multiple parameters at once** -- Adjust one thing at a time, 1-2 clicks, 3-4 laps between changes
4. **Using dampers to fix spring/ARB problems** -- Dampers control the *rate* of weight transfer, not the *amount*. If the car has too much body roll, that's springs or bars
5. **"Full hard for track"** -- Full hard overloads tires on imperfect surfaces, reduces mechanical grip, makes the car unpredictable
6. **Not holding one knob while turning the other** -- On Nitron 3-ways, both knobs rotate together unless held

---

## Diagonal Weight Transfer Theory

During the transition from braking to cornering:
- Inside front damper: moves in rebound
- Outside rear damper: moves in compression

Strong front rebound during this transition has the same effect as a stiffer front anti-roll bar -- it increases front lateral load transfer, creating more understeer. This is **desirable** on a mid-engine car that oversteers on entry.

This is why every fast Exige setup runs stiffer front rebound than rear.

---

## Recording Your Changes

Use this format to log every change:

```
Date: ___________
Track: ___________
Conditions: Temp ___ / Humidity ___ / Track surface ___

Front: R___/Hi___/Lo___
Rear:  R___/Hi___/Lo___

Observations:
- Trail-brake entry:
- Mid-corner:
- Exit/power-on:
- Over bumps/curbs:
- Overall balance:
```

---

## Sources
- [LotusTalk: Nitron 46mm 3-ways setting](https://www.lotustalk.com/threads/nitron-46mm-3-ways-setting.107455/)
- [LotusTalk: Nitron 3-Way Settings + Alignment](https://www.lotustalk.com/threads/nitron-3-way-settings-alignment.545728/)
- [SELOC TechWiki: Damper Settings](https://wiki.seloc.org/a/Damper_Settings)
- [Nitron Automotive User Manual (PDF)](https://www.nitron.co.uk/files/Nitron_Automotive_Manual_A5_website.pdf)
- [Suspension Secrets: Dampers Set Up](https://suspensionsecrets.co.uk/dampers-set-up/)
- [Suspension Secrets: Lotus Exige S2](https://suspensionsecrets.co.uk/lotus-exige-s2-2/)
- [MotoIQ: 3, 4, and 5-Way Adjustable Shocks](https://motoiq.com/how-to-adjust-your-shocks-like-a-pro-and-go-faster-part-3-34-and-5-way-adjustable-shocks-with-advanced-techniques/)
- [NASA Speed News: Chassis Tuning with Dampers](https://nasaspeed.news/tech/suspension/chassis-tuning-with-dampers-a-hard-look-at-shock-absorbers-and-their-effects-on-handling/)
- [Hofmann's Lotus Suspension](https://hofmanns.co.uk/lotus_handling/)
