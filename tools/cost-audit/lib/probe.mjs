// The in-page instrument, installed through
// Page.addScriptToEvaluateOnNewDocument before any page or content script runs.
//
// It counts what a page can observe about an extension that is present:
//   listenerRegistrations - EventTarget.prototype.addEventListener calls seen in
//                 the page world. It is a REGISTRATION count, not a live listener
//                 count: duplicate adds land as duplicate registrations (the
//                 platform deduplicates them), a `once` listener that already
//                 fired still counts, capture is not modelled, AbortSignal
//                 removals are invisible, isolated-world registrations never reach
//                 this prototype, and the log is capped. removeEventListener
//                 calls are counted separately as `listenerRemovalCalls`; nothing
//                 here subtracts one from the other.
//   timers      - setTimeout / setInterval / requestAnimationFrame calls
//   observers   - Mutation/Intersection/Resize/PerformanceObserver constructions
//                   and observe() calls
//   audioContexts, workletNodes, mediaElementSources - audio graph construction
//   patches     - key prototypes/methods whose source text changed since install
//   scriptElements - <script> elements in the document (injection as a script tag)
//
// Every registration records the first stack frame that names an extension, so
// counts can be attributed per extension. Isolated-world (content script)
// registration is NOT visible from here: an isolated world has its own
// EventTarget.prototype, so the content script's own calls never reach this
// wrapper. The harness counts isolated worlds separately through CDP runtime
// execution contexts.

