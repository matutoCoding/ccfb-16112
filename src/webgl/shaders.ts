export const depthVertexShader = `#version 300 es
layout(location=0) in vec3 aPosition;
uniform mat4 uVP;
void main() {
  gl_Position = uVP * vec4(aPosition, 1.0);
}
`;

export const depthFragmentShader = `#version 300 es
precision highp float;
out vec4 outColor;
vec4 encodeDepth(float v) {
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * clamp(v, 0.0, 1.0);
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
  return enc;
}
void main() {
  outColor = encodeDepth(gl_FragCoord.z);
}
`;

export const mainVertexShader = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vColor;
void main() {
  vWorld = aPosition;
  vNormal = aNormal;
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const mainFragmentShader = `#version 300 es
precision highp float;
#define MAXP 4

in vec3 vWorld;
in vec3 vNormal;
in vec3 vColor;
out vec4 outColor;

uniform mat4 uProjVP[MAXP];
uniform sampler2D uDepth0;
uniform sampler2D uDepth1;
uniform sampler2D uDepth2;
uniform sampler2D uDepth3;
uniform sampler2D uSlide0;
uniform sampler2D uSlide1;
uniform sampler2D uSlide2;
uniform sampler2D uSlide3;
uniform vec3 uEye[MAXP];
uniform vec2 uBlendUv[MAXP];
uniform float uLumens[MAXP];
uniform float uThrow[MAXP];
uniform float uAspect[MAXP];
uniform float uNativeContrast[MAXP];
uniform float uPower[MAXP];
uniform int uProjCount;

uniform vec3 uCameraPos;
uniform float uAmbientLux;
uniform float uContrastThreshold;
uniform float uTime;
uniform int uHeatmap;

vec4 encodeDepth(float v) {
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * clamp(v, 0.0, 1.0);
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
  return enc;
}
float decodeDepth(vec4 rgba) {
  return clamp(dot(rgba, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0)), 0.0, 1.0);
}
vec4 sampleDepth(int i, vec2 uv) {
  if (i == 0) return texture(uDepth0, uv);
  if (i == 1) return texture(uDepth1, uv);
  if (i == 2) return texture(uDepth2, uv);
  return texture(uDepth3, uv);
}
vec4 sampleSlide(int i, vec2 uv) {
  if (i == 0) return texture(uSlide0, uv);
  if (i == 1) return texture(uSlide1, uv);
  if (i == 2) return texture(uSlide2, uv);
  return texture(uSlide3, uv);
}
float projectorContrast(int i, vec3 wp) {
  float d = max(200.0, distance(uEye[i], wp));
  float widthMm = d / max(0.1, uThrow[i]);
  float heightMm = widthMm / max(0.1, uAspect[i]);
  float areaM2 = max(0.2, widthMm * heightMm / 1000000.0);
  float lux = uLumens[i] * 0.72 / areaM2;
  float blackFloor = lux / max(100.0, uNativeContrast[i]);
  return (uAmbientLux + lux) / max(1.0, uAmbientLux + blackFloor);
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(vec3(-0.28, -0.38, 0.88));
  float diff = max(dot(N, L), 0.0);
  float hemi = 0.5 + 0.5 * N.z;
  float ambient = 0.10 + 0.46 * clamp(uAmbientLux / 900.0, 0.0, 1.0);
  vec3 base = vColor * (ambient + 0.48 * diff + 0.10 * hemi);
  // 黑色板面保留一点点环境反光，避免死黑
  base += vec3(0.012, 0.014, 0.018) * (1.0 - clamp(length(vColor), 0.0, 1.0));

  vec3 guideSum = vec3(0.0);
  float guideWeight = 0.0;
  float bestContrast = 0.0;
  float anyCoverage = 0.0;

  for (int i = 0; i < MAXP; i++) {
    if (i >= uProjCount) break;
    vec4 clip = uProjVP[i] * vec4(vWorld, 1.0);
    if (clip.w <= 1.0) continue;
    vec3 ndc = clip.xyz / clip.w;
    if (abs(ndc.x) > 1.02 || abs(ndc.y) > 1.02 || ndc.z < -1.0 || ndc.z > 1.0) continue;

    vec2 uv = ndc.xy * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;

    float stored = decodeDepth(sampleDepth(i, uv));
    float currentDepth = ndc.z * 0.5 + 0.5;
    float slopeBias = 0.00045 + 0.0011 * (1.0 - abs(dot(N, normalize(uEye[i] - vWorld))));
    bool projectorLit = currentDepth <= stored + slopeBias;
    if (!projectorLit) continue;

    vec2 edge = min(uv, vec2(1.0) - uv);
    float wx = smoothstep(0.0, max(0.001, uBlendUv[i].x), edge.x);
    float wy = smoothstep(0.0, max(0.001, uBlendUv[i].y), edge.y);
    float w = wx * wy;
    anyCoverage = max(anyCoverage, w);

    float cr = projectorContrast(i, vWorld);
    bestContrast = max(bestContrast, cr);

    vec4 slide = sampleSlide(i, uv);
    vec3 guide = slide.rgb * slide.a;
    guideSum += guide * w * uPower[i];
    guideWeight += w;
  }

  vec3 color = base;
  if (guideWeight > 0.001) {
    vec3 guideColor = guideSum / max(guideWeight, 0.85);
    color += guideColor * 1.65;
  }

  if (uHeatmap == 1) {
    float pulse = 0.72 + 0.28 * sin(uTime * 0.006);
    vec3 good = vec3(0.0, 0.85, 0.42);
    vec3 bad = vec3(1.0, 0.06, 0.16);
    float ratio = clamp(bestContrast / max(0.1, uContrastThreshold), 0.0, 1.35);
    vec3 heat = mix(bad, vec3(1.0, 0.78, 0.05), smoothstep(0.0, 0.82, ratio));
    heat = mix(heat, good, smoothstep(0.82, 1.08, ratio));
    float alpha = bestContrast >= uContrastThreshold ? 0.20 : (0.42 + 0.18 * pulse);
    color = mix(color, heat, alpha);
  }

  // 轻微距离雾，增强工位纵深感
  float camD = distance(uCameraPos, vWorld);
  float fog = smoothstep(4200.0, 8200.0, camD);
  color = mix(color, vec3(0.035, 0.055, 0.085), fog * 0.55);
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

export const lineVertexShader = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const lineFragmentShader = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, 0.92);
}
`;
