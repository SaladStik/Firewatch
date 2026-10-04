/**
 * GPU side of the hex world.
 *
 * Hexes are drawn as instanced prisms with a single ShaderMaterial. Outlines
 * are computed per-pixel from a hex distance field (constant pixel width at
 * any zoom, zero extra geometry). Props are instanced line segments.
 */
import { Color, DataTexture, LinearFilter, RGFormat, ShaderMaterial, Vector2, Vector3, Vector4 } from "three";


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
  /** Screen pixels per km at 1 km from the camera (viewport height / 2·tan(fov/2)). */
  uPxPerKm: { value: 1400 },
  /** Camera + orbit target: hexes between them turn to outlines (x-ray). */
  uCam: { value: new Vector3() },
  uTarget: { value: new Vector3() },
  /** Theme: 0 = dark (night ops), 1 = light (cartographic). uBg = background, linear RGB. */
  uLight: { value: 0 },
  uBg: { value: new Vector3(0, 0, 0) },
  /** Rain intensity over the view (render/RainParticles.ts): tints wet hex tops blue. */
  uRainTex: { value: emptyRainTex() },
  /** Rain texture placement: x0, z0, size (km), on (0/1). */
  uRain: { value: new Vector4(0, 0, 1, 0) },
  /** Dev: Ctrl+Shift+D tints hexes by detail level and stand-in chunks magenta (render/Scene.ts). */
  uDebug: { value: 0 },
  /** Reveal circle (the pitch page): only the map within radius z of (x, y) is drawn; z = 0 = everything. */
  uReveal: { value: new Vector3(0, 0, 0) },
};

