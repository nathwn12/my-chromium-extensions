'use strict';
/*
 * qa/reference-meter.cjs — INDEPENDENT reference loudness meter (second oracle).
 *
 * Purpose: an offline, whole-file, float64, textbook re-implementation of the
 * EBU R128 / ITU-R BS.1770 measurement chain, used to cross-check the
 * production worklet. It is deliberately written the slow, obvious way: no
 * streaming, no incremental state, no ring buffers, no optimisation. If this
 * meter disagrees with the worklet, one of the two is wrong — investigate,
 * never adjust numbers to match.
 *
 * Primary source (read, not recalled — coefficients and thresholds below are
 * transcribed from it):
 *   URL: https://github.com/jiixyj/libebur128/blob/master/ebur128/ebur128.c
 *        (raw: https://raw.githubusercontent.com/jiixyj/libebur128/master/ebur128/ebur128.c)
 *   Functions transcribed: ebur128_init_filter (both K-weighting stages),
 *        EBUR128_FILTER macro (4th-order direct-form difference equations),
 *        ebur128_calc_gating_block (400 ms blocks, 75% overlap, mean square,
 *        surround weight 1.41, dual-mono 2.0, UNUSED/LFE excluded),
 *        ebur128_gated_loudness + ebur128_energy_to_loudness
 *          (absolute gate -70 LUFS, relative gate -10 LU,
 *           L = -0.691 + 10*log10(mean gated energy)),
 *        ebur128_loudness_range_multiple, non-histogram path (3 s windows,
 *          -20 LU relative gate — see LRA note below),
 *        interp_create + interp_process (true-peak 4x polyphase FIR:
 *          49 taps, factor 4, sinc * Hanning window, float delay line).
 *
 * Loudness Range note: integrated loudness uses a RELATIVE gate of -10 LU
 * below the absolute-gated level, but Loudness Range per EBU Tech 3342 uses a
 * different, lower relative gate of -20 LU below the mean of the absolute-
 * gated 3-second short-term blocks. The two gates serve different purposes
 * (programme loudness vs. spread of loudness) and must not be confused.
 *
 * True peak note: BS.1770-4 Annex 2 specifies 4x oversampling followed by
 * peak-picking. This meter implements the oversampler exactly as the primary
 * source does (polyphase FIR, 49 taps, interpolation factor 4, sinc kernel
 * with Hanning window). Reported in dBTP = 20*log10(peak).
 *
 * Usage:
 *   node qa/reference-meter.cjs --wav <path>   print one JSON object
 *   node qa/reference-meter.cjs --all           measure qa/fixtures/*.wav and
 *                                               (atomically) write
 *                                               qa/reference-values.json
 */

const fs = require('node:fs');
const path = require('node:path');

const ABSOLUTE_GATE_LUFS = -70.0;      // absolute gate, integrated + LRA
const RELATIVE_GATE_INT_LU = -10.0;    // relative gate, integrated loudness
const RELATIVE_GATE_LRA_LU = -20.0;    // relative gate, Loudness Range (Tech 3342)
const INTEGRATED_OFFSET = 0.691;       // L_KG = -0.691 + 10*log10(mean energy)
const BLOCK_SECONDS = 0.4;             // 400 ms gating blocks
const HOP_SECONDS = 0.1;               // 75% overlap -> 100 ms hop
const SHORT_TERM_SECONDS = 3.0;        // LRA window: 3 s
const SHORT_TERM_HOP_SECONDS = 1.0;    // LRA hop: 1 s (matches primary source,
                                       // which emits a 3 s block every 1 s)
const TRUE_PEAK_TAPS = 49;             // true-peak oversampler taps
const TRUE_PEAK_FACTOR_BELOW_96K = 4;  // 4x oversampling below 96 kHz

