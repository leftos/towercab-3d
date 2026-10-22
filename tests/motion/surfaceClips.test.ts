// @vitest-environment node
/**
 * Which class of motion drives each glTF animation clip: gear progress, spoilers, reversers or wheel spin. The names
 * are every gear, spoiler, reverser, wheel, tyre and steering clip name found in the 502 FSLTL and AIG source glTFs
 * (TC3D-54 clip census), with the per-model numeric suffixes the census found, and the near misses it named.
 */
import { describe, expect, it } from 'vitest'
import { classifyAnimationClip, isGearClip } from '@/utils/gltfAnimationParser'

const words = (list: string): string[] => list.trim().split(/\s+/)

const SPOILER = words(`
  AIA_Fokker_TailSpeedBrake
  AIG_A330_Spoiler_L AIG_A330_Spoiler_R AIG_A340_Spoiler_L AIG_A340_Spoiler_R
  AIG_B757_Spoiler_L1 AIG_B757_Spoiler_L2 AIG_B757_Spoiler_L3 AIG_B757_Spoiler_R1 AIG_B757_Spoiler_R2 AIG_B757_Spoiler_R3
  custom_anim_SPOILERS_LEFT_POSITION_00 custom_anim_SPOILERS_LEFT_POSITION_03 custom_anim_SPOILERS_LEFT_POSITION_04
  custom_anim_SPOILERS_LEFT_POSITION_06 custom_anim_SPOILERS_LEFT_POSITION_07 custom_anim_SPOILERS_LEFT_POSITION_08
  custom_anim_SPOILERS_LEFT_POSITION_09 custom_anim_SPOILERS_LEFT_POSITION_10 custom_anim_SPOILERS_LEFT_POSITION_11
  custom_anim_SPOILERS_LEFT_POSITION_13 custom_anim_SPOILERS_LEFT_POSITION_21
  custom_anim_SPOILERS_RIGHT_POSITION_01 custom_anim_SPOILERS_RIGHT_POSITION_05 custom_anim_SPOILERS_RIGHT_POSITION_06
  custom_anim_SPOILERS_RIGHT_POSITION_08 custom_anim_SPOILERS_RIGHT_POSITION_09 custom_anim_SPOILERS_RIGHT_POSITION_11
  custom_anim_SPOILERS_RIGHT_POSITION_12 custom_anim_SPOILERS_RIGHT_POSITION_13 custom_anim_SPOILERS_RIGHT_POSITION_14
  custom_anim_SPOILERS_RIGHT_POSITION_34
  Dash8-100_Spoiler_L Dash8-100_Spoiler_R Dash8-200-300_Spoiler_L Dash8-200-300_Spoiler_R
  Dash8-400_Spoiler_L Dash8-400_Spoiler_R
  HANDLING_Spoilers_Ground HANDLING_Spoilers_l HANDLING_Spoilers_r
  l_spoiler_key r_spoiler_key
  Spoiler_L1 Spoiler_L2 Spoiler_L3L5 Spoiler_L4 Spoiler_R1 Spoiler_R2 Spoiler_R3R5 Spoiler_R4 spoiler_Q_new
  spoilers SPOILERS SPOILERS_left SPOILERS_right SPOLIERS_right SPOLIERS_left
  TFS_777_Spoiler_Inner_L TFS_777_Spoiler_Inner_R TFS_777_Spoiler_Out_L1-3 TFS_777_Spoiler_Out_L2
  TFS_777_Spoiler_Out_L4 TFS_777_Spoiler_Out_LR5 TFS_777_Spoiler_Out_R1-3 TFS_777_Spoiler_Out_R2 TFS_777_Spoiler_Out_R4
  TFS_A380_spoiler_inner TFS_A380_spoiler_L_outer TFS_A380_spoiler_R_outer
  UTT_787_spoiler_l_in UTT_787_spoiler_l_out1 UTT_787_spoiler_l_out2 UTT_787_spoiler_l_out3 UTT_787_spoiler_l_out4
  UTT_787_spoiler_r_in UTT_787_spoiler_r_out1 UTT_787_spoiler_r_out2 UTT_787_spoiler_r_out3 UTT_787_spoiler_r_out4
  UTT_A350_Spoiler_L2 UTT_A350_Spoiler_L3 UTT_A350_Spoiler_LR1 UTT_A350_Spoiler_R2 UTT_A350_Spoiler_R3
`)

const REVERSER = words(`
  custom_anim_REV_THRUST reverse_thrust Reverse_Thrust Reverser REVERSERS thrust_rev_1 thrust_rev_2 engine_rev
  custom_anim_TURB_ENG_REVERSE_NOZZLE_PERCENT_1_39 custom_anim_TURB_ENG_REVERSE_NOZZLE_PERCENT_2_40
`)

