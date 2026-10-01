/**
 * GPU side of the hex world.
 *
 * Hexes are drawn as instanced prisms with a single ShaderMaterial. Outlines
 * are computed per-pixel from a hex distance field (constant pixel width at
 * any zoom, zero extra geometry). Props are instanced line segments.
 */
import { Color, ShaderMaterial, Vector2, Vector3 } from "three";


import { HEIGHT_GLSL } from "./heights";

/** Uniforms shared by every level material (same objects, updated once per frame). */
export const sharedUniforms = {
  uTime: { value: 0 },
  uVScale: { value: 10 },
  uFocus: { value: new Vector2() },
  uRadius: { value: 1000 },
  /** xz + active flag */
  uHover: { value: new Vector3(0, 0, 0) },
  uSelect: { value: new Vector3(0, 0, 0) },
  /** Vertical scale for buildings (kept milder than terrain exaggeration). */
  uBScale: { value: 2 },
  /** Camera + orbit target: hexes between them turn to outlines (x-ray). */
  uCam: { value: new Vector3() },
  uTarget: { value: new Vector3() },
  /** Theme: 0 = dark (light on black), 1 = light (ink on paper). uBg = background, linear RGB. */
  uLight: { value: 0 },
  uBg: { value: new Vector3(0, 0, 0) },
};

export function linear(hex: string): Vector3 {
  const c = new Color(hex);
  return new Vector3(c.r, c.g, c.b);
}

/** Shared fragment helpers: theme-aware final colour. */
const COMMON_FRAG = /* glsl */ `
uniform float uLight;
uniform vec3 uBg;
// Dark theme: emissive lines on black. Light theme: the same design as ink on paper —
// the dark-theme brightness becomes ink coverage, hue kept, darkened for contrast.
vec3 themed(vec3 col, float fade) {
  if (uLight < 0.5) return col * fade;
  float m = max(max(col.r, col.g), col.b);
  vec3 hue = m > 1e-4 ? col / m : vec3(0.0);
  vec3 ink = hue * 0.42;
  float amount = clamp(m * 1.5, 0.0, 1.0);
  return mix(uBg, mix(uBg, ink, amount), fade);
}
`;

export interface LevelUniforms {
  uSize: { value: number };
  uGap: { value: number };
  uLevelAlpha: { value: number };
}

const COMMON_VERT = /* glsl */ `
${HEIGHT_GLSL}
uniform float uTime;
uniform vec2 uFocus;
uniform float uRadius;
uniform float uLevelAlpha;
uniform vec3 uHover;
uniform vec3 uSelect;

float easeOut(float t) { t = clamp(t, 0.0, 1.0); return 1.0 - pow(1.0 - t, 3.0); }

// Spawn + view-ring factor: 0 = collapsed, 1 = fully present.
float presence(vec2 xz, float born, float seed, out float ringFade) {
  float d = length(xz - uFocus);
  ringFade = 1.0 - smoothstep(uRadius * 0.72, uRadius, d);
  float grow = easeOut((uTime - born - seed * 0.25 - (d / uRadius) * 0.35) / 0.5);
  return grow * uLevelAlpha * smoothstep(0.0, 0.25, ringFade);
}

float highlight(vec2 xz) {
  float h = uHover.z * step(length(xz - uHover.xy), uSize * 0.5);
  float s = uSelect.z * step(length(xz - uSelect.xy), uSize * 0.5);
  return max(h * 0.6, s);
}
`;

