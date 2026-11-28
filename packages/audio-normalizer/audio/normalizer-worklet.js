
var LOUDNESS_OFFSET = -0.691;
var TARGET_LUFS_DEFAULT = -20;
var ABS_GATE_LUFS = -70;
var ABS_GATE_ENERGY = Math.pow(10, (ABS_GATE_LUFS + 0.691) / 10);
var REL_GATE_FACTOR = Math.pow(10, -10 / 10);

var MAX_BOOST_DB = 12;
var MAX_CUT_DB = 20;

var UP_TC_SECONDS = 3.0;
var DOWN_TC_SECONDS = 0.6;
var FAST_ONSET_SECONDS = 0.05;
var FAST_ONSET_TC_SECONDS = 0.08;

var CEILING_DB = -1;
var CEILING_LINEAR = Math.pow(10, CEILING_DB / 20);
var TP_DETECTOR_MARGIN_DB = 1.0;

var LOOKAHEAD_SECONDS = 0.005;
var LIMITER_ATTACK_SECONDS = 0.002;
var LIMITER_FLAT_SAMPLES = 64;
var LIMITER_RELEASE_SECONDS = 0.1;

var AGC_BAND_DB = 2.5;
var AGC_BOOST_CAP_DB = 6;
var AGC_ATTACK_TC_SECONDS = 0.003; // 3 ms conventional program-AGC attack: follows a level rise before it is audible
var AGC_RELEASE_TC_SECONDS = 0.25; // 250 ms conventional program-AGC release: recovers without audible pumping
var AGC_SLEW_DB_PER_QUANTUM = 0.05; // hard per-quantum ceiling that the attack constant alone cannot guarantee at high sample rates
var AGC_SILENCE_FLOOR_LUFS = -70;
var SLOW_LOCK_LO_DB = 6;
var SLOW_LOCK_HI_DB = 15;

var WARM_SECONDS = 0;
var SLOW_WINDOW_SECONDS = 30;
var SLOW_WINDOW_BLOCKS = SLOW_WINDOW_SECONDS * 10;
var MAX_BLOCKS = 50000;
var METER_EVERY_QUANTA = 48;
var MIN_GAIN_DB = -12;
var MAX_GAIN_DB = 12;

function dbToGain(db) { return Math.pow(10, db / 20); }
function clampNumber(value, min, max) {
  var n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function energyToLoudness(energy) {
  if (!(energy > 0)) return -Infinity;
  return 10 * Math.log10(energy) + LOUDNESS_OFFSET;
}
function channelWeight(index, total) {
  if (total <= 1) return 1;
  if (total === 2) return 1;
  if (total === 3) return 1;
  if (total === 4) return index < 2 ? 1 : 1.41;
  if (total === 5) return index < 3 ? 1 : 1.41;
  if (index === 3) return 0;
  if (index === 4 || index === 5) return 1.41;
  return index < 3 ? 1 : 0;
}

function initKCoeffs(sr) {
  var f0 = 1681.974450955533;
  var G = 3.999843853973347;
  var Q = 0.7071752369554196;
  var K = Math.tan(Math.PI * f0 / sr);
  var Vh = Math.pow(10, G / 20);
  var Vb = Math.pow(Vh, 0.4996667741545416);
  var a0 = 1 + K / Q + K * K;
  var pb0 = (Vh + Vb * K / Q + K * K) / a0;
  var pb1 = 2 * (K * K - Vh) / a0;
  var pb2 = (Vh - Vb * K / Q + K * K) / a0;
  var pa1 = 2 * (K * K - 1) / a0;
  var pa2 = (1 - K / Q + K * K) / a0;

  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sr);
  var denom = 1 + K / Q + K * K;
  var ra1 = 2 * (K * K - 1) / denom;
  var ra2 = (1 - K / Q + K * K) / denom;

  return {
    b0: pb0,
    b1: pb0 * -2 + pb1,
    b2: pb0 + pb1 * -2 + pb2,
    b3: pb1 + pb2 * -2,
    b4: pb2,
    a1: ra1 + pa1,
    a2: ra2 + pa1 * ra1 + pa2,
    a3: pa1 * ra2 + pa2 * ra1,
    a4: pa2 * ra2
  };
}

function besselI0(x) {
  var sum = 1;
  var term = 1;
  for (var k = 1; k < 40; k++) {
    term *= (x * x) / (4 * k * k);
    sum += term;
    if (term < 1e-15) break;
  }
  return sum;
}
function buildInterpPhases() {
  var taps = 97;
  var factor = 4;
  var beta = 6.0;
  var half = (taps - 1) / 2;
  var denom = besselI0(beta);
  var phasesC = [[], [], [], []];
  var phasesI = [[], [], [], []];
  for (var j = 0; j < taps; j++) {
    var m = j - half;
    var c = 1;
    if (m > 0.000001 || m < -0.000001) {
      c = Math.sin(m * Math.PI / factor) / (m * Math.PI / factor);
    }
    var r = (2 * j) / (taps - 1) - 1;
    c = c * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
    if (c > 0.000001 || c < -0.000001) {
      var f = j % factor;
      phasesC[f].push(c);
      phasesI[f].push(Math.floor(j / factor));
    }
  }
  return { c: phasesC, idx: phasesI, delay: Math.floor(taps / factor) + 1 };
}

class LoudnessNormalizerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    var sr = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    this.sr = sr;

    var k = initKCoeffs(sr);
    this.kB0 = k.b0;
    this.kB1 = k.b1;
    this.kB2 = k.b2;
    this.kB3 = k.b3;
    this.kB4 = k.b4;
    this.kA1 = k.a1;
    this.kA2 = k.a2;
    this.kA3 = k.a3;
    this.kA4 = k.a4;

    var ch;
    this.filtV = [];
    for (ch = 0; ch < 6; ch++) this.filtV.push(new Float64Array(5));
    this.filtVLev = [];
    for (ch = 0; ch < 6; ch++) this.filtVLev.push(new Float64Array(5));

    this.samples100 = Math.floor((sr + 5) / 10);
    if (this.samples100 < 1) this.samples100 = 1;
    this.blockSize = this.samples100 * 4;
    this.shortWin = this.samples100 * 30;

    this.pRing = new Float64Array(this.shortWin);
    this.pIndex = 0;
    this.pCount = 0;
    this.sumShort = 0;
    this.sumBlock = 0;
    this.hopCounter = 0;

    this.blocks = new Float64Array(MAX_BLOCKS);
    this.blockWrite = 0;
    this.blockCount = 0;
    this.integratedEnergy = 0;
    this.integratedLufs = -Infinity;
    this.hasGated = false;
    this.meanAbsRaw = 0;

    this.pRingLev = new Float64Array(this.shortWin);
    this.sumShortLev = 0;
    this.sumBlockLev = 0;
    this.blocksLev = new Float64Array(SLOW_WINDOW_BLOCKS);
    this.blockSampleLev = new Float64Array(SLOW_WINDOW_BLOCKS);
    this.slowWindowSamples = Math.max(1, Math.round(SLOW_WINDOW_SECONDS * sr));
    this.blockWriteLev = 0;
    this.blockCountLev = 0;
    this.integratedEnergyLev = 0;
    this.integratedLufsLev = -Infinity;
    this.hasGatedLev = false;

    this.fastWindow = Math.max(1, Math.round(FAST_ONSET_SECONDS * sr));
    this.fastRing = new Float64Array(this.fastWindow);
    this.fastIndex = 0;
    this.fastCount = 0;
    this.fastSum = 0;
    this.onsetCutDb = 0;

    this.delayFrames = Math.max(128, Math.round(sr * LOOKAHEAD_SECONDS));
    this.bufferLength = 1;
    while (this.bufferLength < this.delayFrames + 2048) this.bufferLength <<= 1;
    this.channelBuffers = [];
    for (ch = 0; ch < 6; ch++) this.channelBuffers.push(new Float32Array(this.bufferLength));
    this.limiterTargets = new Float32Array(this.bufferLength);
    this.limiterTargets.fill(1);
    this.writeIndex = 0;
    this.limiterAttackFrames = Math.max(1, Math.round(sr * LIMITER_ATTACK_SECONDS));
    this.limiterReleaseCoeff = Math.exp(-1 / (sr * LIMITER_RELEASE_SECONDS));
    this.currentLimiterGain = 1;

    var ph = buildInterpPhases();
    this.interpC = ph.c;
    this.interpI = ph.idx;
    this.interpDelay = ph.delay;
    this.interpZ = [];
    for (ch = 0; ch < 6; ch++) this.interpZ.push(new Float64Array(ph.delay));
    this.interpZi = 0;
    this.outInterpZ = [];
    for (ch = 0; ch < 6; ch++) this.outInterpZ.push(new Float64Array(ph.delay));
    this.outInterpZi = 0;

    this.currentAgcDb = 0;

    this.targetLufs = TARGET_LUFS_DEFAULT;
    this.trimTargetDb = 0;
    this.trimCurrentDb = 0;
    this.mode = 'normalize';
    this.currentLoudnessDb = 0;
    this.totalFrames = 0;
    this.warm = false;
    this.momentaryLufs = -Infinity;
    this.shortTermLufs = -Infinity;
    this.truePeakTrack = 0;
    this.appliedGainDb = 0;
    this.meterCounter = 0;
    this.lastAppliedResetGeneration = 0;

    this.rawScratch = new Float64Array(6);
    this.preScratch = new Float64Array(6);
    this.outScratch = new Float64Array(6);

    this.telemetry = {
      integratedLufs: -Infinity,
      shortTermLufs: -Infinity,
      momentaryLufs: -Infinity,
      truePeakDb: -Infinity,
      appliedGainDb: 0,
      normGainDb: 0,
      userTrimDb: 0,
      mode: 'normalize',
      warm: false
    };
    this.meterMsg = {
      type: 'meter',
      integratedLufs: -Infinity,
      shortTermLufs: -Infinity,
      momentaryLufs: -Infinity,
      truePeakDb: -Infinity,
      appliedGainDb: 0,
      normGainDb: 0,
      userTrimDb: 0,
      mode: 'normalize',
      warm: false
    };

    var self = this;
    this.port.onmessage = function (event) {
      var data = event && event.data ? event.data : null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'set-gain-db') {
        var trimRaw = Number(data.gainDb);
        if (!Number.isFinite(trimRaw) || trimRaw < MIN_GAIN_DB || trimRaw > MAX_GAIN_DB) return;
        self.trimTargetDb = Math.round(trimRaw * 2) / 2;
        return;
      }
      if (data.type === 'start-normalizing') return;
      if (data.type === 'set-target-lufs') {
        var t = Number(data.targetLufs);
        if (Number.isFinite(t)) self.targetLufs = t;
        return;
      }
      if (data.type === 'set-mode') {
        if (data.mode === 'level' || data.mode === 'normalize') {
          if (self.mode !== data.mode) {
            self.mode = data.mode;
            self.resetMeasurementForModeSwitch();
          }
        }
        return;
      }
      if (data.type === 'reset-meter') {
        self.resetMeter();
      }
      if (data.type === 'reset-program') {
        var gen = data.generation;
        if (typeof gen === 'number' && Number.isInteger(gen)) {
          if (gen <= self.lastAppliedResetGeneration) return;
          self.lastAppliedResetGeneration = gen;
        }
        self.resetProgram();
      }
    };
  }

  resetMeasurementForModeSwitch() {
    var ch, i;
    for (ch = 0; ch < 6; ch++) {
      var v = this.filtV[ch];
      v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0; v[4] = 0;
      var vL = this.filtVLev[ch];
      vL[0] = 0; vL[1] = 0; vL[2] = 0; vL[3] = 0; vL[4] = 0;
    }
    this.pRing.fill(0);
    this.pIndex = 0;
    this.pCount = 0;
    this.sumShort = 0;
    this.sumBlock = 0;
    this.hopCounter = 0;
    this.blocks.fill(0);
    this.blockWrite = 0;
    this.blockCount = 0;
    this.integratedEnergy = 0;
    this.integratedLufs = -Infinity;
    this.hasGated = false;
    this.meanAbsRaw = 0;
    this.pRingLev.fill(0);
    this.sumShortLev = 0;
    this.sumBlockLev = 0;
    this.blocksLev.fill(0);
    this.blockSampleLev.fill(0);
    this.blockWriteLev = 0;
    this.blockCountLev = 0;
    this.integratedEnergyLev = 0;
    this.integratedLufsLev = -Infinity;
    this.hasGatedLev = false;
    this.fastRing.fill(0);
    this.fastIndex = 0;
    this.fastCount = 0;
    this.fastSum = 0;
    this.warm = false;
    this.momentaryLufs = -Infinity;
    this.shortTermLufs = -Infinity;
    this.telemetry.integratedLufs = -Infinity;
    this.telemetry.shortTermLufs = -Infinity;
    this.telemetry.momentaryLufs = -Infinity;
    this.telemetry.warm = false;
    this.meterMsg.integratedLufs = -Infinity;
    this.meterMsg.shortTermLufs = -Infinity;
    this.meterMsg.momentaryLufs = -Infinity;
    this.meterMsg.warm = false;
    this.telemetry.mode = this.mode;
    this.meterMsg.mode = this.mode;
  }

  resetProgram() {
    var folded = this.currentLoudnessDb + this.currentAgcDb;
    if (!Number.isFinite(folded)) folded = 0;
    if (folded > MAX_BOOST_DB) folded = MAX_BOOST_DB;
    if (folded < -MAX_CUT_DB) folded = -MAX_CUT_DB;
    this.currentLoudnessDb = folded;
    this.currentAgcDb = 0;
    var ch;
    for (ch = 0; ch < 6; ch++) {
      var v = this.filtV[ch];
      v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0; v[4] = 0;
      var vL = this.filtVLev[ch];
      vL[0] = 0; vL[1] = 0; vL[2] = 0; vL[3] = 0; vL[4] = 0;
    }
    this.pRing.fill(0);
    this.pIndex = 0;
    this.pCount = 0;
    this.sumShort = 0;
    this.sumBlock = 0;
    this.hopCounter = 0;
    this.blocks.fill(0);
    this.blockWrite = 0;
    this.blockCount = 0;
    this.integratedEnergy = 0;
    this.integratedLufs = -Infinity;
    this.hasGated = false;
    this.meanAbsRaw = 0;
    this.pRingLev.fill(0);
    this.sumShortLev = 0;
    this.sumBlockLev = 0;
    this.blocksLev.fill(0);
    this.blockSampleLev.fill(0);
    this.blockWriteLev = 0;
    this.blockCountLev = 0;
    this.integratedEnergyLev = 0;
    this.integratedLufsLev = -Infinity;
    this.hasGatedLev = false;
    this.fastRing.fill(0);
    this.fastIndex = 0;
    this.fastCount = 0;
    this.fastSum = 0;
    this.onsetCutDb = 0;
    this.warm = false;
    this.momentaryLufs = -Infinity;
    this.shortTermLufs = -Infinity;
    this.appliedGainDb = this.currentLoudnessDb;
    this.telemetry.normGainDb = this.currentLoudnessDb;
    this.telemetry.integratedLufs = -Infinity;
    this.telemetry.shortTermLufs = -Infinity;
    this.telemetry.momentaryLufs = -Infinity;
    this.telemetry.truePeakDb = this.truePeakTrack > 0 ? 20 * Math.log10(this.truePeakTrack) : -Infinity;
    this.telemetry.appliedGainDb = this.appliedGainDb;
    this.telemetry.userTrimDb = this.trimCurrentDb;
    this.telemetry.mode = this.mode;
    this.telemetry.warm = false;
    this.meterMsg.integratedLufs = -Infinity;
    this.meterMsg.shortTermLufs = -Infinity;
    this.meterMsg.momentaryLufs = -Infinity;
    this.meterMsg.truePeakDb = this.telemetry.truePeakDb;
    this.meterMsg.appliedGainDb = this.appliedGainDb;
    this.meterMsg.normGainDb = this.currentLoudnessDb;
    this.meterMsg.userTrimDb = this.trimCurrentDb;
    this.meterMsg.mode = this.mode;
    this.meterMsg.warm = false;
  }

  resetMeter() {
    var ch, i;
    for (ch = 0; ch < 6; ch++) {
      var v = this.filtV[ch];
      v[0] = 0; v[1] = 0; v[2] = 0; v[3] = 0; v[4] = 0;
      var vR = this.filtVLev[ch];
      vR[0] = 0; vR[1] = 0; vR[2] = 0; vR[3] = 0; vR[4] = 0;
    }
    this.pRing.fill(0);
    this.pIndex = 0;
    this.pCount = 0;
    this.sumShort = 0;
    this.sumBlock = 0;
    this.hopCounter = 0;
    this.blocks.fill(0);
    this.blockWrite = 0;
    this.blockCount = 0;
    this.integratedEnergy = 0;
    this.integratedLufs = -Infinity;
    this.hasGated = false;
    this.meanAbsRaw = 0;
    this.pRingLev.fill(0);
    this.sumShortLev = 0;
    this.sumBlockLev = 0;
    this.blocksLev.fill(0);
    this.blockSampleLev.fill(0);
    this.blockWriteLev = 0;
    this.blockCountLev = 0;
    this.integratedEnergyLev = 0;
    this.integratedLufsLev = -Infinity;
    this.hasGatedLev = false;
    this.fastRing.fill(0);
    this.fastIndex = 0;
    this.fastCount = 0;
    this.fastSum = 0;
    this.onsetCutDb = 0;
    this.totalFrames = 0;
    this.warm = false;
    this.momentaryLufs = -Infinity;
    this.shortTermLufs = -Infinity;
    this.truePeakTrack = 0;
    this.currentLoudnessDb = 0;
    this.currentAgcDb = 0;
    this.trimCurrentDb = this.trimTargetDb;
    this.appliedGainDb = 0;
    for (ch = 0; ch < 6; ch++) this.channelBuffers[ch].fill(0);
    for (i = 0; i < this.bufferLength; i++) this.limiterTargets[i] = 1;
    this.writeIndex = 0;
    this.currentLimiterGain = 1;
    for (ch = 0; ch < 6; ch++) this.interpZ[ch].fill(0);
    this.interpZi = 0;
    for (ch = 0; ch < 6; ch++) this.outInterpZ[ch].fill(0);
    this.outInterpZi = 0;
    this.meterCounter = 0;
    this.rawScratch.fill(0);
    this.preScratch.fill(0);
    this.outScratch.fill(0);
    this.telemetry.integratedLufs = -Infinity;
    this.telemetry.shortTermLufs = -Infinity;
    this.telemetry.momentaryLufs = -Infinity;
    this.telemetry.truePeakDb = -Infinity;
    this.telemetry.appliedGainDb = 0;
    this.telemetry.normGainDb = 0;
    this.telemetry.userTrimDb = this.trimCurrentDb;
    this.telemetry.mode = this.mode;
    this.telemetry.warm = false;
    this.meterMsg.integratedLufs = -Infinity;
    this.meterMsg.shortTermLufs = -Infinity;
    this.meterMsg.momentaryLufs = -Infinity;
    this.meterMsg.truePeakDb = -Infinity;
    this.meterMsg.appliedGainDb = 0;
    this.meterMsg.normGainDb = 0;
    this.meterMsg.userTrimDb = this.trimCurrentDb;
    this.meterMsg.mode = this.mode;
    this.meterMsg.warm = false;
  }

  recomputeIntegrated() {
    if (this.blockCount === 0) {
      this.integratedEnergy = 0;
      this.integratedLufs = -Infinity;
      this.hasGated = false;
      this.meanAbsRaw = 0;
      return;
    }
    var sum = 0;
    var i;
    for (i = 0; i < this.blockCount; i++) sum += this.blocks[i];
    var meanAbs = sum / this.blockCount;
    this.meanAbsRaw = meanAbs;
    var relThresh = meanAbs * REL_GATE_FACTOR;
    var sumG = 0;
    var cntG = 0;
    for (i = 0; i < this.blockCount; i++) {
      var e = this.blocks[i];
      if (e >= relThresh) {
        sumG += e;
        cntG++;
      }
    }
    if (cntG === 0) {
      this.integratedEnergy = 0;
      this.integratedLufs = -Infinity;
      this.hasGated = false;
      return;
    }
    this.integratedEnergy = sumG / cntG;
    this.integratedLufs = energyToLoudness(this.integratedEnergy);
    this.hasGated = Number.isFinite(this.integratedLufs);
  }

  recomputeLevelled() {
    if (this.blockCountLev === 0) {
      this.integratedEnergyLev = 0;
      this.integratedLufsLev = -Infinity;
      this.hasGatedLev = false;
      return;
    }
    var now = this.totalFrames;
    var maxAge = this.slowWindowSamples;
    var stRef = this.shortTermLufs;
    if (Number.isFinite(this.momentaryLufs) && this.momentaryLufs > stRef) stRef = this.momentaryLufs;
    var lockOn = Number.isFinite(stRef);
    var lockLo = stRef - SLOW_LOCK_LO_DB;
    var lockHi = stRef + SLOW_LOCK_HI_DB;
    var sum = 0;
    var absN = 0;
    var i;
    for (i = 0; i < this.blockCountLev; i++) {
      if (now - this.blockSampleLev[i] > maxAge) continue;
      var e0 = this.blocksLev[i];
      if (lockOn) {
        var l0 = energyToLoudness(e0);
        if (l0 < lockLo || l0 > lockHi) continue;
      }
      sum += e0;
      absN++;
    }
    if (absN === 0) {
      this.integratedEnergyLev = 0;
      this.integratedLufsLev = -Infinity;
      this.hasGatedLev = false;
      return;
    }
    var meanAbs = sum / absN;
    var relThresh = meanAbs * REL_GATE_FACTOR;
    var sumG = 0;
    var cntG = 0;
    for (i = 0; i < this.blockCountLev; i++) {
      if (now - this.blockSampleLev[i] > maxAge) continue;
      var e = this.blocksLev[i];
      if (lockOn) {
        var l1 = energyToLoudness(e);
        if (l1 < lockLo || l1 > lockHi) continue;
      }
      if (e >= relThresh) {
        sumG += e;
        cntG++;
      }
    }
    if (cntG === 0) {
      this.integratedEnergyLev = 0;
      this.integratedLufsLev = -Infinity;
      this.hasGatedLev = false;
      return;
    }
    this.integratedEnergyLev = sumG / cntG;
    this.integratedLufsLev = energyToLoudness(this.integratedEnergyLev);
    this.hasGatedLev = Number.isFinite(this.integratedLufsLev);
  }

  interpPeak(preCh, nCh) {
    var peak = 0;
    var ch, f, t;
    for (ch = 0; ch < nCh; ch++) {
      var x = preCh[ch];
      var ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
      this.interpZ[ch][this.interpZi] = x;
    }
    for (ch = 0; ch < nCh; ch++) {
      var z = this.interpZ[ch];
      for (f = 0; f < 4; f++) {
        var acc = 0;
        var coeffs = this.interpC[f];
        var indices = this.interpI[f];
        for (t = 0; t < coeffs.length; t++) {
          var pos = this.interpZi - indices[t];
          if (pos < 0) pos += this.interpDelay;
          acc += coeffs[t] * z[pos];
        }
        var a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  outputPeak(outCh, nCh) {
    var peak = 0;
    var ch, f, t;
    for (ch = 0; ch < nCh; ch++) {
      var x = outCh[ch];
      var ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
      this.outInterpZ[ch][this.outInterpZi] = x;
    }
    for (ch = 0; ch < nCh; ch++) {
      var z = this.outInterpZ[ch];
      for (f = 0; f < 4; f++) {
        var acc = 0;
        var coeffs = this.interpC[f];
        var indices = this.interpI[f];
        for (t = 0; t < coeffs.length; t++) {
          var pos = this.outInterpZi - indices[t];
          if (pos < 0) pos += this.interpDelay;
          acc += coeffs[t] * z[pos];
        }
        var a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  scheduleLimiter(writeIndex, targetGain) {
    if (!(targetGain < 1)) return;
    var idx = writeIndex;
    var off;
    for (off = 0; off < LIMITER_FLAT_SAMPLES; off++) {
      if (targetGain < this.limiterTargets[idx]) this.limiterTargets[idx] = targetGain;
      idx--;
      if (idx < 0) idx = this.bufferLength - 1;
    }
    var attack = this.limiterAttackFrames;
    var delta = targetGain - 1;
    for (off = 0; off < attack; off++) {
      var ramped = 1 + delta * (1 - off / attack);
      if (ramped < this.limiterTargets[idx]) this.limiterTargets[idx] = ramped;
      idx--;
      if (idx < 0) idx = this.bufferLength - 1;
    }
  }

  stepLimiter(scheduledGain) {
    if (scheduledGain < this.currentLimiterGain) {
      this.currentLimiterGain = scheduledGain;
    } else {
      this.currentLimiterGain = 1 + (this.currentLimiterGain - 1) * this.limiterReleaseCoeff;
    }
    return this.currentLimiterGain;
  }

  process(inputs, outputs) {
    var output = outputs ? outputs[0] : null;
    if (!output || output.length === 0) return true;
    var frameCount = output[0].length;
    var input = inputs ? inputs[0] : null;
    var inCh = input ? input.length : 0;
    if (inCh > 6) inCh = 6;
    var outCh = output.length;
    if (outCh > 6) outCh = 6;

    var sr = this.sr;
    var agcAttackCoeff = Math.exp(-1 / (sr * AGC_ATTACK_TC_SECONDS));
    var agcReleaseCoeff = Math.exp(-1 / (sr * AGC_RELEASE_TC_SECONDS));
    var agcSlewPerSampleDb = AGC_SLEW_DB_PER_QUANTUM / 128;
    var ceiling = CEILING_LINEAR;
    var marginLin = dbToGain(-TP_DETECTOR_MARGIN_DB);
    var effCeiling = ceiling * marginLin;

    if (!input || inCh === 0) {
      var c0;
      for (c0 = 0; c0 < outCh; c0++) output[c0].fill(0);
      this.truePeakTrack = 0 + (this.truePeakTrack - 0) * Math.exp(-frameCount / (sr * 1.5));
      if (!Number.isFinite(this.truePeakTrack)) this.truePeakTrack = 0;
      this.telemetry.integratedLufs = this.integratedLufs;
      this.telemetry.shortTermLufs = this.shortTermLufs;
      this.telemetry.momentaryLufs = this.momentaryLufs;
      this.telemetry.truePeakDb = this.truePeakTrack > 0 ? 20 * Math.log10(this.truePeakTrack) : -Infinity;
      this.telemetry.appliedGainDb = this.appliedGainDb;
      this.telemetry.normGainDb = this.currentLoudnessDb;
      this.telemetry.userTrimDb = this.trimCurrentDb;
      this.telemetry.mode = this.mode;
      this.telemetry.warm = this.warm;
      this.meterCounter++;
      if (this.meterCounter >= METER_EVERY_QUANTA) {
        this.meterCounter = 0;
        this.meterMsg.integratedLufs = this.telemetry.integratedLufs;
        this.meterMsg.shortTermLufs = this.telemetry.shortTermLufs;
        this.meterMsg.momentaryLufs = this.telemetry.momentaryLufs;
        this.meterMsg.truePeakDb = this.telemetry.truePeakDb;
        this.meterMsg.appliedGainDb = this.telemetry.appliedGainDb;
        this.meterMsg.normGainDb = this.telemetry.normGainDb;
        this.meterMsg.userTrimDb = this.telemetry.userTrimDb;
        this.meterMsg.mode = this.telemetry.mode;
        this.meterMsg.warm = this.telemetry.warm;
        try { this.port.postMessage(this.meterMsg); } catch (e) { /* harness stub never throws */ }
      }
      return true;
    }

    var wantWarmLev = this.totalFrames >= Math.round(sr * WARM_SECONDS) && this.hasGatedLev;
    var coldDesired = this.currentLoudnessDb;
    if (!this.hasGatedLev && this.fastCount >= this.fastWindow) {
      var fastLevelDb = energyToLoudness(this.fastSum / this.fastWindow);
      var probeDesired = MAX_BOOST_DB;
      if (Number.isFinite(fastLevelDb)) {
        probeDesired = this.targetLufs - fastLevelDb - this.currentAgcDb;
        if (probeDesired > MAX_BOOST_DB) probeDesired = MAX_BOOST_DB;
        else if (probeDesired < -MAX_CUT_DB) probeDesired = -MAX_CUT_DB;
        if (!Number.isFinite(probeDesired)) probeDesired = MAX_BOOST_DB;
      }
      if (probeDesired < coldDesired) coldDesired = probeDesired;
      if (coldDesired < 0) this.onsetCutDb = coldDesired;
      else this.onsetCutDb = 0;
    }
    var desiredLoudnessDb = 0;
    if (wantWarmLev) {
      var need = this.targetLufs - this.integratedLufsLev;
      var normMax = MAX_BOOST_DB - this.currentAgcDb;
      var normMin = -MAX_CUT_DB - this.currentAgcDb;
      if (need > normMax) need = normMax;
      if (need < normMin) need = normMin;
      desiredLoudnessDb = need;
    } else if (!this.hasGatedLev) {
      desiredLoudnessDb = coldDesired;
    }
    var tc;
    if (desiredLoudnessDb > this.currentLoudnessDb) tc = UP_TC_SECONDS;
    else if (!this.hasGatedLev) tc = FAST_ONSET_TC_SECONDS;
    else tc = DOWN_TC_SECONDS;
    var smooth = Math.exp(-frameCount / (sr * tc));
    var prevLoudnessDb = this.currentLoudnessDb;
    this.currentLoudnessDb = desiredLoudnessDb + (this.currentLoudnessDb - desiredLoudnessDb) * smooth;
    var startLog = prevLoudnessDb * (Math.LN10 / 20);
    var endLog = this.currentLoudnessDb * (Math.LN10 / 20);
    var gainStep = frameCount > 0 ? (endLog - startLog) / frameCount : 0;

    var trimStartDb = this.trimCurrentDb;
    var trimEndDb = this.trimTargetDb;
    var trimStepDb = frameCount > 0 ? (trimEndDb - trimStartDb) / frameCount : 0;
    var trimDbAcc = trimStartDb;

    var quantumTruePeak = 0;

    var readIndex = this.writeIndex + this.bufferLength - this.delayFrames;
    if (readIndex >= this.bufferLength) readIndex -= this.bufferLength;

    var loudLog = startLog;

    var i, ch;
    for (i = 0; i < frameCount; i++) {
      for (ch = 0; ch < inCh; ch++) {
        var chanData = input[ch];
        var sLoad = chanData ? chanData[i] : 0;
        if (!Number.isFinite(sLoad)) sLoad = 0;
        this.rawScratch[ch] = sLoad;
      }

      var agcTargetDb = 0;
      if (this.hasGated && this.pCount >= this.blockSize && Number.isFinite(this.integratedLufs)) {
        var shortDenAgc = this.pCount < this.shortWin ? this.pCount : this.shortWin;
        var stAgc = energyToLoudness(this.sumShort / shortDenAgc);
        var relAgc = energyToLoudness(this.meanAbsRaw * REL_GATE_FACTOR);
        var silentAgc = !(stAgc > relAgc) || !(stAgc > AGC_SILENCE_FLOOR_LUFS);
        if (!silentAgc) {
          var diffAgc = stAgc - this.integratedLufs;
          var adiffAgc = diffAgc < 0 ? -diffAgc : diffAgc;
          if (adiffAgc > AGC_BAND_DB) {
            var sgnAgc = diffAgc < 0 ? -1 : 1;
            agcTargetDb = -(diffAgc - sgnAgc * AGC_BAND_DB);
            if (agcTargetDb > AGC_BOOST_CAP_DB) agcTargetDb = AGC_BOOST_CAP_DB;
            if (agcTargetDb > 0 && this.fastCount >= this.fastWindow) {
              var fastLevDb = energyToLoudness(this.fastSum / this.fastWindow);
              var fastRawGate = Number.isFinite(fastLevDb) ? fastLevDb - this.currentAgcDb : -Infinity;
              if (fastRawGate > this.integratedLufs - AGC_BAND_DB) agcTargetDb = 0;
            }
          }
        } else {
          agcTargetDb = this.currentAgcDb;
        }
      }
      var agcCapMax = MAX_BOOST_DB - this.currentLoudnessDb;
      var agcCapMin = -MAX_CUT_DB - this.currentLoudnessDb;
      if (agcTargetDb > agcCapMax) agcTargetDb = agcCapMax;
      if (agcTargetDb < agcCapMin) agcTargetDb = agcCapMin;
      var agcNextDb = agcTargetDb + (this.currentAgcDb - agcTargetDb) * (agcTargetDb > this.currentAgcDb ? agcAttackCoeff : agcReleaseCoeff);
      var agcMoveDb = agcNextDb - this.currentAgcDb;
      if (agcMoveDb > agcSlewPerSampleDb) agcMoveDb = agcSlewPerSampleDb;
      else if (agcMoveDb < -agcSlewPerSampleDb) agcMoveDb = -agcSlewPerSampleDb;
      this.currentAgcDb += agcMoveDb;
      if (this.currentAgcDb > agcCapMax) this.currentAgcDb = agcCapMax;
      if (this.currentAgcDb < agcCapMin) this.currentAgcDb = agcCapMin;
      var agcLinSamp = dbToGain(this.currentAgcDb);

      var newP = 0;
      var newPLev = 0;
      for (ch = 0; ch < inCh; ch++) {
        var s = this.rawScratch[ch] || 0;
        var w = channelWeight(ch, inCh);
        if (w === 0) continue;
        var v = this.filtV[ch];
        var v1 = v[1], v2 = v[2], v3 = v[3], v4 = v[4];
        var v0 = s - this.kA1 * v1 - this.kA2 * v2 - this.kA3 * v3 - this.kA4 * v4;
        if (!Number.isFinite(v0)) v0 = 0;
        else if (v0 > -1e-30 && v0 < 1e-30) v0 = 0;
        var y = this.kB0 * v0 + this.kB1 * v1 + this.kB2 * v2 + this.kB3 * v3 + this.kB4 * v4;
        if (!Number.isFinite(y)) y = 0;
        else if (y > -1e-30 && y < 1e-30) y = 0;
        v[4] = v3;
        v[3] = v2;
        v[2] = v1;
        v[1] = v0;
        v[0] = v0;
        newP += w * y * y;
        var sL = s * agcLinSamp;
        var vL = this.filtVLev[ch];
        var u1 = vL[1], u2 = vL[2], u3 = vL[3], u4 = vL[4];
        var u0 = sL - this.kA1 * u1 - this.kA2 * u2 - this.kA3 * u3 - this.kA4 * u4;
        if (!Number.isFinite(u0)) u0 = 0;
        else if (u0 > -1e-30 && u0 < 1e-30) u0 = 0;
        var yL = this.kB0 * u0 + this.kB1 * u1 + this.kB2 * u2 + this.kB3 * u3 + this.kB4 * u4;
        if (!Number.isFinite(yL)) yL = 0;
        else if (yL > -1e-30 && yL < 1e-30) yL = 0;
        vL[4] = u3;
        vL[3] = u2;
        vL[2] = u1;
        vL[1] = u0;
        vL[0] = u0;
        newPLev += w * yL * yL;
      }
      if (!Number.isFinite(newP)) newP = 0;
      if (!Number.isFinite(newPLev)) newPLev = 0;
      var fastOut = this.fastCount >= this.fastWindow ? this.fastRing[this.fastIndex] : 0;
      this.fastSum += newPLev - fastOut;
      this.fastRing[this.fastIndex] = newPLev;
      this.fastIndex++;
      if (this.fastIndex >= this.fastWindow) this.fastIndex = 0;
      if (this.fastCount < this.fastWindow) this.fastCount++;

      var shortOut = 0;
      var blockOut = 0;
      if (this.pCount >= this.shortWin) shortOut = this.pRing[this.pIndex];
      if (this.pCount >= this.blockSize) {
        var bIdx = this.pIndex - this.blockSize;
        if (bIdx < 0) bIdx += this.shortWin;
        blockOut = this.pRing[bIdx];
      }
      this.sumShort += newP - (this.pCount >= this.shortWin ? shortOut : 0);
      this.sumBlock += newP - (this.pCount >= this.blockSize ? blockOut : 0);
      this.pRing[this.pIndex] = newP;
      var shortOutLev = 0;
      var blockOutLev = 0;
      if (this.pCount >= this.shortWin) shortOutLev = this.pRingLev[this.pIndex];
      if (this.pCount >= this.blockSize) {
        var bIdxLev = this.pIndex - this.blockSize;
        if (bIdxLev < 0) bIdxLev += this.shortWin;
        blockOutLev = this.pRingLev[bIdxLev];
      }
      this.sumShortLev += newPLev - (this.pCount >= this.shortWin ? shortOutLev : 0);
      this.sumBlockLev += newPLev - (this.pCount >= this.blockSize ? blockOutLev : 0);
      this.pRingLev[this.pIndex] = newPLev;
      this.pIndex++;
      if (this.pIndex >= this.shortWin) this.pIndex = 0;
      this.pCount++;
      this.hopCounter++;
      if (this.hopCounter >= this.samples100) {
        this.hopCounter -= this.samples100;
        if (this.pCount >= this.blockSize) {
          var blockEnergy = this.sumBlock / this.blockSize;
          if (blockEnergy >= ABS_GATE_ENERGY) {
            if (this.blockCount < MAX_BLOCKS) {
              this.blocks[this.blockWrite] = blockEnergy;
              this.blockWrite++;
              if (this.blockWrite >= MAX_BLOCKS) this.blockWrite = 0;
              this.blockCount++;
            } else {
              this.blocks[this.blockWrite] = blockEnergy;
              this.blockWrite++;
              if (this.blockWrite >= MAX_BLOCKS) this.blockWrite = 0;
            }
            this.recomputeIntegrated();
          }
          var blockEnergyLev = this.sumBlockLev / this.blockSize;
          if (blockEnergyLev >= ABS_GATE_ENERGY) {
            if (this.blockCountLev < SLOW_WINDOW_BLOCKS) {
              this.blocksLev[this.blockWriteLev] = blockEnergyLev;
              this.blockSampleLev[this.blockWriteLev] = this.totalFrames;
              this.blockWriteLev++;
              if (this.blockWriteLev >= SLOW_WINDOW_BLOCKS) this.blockWriteLev = 0;
              this.blockCountLev++;
            } else {
              this.blocksLev[this.blockWriteLev] = blockEnergyLev;
              this.blockSampleLev[this.blockWriteLev] = this.totalFrames;
              this.blockWriteLev++;
              if (this.blockWriteLev >= SLOW_WINDOW_BLOCKS) this.blockWriteLev = 0;
            }
            this.recomputeLevelled();
          }
        }
      }
      this.totalFrames++;

      var loudLin = Math.exp(loudLog);
      loudLog += gainStep;
      trimDbAcc += trimStepDb;
      var trimLin = dbToGain(trimDbAcc);
      var nOut = outCh;
      for (ch = 0; ch < nOut; ch++) {
        var srcCh = ch < inCh ? ch : 0;
        var rawS = this.rawScratch[srcCh] || 0;
        this.preScratch[ch] = rawS * agcLinSamp * loudLin * trimLin;
      }
      var framePeak = this.interpPeak(this.preScratch, nOut);
      if (!Number.isFinite(framePeak)) framePeak = 0;
      if (framePeak > effCeiling) {
        var need = effCeiling / framePeak;
        this.scheduleLimiter(this.writeIndex, need);
      }

      var limGain = this.stepLimiter(this.limiterTargets[readIndex]);
      for (ch = 0; ch < nOut; ch++) {
        this.channelBuffers[ch][this.writeIndex] = this.preScratch[ch];
      }
      for (ch = 0; ch < nOut; ch++) {
        var delayed = this.channelBuffers[ch][readIndex];
        var o = delayed * limGain;
        if (!Number.isFinite(o)) o = 0;
        if (o > ceiling) o = ceiling;
        else if (o < -ceiling) o = -ceiling;
        output[ch][i] = o;
        this.outScratch[ch] = o;
      }
      var outFramePeak = this.outputPeak(this.outScratch, nOut);
      if (!Number.isFinite(outFramePeak)) outFramePeak = 0;
      if (outFramePeak > quantumTruePeak) quantumTruePeak = outFramePeak;
      this.limiterTargets[readIndex] = 1;
      this.writeIndex++;
      if (this.writeIndex >= this.bufferLength) this.writeIndex = 0;
      readIndex++;
      if (readIndex >= this.bufferLength) readIndex = 0;
      this.interpZi++;
      if (this.interpZi >= this.interpDelay) this.interpZi = 0;
      this.outInterpZi++;
      if (this.outInterpZi >= this.interpDelay) this.outInterpZi = 0;
    }

    this.warm = this.totalFrames >= Math.round(sr * WARM_SECONDS) && this.hasGated;
    if (this.pCount >= this.blockSize) {
      this.momentaryLufs = energyToLoudness(this.sumBlock / this.blockSize);
    }
    var shortDen = this.pCount < this.shortWin ? this.pCount : this.shortWin;
    if (shortDen > 0 && this.pCount >= this.blockSize) {
      this.shortTermLufs = energyToLoudness(this.sumShort / shortDen);
    }
    if (quantumTruePeak > this.truePeakTrack) {
      this.truePeakTrack = quantumTruePeak;
    } else {
      this.truePeakTrack = quantumTruePeak + (this.truePeakTrack - quantumTruePeak) * Math.exp(-frameCount / (sr * 1.5));
    }
    if (!Number.isFinite(this.truePeakTrack)) this.truePeakTrack = 0;
    this.appliedGainDb = this.currentLoudnessDb + this.currentAgcDb;
    this.trimCurrentDb = trimEndDb;
    this.telemetry.normGainDb = this.currentLoudnessDb;

    this.telemetry.integratedLufs = this.integratedLufs;
    this.telemetry.shortTermLufs = this.shortTermLufs;
    this.telemetry.momentaryLufs = this.momentaryLufs;
    this.telemetry.truePeakDb = this.truePeakTrack > 0 ? 20 * Math.log10(this.truePeakTrack) : -Infinity;
    this.telemetry.appliedGainDb = this.appliedGainDb;
    this.telemetry.userTrimDb = this.trimCurrentDb;
    this.telemetry.mode = this.mode;
    this.telemetry.warm = this.warm;

    this.meterCounter++;
    if (this.meterCounter >= METER_EVERY_QUANTA) {
      this.meterCounter = 0;
      this.meterMsg.integratedLufs = this.telemetry.integratedLufs;
      this.meterMsg.shortTermLufs = this.telemetry.shortTermLufs;
      this.meterMsg.momentaryLufs = this.telemetry.momentaryLufs;
      this.meterMsg.truePeakDb = this.telemetry.truePeakDb;
      this.meterMsg.appliedGainDb = this.telemetry.appliedGainDb;
      this.meterMsg.normGainDb = this.telemetry.normGainDb;
      this.meterMsg.userTrimDb = this.telemetry.userTrimDb;
      this.meterMsg.mode = this.telemetry.mode;
      this.meterMsg.warm = this.telemetry.warm;
      try { this.port.postMessage(this.meterMsg); } catch (e) { /* stub-safe */ }
    }
    return true;
  }
}

registerProcessor('loudness-normalizer', LoudnessNormalizerProcessor);
