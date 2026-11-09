/*
 * Castle browser observer v0.1
 * Chrome DevTools > Sources > Snippets: paste this entire file and run.
 * Passive tracing only: no requests are sent and no token/header values are exported.
 * Run after page load for late-stage observation; see the accompanying guide for
 * the limitation concerning SDK initialization before the snippet is installed.
 */
(() => {
  'use strict';

  const root = globalThis;
  if (root.__castleObserver?.version === '0.1.0') {
    console.info('[CastleObserver] Already installed; call __castleObserver.status()');
    return;
  }

  const settings = Object.freeze({
    maxEvents: 8000,
    maxEventsPerApi: 240,
    captureStack: true,
    maxStackLines: 5,
  });
  const started = new Date().toISOString();
  const nativeNow = root.performance?.now?.bind(root.performance) ?? (() => Date.now());
  const patches = [];
  const events = [];
  const counters = new Map();
  const latestTokens = [];
  const requests = new Map();
  let seq = 0;
  let requestSeq = 0;
  let dropped = 0;
  let active = true;

  function stack() {
    if (!settings.captureStack) return undefined;
    const lines = (new Error().stack ?? '').split('\n').slice(3, 3 + settings.maxStackLines);
    return lines.map(line => line
      .replace(/(https?:\/\/[^\s?#)]+)[^\s)]*/g, '$1')
      .trim());
  }

  function summary(value) {
    if (value === null) return null;
    const type = typeof value;
    if (type === 'undefined') return {type};
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'string') {
      // Never persist long opaque strings; these may be credentials or fingerprints.
      return value.length > 200 ? {type: 'string', length: value.length} : value;
    }
    if (type === 'bigint') return {type, value: String(value)};
    if (type === 'function') return {type};
    if (ArrayBuffer.isView(value)) {
      const length = value.length ?? value.byteLength;
      return {type: value.constructor?.name ?? 'TypedArray', length,
        ...(typeof value.length === 'number' && length <= 16 ? {values: Array.from(value)} : {})};
    }
    if (Array.isArray(value)) {
      return {type: 'Array', length: value.length, first: value.slice(0, 12).map(summary)};
    }
    if (value instanceof Promise) return {type: 'Promise'};
    let name = 'Object';
    try { name = Object.getPrototypeOf(value)?.constructor?.name || name; } catch {}
    let length;
    try {
      if (typeof value.length === 'number') length = value.length;
      else if (typeof value.size === 'number') length = value.size;
    } catch {}
    return {type: name, ...(length === undefined ? {} : {length})};
  }

  function emit(api, data = {}) {
    if (!active) return;
    const count = (counters.get(api) ?? 0) + 1;
    counters.set(api, count);
    if (events.length >= settings.maxEvents || count > settings.maxEventsPerApi) {
      dropped++;
      return;
    }
    events.push({seq: ++seq, ms: Math.round(nativeNow() * 100) / 100, api, ...data,
      ...(settings.captureStack ? {stack: stack()} : {})});
  }

  function patchDescriptor(object, property, descriptor) {
    if (!object) return false;
    const previous = Object.getOwnPropertyDescriptor(object, property);
    if (!previous || !previous.configurable) return false;
    try {
      Object.defineProperty(object, property, descriptor);
      patches.push(() => Object.defineProperty(object, property, previous));
      return true;
    } catch { return false; }
  }

  function getter(object, property, label) {
    if (!object) return;
    const desc = Object.getOwnPropertyDescriptor(object, property);
    if (!desc?.get) return;
    patchDescriptor(object, property, {...desc, get: function () {
      try {
        const value = Reflect.apply(desc.get, this, []);
        emit(label, {result: summary(value)});
        return value;
      } catch (error) {
        emit(label, {threw: error?.name ?? 'Error'});
        throw error;
      }
    }});
  }

  function method(object, property, label, project = (args, result) => ({
    args: args.map(summary), result: summary(result),
  })) {
    if (!object) return;
    const desc = Object.getOwnPropertyDescriptor(object, property);
    if (typeof desc?.value !== 'function') return;
    const original = desc.value;
    patchDescriptor(object, property, {...desc, value: function (...args) {
      let result;
      try { result = Reflect.apply(original, this, args); }
      catch (error) {
        emit(label, {threw: error?.name ?? 'Error'});
        throw error;
      }
      try { emit(label, project(args, result, this)); } catch {}
      return result;
    }});
  }

  function prototype(name) {
    return typeof root[name] === 'function' ? root[name].prototype : undefined;
  }

  // Navigator, Screen, Window, Document and Performance: observed reads only.
  for (const key of [
    'userAgent', 'platform', 'vendor', 'language', 'languages', 'hardwareConcurrency',
    'deviceMemory', 'maxTouchPoints', 'webdriver', 'plugins', 'mimeTypes',
    'cookieEnabled', 'onLine', 'pdfViewerEnabled', 'userAgentData',
  ]) getter(prototype('Navigator'), key, `Navigator.${key}`);
  for (const key of ['width', 'height', 'availWidth', 'availHeight',
    'colorDepth', 'pixelDepth', 'availLeft', 'availTop']) {
    getter(prototype('Screen'), key, `Screen.${key}`);
  }
  for (const key of ['devicePixelRatio', 'innerWidth', 'innerHeight',
    'outerWidth', 'outerHeight', 'screenX', 'screenY']) {
    getter(root, key, `Window.${key}`);
  }
  for (const key of ['visibilityState', 'hidden', 'characterSet', 'compatMode']) {
    getter(prototype('Document'), key, `Document.${key}`);
  }
  for (const key of ['timeOrigin', 'memory', 'timing', 'navigation']) {
    getter(prototype('Performance'), key, `Performance.${key}`);
  }
  for (const key of ['length']) {
    getter(prototype('PluginArray'), key, `PluginArray.${key}`);
    getter(prototype('MimeTypeArray'), key, `MimeTypeArray.${key}`);
  }

  method(root, 'matchMedia', 'Window.matchMedia', ([query], result) => ({
    query: String(query).slice(0, 200), matches: !!result?.matches,
  }));
  method(root, 'getComputedStyle', 'Window.getComputedStyle', ([el, pseudo]) => ({
    element: el?.tagName ?? null, pseudo: pseudo ?? null,
  }));
  method(prototype('Document'), 'querySelector', 'Document.querySelector', ([selector]) => ({
    selector: String(selector).slice(0, 160),
  }));
  method(prototype('Document'), 'createElement', 'Document.createElement', ([tag]) => ({
    tag: String(tag),
  }));
  method(prototype('CSSStyleDeclaration'), 'getPropertyValue', 'CSS.getPropertyValue', ([name], result) => ({
    property: String(name), result: summary(result),
  }));

  // Font and CSS tests (observing SDK calls, not synthesizing measurements).
  method(prototype('FontFaceSet'), 'check', 'FontFaceSet.check', ([font, text], result) => ({
    font: String(font).slice(0, 160), textLength: String(text ?? '').length, result,
  }));
  method(prototype('FontFaceSet'), 'load', 'FontFaceSet.load', ([font, text]) => ({
    font: String(font).slice(0, 160), textLength: String(text ?? '').length,
  }));
  method(prototype('CanvasRenderingContext2D'), 'measureText', 'Canvas2D.measureText', ([text], result, self) => ({
    textLength: String(text).length, textSample: String(text).slice(0, 40),
    font: String(self.font).slice(0, 180), width: result?.width,
  }));

  // Canvas and WebGL: output properties/size, never raw image pixels or Data URLs.
  method(prototype('HTMLCanvasElement'), 'getContext', 'Canvas.getContext', ([kind], result) => ({
    kind: String(kind), available: result !== null,
  }));
  method(prototype('HTMLCanvasElement'), 'toDataURL', 'Canvas.toDataURL', ([type], result) => ({
    mime: type ?? 'image/png', resultLength: result?.length ?? null,
  }));
  method(prototype('HTMLCanvasElement'), 'toBlob', 'Canvas.toBlob', ([, type]) => ({
    mime: type ?? 'image/png',
  }));
  method(prototype('CanvasRenderingContext2D'), 'getImageData', 'Canvas2D.getImageData', ([x, y, w, h], result) => ({
    x, y, width: w, height: h, dataLength: result?.data?.length,
  }));
  for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const proto = prototype(name);
    for (const [api, key] of [
      ['getParameter', 'parameter'], ['getExtension', 'extension'],
      ['getSupportedExtensions', 'extensions'],
      ['getShaderPrecisionFormat', 'precision'],
      ['getContextAttributes', 'contextAttributes'],
    ]) {
      method(proto, api, `${name}.${api}`, (args, result) => ({
        [key]: args.map(summary), result: summary(result),
      }));
    }
  }

  // Web Audio: the contents of buffers are deliberately not persisted.
  for (const name of ['AudioContext', 'OfflineAudioContext', 'BaseAudioContext']) {
    for (const api of ['createOscillator', 'createAnalyser', 'createDynamicsCompressor']) {
      method(prototype(name), api, `${name}.${api}`);
    }
  }
  method(prototype('AudioBuffer'), 'getChannelData', 'AudioBuffer.getChannelData', ([channel], result) => ({
    channel, length: result?.length,
  }));
  for (const api of ['getFloatFrequencyData', 'getByteFrequencyData', 'getFloatTimeDomainData']) {
    method(prototype('AnalyserNode'), api, `AnalyserNode.${api}`, ([buffer]) => ({
      outputLength: buffer?.length,
    }));
  }

  // A small event-registration trace can expose initialization and interactions.
  const eventTarget = prototype('EventTarget');
  const addEventListenerDescriptor = eventTarget && Object.getOwnPropertyDescriptor(eventTarget, 'addEventListener');
  if (typeof addEventListenerDescriptor?.value === 'function') {
    patchDescriptor(eventTarget, 'addEventListener', {...addEventListenerDescriptor,
      value: function (...args) {
        if (this === root || this === root.document) {
          emit('EventTarget.addEventListener', {target: this === root ? 'window' : 'document',
            eventType: String(args[0])});
        }
        return Reflect.apply(addEventListenerDescriptor.value, this, args);
      },
    });
  }

  // Keep a few fresh SDK tokens only in this closure to match them against
  // subsequent request HEADER values. Never put the token in the exported log.
  function rememberToken(token) {
    if (typeof token !== 'string' || token.length === 0) return;
    latestTokens.unshift(token);
    if (latestTokens.length > 5) latestTokens.length = 5;
    emit('SDK.token.resolved', {length: token.length});
  }

  function headerInfo(headers) {
    const names = [];
    const tokenHeaderNames = [];
    if (!headers) return {names, tokenHeaderNames};
    try {
      new Headers(headers).forEach((value, name) => {
        names.push(name);
        if (latestTokens.some(t => value.includes(t))) tokenHeaderNames.push(name);
      });
    } catch {}
    return {names, tokenHeaderNames};
  }

  function safeURL(input) {
    try {
      const url = new URL(String(input), root.location.href);
      return `${url.origin}${url.pathname}`; // Query string & fragment excluded.
    } catch { return '[invalid URL]'; }
  }

  // Network observation: HTTP code + method + path + header NAMES only.
  // No request bodies, cookies, authorization values or response contents.
  const fetchDescriptor = Object.getOwnPropertyDescriptor(root, 'fetch');
  if (typeof fetchDescriptor?.value === 'function') {
    const originalFetch = fetchDescriptor.value;
    patchDescriptor(root, 'fetch', {...fetchDescriptor, value: function (...args) {
      const input = args[0];
      const init = args[1];
      const id = ++requestSeq;
      const methodName = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      const href = safeURL(input?.url ?? input);
      const headers = headerInfo(init?.headers ?? input?.headers);
      requests.set(id, {id, transport: 'fetch', method: methodName, url: href,
        headerNames: headers.names, tokenHeaderNames: headers.tokenHeaderNames});
      emit('fetch.start', {id, method: methodName, url: href, ...headers});
      let result;
      try { result = Reflect.apply(originalFetch, this, args); }
      catch (error) {
        emit('fetch.throw', {id, errorName: error?.name ?? 'Error'});
        throw error;
      }
      Promise.resolve(result).then(response => {
        const r = requests.get(id);
        if (r) Object.assign(r, {status: response.status, ok: response.ok});
        emit('fetch.end', {id, status: response.status, ok: response.ok});
      }, error => {
        const r = requests.get(id);
        if (r) r.errorName = error?.name ?? 'Error';
        emit('fetch.reject', {id, errorName: error?.name ?? 'Error'});
      });
      return result;
    }});
  }

  const xhrPrototype = prototype('XMLHttpRequest');
  const xhrState = new WeakMap();
  function patchXhr(name, replacement) {
    const descriptor = xhrPrototype && Object.getOwnPropertyDescriptor(xhrPrototype, name);
    if (typeof descriptor?.value === 'function') {
      patchDescriptor(xhrPrototype, name, {...descriptor,
        value: function (...args) { return replacement.call(this, descriptor.value, args); },
      });
    }
  }
  patchXhr('open', function (original, args) {
    const [methodName, url] = args;
    xhrState.set(this, {id: ++requestSeq, transport: 'xhr',
      method: String(methodName).toUpperCase(), url: safeURL(url),
      headerNames: [], tokenHeaderNames: []});
    return Reflect.apply(original, this, args);
  });
  patchXhr('setRequestHeader', function (original, args) {
    const state = xhrState.get(this);
    if (state) {
      const [name, value] = args;
      const lower = String(name).toLowerCase();
      state.headerNames.push(lower);
      if (latestTokens.some(t => String(value).includes(t))) state.tokenHeaderNames.push(lower);
    }
    return Reflect.apply(original, this, args);
  });
  patchXhr('send', function (original, args) {
    const state = xhrState.get(this);
    if (state) {
      requests.set(state.id, state);
      emit('xhr.start', {...state});
      // Native addEventListener avoids a redundant trace event.
      const listen = addEventListenerDescriptor?.value ?? this.addEventListener;
      Reflect.apply(listen, this, ['loadend', () => {
        state.status = this.status;
        state.ok = this.status >= 200 && this.status < 300;
        emit('xhr.end', {id: state.id, status: this.status, ok: state.ok});
      }, {once: true}]);
    }
    return Reflect.apply(original, this, args);
  });

  function watchSdk(sdk, label = 'castle') {
    if (!sdk || (typeof sdk !== 'object' && typeof sdk !== 'function')) {
      return {ok: false, reason: 'Expected a configured SDK object'};
    }
    let count = 0;
    for (const key of ['configure', 'createRequestToken']) {
      let owner = sdk;
      while (owner && !Object.getOwnPropertyDescriptor(owner, key)) {
        owner = Object.getPrototypeOf(owner);
      }
      const desc = owner && Object.getOwnPropertyDescriptor(owner, key);
      if (!owner || typeof desc?.value !== 'function') continue;
      const original = desc.value;
      if (patchDescriptor(owner, key, {...desc, value: function (...args) {
        emit(`SDK.${key}.start`, {label, argumentCount: args.length});
        let result;
        try { result = Reflect.apply(original, this, args); }
        catch (error) {
          emit(`SDK.${key}.throw`, {label, errorName: error?.name ?? 'Error'});
          throw error;
        }
        Promise.resolve(result).then(value => {
          if (key === 'createRequestToken') rememberToken(value);
          else {
            emit('SDK.configure.resolved', {label, result: summary(value)});
            if (value && value !== sdk) watchSdk(value, `${label}.configured`);
          }
        }, error => {
          emit(`SDK.${key}.reject`, {label, errorName: error?.name ?? 'Error'});
        });
        return result;
      }})) count++;
    }
    emit('observer.watchSdk', {label, patchedMethods: count});
    return {ok: count > 0, patchedMethods: count};
  }

  function mark(label, extra = {}) {
    emit('observer.mark', {label: String(label).slice(0, 100),
      note: typeof extra.note === 'string' ? extra.note.slice(0, 200) : undefined});
  }

  // Intentional, active probes. Run ONLY after the request being validated;
  // creating a WebGL context / reading fonts can change observable page state.
  function snapshotEnvironment() {
    function read(fn) {
      try { return fn(); } catch (error) { return {errorName: error?.name ?? 'Error'}; }
    }
    const nav = root.navigator;
    const doc = root.document;
    const screen = root.screen;
    const snapshot = {
      at: new Date().toISOString(),
      navigator: read(() => ({
        userAgent: nav.userAgent, platform: nav.platform, vendor: nav.vendor,
        languages: Array.from(nav.languages), hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory ?? null, maxTouchPoints: nav.maxTouchPoints,
        webdriver: nav.webdriver, pdfViewerEnabled: nav.pdfViewerEnabled,
        plugins: Array.from(nav.plugins, p => ({name: p.name, filename: p.filename})),
        mimeTypes: Array.from(nav.mimeTypes, m => m.type),
      })),
      window: read(() => ({devicePixelRatio: root.devicePixelRatio,
        innerWidth: root.innerWidth, innerHeight: root.innerHeight,
        outerWidth: root.outerWidth, outerHeight: root.outerHeight})),
      screen: read(() => ({width: screen.width, height: screen.height,
        availWidth: screen.availWidth, availHeight: screen.availHeight,
        colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth})),
      document: read(() => ({visibilityState: doc.visibilityState,
        fontsStatus: doc.fonts?.status ?? null, fontsSize: doc.fonts?.size ?? null,
        stylesheetCount: doc.styleSheets?.length ?? null})),
      performance: read(() => ({timeOrigin: root.performance?.timeOrigin,
        memory: root.performance?.memory ? {
          jsHeapSizeLimit: root.performance.memory.jsHeapSizeLimit,
          totalJSHeapSize: root.performance.memory.totalJSHeapSize,
          usedJSHeapSize: root.performance.memory.usedJSHeapSize,
        } : null})),
      webgl: read(() => {
        const canvas = doc.createElement('canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return {available: false};
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          available: true, version: gl.getParameter(gl.VERSION),
          vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
          shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
          maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
          extensions: gl.getSupportedExtensions(),
        };
      }),
    };
    emit('observer.environmentSnapshot', {snapshot});
    return snapshot;
  }

  function status() {
    return {
      version: '0.1.0', active, started, eventCount: events.length, dropped,
      installedPatches: patches.length,
      counts: Object.fromEntries([...counters].sort((a, b) => b[1] - a[1])),
      tokenCountInMemory: latestTokens.length,
      requests: [...requests.values()].map(x => ({...x})),
    };
  }

  function jsonl() {
    return [JSON.stringify({type: 'metadata', ...status(),
      requests: undefined, counts: undefined}),
      ...events.map(event => JSON.stringify({type: 'event', ...event})),
      ...[...requests.values()].map(request => JSON.stringify({type: 'request', ...request})),
      JSON.stringify({type: 'counts', counts: status().counts})].join('\n') + '\n';
  }

  function download() {
    const blob = new Blob([jsonl()], {type: 'application/x-ndjson'});
    const url = URL.createObjectURL(blob);
    const a = root.document.createElement('a');
    a.href = url;
    a.download = `castle-browser-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return {eventCount: events.length, dropped};
  }

  function stop() {
    if (!active) return status();
    active = false;
    for (const restore of patches.reverse()) {
      try { restore(); } catch {}
    }
    latestTokens.length = 0;
    return status();
  }

  Object.defineProperty(root, '__castleObserver', {
    configurable: true, value: Object.freeze({version: '0.1.0', settings, mark,
      watchSdk, snapshotEnvironment, status, jsonl, download, stop}),
  });
  emit('observer.ready', {origin: root.location?.origin ?? null});
  console.info('[CastleObserver] Active. Mark the next action with __castleObserver.mark("before-request").');
})();
