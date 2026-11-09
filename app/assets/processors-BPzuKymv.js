/* AudioWorklets: se ejecutan igual en AudioContext (vista previa) y OfflineAudioContext (exportación). */

/** FFT compleja radix-2 en el sitio. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const a = i + k; const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const N = 2048;
const OSAMP = 4;
const STEP = N / OSAMP;
const LATENCY = N - STEP;
const HALF = N / 2;
const EXPECT = (2 * Math.PI * STEP) / N;
const WINDOW = Float32Array.from({ length: N }, (_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N));

class Voice {
  constructor() {
    this.inF = new Float32Array(N); this.outF = new Float32Array(N); this.acc = new Float32Array(2 * N);
    this.last = new Float32Array(HALF + 1); this.sum = new Float32Array(HALF + 1);
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.aM = new Float32Array(HALF + 1); this.aF = new Float32Array(HALF + 1);
    this.sM = new Float32Array(HALF + 1); this.sF = new Float32Array(HALF + 1);
    this.rover = LATENCY;
  }
  push(x, ratio) {
    this.inF[this.rover] = x;
    const y = this.outF[this.rover - LATENCY];
    if (++this.rover >= N) { this.rover = LATENCY; this.frame(ratio); }
    return y;
  }
  frame(ratio) {
    const { re, im, aM, aF, sM, sF, last, sum, inF, outF, acc } = this;
    for (let k = 0; k < N; k++) { re[k] = inF[k] * WINDOW[k]; im[k] = 0; }
    fft(re, im, false);
    for (let k = 0; k <= HALF; k++) {
      const ph = Math.atan2(im[k], re[k]);
      let d = ph - last[k] - k * EXPECT;
      last[k] = ph;
      let q = Math.trunc(d / Math.PI);
      q += q >= 0 ? q & 1 : -(q & 1);
      d -= Math.PI * q;
      aM[k] = 2 * Math.hypot(re[k], im[k]);
      aF[k] = k + (OSAMP * d) / (2 * Math.PI);
    }
    sM.fill(0); sF.fill(0);
    for (let k = 0; k <= HALF; k++) {
      const i = Math.floor(k * ratio);
      if (i <= HALF) { sM[i] += aM[k]; sF[i] = aF[k] * ratio; }
    }
    for (let k = 0; k <= HALF; k++) {
      sum[k] += ((sF[k] - k) * 2 * Math.PI) / OSAMP + k * EXPECT;
      re[k] = sM[k] * Math.cos(sum[k]);
      im[k] = sM[k] * Math.sin(sum[k]);
    }
    for (let k = HALF + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
    fft(re, im, true);
    const scale = 2 / (HALF * OSAMP);
    for (let k = 0; k < N; k++) acc[k] += scale * WINDOW[k] * re[k];
    for (let k = 0; k < STEP; k++) outF[k] = acc[k];
    acc.copyWithin(0, STEP);
    acc.fill(0, N);
    inF.copyWithin(0, STEP);
  }
}

/** Phase vocoder: cambia el tono sin alterar la duración. */
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() { super(); this.voices = [new Voice(), new Voice()]; this.idle = 0; }
  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    const ratio = params.ratio[0];
    const n = out[0].length;
    for (let c = 0; c < out.length && c < 2; c++) {
      const src = inp[c] ?? inp[0];
      const v = this.voices[c];
      for (let i = 0; i < n; i++) out[c][i] = v.push(src ? src[i] : 0, ratio);
    }
    // sin entrada conectada: deja salir la cola y libera el procesador
    this.idle = inp.length ? 0 : this.idle + n;
    return this.idle < sampleRate;
  }
}
registerProcessor('nx-pitch', PitchShifter);

/** Puerta de ruido con ataque y relajación. */
class NoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -40, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.005, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.12, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.env = 0; this.gain = 0; }
  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    const th = Math.pow(10, params.threshold[0] / 20);
    const a = 1 - Math.exp(-1 / (params.attack[0] * sampleRate));
    const r = 1 - Math.exp(-1 / (params.release[0] * sampleRate));
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > peak) peak = v; }
      this.env += (peak - this.env) * (peak > this.env ? 0.2 : 0.002);
      const target = this.env >= th ? 1 : 0;
      this.gain += (target - this.gain) * (target ? a : r);
      for (let c = 0; c < out.length; c++) { const src = inp[c] ?? inp[0]; out[c][i] = src ? src[i] * this.gain : 0; }
    }
    return inp.length > 0;
  }
}
registerProcessor('nx-gate', NoiseGate);


