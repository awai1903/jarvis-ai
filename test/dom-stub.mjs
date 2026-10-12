// Minimal browser stubs so the single-file app can boot inside jsdom.
// Canvas, WebAudio and speech APIs do not exist in jsdom; the app must
// tolerate their absence, so we both stub them and record if it explodes.
export function makeCanvasStub() {
  const noop = () => {};
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'createRadialGradient') return () => ({ addColorStop: noop });
        if (prop === 'createLinearGradient') return () => ({ addColorStop: noop });
        if (prop === 'getByteFrequencyData' || prop === 'getByteTimeDomainData') return () => {};
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'canvas') return { width: 0, height: 0 };
        return typeof prop === 'string' ? noop : undefined;
      },
      set() {
        return true;
      },
    }
  );
  return ctx;
}

export function installStubs(window, log) {
  const noop = () => {};
  window.HTMLCanvasElement.prototype.getContext = function () {
    return makeCanvasStub();
  };
  // jsdom reports clientWidth/clientHeight as 0 which is fine, but the app
  // reads devicePixelRatio and matchMedia, so give it sane values.
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop });
  }
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(window.performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  if (!window.AudioContext) {
    window.AudioContext = class {
      constructor() {
        this.state = 'running';
        this.destination = {};
      }
      createAnalyser() {
        return { fftSize: 256, frequencyBinCount: 128, connect: noop, getByteFrequencyData: noop, getByteTimeDomainData: noop };
      }
      createMediaStreamSource() {
        return { connect: noop };
      }
      createBuffer() {
        return { copyToChannel: noop };
      }
      createBufferSource() {
        return { connect: noop, start: noop, stop: noop };
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    };
  }
  if (!window.navigator.mediaDevices) {
    Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(new Error('stub')) }, configurable: true });
  }
  // Deliberately do NOT define SpeechRecognition or speechSynthesis: the app
  // must degrade gracefully when they are missing.
  window.fetch = () => {
    log.fetches.push('stub');
    return Promise.reject(new Error('network disabled in tests'));
  };
  window.scrollTo = noop;
}