// ---------------------------------------------------------------------------
// WAV input. Supports PCM 16/24/32-bit int and 32-bit float, plus
// WAVE_FORMAT_EXTENSIBLE. Whole file is decoded up front into float64.
// ---------------------------------------------------------------------------
function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('not a RIFF WAV file: ' + filePath);
  }
  // Walk chunks; never assume fixed offsets (fmt may be 16/18/40 bytes,
  // and bext/fact/etc. chunks may precede data).
  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channelMask = 0;
  let hasMask = false;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      audioFormat = buf.readUInt16LE(body);
      numChannels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
      if (audioFormat === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE: extension starts at body+16
        // (cbSize, valid-bits, channel mask, SubFormat GUID).
        const subFormat = buf.readUInt16LE(body + 24);
        channelMask = buf.readUInt32LE(body + 20);
        hasMask = true;
        audioFormat = subFormat;
      }
    } else if (id === 'data' && dataStart < 0) {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataStart < 0) throw new Error('WAV has no data chunk: ' + filePath);
  if (numChannels < 1) throw new Error('WAV has no channels: ' + filePath);

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * numChannels));
  const planar = [];
  for (let c = 0; c < numChannels; c++) planar.push(new Float64Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const at = dataStart + (i * numChannels + c) * bytesPerSample;
      let v;
      if (audioFormat === 3 && bitsPerSample === 32) {
        v = buf.readFloatLE(at);
      } else if (audioFormat === 1) {
        if (bitsPerSample === 16) v = buf.readInt16LE(at) / 32768;
        else if (bitsPerSample === 24) v = buf.readIntLE(at, 3) / 8388608;
        else if (bitsPerSample === 32) v = buf.readInt32LE(at) / 2147483648;
        else throw new Error('unsupported PCM width: ' + bitsPerSample);
      } else {
        throw new Error('unsupported WAV format tag: ' + audioFormat);
      }
      planar[c][i] = v;
    }
  }
  return { sampleRate, channels: numChannels, frames, planar, channelMask, hasMask };
}

// Channel weights per BS.1770: front/centre channels count 1.0, surrounds
// count 1.41 (+1.5 dB power), LFE is excluded (weight 0). Mono/stereo files
// weight every channel 1.0.
function channelWeights(channels, channelMask, hasMask) {
  if (channels <= 2) return new Array(channels).fill(1.0);
  if (hasMask && channelMask !== 0) {
    // WAVEFORMATEXTENSIBLE speaker bits: 0x1 FL, 0x2 FR, 0x4 FC, 0x8 LFE,
    // 0x10 BL, 0x20 BR. LFE -> excluded; surrounds -> 1.41; rest -> 1.0.
    // Only the first six positions are mapped; anything else is excluded.
    const table = [0x1, 0x2, 0x4, 0x8, 0x10, 0x20];
    const weights = [];
    for (let c = 0; c < channels; c++) {
      if (c >= table.length || !(channelMask & table[c])) weights.push(0.0);
      else if (table[c] === 0x8) weights.push(0.0); // LFE: excluded
      else if (table[c] === 0x10 || table[c] === 0x20) weights.push(1.41);
      else weights.push(1.0);
    }
    return weights;
  }
  // Default SMPTE order L R C LFE Ls Rs; anything beyond is excluded.
  const weights = [];
  for (let c = 0; c < channels; c++) {
    if (c <= 2) weights.push(1.0);
    else if (c === 3) weights.push(0.0);
    else if (c === 4 || c === 5) weights.push(1.41);
    else weights.push(0.0);
  }
  return weights;
}