export function createHexMaterial(level: LevelUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...sharedUniforms, ...level },
    vertexShader: /* glsl */ `
      ${COMMON_VERT}
      uniform float uGap;
      attribute vec3 aPos;    // x, z, elevation (km)
      attribute vec4 aLine;   // outline colour (linear) + emphasis
      attribute vec2 aEdges;  // 6-bit masks: region-boundary edges, contour (step-down) edges
      attribute vec4 aStyle;  // fill, pulse, lift, pattern
      attribute vec2 aMeta;   // born time, seed
      attribute float aFace;  // 0 = top, 1 = side
      attribute vec2 aUV;

      varying vec3 vLine;
      varying vec4 vStyle;
      varying vec2 vLocal;
      varying vec2 vUV;
      varying float vFace;
      varying float vFade;
      varying float vHL;
      varying float vSeed;
      varying float vShade;
      varying vec2 vEdges;
      varying vec3 vW;

      void main() {
        float ring;
        float s = presence(aPos.xy, aMeta.x, aMeta.y, ring);
        if (s < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float top = hexTop(aPos.z, aStyle.z);
        vec3 w;
        w.xz = aPos.xy + position.xz * uSize * uGap * mix(0.35, 1.0, s);
        w.y = position.y * top * s;
        vLine = aLine.rgb * aLine.a;
        vEdges = aEdges;
        vStyle = aStyle;
        vLocal = position.xz;
        vUV = aUV;
        vFace = aFace;
        vFade = ring * uLevelAlpha;
        vHL = highlight(aPos.xy);
        vSeed = aMeta.y;
        vShade = aFace > 0.5 ? 0.35 + 0.65 * max(0.0, dot(normal, normalize(vec3(-0.45, 0.0, 0.9)))) : 1.0;
        vW = w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_FRAG}
      uniform float uTime;
      uniform float uSize;
      uniform vec3 uCam;
      uniform vec3 uTarget;
      varying vec3 vW;
      varying vec3 vLine;
      varying vec4 vStyle;
      varying vec2 vLocal;
      varying vec2 vUV;
      varying float vFace;
      varying float vFade;
      varying float vHL;
      varying float vSeed;
      varying float vShade;
      varying vec2 vEdges;

      float bit(float mask, float k) { return mod(floor(mask / exp2(k) + 0.5 / 64.0), 2.0); }
      // Edge strength: region boundary = 1, terrace step (contour) = 0.55, interior = faint.
      float edgeWeight(float k) { return max(bit(vEdges.x, k), bit(vEdges.y, k) * 0.55); }

      // Anti-aliased line of ~constant pixel width. Fades out once a line would be
      // wider than the face can hold (grazing angles / tiny hexes) to avoid glare.
      float aaLine(float d, float width) {
        float fw = max(fwidth(d), 1e-5);
        float cover = clamp(0.045 / fw, 0.0, 1.0);
        return (1.0 - smoothstep(fw * (width - 0.5), fw * (width + 0.8), d)) * cover;
      }
      float repLine(float t, float width) {
        float f = fract(t);
        return aaLine(min(f, 1.0 - f), width);
      }

      float pattern(int kind, vec2 p) {
        if (kind == 1) return repLine(p.x * 2.6 + p.y * 1.5, 0.6);                         // stripes
        if (kind == 2) { vec2 g = fract(p * 3.2) - 0.5; return aaLine(length(g) - 0.04, 1.0); } // dots
        if (kind == 3) return repLine(p.y * 3.0 + sin(p.x * 7.0 + uTime * 0.7) * 0.18, 0.6); // waves
        if (kind == 4) return max(repLine(p.x * 3.5, 0.5), repLine(p.y * 3.5, 0.5));       // grid
        if (kind == 5) {                                                                     // ice: cracked crosshatch
          float a = repLine(p.x * 2.1 + p.y * 1.2, 0.55), b = repLine(p.x * 1.4 - p.y * 2.3 + 0.37, 0.55);
          return max(a, b * 0.8);
        }
        return 0.0;
      }

      // 1 when this fragment actually blocks the view: it lies between camera and target,
      // near the sight line, and rises ABOVE it (flat ground in front of the target never does).
      float occluder() {
        vec3 d = uTarget - uCam;
        float L = length(d);
        vec3 dir = d / max(L, 1e-4);
        float t = dot(vW - uCam, dir);
        vec3 p = uCam + dir * t;
        float r = length(vW.xz - p.xz);
        float R = max(uSize * 1.5, L * 0.06);
        float above = step(p.y + uSize * 0.05, vW.y);
        return step(0.0, t) * step(t, L - uSize * 2.0) * above * (1.0 - smoothstep(R * 0.6, R, r));
      }

      float segDist(vec2 p, vec2 a, vec2 b, out float t) {
        vec2 ab = b - a;
        t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
        return length(p - a - ab * t);
      }
      void main() {
        float xray = occluder();
        float pulseWave = 0.5 + 0.5 * sin(uTime * 3.4 + vSeed * 6.2831);
        bool top = vFace < 0.5;

        // ---- Shared ingredients (0..1 amounts), composed per theme below.
        float line = 0.0;     // outline / edge ink
        float pat = 0.0;      // surface pattern
        if (top) {
          // Pointy-top hex distance field: 0 at centre, 0.866 at edge midpoints.
          vec2 p = abs(vLocal);
          float edge = 0.8660254 - max(p.x, dot(p, vec2(0.5, 0.8660254)));
          // Nearest edge k: boundary edges strong, contour steps medium, interior faint —
          // same-type clusters read as single shapes (forests, towns, rivers, fire fronts).
          float k = floor(mod(atan(vLocal.y, vLocal.x) + 0.5235988, 6.2831853) / 1.0471976);
          float b = edgeWeight(k);
          float density = clamp((fwidth(vLocal.x) - 0.04) * 5.0, 0.0, 1.0);
          line = aaLine(edge, mix(0.8, 1.5, b)) * mix(0.09, 1.0, b) + density * 0.12;
          float detail = 1.0 - smoothstep(0.012, 0.03, fwidth(vLocal.x)); // patterns only when close
          pat = pattern(int(vStyle.w + 0.5), vLocal) * detail * step(0.14, edge);
        } else {
          // Side face k sits under top edge k.
          float k = floor(mod(atan(vLocal.y, vLocal.x) + 0.5235988, 6.2831853) / 1.0471976);
          float b = edgeWeight(k);
          line = aaLine(min(vUV.x, 1.0 - vUV.x), 0.8) * 0.12 * vShade + aaLine(1.0 - vUV.y, 1.0) * mix(0.08, 0.7, b);
        }
        // X-ray: terrain in front of the target keeps only its outlines, so what's behind stays visible.
        if (xray > 0.5 && line < 0.06) discard;
        float solid = 1.0 - xray;

        vec3 col;
        if (uLight < 0.5) {
          // DARK — emissive lines on black; fill is a faint glow of the line colour.
          float fill = vStyle.x * 0.3;
          col = top ? vLine * (fill * solid + pat * 0.08 * solid + line)
                    : vLine * (fill * 0.3 * vShade * solid + line);
          if (top) col *= 1.0 + vStyle.y * pulseWave * 1.1;
          col += vLine * vHL * (top ? 0.35 : 0.15);
          gl_FragColor = vec4(col * vFade, 1.0);
        } else {
          // LIGHT — cartographic: soft tinted land, darker walls for depth, ink outlines.
          float m = max(max(vLine.r, vLine.g), vLine.b);
          vec3 hue = vLine / max(m, 1e-4);            // colour without brightness
          // Near-white types (roads, snow) would vanish on paper: draw them as grey instead.
          float sat = 1.0 - min(min(hue.r, hue.g), hue.b);
          hue = mix(vec3(0.42, 0.46, 0.5), hue, smoothstep(0.08, 0.25, sat));
          float strength = clamp(m * 1.6, 0.35, 1.0);  // unfocused regions / quiet types fade toward paper
          float tintAmt = (0.24 + vStyle.x * 1.3) * strength;   // hazards fill strongly
          if (top) tintAmt *= 1.0 + vStyle.y * pulseWave * 0.5;
          vec3 face = mix(uBg, hue * 0.8 + 0.12, clamp(tintAmt, 0.0, 0.85));
          if (!top) face *= 0.62 + 0.24 * vShade;      // shaded walls read as columns
          face = mix(uBg, face, solid);
          vec3 ink = hue * 0.3;
          col = mix(face, ink, clamp(line * 1.1 * strength, 0.0, 1.0));
          col = mix(col, ink, pat * 0.12 * strength * solid);
          col = mix(col, hue * 0.5, vHL * (top ? 0.25 : 0.12));
          gl_FragColor = vec4(mix(uBg, col, vFade), 1.0);
        }
      }
    `,
  });
}