/** De-esser: detector en banda alta que reduce esa banda solo cuando supera el umbral. */
class DeEsser extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 6500, minValue: 1000, maxValue: 16000, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -28, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'amount', defaultValue: 10, minValue: 0, maxValue: 40, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.lp = [0, 0]; this.env = 0; }
  process(inputs, outputs, params) {
    const inp = inputs[0]; const out = outputs[0];
    const a = 1 - Math.exp((-2 * Math.PI * params.freq[0]) / sampleRate);
    const th = 10 ** (params.threshold[0] / 20);
    const maxCut = 10 ** (-params.amount[0] / 20);
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      let hiPeak = 0;
      const lo = [0, 0]; const hi = [0, 0];
      for (let c = 0; c < 2; c++) {
        const src = inp[c] ?? inp[0];
        const x = src ? src[i] : 0;
        this.lp[c] += (x - this.lp[c]) * a;
        lo[c] = this.lp[c]; hi[c] = x - this.lp[c];
        const v = Math.abs(hi[c]);
        if (v > hiPeak) hiPeak = v;
      }
      this.env += (hiPeak - this.env) * (hiPeak > this.env ? 0.05 : 0.0015);
      const g = this.env > th ? Math.max(maxCut, th / this.env) : 1;
      for (let c = 0; c < out.length && c < 2; c++) out[c][i] = lo[c] + hi[c] * g;
    }
    return inp.length > 0;
  }
}
registerProcessor('nx-deesser', DeEsser);

/** Reducción de ruido por resta espectral con seguimiento del suelo de ruido por banda. */
/** bloques con señal que se promedian para la estimación inicial del ruido (unos 0,15 s) */
const LEARN = 14;

class Denoiser extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'floor', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    // fill: bloques recibidos (los OSAMP primeros aún llevan el relleno inicial de ceros); learn: bloques promediados
    this.v = [0, 1].map(() => ({ inF: new Float32Array(N), outF: new Float32Array(N), acc: new Float32Array(2 * N), re: new Float32Array(N), im: new Float32Array(N), noise: new Float32Array(HALF + 1), sm: new Float32Array(HALF + 1), rover: LATENCY, fill: 0, learn: 0 }));
    this.idle = 0;
  }
  frame(v, amount, floor) {
    const { re, im, inF, outF, acc, noise } = v;
    let energy = 0;
    for (let k = 0; k < N; k++) { re[k] = inF[k] * WINDOW[k]; im[k] = 0; energy += inF[k] * inF[k]; }
    fft(re, im, false);
    v.fill++;
    // arranque: la estimación es la media de los primeros bloques reales con señal; una sola medida puede salir
    // muy baja por azar y después tardaría segundos en subir. El silencio digital no cuenta.
    const learning = v.learn < LEARN;
    const counts = learning && v.fill >= OSAMP && energy > 1e-10;
    if (counts) v.learn++;
    for (let k = 0; k <= HALF; k++) {
      const mag = Math.hypot(re[k], im[k]);
      // media del ruido estacionario: solo aprende de lo que no sobresale, así la voz no contamina la estimación
      if (learning) { if (counts) noise[k] += (mag - noise[k]) / v.learn; }
      else if (mag < noise[k] * 3.5) noise[k] += (mag - noise[k]) * 0.06;
      else noise[k] *= 1.0005;
      v.sm[k] += (mag - v.sm[k]) * 0.5;
      const g = learning ? 1 : Math.max(floor, 1 - (amount * 2.2 * noise[k]) / (v.sm[k] + 1e-9));
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < HALF) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft(re, im, true);
    const scale = 1 / (N * OSAMP * 0.375);
    for (let k = 0; k < N; k++) acc[k] += scale * WINDOW[k] * re[k];
    for (let k = 0; k < STEP; k++) outF[k] = acc[k];
    acc.copyWithin(0, STEP);
    acc.fill(0, N);
    inF.copyWithin(0, STEP);
  }
  process(inputs, outputs, params) {
    const inp = inputs[0]; const out = outputs[0];
    const n = out[0].length;
    for (let c = 0; c < out.length && c < 2; c++) {
      const src = inp[c] ?? inp[0]; const v = this.v[c];
      for (let i = 0; i < n; i++) {
        v.inF[v.rover] = src ? src[i] : 0;
        out[c][i] = v.outF[v.rover - LATENCY];
        if (++v.rover >= N) { v.rover = LATENCY; this.frame(v, params.amount[0], params.floor[0]); }
      }
    }
    this.idle = inp.length ? 0 : this.idle + n;
    return this.idle < sampleRate;
  }
}
registerProcessor('nx-denoise', Denoiser);


/** Limitador de picos: ataque instantáneo, la salida nunca supera el techo. */
class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: -1, minValue: -40, maxValue: 0, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.06, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.g = 1; }
  process(inputs, outputs, params) {
    const inp = inputs[0]; const out = outputs[0];
    const ceil = 10 ** (params.ceiling[0] / 20);
    const rel = 1 - Math.exp(-1 / (params.release[0] * sampleRate));
    const n = out[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > peak) peak = v; }
      const want = peak > ceil ? ceil / peak : 1;
      this.g = want < this.g ? want : this.g + (want - this.g) * rel;
      for (let c = 0; c < out.length; c++) { const src = inp[c] ?? inp[0]; out[c][i] = src ? src[i] * this.g : 0; }
    }
    return inp.length > 0;
  }
}
registerProcessor('nx-limiter', Limiter);
