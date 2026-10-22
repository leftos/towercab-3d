/**
 * GLSL for the cloud and fog post-process stages drawn by `useCesiumWeatherStages`.
 *
 * Both stages work in a local east-north-up frame anchored on the airport's
 * ground (z = meters above the airport). The camera position in that frame is
 * computed on the CPU in double precision and passed as `u_camPosEnu`; ray
 * directions come from Cesium's inverse projection and inverse view.
 *
 * Scene distance per pixel comes from the stage's `depthTexture`. With the
 * logarithmic depth buffer the stage is compiled with LOG_DEPTH, and
 * `czm_windowToEyeCoordinates(vec2, float)` undoes the log encoding and returns
 * an eye position whose w is 1 / depthFromCamera, so xyz / w is the eye-space
 * point. A cleared depth of 1.0 means nothing was drawn (sky).
 */

const COMMON = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec3 u_camPosEnu;
uniform mat3 u_ecefToEnu;
uniform float u_visibility;
uniform float u_fogExtinction;
uniform float u_fogHeightScale;
in vec2 v_textureCoordinates;

const float SKY_DISTANCE = 1.0e6;

float sceneDistance(vec2 uv) {
  float rawDepth = texture(depthTexture, uv).r;
  if (rawDepth >= 1.0) {
    return SKY_DISTANCE;
  }
  // Called through czm_windowToEyeCoordinates: Cesium injects a built-in file only for the
  // name the file is keyed by, and czm_screenToEyeCoordinates lives in that file.
  vec4 eye = czm_windowToEyeCoordinates(uv * czm_viewport.zw + czm_viewport.xy, rawDepth);
  return min(length(eye.xyz / eye.w), SKY_DISTANCE);
}

vec3 viewRayEnu(vec2 uv) {
  vec4 p = czm_inverseProjection * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec3 dirEye = normalize(p.xyz / p.w);
  vec3 dirWc = mat3(czm_inverseView) * dirEye;
  return normalize(u_ecefToEnu * dirWc);
}

vec3 sunEnu() {
  return normalize(u_ecefToEnu * czm_sunDirectionWC);
}

float daylight() {
  return smoothstep(-0.1, 0.25, sunEnu().z);
}

vec3 fogColor() {
  return vec3(0.62, 0.66, 0.70) * (0.08 + 0.92 * daylight());
}

// Length of the segment from ro over distance d along rd that lies below the anchor ground (z < 0).
float fogBelowGroundLength(vec3 ro, vec3 rd, float d) {
  float h1 = ro.z + rd.z * d;
  if (ro.z >= 0.0 && h1 >= 0.0) {
    return 0.0;
  }
  if (ro.z < 0.0 && h1 < 0.0) {
    return d;
  }
  float tGround = -ro.z / rd.z;
  return ro.z < 0.0 ? tGround : d - tGround;
}

// Transmittance of height fog between the camera and distance d along rd.
// Density is (1 / visibility) * exp(-max(height, 0) / u_fogHeightScale): never denser than at
// the anchor ground, so terrain below it is not drowned. Below the ground the density is
// constant; above it the integral is analytic, starting at the camera or at the ground.
float fogTransmittance(vec3 ro, vec3 rd, float d) {
  if (u_visibility <= 0.0) {
    return 1.0;
  }
  float below = fogBelowGroundLength(ro, rd, d);
  float above = d - below;
  float integral = below / u_visibility;
  float base = exp(-max(ro.z, 0.0) / u_fogHeightScale) / u_visibility;
  float k = rd.z / u_fogHeightScale;
  if (abs(k * above) < 1.0e-4) {
    integral += base * above;
  } else {
    integral += base * (1.0 - exp(min(-k * above, 80.0))) / k;
  }
  return exp(-u_fogExtinction * integral);
}
`

export const CLOUD_STAGE_FS = /* glsl */ `
${COMMON}
uniform vec4 u_layer0;
uniform vec4 u_layer1;
uniform vec4 u_layer2;
uniform vec4 u_layer3;
uniform float u_layerCount;
uniform float u_steps;
uniform float u_densityScale;
uniform float u_radius;
uniform float u_time;
// Horizontal position of this frame's origin from a fixed noise origin, in this frame's axes,
// so the noise field stays put horizontally when the anchor moves; vertically it follows the deck.
uniform vec3 u_noiseOffset;

const int MAX_STEPS = 128;

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * valueNoise(p);
    p = p * 2.03 + vec3(17.1, 9.7, 3.3);
    amplitude *= 0.5;
  }
  return sum / 0.9375;
}

// Layer: x = base (m above airport), y = thickness (m), z = coverage (0..1), w = active.
float cloudDensity(vec3 p, vec4 layer) {
  float hf = (p.z - layer.x) / layer.y;
  if (hf < 0.0 || hf > 1.0) {
    return 0.0;
  }
  float edge = 1.0 - smoothstep(u_radius * 0.75, u_radius, length(p.xy));
  if (edge <= 0.0) {
    return 0.0;
  }
  float shape = smoothstep(0.0, 0.12, hf) * (1.0 - smoothstep(0.5, 1.0, hf));
  vec3 world = p + u_noiseOffset;
  vec3 q = vec3(world.xy / 1800.0, world.z / 600.0) + vec3(u_time * 0.004, u_time * 0.002, 0.0);
  // fbm of value noise clusters around 0.5; stretch it so the coverage threshold
  // leaves roughly the reported fraction of sky covered.
  float n = clamp((fbm(q) - 0.3) / 0.4, 0.0, 1.0);
  float overcastBoost = layer.z >= 0.95 ? 0.45 : 0.0;
  float d = clamp((n * shape + layer.z - 1.0) * 3.0 + overcastBoost * shape, 0.0, 1.0);
  return d * edge;
}

