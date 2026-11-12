// Open a tab, install the instrument, navigate, read back what happened.

import { PROBE_SOURCE } from "./probe.mjs";

const PROBE_EXPRESSION = "JSON.stringify(window.__costProbe && window.__costProbe.installed ? window.__costProbe.read() : null)";

/** A fresh tab with the probe armed before the first script of any world. */
export async function openTab(client) {
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const contexts = [];
  const off = client.on((message) => {
    if (message.method !== "Runtime.executionContextCreated") return;
    if (message.sessionId !== sessionId) return;
    const context = message.params.context;
    contexts.push({
      id: context.id,
      origin: context.origin,
      name: context.name,
      type: context.auxData?.type ?? "unknown",
      frameId: context.auxData?.frameId ?? null,
    });
  });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_SOURCE, runImmediately: true }, sessionId);
  return { targetId, sessionId, contexts, close: () => closeTab(client, targetId, off) };
}

export async function closeTab(client, targetId, off) {
  try {
    off?.();
  } catch {
    /* listener already gone */
  }
  try {
    await client.send("Target.closeTarget", { targetId });
  } catch {
    /* tab already closed */
  }
}

/** Navigate and wait for the document to be complete, then let async work settle. */
export async function visit(client, sessionId, url, { settleMs = 1200, timeoutMs = 15000 } = {}) {
  await client.send("Page.navigate", { url }, sessionId);
  const deadline = Date.now() + timeoutMs;
  let readyState = "";
  while (Date.now() < deadline) {
    try {
      const result = await client.send(
        "Runtime.evaluate",
        { expression: "document.readyState + '|' + location.href", returnByValue: true },
        sessionId,
      );
      readyState = String(result.result?.value ?? "");
      if (readyState.startsWith("complete|") && !readyState.endsWith("|about:blank")) break;
    } catch {
      /* the context is being replaced mid-navigation */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return readyState;
}

export async function readProbe(client, sessionId) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression: PROBE_EXPRESSION, returnByValue: true },
    sessionId,
  );
  const raw = result.result?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Evaluate an expression inside an extension service worker. */
export async function evaluateInWorker(client, workerTargetId, expression, { awaitPromise = true } = {}) {
  const { sessionId } = await client.send("Target.attachToTarget", { targetId: workerTargetId, flatten: true });
  const result = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "worker evaluation failed");
  }
  return result.result?.value;
}

/** Evaluate an expression inside a specific execution context (an isolated world). */
export async function evaluateInContext(client, sessionId, contextId, expression) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, contextId },
    sessionId,
  );
  if (result.exceptionDetails) {
    return `probe threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"}`;
  }
  return String(result.result?.value ?? "");
}

/** The extension's own service worker target, waking it through its extension page if lazy. */
export async function findWorker(client, extensionId) {
  const wanted = `chrome-extension://${extensionId}/background.js`;
  let target = (await client.send("Target.getTargets")).targetInfos.find(
    (info) => info.type === "service_worker" && info.url === wanted,
  );
  if (target) return target;

  // Service workers are lazy: opening an extension page starts the worker.
  const { targetId } = await client.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup.html`,
  });
  try {
    for (let i = 0; i < 30 && !target; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      target = (await client.send("Target.getTargets")).targetInfos.find(
        (info) => info.type === "service_worker" && info.url === wanted,
      );
    }
  } finally {
    await client.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return target ?? null;
}

/**
 * Count per-extension activity out of one page read.
 * Attribution comes from the stack frame recorded at each registration.
 */
export function aggregate({ probe, contexts }, extensions) {
  const byPackage = {};
  for (const ext of extensions) {
    const origin = `chrome-extension://${ext.id}`;
    const frame = `extension:${ext.id}`;
    const own = (list) => (list ?? []).filter((entry) => entry.frame === frame).length;
    byPackage[ext.package] = {
      scripts: (contexts ?? []).filter((context) => context.origin === origin && context.type === "isolated").length,
      listeners: own(probe?.listeners),
      timers: own(probe?.timers) + own(probe?.rafs),
      observers: own(probe?.observers),
      patches: 0,
      audioContexts: own(probe?.audioContexts),
      audioContextsRunning: (probe?.contextStates ?? []).filter(
        (entry) => entry.frame === frame && entry.state === "running",
      ).length,
      audioContextTimes: (probe?.contextStates ?? [])
        .filter((entry) => entry.frame === frame)
        .map((entry) => `${entry.state}@${Number(entry.currentTime).toFixed(2)}s`),
      workletNodes: own(probe?.workletNodes),
      mediaElementSources: own(probe?.mediaElementSources),
    };
  }
  return byPackage;
}

/** Which loaded extensions opened an isolated world on this page, by extension id. */
export function isolatedWorlds(contexts) {
  return (contexts ?? []).filter((context) => context.type === "isolated");
}