export const PROBE_SOURCE = `(() => {
  var SENTINEL = "__costProbe";
  if (window[SENTINEL] && window[SENTINEL].installed) return;

  var state = {
    installed: true,
    listeners: [],
    timers: [],
    rafs: [],
    observers: [],
    observerObservations: [],
    audioContexts: [],
    contextRefs: [],
    workletNodes: [],
    mediaElementSources: [],
    uncaught: [],
    inlineScriptCalls: 0
  };
  var CAP = 500;
  // How many removeEventListener calls this page world saw. Deliberately NOT
  // paired with registrations: the platform deduplicates duplicate adds, honours
  // capture, drops once-listeners after they fire and accepts an AbortSignal,
  // none of which this instrument can observe. A "live listener count" built by
  // subtracting these would be a guess dressed as a measurement, so only the
  // observed registration count is published.
  var listenerRemovalCalls = 0;

  function push(list, value) {
    if (list.length < CAP) {
      list.push(value);
      return true;
    }
    return false;
  }

  function frameOf(stack) {
    var text = String(stack || "");
    var lines = text.split("\\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("__costProbe") >= 0) continue;
      var ext = /chrome-extension:\\/\\/([a-p]{32})/.exec(line);
      if (ext) return "extension:" + ext[1];
      if (/^(https?|file):\\/\\//.test(line.replace(/^\\s*at\\s+/, "")) || line.indexOf(" \\/") >= 0) return "page";
    }
    return "unknown";
  }

  function stackNow() {
    return new Error().stack;
  }

  function srcOf(fn) {
    try {
      return Function.prototype.toString.call(fn).replace(/\\s+/g, " ").slice(0, 200);
    } catch (error) {
      return "unreadable";
    }
  }

  // 1. natives, captured before anything is replaced
  var nativeAdd = EventTarget.prototype.addEventListener;
  var nativeRemove = EventTarget.prototype.removeEventListener;
  var nativeSetTimeout = window.setTimeout;
  var nativeSetInterval = window.setInterval;
  var nativeRaf = window.requestAnimationFrame;
  var NativeAudioContext = window.AudioContext;
  var NativeWorkletNode = window.AudioWorkletNode;
  var NativeMediaElementSource = NativeAudioContext && NativeAudioContext.prototype.createMediaElementSource;

  // 2. uncaught errors, registered through the untouched native so they are not
  //    counted as page listeners
  function noteError(kind, detail) {
    push(state.uncaught, { kind: kind, detail: String(detail || "").slice(0, 300) });
  }
  try {
    nativeAdd.call(window, "error", function (event) {
      noteError("error", (event && event.message) || "error event");
    });
    nativeAdd.call(window, "unhandledrejection", function (event) {
      noteError("unhandledrejection", (event && event.reason && (event.reason.message || event.reason)) || "rejection");
    });
  } catch (error) {
    noteError("install", "error listeners: " + error);
  }

  // 3. audio graph instruments. Constructed through a subclass so instanceof and
  //    the prototype chain still point at the real classes.
  var NativeAudioContextRef = NativeAudioContext;
  if (typeof NativeAudioContext === "function") {
    var CostAudioContext = class AudioContext extends NativeAudioContextRef {
      constructor() {
        super(...arguments);
        var frame = frameOf(stackNow());
        push(state.audioContexts, { frame: frame, at: Date.now() });
        if (state.contextRefs.length < 8) state.contextRefs.push({ frame: frame, context: this });
      }
    };
    try {
      window.AudioContext = CostAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = CostAudioContext;
    } catch (error) {
      noteError("install", "AudioContext shim: " + error);
    }
  }

  if (typeof NativeWorkletNode === "function") {
    var NativeWorkletRef = NativeWorkletNode;
    var CostWorkletNode = class AudioWorkletNode extends NativeWorkletRef {
      constructor(context, name) {
        super(...arguments);
        push(state.workletNodes, { processor: String(name), frame: frameOf(stackNow()), at: Date.now() });
      }
    };
    try {
      window.AudioWorkletNode = CostWorkletNode;
    } catch (error) {
      noteError("install", "AudioWorkletNode shim: " + error);
    }
  }

  if (NativeAudioContext && typeof NativeMediaElementSource === "function") {
    var mediaCalls = [];
    var NativeCreate = NativeMediaElementSource;
    try {
      NativeAudioContext.prototype.createMediaElementSource = function (element) {
        var frame = frameOf(stackNow());
        var count = 1;
        for (var i = 0; i < mediaCalls.length; i++) {
          if (mediaCalls[i].element === element) {
            mediaCalls[i].count += 1;
            mediaCalls[i].frames.push(frame);
            count = mediaCalls[i].count;
            break;
          }
        }
        if (count === 1) mediaCalls.push({ element: element, count: 1, frames: [frame] });
        push(state.mediaElementSources, { count: count, frame: frame });
        return NativeCreate.apply(this, arguments);
      };
      state.mediaCallLog = mediaCalls;
    } catch (error) {
      noteError("install", "createMediaElementSource wrapper: " + error);
    }
  }

  // 4. baseline AFTER our own instruments, so our shims never read as patches
  var surfaces = {
    AudioContext: function () { return window.AudioContext; },
    webkitAudioContext: function () { return window.webkitAudioContext; },
    AudioWorkletNode: function () { return window.AudioWorkletNode; },
    "AudioNode.connect": function () { return AudioNode.prototype.connect; },
    "AudioContext.createMediaElementSource": function () { return NativeAudioContext.prototype.createMediaElementSource; },
    "HTMLMediaElement.play": function () { return HTMLMediaElement.prototype.play; },
    "Element.attachShadow": function () { return Element.prototype.attachShadow; }
  };
  var baseline = {};
  Object.keys(surfaces).forEach(function (key) {
    baseline[key] = srcOf(surfaces[key]());
  });

  // 5. listener / timer / observer instruments
  EventTarget.prototype.addEventListener = function (type) {
    var stack = stackNow();
    push(state.listeners, {
      type: String(type),
      target: this === window ? "window" : this === document ? "document" : (this && this.nodeName) || typeof this,
      frame: frameOf(stack),
      at: Date.now()
    });
    return nativeAdd.apply(this, arguments);
  };

  EventTarget.prototype.removeEventListener = function () {
    listenerRemovalCalls += 1;
    return nativeRemove.apply(this, arguments);
  };

  window.setTimeout = function () {
    push(state.timers, { kind: "timeout", delay: Number(arguments[1]) || 0, frame: frameOf(stackNow()), at: Date.now() });
    return nativeSetTimeout.apply(window, arguments);
  };
  window.setInterval = function () {
    push(state.timers, { kind: "interval", delay: Number(arguments[1]) || 0, frame: frameOf(stackNow()), at: Date.now() });
    return nativeSetInterval.apply(window, arguments);
  };
  window.requestAnimationFrame = function () {
    push(state.rafs, { frame: frameOf(stackNow()), at: Date.now() });
    return nativeRaf.apply(window, arguments);
  };

  ["MutationObserver", "IntersectionObserver", "ResizeObserver", "PerformanceObserver"].forEach(function (kind) {
    var Native = window[kind];
    if (typeof Native !== "function") return;
    var Wrapped = class extends Native {
      constructor() {
        super(...arguments);
        push(state.observers, { kind: kind, frame: frameOf(stackNow()), at: Date.now() });
      }
      observe() {
        push(state.observerObservations, { kind: kind, frame: frameOf(stackNow()), at: Date.now() });
        return super.observe.apply(this, arguments);
      }
    };
    try {
      window[kind] = Wrapped;
    } catch (error) {
      noteError("install", kind + " shim: " + error);
    }
  });

  var markers = ["__tabNormalizerHookV5", "__slowedReverbAudioPageHook", "__tnConnect"];

  window[SENTINEL] = {
    installed: true,
    markInlineScript: function () {
      state.inlineScriptCalls += 1;
    },
    read: function () {
      var patches = [];
      Object.keys(surfaces).forEach(function (key) {
        var now = srcOf(surfaces[key]());
        if (now !== baseline[key]) patches.push(key);
      });
      var presentMarkers = markers.filter(function (name) {
        return name in window;
      });
      var doubled = [];
      (state.mediaCallLog || []).forEach(function (entry, index) {
        if (entry.count > 1) doubled.push({ elementIndex: index, count: entry.count, frames: entry.frames });
      });
      var audio = document.querySelector("audio,video");
      var scripts = [];
      var nodes = document.querySelectorAll("script");
      for (var i = 0; i < nodes.length; i++) {
        scripts.push({ src: nodes[i].src || "", inline: !nodes[i].src });
      }
      return {
        url: location.href,
        host: location.hostname,
        listeners: state.listeners,
        listenerRegistrations: state.listeners.length,
        listenerRemovalCalls: listenerRemovalCalls,
        timers: state.timers,
        rafs: state.rafs,
        observers: state.observers,
        observerObservations: state.observerObservations,
        audioContexts: state.audioContexts,
        contextStates: state.contextRefs.map(function (entry) {
          return {
            frame: entry.frame,
            state: String(entry.context.state),
            currentTime: Number(entry.context.currentTime) || 0,
            sampleRate: Number(entry.context.sampleRate) || 0
          };
        }),
        workletNodes: state.workletNodes,
        mediaElementSources: state.mediaElementSources,
        doubledWiring: doubled,
        uncaught: state.uncaught,
        scriptElements: scripts,
        inlineScriptCalls: state.inlineScriptCalls,
        patches: patches,
        markers: presentMarkers,
        mediaElementCurrentTime: audio ? Number(audio.currentTime) || 0 : 0,
        mediaElementPaused: audio ? Boolean(audio.paused) : null,
        mediaElementPresent: Boolean(audio)
      };
    }
  };
})();`;

/** WAV data URI generated in memory: 2s, 440 Hz, mono, 8 kHz, PCM16. */
export function sineWavDataUri({ seconds = 2, frequency = 440, sampleRate = 8000 } = {}) {
  const frames = Math.floor(seconds * sampleRate);
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return `data:audio/wav;base64,${buffer.toString("base64")}`;
}
