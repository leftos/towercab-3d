# Aircraft orientation: yaat's flight-physics values (TC3D-52)

The values yaat's simulator uses, as yaat reported them for TC3D-52. TC3D-52's rotation, flare, bank and approach-attitude constants come from here (owner ruling: take them from yaat). yaat is MIT (`X:\dev\yaat\LICENSE`): its per-category constants may be hard-coded here with the MIT notice kept; its `AircraftProfiles.json` must not be copied (provenance unrecorded, yaat item YAAT-267).

**In short, yaat does not model pitch, roll rate or ground attitude.** The only attitude quantity it computes is a bank angle, derived from turn rate. It isn't on any wire: neither the yaat hub DTOs nor the CRC/vNAS DTOs from yaat-server carry it. Rotation and touchdown happen instantly. The speeds and heights below are therefore the only ground truth yaat can offer. Any pitch you draw is your own inference. Paths are relative to X:\dev\yaat\src\Yaat.Sim\ and the values are quoted from the code.

## 1. Takeoff
| quantity | value / formula | where |
|---|---|---|
| VR | per-type `RotateSpeed` from the profile, else the category value | AircraftPerformance.cs:269-273 |
| VR category fallback | Jet 150, Turboprop 110, Piston 65 kt | AircraftCategory.cs:267-277 |
| V1 | VR − 5 | AircraftPerformance.cs:280 |
| Liftoff | instant at IAS ≥ VR (`GroundFrame.LeaveGround`), followed straight away by the climb targets | Phases/Tower/TakeoffPhase.cs:195-214 |
| Rotation pitch rate, liftoff pitch, climb pitch | **not modeled** | none |
| Ground-roll accel | a(t) = idle + (steady − idle)·min(t/spool, 1) | GroundRollProfile.cs:56-74 |
| idle / steady (kt/s), spool (s) | Jet 1.0 → 5.0 over 5 s; TP 0.8 → 4.0 over 4 s; Piston 0.5 → 2.7 over 3 s | AircraftCategory.cs:219-264 |
| Initial climb speed (kt) / rate (fpm), category | Jet 180 / 3000; TP 130 / 1800; Piston 80 / 800 | AircraftCategory.cs:280-302 |
| Initial climb, per type | profile `ClimbSpeedInitial` / `ClimbRateInitial`, rescaled against the FAA ACD | AircraftPerformance.cs:282-304 |

For drawing: a liftoff pitch can be inferred from the climb gradient, as climb fpm ÷ (TAS kt × 101.27). yaat has no number of its own for this.

## 2. Landing
| quantity | value / formula | where |
|---|---|---|
| Flare entry height AGL | Jet 30, TP 20, Piston 15 ft | AircraftCategory.cs:319-329; LandingPhase.cs:643 |
| Sink through the flare | −FlareFpm·(1 − f), where f = clamp(1 − agl/FlareEntryAgl, 0, 1). It falls linearly to 0 at touchdown. | LandingPhase.cs:773-774 |
| FlareFpm | Jet 370, TP 150, Piston 100 | AircraftCategory.cs:363-372 |
| Speed through the flare | Vref − (Vref − Vtd)·f | LandingPhase.cs:780 |
| Vref (landing plan) | category approach speed + gust additive: Jet 140, TP 110, Piston 75 kt | LandingPhase.cs:534; AircraftCategory.cs:306-316 |
| Vtd | per-type profile `LandingSpeed`, else Jet 135, TP 105, Piston 65 | AircraftPerformance.cs:391-395; AircraftCategory.cs:376-386 |
| Threshold crossing height | Jet 30, TP 25, Piston 20 ft; aim point = TCH / tan 3° | AircraftCategory.cs:343-353 |
| Rollout decel | Jet 3.6, TP 3.0, Piston 2.5 kt/s | AircraftCategory.cs:395-403 |
| Flare pitch, touchdown attitude, de-rotation rate | **not modeled** | none |

## 3. Bank in turns
| quantity | value / formula | where |
|---|---|---|
| Bank | bank = atan(TAS_kt · ω_deg/s · π/180 · 1.6878 / 32.174), i.e. the coordinated turn tan φ = V·ω/g, signed by turn direction | FlightPhysics.cs:870, 933-934 |
| Bank cap | **none**. For example, a jet at 250 kt TAS and 2.5°/s gives about 29°. | FlightPhysics.cs:933 |
| Roll rate | **not modeled**. Bank is set fresh every tick and drops to 0 the moment the heading is reached. | FlightPhysics.cs:890, 902, 918 |
| Turn rate (deg/s) | Jet 2.5, TP 3.0, Piston 3.0, Heli 5.0, constant with speed. Per type, `StandardTurnRateOverride` can replace it. | AircraftCategory.cs:74-84; AircraftPerformance.cs:306-315; FlightPhysics.cs:922 |
| Pattern turns (deg/s) | Jet 3, TP 4, Piston 5, Heli 6 | AircraftCategory.cs:549-558 |
| Stored on | `AircraftState.BankAngle` (+ right). It reaches clients only through recording snapshots. | AircraftState.cs:385 |

## 4. Ground and approach
| quantity | value / formula | where |
|---|---|---|
| Taxi speed | Jet 30, TP 25, Piston 20 kt; turns of 90° or more at 15 / 15 / 10; turns of 150° or more at 8 / 8 / 5 | AircraftCategory.cs:683-692, 1028-1047 |
| Ground attitude (taxi, takeoff roll) | **not modeled**; bank is held at 0 on the ground | FlightPhysics.cs:902 |
| Glideslope | 3.0°; descent fpm = GS_kt · tan(angle) · 101.269 (about 5.3 × GS) | Phases/GlideSlopeGeometry.cs:9, 59 |
| Approach pitch / AoA | **not modeled** | none |

## 5. Per-type data and its license
- **File:** `Data/AircraftProfiles.json` is a JSON array of 163 entries keyed by `typeCode`. That count includes one junk entry, `VEH1`. Its fields are listed in `docs/aircraft-performance.md:94-104`.
- **Lookup:** `AircraftProfileDatabase.Get(type)` strips prefixes such as `H/`. It falls back to a sibling type (`AircraftProfileSiblings.json`) and then to the `CategoryPerformance` constants. `AircraftProfileOverrides.json` adds hand-checked fields, currently only SF50. Six speed and climb fields are rescaled at runtime against the FAA ACD Vref (`EurocontrolProfileCorrectionAdapter`).
- **Licence:** yaat's code is MIT. **Do not copy `AircraftProfiles.json`, though.** Our docs say it was derived from Eurocontrol performance data. They disagree on the exact source: `docs/aircraft-performance.md:13` says BADA, `docs/architecture.md:1258` says ATCTrainer. NOTICE records no source or licence for it. Eurocontrol's data has its own terms, and nobody has checked them. I've added yaat plan item YAAT-267 to settle where the file came from.
- **Recommendation:** hard-code per weight class from the category table above. The numbers in it are yaat's own MIT constants, so copying them into a GPL-2.0 project is fine with the MIT notice kept. For a per-type Vref, the FAA Aircraft Characteristics Database is US-government data, and that's what yaat uses as ground truth.