function emptyRainTex() {
  const t = new DataTexture(new Uint8Array([0, 0]), 1, 1, RGFormat);
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** Precipitation texture for the hex shader (size×size, filtered so it blends smoothly): R = rain, G = snow. */
export function makeRainTexture(size: number, data: Uint8Array) {
  const t = new DataTexture(data, size, size, RGFormat);
  t.unpackAlignment = 1;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function linear(hex: string): Vector3 {
  const c = new Color(hex);
  return new Vector3(c.r, c.g, c.b);
}

/** Shared fragment helpers: theme-aware final colour. */
const COMMON_FRAG = /* glsl */ `
uniform float uLight;
uniform vec3 uBg;
// Dark theme: emissive lines on black. Light theme: the same design as ink on paper —
// neutral lines (buildings) print charcoal, coloured ones a deep shade of their own hue.
vec3 themed(vec3 col, float fade) {
  if (uLight < 0.5) return col * fade;
  float m = max(max(col.r, col.g), col.b);
  vec3 hue = m > 1e-4 ? col / m : vec3(0.0);
  float sat = 1.0 - min(min(hue.r, hue.g), hue.b);
  vec3 ink = hue * mix(0.035, 0.22, sat);
  float amount = clamp(m * 1.5, 0.0, 1.0);
  return mix(uBg, mix(uBg, ink, amount), fade);
}
`;

export interface LevelUniforms {
  uSize: { value: number };
  uGap: { value: number };
  uLevelAlpha: { value: number };
  /** This level's ring: centre + outer radius, and the finer ring it surrounds (its hole). */
  uFocusL: { value: Vector2 };
  uRadius: { value: number };
  uInnerFocus: { value: Vector2 };
  uInnerRadius: { value: number };
  /** Which detail level this is (debug tint). */
  uLevelIdx: { value: number };
}

const COMMON_VERT = /* glsl */ `
${HEIGHT_GLSL}
uniform float uTime;
uniform vec2 uFocusL;
uniform float uRadius;
uniform vec2 uInnerFocus;
uniform float uInnerRadius;
uniform float uHoleOn;
uniform float uLevelAlpha;
uniform vec3 uHover;
uniform vec3 uSelect;
uniform vec3 uReveal;

float easeOut(float t) { t = clamp(t, 0.0, 1.0); return 1.0 - pow(1.0 - t, 3.0); }

// Spawn + view-ring factor: 0 = collapsed, 1 = fully present.
float presence(vec2 xz, float born, float seed, out float ringFade) {
  float d = length(xz - uFocusL);
  ringFade = 1.0 - smoothstep(uRadius * 0.82, uRadius, d);
  // Outside the reveal circle the map isn't there yet: it rises in as the circle widens.
  if (uReveal.z > 0.0) ringFade *= 1.0 - smoothstep(uReveal.z * 0.8, uReveal.z, length(xz - uReveal.xy));
  // Coarser rings leave a hole where the finer ring is drawn (unless standing in while it loads).
  if (uHoleOn > 0.5 && uInnerRadius > 0.0 && length(xz - uInnerFocus) < uInnerRadius * 0.9) { ringFade = 0.0; return 0.0; }
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
    uniforms: { ...sharedUniforms, ...level, uHoleOn: { value: 1 } },
    vertexShader: /* glsl */ `
      ${COMMON_VERT}
      uniform float uGap;
      attribute vec3 aPos;    // x, z, elevation (km)
      attribute vec4 aLine;   // outline colour (linear) + emphasis
      attribute vec2 aEdges;  // 6-bit masks: region-boundary edges, contour (step-down) edges
      attribute vec4 aStyle;  // fill, pulse, lift, pattern
      attribute vec2 aMeta;   // born time, seed
      attribute float aFace;  // 0 = top, 1 = side
      attribute float aSide;  // -1 = top; 0..5 = which wall (instanced)
      attribute vec2 aFloor;  // walls: neighbour's elevation (km) + lift on that side; x < 0 = unknown (down to 0)
      attribute vec2 aUV;

      varying vec3 vLine;
      varying float vEmph;
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
        // Walls are instanced per visible wall: rotate the side-0 quad to side aSide.
        vec3 P = position, N = normal;
        if (aSide >= 0.0) {
          float ang = aSide * 1.0471976, c = cos(ang), sn = sin(ang);
          mat2 rot = mat2(c, sn, -sn, c);
          P.xz = rot * P.xz;
          N.xz = rot * N.xz;
        }
        vec3 w;
        w.xz = aPos.xy + P.xz * uSize * uGap * mix(0.35, 1.0, s);
        // A wall only spans down to the neighbour's top on that side (it would otherwise run on
        // below the surface and show through the hairline gaps between hexes).
        float floorY = aSide >= 0.0 && aFloor.x >= 0.0 ? min(hexTop(aFloor.x, aFloor.y), top) : 0.0;
        w.y = mix(floorY, top, P.y) * s;
        vLine = aLine.rgb * aLine.a;
        vEmph = aLine.a;
        vEdges = aEdges;
        vStyle = aStyle;
        vLocal = P.xz;
        vUV = aUV;
        vFace = aFace;
        vFade = ring * uLevelAlpha;
        vHL = highlight(aPos.xy);
        vSeed = aMeta.y;
        vShade = aFace > 0.5 ? 0.35 + 0.65 * max(0.0, dot(N, normalize(vec3(-0.45, 0.0, 0.9)))) : 1.0;
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
      uniform sampler2D uRainTex;
      uniform vec4 uRain;
      uniform float uDebug;
      uniform float uLevelIdx;
      uniform float uHoleOn;
      // Dev view: each detail level its own colour; chunks standing in for unloaded finer ones magenta.
      vec3 debugTint(vec3 c) {
        if (uDebug < 0.5) return c;
        int l = int(uLevelIdx + 0.5);
        vec3 k = l == 0 ? vec3(0.6, 0.6, 0.6) : l == 1 ? vec3(0.3, 0.4, 1.0) : l == 2 ? vec3(0.2, 1.0, 0.3) : l == 3 ? vec3(1.0, 0.2, 0.2) : l == 4 ? vec3(1.0, 0.9, 0.1) : vec3(0.1, 0.9, 1.0);
        c = mix(c, k * 0.6, 0.55);
        return uHoleOn < 0.5 ? mix(c, vec3(1.0, 0.0, 1.0), 0.5) : c;
      }
      varying vec3 vW;
      varying vec3 vLine;
      varying float vEmph;
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
        // Soft edges on every side, so the see-through zone never reads as a box.
        float above = smoothstep(p.y - uSize * 0.5, p.y + uSize * 2.0, vW.y);
        float along = smoothstep(0.0, L * 0.08, t) * (1.0 - smoothstep(L - uSize * 8.0, L - uSize * 2.0, t));
        return along * above * (1.0 - smoothstep(R * 0.45, R, r));
      }

      float segDist(vec2 p, vec2 a, vec2 b, out float t) {
        vec2 ab = b - a;
        t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
        return length(p - a - ab * t);
      }
      float rainAt(vec2 xz) {
        if (uRain.w < 0.5) return 0.0;
        vec2 uv = (xz - uRain.xy) / uRain.z;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
        return smoothstep(0.02, 0.6, texture2D(uRainTex, uv).r);
      }
      float snowAt(vec2 xz) {
        if (uRain.w < 0.5) return 0.0;
        vec2 uv = (xz - uRain.xy) / uRain.z;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
        return smoothstep(0.02, 0.6, texture2D(uRainTex, uv).g);
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
          // Interior edges (same type, same height) only show when each hex is big on screen;
          // further out a uniform area reads as one surface.
          float interior = 0.04 * (1.0 - smoothstep(0.012, 0.03, fwidth(vLocal.x)));
          // Terrace (contour) steps fade once a hex is only a few pixels across — at that size
          // they're sub-pixel speckle, not information. Region borders (b = 1) always stay.
          float fwl = fwidth(vLocal.x);
          float small = smoothstep(0.07, 0.16, fwl);
          b = b >= 0.99 ? b : b * (1.0 - small);
          line = aaLine(edge, mix(0.8, 1.5, b)) * mix(interior, 1.0, b) + density * 0.12 * b;
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
          // DARK — filled land cover on a dark ops background; outlines stay quiet.
          float fill = 0.22 + vStyle.x * 0.7;
          col = top ? mix(uBg, vLine, fill * solid) + vLine * (pat * 0.08 * solid + line)
                    : mix(uBg, vLine * (0.45 + 0.4 * vShade), fill * 0.85 * solid) + vLine * line;
          if (top) col *= 1.0 + vStyle.y * pulseWave * 0.35;
          col += vLine * vHL * (top ? 0.22 : 0.1);
          float wetK = rainAt(vW.xz);
          if (top) col = mix(col, vec3(0.2, 0.45, 0.95) * (0.55 + 0.45 * vStyle.x), wetK * 0.55);
          if (top) col = mix(col, vec3(0.62, 0.68, 0.75), snowAt(vW.xz) * 0.5); // snowing: a cold white wash
          gl_FragColor = vec4(debugTint(col * vFade), 1.0);
        } else {
          // LIGHT — a printed map: each land class a clear tint of its own colour on paper,
          // relief shaded like a hillshade (walls darker than tops), and the status colours
          // (danger, fire, projection) printed near full strength so they own the page.
          vec3 hue = clamp(vLine / max(vEmph, 1e-3), 0.0, 1.0);
          vec3 hueS = sqrt(hue), paperS = vec3(0.87, 0.885, 0.85); // map paper (~sRGB, mixing in ~sRGB)
          float status = clamp(vStyle.y, 0.0, 1.0);           // pulse: 0 for land cover
          float ink = status > 0.01 ? mix(0.88, 1.0, status) : mix(0.66, 0.95, clamp(vStyle.x, 0.0, 1.0));
          ink *= clamp(vEmph, 0.6, 1.0);                       // unfocused regions print paler
          if (top) ink = min(1.0, ink * (1.0 + status * pulseWave * 0.12));
          vec3 face = mix(paperS, hueS, ink);
          face *= face;
          if (!top) face *= 0.58 + 0.32 * vShade;
          face = mix(uBg, face, solid);
          vec3 edgeInk = face * 0.42;
          col = mix(face, edgeInk, clamp(line * 0.75, 0.0, 0.75));
          col = mix(col, edgeInk, pat * 0.16 * solid);
          col = mix(col, face * 0.55, vHL * (top ? 0.4 : 0.15));
          if (top) col = mix(col, vec3(0.03, 0.17, 0.62), rainAt(vW.xz) * 0.5);
          if (top) col = mix(col, vec3(0.93, 0.95, 0.98), snowAt(vW.xz) * 0.6);
          gl_FragColor = vec4(debugTint(mix(uBg, col, vFade)), 1.0);
        }
      }
    `,
  });
}

export function createPropMaterial(level: LevelUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...sharedUniforms, ...level, uHoleOn: { value: 1 } },
    vertexShader: /* glsl */ `
      ${COMMON_VERT}
      attribute vec3 aPos;    // hex x, z, elevation (km)
      uniform float uPxPerKm;
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
        // Props under a few screen pixels read as speckle noise — shrink them out.
        float px = aOff.z * uSize * 0.34 / max(distance(cameraPosition, vec3(aPos.x, 0.0, aPos.y)), 0.01) * uPxPerKm;
        float vis = smoothstep(2.0, 4.0, px);
        if (vis < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        s *= vis;
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
    uniforms: { ...sharedUniforms, ...level, uHoleOn: { value: 1 } },
    vertexShader: /* glsl */ `
      ${COMMON_VERT}
      uniform float uBScale;
      uniform float uPxPerKm;
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
        // Buildings smaller than a couple of screen pixels are just noise (speckle) — shrink them out.
        float bSize = max(max(aDim.x, aDim.y), aDim.z * uBScale);
        float px = bSize / max(distance(cameraPosition, vec3(aPos.x, 0.0, aPos.y)), 0.01) * uPxPerKm;
        float vis = smoothstep(1.6, 3.2, px);
        if (vis < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        s *= vis;
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