export function createPropMaterial(level: LevelUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...sharedUniforms, ...level },
    vertexShader: /* glsl */ `
      ${COMMON_VERT}
      attribute vec3 aPos;    // hex x, z, elevation (km)
      attribute vec4 aOff;    // local dx, dz (hex units), scale, rotation
      attribute vec3 aColor;
      attribute vec3 aMeta;   // born, seed, lift
      varying vec3 vColor;
      varying float vFade;
      varying float vSeed;
      void main() {
        float ring;
        float s = presence(aPos.xy, aMeta.x, aMeta.y, ring);
        if (s < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float c = cos(aOff.w), sn = sin(aOff.w);
        vec3 p = position * aOff.z * uSize * 0.17;
        p.xz = mat2(c, -sn, sn, c) * p.xz;
        vec3 w;
        w.xz = aPos.xy + aOff.xy * uSize + p.xz;
        w.y = hexTop(aPos.z, aMeta.z) * s + p.y * s;
        vColor = aColor;
        vFade = ring * uLevelAlpha;
        vSeed = aMeta.y;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_FRAG}
      varying vec3 vColor;
      varying float vFade;
      varying float vSeed;
      void main() {
        gl_FragColor = vec4(themed(vColor * 0.5, vFade), 1.0);
      }
    `,
  });
}

export function createBuildingMaterial(level: LevelUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...sharedUniforms, ...level },
    vertexShader: /* glsl */ `
      ${COMMON_VERT}
      uniform float uBScale;
      attribute vec3 aPos;    // x, z, hex elevation (km)
      attribute vec3 aDim;    // footprint w, d (km), height (km)
      attribute vec3 aColor;
      attribute vec3 aMeta;   // born, seed, lift
      varying vec3 vColor;
      varying float vFade;
      void main() {
        float ring;
        float s = presence(aPos.xy, aMeta.x, aMeta.y, ring);
        if (s < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec3 w;
        w.xz = aPos.xy + position.xz * aDim.xy;
        w.y = hexTop(aPos.z, aMeta.z) * s + position.y * aDim.z * uBScale * s;
        vColor = aColor;
        vFade = ring * uLevelAlpha;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_FRAG}
      varying vec3 vColor;
      varying float vFade;
      void main() { gl_FragColor = vec4(themed(vColor, vFade), 1.0); }
    `,
  });
}