const WHEEL_SPIN = words(`
  c_tire c_tire_anim c_tire_blurred_key c_tire_key c_tire_roll c_tire_still_key center_tire_roll
  l_tire l_tire_anim l_tire_blurred_key l_tire_key l_tire_roll l_tire_still_key
  r_tire r_tire_anim r_tire_blurred_key r_tire_key r_tire_roll r_tire_still_key tire_anim
  custom_anim_CENTER_WHEEL_ROTATION_ANGLE_01 custom_anim_CENTER_WHEEL_ROTATION_ANGLE_02
  custom_anim_CENTER_WHEEL_ROTATION_ANGLE_04 custom_anim_CENTER_WHEEL_ROTATION_ANGLE_06
  custom_anim_CENTER_WHEEL_ROTATION_ANGLE_07 custom_anim_CENTER_WHEEL_ROTATION_ANGLE_08
  custom_anim_CENTER_WHEEL_ROTATION_ANGLE_11 custom_anim_CENTER_WHEEL_ROTATION_ANGLE_12
  custom_anim_CENTER_WHEEL_ROTATION_ANGLE_14 custom_anim_CENTER_WHEEL_ROTATION_ANGLE_15
  custom_anim_CENTER_WHEEL_ROTATION_ANGLE_19
  custom_anim_LEFT_WHEEL_ROTATION_ANGLE_01 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_02 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_03
  custom_anim_LEFT_WHEEL_ROTATION_ANGLE_08 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_09 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_10
  custom_anim_LEFT_WHEEL_ROTATION_ANGLE_11 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_12 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_13
  custom_anim_LEFT_WHEEL_ROTATION_ANGLE_17 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_22 custom_anim_LEFT_WHEEL_ROTATION_ANGLE_23
  custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_03 custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_05
  custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_08 custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_09
  custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_10 custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_12
  custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_13 custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_14
  custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_15 custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_19
  custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_35 custom_anim_RIGHT_WHEEL_ROTATION_ANGLE_36
  GEAR_Center_Tire GEAR_Left_Tire GEAR_Right_Tire
  WHEEL_ROLL_center WHEEL_ROLL_left WHEEL_ROLL_right
`)

const GEAR = words(`
  c_gear l_gear r_gear MainGearDoor_EarlyDeploy UTT_787_gear_789EDO
  c_gear_door1 c_gear_door2 f_gear_door_1 f_gear_door_2 l_gear_door l_gear_door1 l_gear_door2 l_gear_door3
  r_gear_door r_gear_door1 r_gear_door2 r_gear_door3
  custom_anim_GEAR_ANIMATION_POSITION_0_00 custom_anim_GEAR_ANIMATION_POSITION_0_03
  custom_anim_GEAR_ANIMATION_POSITION_0_05 custom_anim_GEAR_ANIMATION_POSITION_0_06
  custom_anim_GEAR_ANIMATION_POSITION_0_07 custom_anim_GEAR_ANIMATION_POSITION_0_14
  custom_anim_GEAR_ANIMATION_POSITION_0_17 custom_anim_GEAR_ANIMATION_POSITION_1_00
  custom_anim_GEAR_ANIMATION_POSITION_1_01 custom_anim_GEAR_ANIMATION_POSITION_1_02
  custom_anim_GEAR_ANIMATION_POSITION_1_03 custom_anim_GEAR_ANIMATION_POSITION_1_07
  custom_anim_GEAR_ANIMATION_POSITION_1_08 custom_anim_GEAR_ANIMATION_POSITION_1_09
  custom_anim_GEAR_ANIMATION_POSITION_1_10 custom_anim_GEAR_ANIMATION_POSITION_1_12
  custom_anim_GEAR_ANIMATION_POSITION_1_16 custom_anim_GEAR_ANIMATION_POSITION_1_19
  custom_anim_GEAR_ANIMATION_POSITION_2_02 custom_anim_GEAR_ANIMATION_POSITION_2_04
  custom_anim_GEAR_ANIMATION_POSITION_2_05 custom_anim_GEAR_ANIMATION_POSITION_2_07
  custom_anim_GEAR_ANIMATION_POSITION_2_08 custom_anim_GEAR_ANIMATION_POSITION_2_10
  custom_anim_GEAR_ANIMATION_POSITION_2_11 custom_anim_GEAR_ANIMATION_POSITION_2_12
  custom_anim_GEAR_ANIMATION_POSITION_2_13 custom_anim_GEAR_ANIMATION_POSITION_2_14
  custom_anim_GEAR_ANIMATION_POSITION_2_18 custom_anim_GEAR_ANIMATION_POSITION_2_32
  GEAR_center GEAR_Center GEAR_left GEAR_Left GEAR_right GEAR_Right
  gear_left.002 gear_left_suspension gear_right_suspension gearRight.001
  main_gear_c main_gear_l main_gear_left main_gear_r main_gear_right
  nose_gear nose_gear_1 nose_gear_2 nose_gear_3 nose_gear_4
`)