// ---------------------------------------------------------------------------
// K-weighting. Both stages are derived from the file's actual sample rate
// (transcribed from ebur128_init_filter), cascaded into one 4th-order
// section, applied as plain direct-form difference equations in float64.
// ---------------------------------------------------------------------------
function designKWeighting(sampleRate) {
  // Stage 1: high shelf, f0 = 1681.974450955533 Hz.
  const f0Stage1 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const qStage1 = 0.7071752369554196;
  const k1 = Math.tan(Math.PI * f0Stage1 / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k1 / qStage1 + k1 * k1;
  const pb0 = (vh + (vb * k1) / qStage1 + k1 * k1) / a0;
  const pb1 = (2 * (k1 * k1 - vh)) / a0;
  const pb2 = (vh - (vb * k1) / qStage1 + k1 * k1) / a0;
  const pa1 = (2 * (k1 * k1 - 1)) / a0;
  const pa2 = (1 - k1 / qStage1 + k1 * k1) / a0;

  // Stage 2: high-pass (RLB), f0 = 38.13547087602444 Hz.
  const f0Stage2 = 38.13547087602444;
  const qStage2 = 0.5003270373238773;
  const k2 = Math.tan(Math.PI * f0Stage2 / sampleRate);
  const denom2 = 1 + k2 / qStage2 + k2 * k2;
  const ra1 = (2 * (k2 * k2 - 1)) / denom2;
  const ra2 = (1 - k2 / qStage2 + k2 * k2) / denom2;
  const rb0 = 1;
  const rb1 = -2;
  const rb2 = 1;

  // Cascade the two biquads into a single 4th-order section.
  const b = [
    pb0 * rb0,
    pb0 * rb1 + pb1 * rb0,
    pb0 * rb2 + pb1 * rb1 + pb2 * rb0,
    pb1 * rb2 + pb2 * rb1,
    pb2 * rb2,
  ];
  const a = [
    1,
    ra1 + pa1,
    ra2 + pa1 * ra1 + pa2,
    pa1 * ra2 + pa2 * ra1,
    pa2 * ra2,
  ];
  return { b, a };
}

function applyKWeighting(planar, filter) {
  const { b, a } = filter;
  const filtered = [];
  for (let c = 0; c < planar.length; c++) {
    const input = planar[c];
    const output = new Float64Array(input.length);
    // Filter state, zero-initialised, carried across the whole file.
    let v1 = 0;
    let v2 = 0;
    let v3 = 0;
    let v4 = 0;
    for (let i = 0; i < input.length; i++) {
      const v0 = input[i] - a[1] * v1 - a[2] * v2 - a[3] * v3 - a[4] * v4;
      output[i] = b[0] * v0 + b[1] * v1 + b[2] * v2 + b[3] * v3 + b[4] * v4;
      v4 = v3;
      v3 = v2;
      v2 = v1;
      v1 = v0;
    }
    filtered.push(output);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Gating blocks: 400 ms long, 100 ms hop. Block energy = mean square of the
// K-weighted signal over the block, summed across channels with weights.
// Trailing partial blocks (< 400 ms) are dropped, as in the primary source.
// ---------------------------------------------------------------------------
function gatingBlockEnergies(filtered, sampleRate, weights) {
  const blockLen = Math.round((BLOCK_SECONDS * sampleRate) / 1);
  const hop = Math.round((HOP_SECONDS * sampleRate) / 1);
  const frames = filtered[0].length;
  const energies = [];
  for (let start = 0; start + blockLen <= frames; start += hop) {
    let sum = 0;
    for (let c = 0; c < filtered.length; c++) {
      const w = weights[c];
      if (w === 0) continue; // LFE / unused: excluded
      const ch = filtered[c];
      let channelSum = 0;
      for (let i = start; i < start + blockLen; i++) {
        channelSum += ch[i] * ch[i];
      }
      sum += w * channelSum;
    }
    energies.push(sum / blockLen);
  }
  return energies;
}

function energyToLoudness(energy) {
  return 10 * (Math.log(energy) / Math.LN10) - INTEGRATED_OFFSET;
}

function absoluteGateEnergy() {
  return Math.pow(10, (ABSOLUTE_GATE_LUFS + INTEGRATED_OFFSET) / 10);
}

// Integrated loudness: absolute gate at -70 LUFS, then relative gate -10 LU
// below the absolute-gated mean, then L = -0.691 + 10*log10(gated mean).
function integratedLoudness(blockEnergies) {
  const absGate = absoluteGateEnergy();
  const passed = blockEnergies.filter((e) => e >= absGate);
  if (passed.length === 0) return { lufs: null, gatedBlocks: 0 };
  const absMean = passed.reduce((s, e) => s + e, 0) / passed.length;
  const relGate = absMean * Math.pow(10, RELATIVE_GATE_INT_LU / 10);
  const gated = passed.filter((e) => e >= relGate);
  if (gated.length === 0) return { lufs: null, gatedBlocks: 0 };
  const mean = gated.reduce((s, e) => s + e, 0) / gated.length;
  return { lufs: energyToLoudness(mean), gatedBlocks: gated.length };
}

// ---------------------------------------------------------------------------
// Loudness Range per EBU Tech 3342: 3 s windows every 1 s, absolute gate at
// -70 LUFS, then a -20 LU relative gate (NOT the -10 LU gate used for
// integrated loudness), then LRA = P95 - P10 loudness of the survivors.
// Percentiles use nearest-rank on the sorted energies.
// ---------------------------------------------------------------------------
function loudnessRange(filtered, sampleRate, weights) {
  const windowLen = Math.round(SHORT_TERM_SECONDS * sampleRate);
  const hop = Math.round(SHORT_TERM_HOP_SECONDS * sampleRate);
  const frames = filtered[0].length;
  const absGate = absoluteGateEnergy();
  const shortTerm = [];
  for (let start = 0; start + windowLen <= frames; start += hop) {
    let sum = 0;
    for (let c = 0; c < filtered.length; c++) {
      const w = weights[c];
      if (w === 0) continue;
      const ch = filtered[c];
      let channelSum = 0;
      for (let i = start; i < start + windowLen; i++) {
        channelSum += ch[i] * ch[i];
      }
      sum += w * channelSum;
    }
    const energy = sum / windowLen;
    if (energy >= absGate) shortTerm.push(energy);
  }
  if (shortTerm.length === 0) return { lra: 0.0, shortTermBlocks: 0 };
  const absMean = shortTerm.reduce((s, e) => s + e, 0) / shortTerm.length;
  const relGate = absMean * Math.pow(10, RELATIVE_GATE_LRA_LU / 10);
  const gated = shortTerm.filter((e) => e >= relGate).sort((x, y) => x - y);
  if (gated.length === 0) return { lra: 0.0, shortTermBlocks: 0 };
  const rank = (p) => gated[Math.min(gated.length - 1, Math.floor((gated.length - 1) * p + 0.5))];
  const lra = energyToLoudness(rank(0.95)) - energyToLoudness(rank(0.1));
  return { lra, shortTermBlocks: gated.length };
}

// ---------------------------------------------------------------------------
// True peak: 4x polyphase FIR oversampler (49 taps, sinc * Hanning), float
// delay line shared-phase index, peak over every oversampled output sample.
// Transcribed from interp_create / interp_process.
// ---------------------------------------------------------------------------
function designOversampler(factor) {
  const taps = TRUE_PEAK_TAPS;
  const delay = Math.floor((taps + factor - 1) / factor);
  const phases = [];
  for (let f = 0; f < factor; f++) phases.push({ coeff: [], index: [] });
  for (let j = 0; j < taps; j++) {
    const m = j - (taps - 1) / 2;
    let c = Math.abs(m) < 1e-6 ? 1 : Math.sin((m * Math.PI) / factor) / ((m * Math.PI) / factor);
    c *= 0.5 * (1 - Math.cos((2 * Math.PI * j) / (taps - 1))); // Hanning
    if (Math.abs(c) > 1e-6) {
      const f = j % factor;
      phases[f].coeff.push(c);
      phases[f].index.push(Math.floor(j / factor));
    }
  }
  return { factor, delay, phases };
}

function truePeak(planar, sampleRate) {
  let factor;
  if (sampleRate < 96000) factor = TRUE_PEAK_FACTOR_BELOW_96K;
  else if (sampleRate < 192000) factor = 2;
  else factor = 1; // >= 192 kHz: no oversampling, peak of samples
  if (factor === 1) {
    let peak = 0;
    for (const ch of planar) {
      for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    }
    return 20 * (Math.log(peak) / Math.LN10);
  }
  const over = designOversampler(factor);
  let peak = 0;
  // One float delay line per channel; the phase index advances once per
  // input frame (shared across channels), exactly like the primary source.
  const lines = planar.map(() => new Float32Array(over.delay));
  let zi = 0;
  for (let i = 0; i < planar[0].length; i++) {
    for (let c = 0; c < planar.length; c++) {
      lines[c][zi] = Math.fround(planar[c][i]);
    }
    for (let c = 0; c < planar.length; c++) {
      const line = lines[c];
      for (let f = 0; f < factor; f++) {
        const phase = over.phases[f];
        let acc = 0;
        for (let t = 0; t < phase.coeff.length; t++) {
          let at = zi - phase.index[t];
          if (at < 0) at += over.delay;
          acc += line[at] * phase.coeff[t];
        }
        const out = Math.fround(acc);
        const mag = Math.abs(out);
        if (mag > peak) peak = mag;
      }
    }
    zi++;
    if (zi === over.delay) zi = 0;
  }
  if (peak <= 0) return null;
  return 20 * (Math.log(peak) / Math.LN10);
}

// ---------------------------------------------------------------------------
// Whole-file measurement.
// ---------------------------------------------------------------------------
function measureFile(wavPath) {
  const wav = readWav(wavPath);
  const weights = channelWeights(wav.channels, wav.channelMask, wav.hasMask);
  const filter = designKWeighting(wav.sampleRate);
  const filtered = applyKWeighting(wav.planar, filter);
  const blocks = gatingBlockEnergies(filtered, wav.sampleRate, weights);
  const integrated = integratedLoudness(blocks);
  const range = loudnessRange(filtered, wav.sampleRate, weights);
  const peak = truePeak(wav.planar, wav.sampleRate);
  return {
    integratedLufs: integrated.lufs,
    // Canonical spelling read by qa/loudness-verify.cjs
    // (reference.values[<basename>].truePeakDbTp). The legacy `truePeakDbtp`
    // alias below carries the same number for anything written against the
    // first version of this file.
    truePeakDbTp: peak,
    truePeakDbtp: peak,
    lra: range.lra,
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    frames: wav.frames,
    source: 'reference-meter',
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--wav' && args[1]) {
    const result = measureFile(path.resolve(args[1]));
    process.stdout.write(JSON.stringify({ file: path.basename(args[1]), ...result }) + '\n');
    return;
  }
  if (args[0] === '--all') {
    // Fixture sources: the harness-owned qa/fixtures/ plus this meter's own
    // qa/reference-fixtures/ (extra coverage the harness does not generate:
    // 44.1 kHz, multichannel). Keys are basenames WITHOUT extension, because
    // that is the exact lookup the consumer performs:
    //   qa/loudness-verify.cjs: key = path.basename(f.name, '.wav');
    //                            refEntry = reference.values[key];
    //                            refEntry.integratedLufs / .truePeakDbTp / .source
    // where reference.values = parsed JSON's `.fixtures` object. Harness
    // fixtures win on basename collision (processed first, never overwritten).
    const here = __dirname;
    const fixtureDirs = [
      path.join(here, 'fixtures'),
      path.join(here, 'reference-fixtures'),
    ];
    const seen = new Set();
    const fixtures = {};
    for (const dir of fixtureDirs) {
      if (!fs.existsSync(dir)) continue;
      const names = fs
        .readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.wav'))
        .sort();
      for (const name of names) {
        const key = path.basename(name, '.wav');
        if (seen.has(key)) continue;
        seen.add(key);
        fixtures[key] = measureFile(path.join(dir, name));
      }
    }
    if (Object.keys(fixtures).length === 0) {
      throw new Error('no WAV fixtures found');
    }
    const outPath = path.join(__dirname, 'reference-values.json');
    const payload = JSON.stringify({ fixtures }, null, 2) + '\n';
    // Atomic write: temp file in the same directory, then rename, so a
    // concurrent reader never observes a half-written file.
    const tmpPath = path.join(__dirname, `.reference-values.json.tmp.${process.pid}`);
    fs.writeFileSync(tmpPath, payload);
    fs.renameSync(tmpPath, outPath);
    process.stdout.write(`wrote ${Object.keys(fixtures).length} fixtures to ${outPath}\n`);
    return;
  }
  process.stderr.write('usage:\n');
  process.stderr.write('  node qa/reference-meter.cjs --wav <path>\n');
  process.stderr.write('  node qa/reference-meter.cjs --all\n');
  process.exitCode = 2;
}

main();