vec3 cloudLight(vec3 p, vec4 layer, vec3 sun) {
  float lightStep = layer.y * 0.3;
  float occluder = cloudDensity(p + sun * lightStep, layer);
  float lightT = exp(-occluder * u_densityScale * lightStep * 0.5);
  float hf = clamp((p.z - layer.x) / layer.y, 0.0, 1.0);
  vec3 dark = vec3(0.40, 0.43, 0.50);
  vec3 bright = vec3(1.0, 0.98, 0.95);
  return mix(dark, bright, clamp(0.35 * hf + 0.65 * lightT, 0.0, 1.0)) * (0.08 + 0.92 * daylight());
}

vec4 layerAt(int i) {
  if (i == 0) return u_layer0;
  if (i == 1) return u_layer1;
  if (i == 2) return u_layer2;
  return u_layer3;
}

// Exit distance of the ray from the cylinder of radius u_radius around the airport.
float cylinderExit(vec3 ro, vec3 rd) {
  vec2 o = ro.xy;
  vec2 d = rd.xy;
  float a = dot(d, d);
  if (a < 1.0e-8) {
    return SKY_DISTANCE;
  }
  float b = dot(o, d);
  float c = dot(o, o) - u_radius * u_radius;
  float disc = b * b - a * c;
  if (disc < 0.0) {
    return -1.0;
  }
  return (-b + sqrt(disc)) / a;
}

void marchLayer(vec3 ro, vec3 rd, float tScene, vec4 layer, float jitter, vec3 sun,
                inout float transmittance, inout vec3 color, inout float weightedT, inout float weightSum) {
  float top = layer.x + layer.y;
  float t0;
  float t1;
  if (abs(rd.z) < 1.0e-5) {
    if (ro.z < layer.x || ro.z > top) {
      return;
    }
    t0 = 0.0;
    t1 = SKY_DISTANCE;
  } else {
    float ta = (layer.x - ro.z) / rd.z;
    float tb = (top - ro.z) / rd.z;
    t0 = max(min(ta, tb), 0.0);
    t1 = max(ta, tb);
  }
  t1 = min(t1, min(tScene, cylinderExit(ro, rd)));
  if (t1 <= t0) {
    return;
  }
  float dt = (t1 - t0) / u_steps;
  float t = t0 + dt * jitter;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= u_steps || transmittance < 0.01) {
      break;
    }
    vec3 p = ro + rd * t;
    float density = cloudDensity(p, layer);
    if (density > 0.0) {
      float alpha = 1.0 - exp(-density * u_densityScale * dt);
      float contribution = transmittance * alpha;
      color += contribution * cloudLight(p, layer, sun);
      weightedT += contribution * t;
      weightSum += contribution;
      transmittance *= 1.0 - alpha;
    }
    t += dt;
  }
}

void main() {
  vec2 uv = v_textureCoordinates;
  vec3 ro = u_camPosEnu;
  vec3 rd = viewRayEnu(uv);
  float tScene = sceneDistance(uv);
  vec3 sun = sunEnu();
  float jitter = hash13(vec3(gl_FragCoord.xy, fract(u_time) * 97.0));

  float transmittance = 1.0;
  vec3 color = vec3(0.0);
  float weightedT = 0.0;
  float weightSum = 0.0;
  int count = int(u_layerCount);
  // Layers arrive sorted by base, lowest first; march them in the order the ray meets them.
  for (int k = 0; k < 4; k++) {
    if (k >= count) {
      break;
    }
    int i = rd.z >= 0.0 ? k : count - 1 - k;
    marchLayer(ro, rd, tScene, layerAt(i), jitter, sun, transmittance, color, weightedT, weightSum);
  }

  float alpha = 1.0 - transmittance;
  if (weightSum > 0.0) {
    float fogT = fogTransmittance(ro, rd, weightedT / weightSum);
    color = color * fogT + fogColor() * (1.0 - fogT) * alpha;
  }
  out_FragColor = vec4(color, alpha);
}
`

export const WEATHER_COMPOSITE_FS = /* glsl */ `
${COMMON}
uniform sampler2D cloudTexture;

void main() {
  vec2 uv = v_textureCoordinates;
  vec4 scene = texture(colorTexture, uv);
  vec4 cloud = texture(cloudTexture, uv);
  float fogT = fogTransmittance(u_camPosEnu, viewRayEnu(uv), sceneDistance(uv));
  vec3 fogged = mix(fogColor(), scene.rgb, fogT);
  out_FragColor = vec4(fogged * (1.0 - cloud.a) + cloud.rgb, scene.a);
}
`