/** Steering, wheel RPM, tyre contact points, ground-velocity flap swings, roll spoilers and motionless generic clips. */
const NONE = words(`
  custom_anim_C_WHEEL_LR c_wheel c_wheel_key GEAR_STEER GEAR_Steering center_gear_steer front_gear_steer
  nose_steer nose_steering custom_anim_GEAR_CENTER_STEER_ANGLE_03 custom_anim_GEAR_CENTER_STEER_ANGLE_09
  custom_anim_ROTATION_VELOCITY_BODY_Y_08 custom_anim_ROTATION_VELOCITY_BODY_Y_10
  custom_anim_LEFT_WHEEL_RPM_07 custom_anim_RIGHT_WHEEL_RPM_08 custom_anim_CENTER_WHEEL_RPM_09
  fx_tire_contactpoint_center_left fx_tire_contactPoint_center_left fx_tire_contactPoint_center_leftAction
  fx_tire_contactpoint_center_right fx_tire_contactPoint_center_right fx_tire_contactPoint_center_rightAction
  fx_tire_contactpoint_left_in fx_tire_contactPoint_left_in fx_tire_contactPoint_left_in_in
  fx_tire_contactPoint_left_in_out fx_tire_contactPoint_left_inAction
  fx_tire_contactpoint_left_out fx_tire_contactPoint_left_out fx_tire_contactPoint_left_out_in
  fx_tire_contactPoint_left_out_out fx_tire_contactPoint_left_outAction
  fx_tire_contactPoint_rearcenter_lf fx_tire_contactPoint_rearcenter_lr fx_tire_contactPoint_rearcenter_rf
  fx_tire_contactPoint_rearcenter_rr
  fx_tire_contactpoint_right_in fx_tire_contactPoint_right_in fx_tire_contactPoint_right_in_in
  fx_tire_contactPoint_right_in_out fx_tire_contactPoint_right_inAction
  fx_tire_contactpoint_right_out fx_tire_contactPoint_right_out fx_tire_contactPoint_right_out_in
  fx_tire_contactPoint_right_out_out fx_tire_contactPoint_right_outAction
  custom_anim_GROUND_VELOCITY_02 custom_anim_GROUND_VELOCITY_03
  spoiler_UTT787_aileron
  custom_anim_FLAPS_AIRLINER custom_anim_SLATS_AIRLINER Flaps Aileron_L AI_Rudder_wind_deflect
  node123 Cube.004 Cylinder.012
`)

const table: [string, ReturnType<typeof classifyAnimationClip>][] = [
  ...SPOILER.map((n): [string, 'spoiler'] => [n, 'spoiler']),
  ...REVERSER.map((n): [string, 'reverser'] => [n, 'reverser']),
  ...WHEEL_SPIN.map((n): [string, 'wheelSpin'] => [n, 'wheelSpin']),
  ...GEAR.map((n): [string, 'gear'] => [n, 'gear']),
  ...NONE.map((n): [string, null] => [n, null]),
]

describe('classifyAnimationClip', () => {
  it.each(table)('%s is %s', (name, expected) => {
    expect(classifyAnimationClip(name)).toBe(expected)
  })

  it('matches regardless of case', () => {
    expect(classifyAnimationClip('L_SPOILER_KEY')).toBe('spoiler')
    expect(classifyAnimationClip('Custom_Anim_Rev_Thrust')).toBe('reverser')
    expect(classifyAnimationClip('C_TIRE_BLURRED_KEY')).toBe('wheelSpin')
  })

  it('anchors each name: a spoiler, reverser or tyre name inside a longer name is not claimed', () => {
    expect(classifyAnimationClip('l_spoiler_key_extra')).toBe(null)
    expect(classifyAnimationClip('pre_engine_rev')).toBe(null)
    expect(classifyAnimationClip('c_tire_blurred_key_old')).toBe(null)
  })
})

describe('isGearClip', () => {
  it.each(['GEAR_Center_Tire', 'GEAR_Left_Tire', 'GEAR_Right_Tire'])('no longer drives the wheel spin %s', (name) => {
    expect(isGearClip(name)).toBe(false)
  })

  it.each(GEAR)('still drives %s', (name) => {
    expect(isGearClip(name)).toBe(true)
  })

  it.each([...SPOILER, ...REVERSER, ...WHEEL_SPIN, ...NONE])('does not drive %s', (name) => {
    expect(isGearClip(name)).toBe(false)
  })
})
