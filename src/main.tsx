import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Prevent Chromium "ResizeObserver loop completed with undelivered notifications"
// triggered by React Flow / Monaco layout updates during the same observation pass.
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'function') {
  const NativeResizeObserver = window.ResizeObserver;
  const pendingByObserver = new WeakMap<
    ResizeObserver,
    { rafId: number; entries: Map<Element, ResizeObserverEntry>; callback: ResizeObserverCallback }
  >();

  window.ResizeObserver = class SafeResizeObserver extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      let state: {
        rafId: number;
        entries: Map<Element, ResizeObserverEntry>;
        callback: ResizeObserverCallback;
      };

      super((incomingEntries, observer) => {
        for (const entry of incomingEntries) {
          state.entries.set(entry.target, entry);
        }
        if (!state.rafId) {
          state.rafId = window.requestAnimationFrame(() => {
            state.rafId = 0;
            const batched = Array.from(state.entries.values());
            state.entries.clear();
            if (batched.length > 0) {
              state.callback(batched, observer);
            }
          });
        }
      });

      state = { rafId: 0, entries: new Map(), callback };
      pendingByObserver.set(this, state);
    }

    override disconnect(): void {
      const state = pendingByObserver.get(this);
      if (state) {
        if (state.rafId) {
          window.cancelAnimationFrame(state.rafId);
          state.rafId = 0;
        }
        state.entries.clear();
      }
      super.disconnect();
    }

    override unobserve(target: Element): void {
      const state = pendingByObserver.get(this);
      if (state) {
        state.entries.delete(target);
      }
      super.unobserve(target);
    }
  };

  window.addEventListener(
    'error',
    (event) => {
      if (
        typeof event.message === 'string' &&
        event.message.includes('ResizeObserver loop')
      ) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true
  );
}

createRoot(document.getElementById('root')!).render(<App />);

