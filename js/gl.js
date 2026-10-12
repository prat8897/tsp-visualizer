// Small WebGL 1 renderer: anti-aliased thick/dashed lines, triangles and round markers.
// Everything is rebuilt into two vertex batches each frame, then drawn in two calls.

const LINE_VS = `
attribute vec2 a_pos;
attribute vec4 a_col;
attribute vec3 a_dash;   // distance along line, dash length, gap length (0 = solid)
attribute vec2 a_tw;     // across-line coordinate -1..1, half width incl. 1px AA margin (0 = fill)
uniform vec2 u_res;
varying vec4 v_col; varying vec3 v_dash; varying vec2 v_tw;
void main() {
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_col = a_col; v_dash = a_dash; v_tw = a_tw;
}`;

const LINE_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 v_col; varying vec3 v_dash; varying vec2 v_tw;
void main() {
  float a = v_col.a;
  if (v_tw.y > 0.0) {
    float dist = abs(v_tw.x) * v_tw.y;
    a *= clamp(v_tw.y - 1.0 - dist + 0.5, 0.0, 1.0);
  }
  if (v_dash.y > 0.0) {
    float p = mod(v_dash.x, v_dash.y + v_dash.z);
    a *= clamp(v_dash.y - p + 0.5, 0.0, 1.0) * clamp(p + 0.5, 0.0, 1.0);
  }
  gl_FragColor = vec4(v_col.rgb, a);
}`;

const PT_VS = `
attribute vec2 a_pos;
attribute vec2 a_sz;     // diameter, ring width (css px)
attribute vec4 a_fill;
attribute vec4 a_ring;
uniform vec2 u_res;
uniform float u_dpr;
varying vec4 v_fill; varying vec4 v_ring; varying vec2 v_sz;
void main() {
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = (a_sz.x + 2.0) * u_dpr;
  v_fill = a_fill; v_ring = a_ring; v_sz = a_sz;
}`;

const PT_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 v_fill; varying vec4 v_ring; varying vec2 v_sz;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * 2.0;
  float r = length(p) * (v_sz.x + 2.0) * 0.5;
  float R = v_sz.x * 0.5;
  float outer = clamp(R - r + 0.5, 0.0, 1.0);
  float t = clamp(r - (R - v_sz.y) + 0.5, 0.0, 1.0);
  vec4 col = mix(v_fill, v_ring, t);
  gl_FragColor = vec4(col.rgb, col.a * outer);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

class Batch {
  constructor(stride) { this.stride = stride; this.buf = new Float32Array(stride * 4096); this.n = 0; }
  reset() { this.n = 0; }
  _room(k) {
    if ((this.n + k) * this.stride > this.buf.length) {
      const b = new Float32Array(this.buf.length * 2); b.set(this.buf); this.buf = b;
    }
  }
}

export const hex = (h, a = 1) => {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, a];
};

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl; this.canvas = canvas;
    this.lineProg = program(gl, LINE_VS, LINE_FS);
    this.ptProg = program(gl, PT_VS, PT_FS);
    this.lineBuf = gl.createBuffer(); this.ptBuf = gl.createBuffer();
    this.lines = new Batch(11); this.pts = new Batch(12);
    this.w = 1; this.h = 1; this.dpr = 1;
    this.bg = [1, 1, 1];
  }

  resize(cssW, cssH, dpr) {
    this.w = cssW; this.h = cssH; this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr); this.canvas.height = Math.round(cssH * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  begin() { this.lines.reset(); this.pts.reset(); }

  /** Thick line from (x1,y1) to (x2,y2). `ext` extends both ends (round-cap look for glows). */
  seg(x1, y1, x2, y2, width, c, dashOn = 0, dashOff = 0, ext = 0) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const hw = width / 2 + 1;
    const ax = x1 - ux * ext, ay = y1 - uy * ext, bx = x2 + ux * ext, by = y2 + uy * ext;
    const s0 = -ext, s1 = len + ext;
    const L = this.lines; L._room(6);
    const v = (x, y, s, t) => {
      const o = L.n * 11, b = L.buf;
      b[o] = x; b[o + 1] = y; b[o + 2] = c[0]; b[o + 3] = c[1]; b[o + 4] = c[2]; b[o + 5] = c[3];
      b[o + 6] = s; b[o + 7] = dashOn; b[o + 8] = dashOff; b[o + 9] = t; b[o + 10] = hw;
      L.n++;
    };
    v(ax + nx * hw, ay + ny * hw, s0, 1); v(ax - nx * hw, ay - ny * hw, s0, -1); v(bx + nx * hw, by + ny * hw, s1, 1);
    v(bx + nx * hw, by + ny * hw, s1, 1); v(ax - nx * hw, ay - ny * hw, s0, -1); v(bx - nx * hw, by - ny * hw, s1, -1);
  }

  tri(x1, y1, x2, y2, x3, y3, c) {
    const L = this.lines; L._room(3);
    for (const [x, y] of [[x1, y1], [x2, y2], [x3, y3]]) {
      const o = L.n * 11, b = L.buf;
      b[o] = x; b[o + 1] = y; b[o + 2] = c[0]; b[o + 3] = c[1]; b[o + 4] = c[2]; b[o + 5] = c[3];
      b[o + 6] = 0; b[o + 7] = 0; b[o + 8] = 0; b[o + 9] = 0; b[o + 10] = 0;
      L.n++;
    }
  }

  arrow(x1, y1, x2, y2, width, c, head = 9) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 2) return;
    const ux = dx / len, uy = dy / len, hl = Math.min(head, len * 0.8), hw = hl * 0.45;
    this.seg(x1, y1, x2 - ux * hl * 0.6, y2 - uy * hl * 0.6, width, c);
    this.tri(x2, y2, x2 - ux * hl - uy * hw, y2 - uy * hl + ux * hw, x2 - ux * hl + uy * hw, y2 - uy * hl - ux * hw, c);
  }

  /** Round marker. diameter and ring width in CSS px. */
  dot(x, y, diameter, fill, ring, ringWidth) {
    const P = this.pts; P._room(1);
    const o = P.n * 12, b = P.buf;
    b[o] = x; b[o + 1] = y; b[o + 2] = diameter; b[o + 3] = ringWidth;
    b[o + 4] = fill[0]; b[o + 5] = fill[1]; b[o + 6] = fill[2]; b[o + 7] = fill[3];
    b[o + 8] = ring[0]; b[o + 9] = ring[1]; b[o + 10] = ring[2]; b[o + 11] = ring[3];
    P.n++;
  }

  end() {
    const gl = this.gl;
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    if (this.lines.n) {
      gl.useProgram(this.lineProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.lines.buf.subarray(0, this.lines.n * 11), gl.DYNAMIC_DRAW);
      const p = this.lineProg, F = 4;
      this._attr(p, "a_pos", 2, 11 * F, 0); this._attr(p, "a_col", 4, 11 * F, 2 * F);
      this._attr(p, "a_dash", 3, 11 * F, 6 * F); this._attr(p, "a_tw", 2, 11 * F, 9 * F);
      gl.uniform2f(gl.getUniformLocation(p, "u_res"), this.w, this.h);
      gl.drawArrays(gl.TRIANGLES, 0, this.lines.n);
    }
    if (this.pts.n) {
      gl.useProgram(this.ptProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.pts.buf.subarray(0, this.pts.n * 12), gl.DYNAMIC_DRAW);
      const p = this.ptProg, F = 4;
      this._attr(p, "a_pos", 2, 12 * F, 0); this._attr(p, "a_sz", 2, 12 * F, 2 * F);
      this._attr(p, "a_fill", 4, 12 * F, 4 * F); this._attr(p, "a_ring", 4, 12 * F, 8 * F);
      gl.uniform2f(gl.getUniformLocation(p, "u_res"), this.w, this.h);
      gl.uniform1f(gl.getUniformLocation(p, "u_dpr"), this.dpr);
      gl.drawArrays(gl.POINTS, 0, this.pts.n);
    }
  }

  _attr(prog, name, size, stride, offset) {
    const gl = this.gl, loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  }
}
