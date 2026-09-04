/**
 * The last line of defence, and the only one that can still save the document.
 *
 * ── What React does without one ─────────────────────────────────────────────
 *
 * Since React 16, an uncaught error during render unmounts the **entire tree**.
 * Not the broken component — everything. The deliberate reasoning is that a
 * half-rendered UI is more dangerous than no UI, and for a banking screen that
 * is obviously right. For a drawing app it means: white page, and the user's
 * work is gone from the screen with no way to reach it.
 *
 * ── The design rule that shapes this file ───────────────────────────────────
 *
 * **A recovery path must not depend on the thing that failed.**
 *
 * The obvious implementation asks the Engine for the document and offers it as a
 * download. It is also useless, because the most likely reason we are here is
 * that the Engine is in a state that throws. So this component talks to
 * IndexedDB directly, through its own `DocumentStore` instance, and never
 * touches the engine, the scene, or any React context above it.
 *
 * What it hands back is the last autosaved document (Phase 8). That may be up to
 * `SAVE_DEBOUNCE_MS` old — 1.2 seconds of drawing, worst case — and saying so
 * plainly is better than implying it is current. A recovery UI that overstates
 * what it recovered is how someone loses work while being told they did not.
 *
 * ── Why the reload button clears nothing ────────────────────────────────────
 *
 * Tempting: "Reset the app" that wipes storage, because a corrupt document is a
 * plausible cause of the crash. Also the single most destructive button it is
 * possible to put on this screen — one click, and the thing the user came back
 * for is gone. Phase 8's `restore()` already drops what it cannot parse, so a
 * plain reload is very likely to work; and if it does not, the user still has
 * the file this panel just gave them. Offer the download first, and never offer
 * to delete.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { DocumentStore } from '@engine/persist/storage';
import { rescueDocument } from '@engine/persist/rescue';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
  readonly componentStack: string | null;
  readonly rescue: 'idle' | 'working' | 'saved' | 'empty' | 'failed';
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null, rescue: 'idle' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /* The component stack is the genuinely useful half — it names which
       component threw, which the message rarely does. Kept in state and shown
       behind a <details>, because the user cannot act on it but the person they
       report the bug to very much can. In a deployed app this is where a
       Sentry/Bugsnag call goes; there is no error-reporting service in this
       project and inventing one to look professional would be worse than the
       gap. */
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[ErrorBoundary] React tree unmounted:', error, info.componentStack);
  }

  private readonly download = async (): Promise<void> => {
    this.setState({ rescue: 'working' });

    /* A fresh store, opened here, using nothing from the crashed tree. */
    const store = new DocumentStore();
    try {
      const opened = await store.open();
      const outcome = await rescueDocument(async () =>
        opened ? await store.load() : Promise.reject(new Error('storage unavailable')),
      );

      if (outcome.kind !== 'saved') {
        this.setState({ rescue: outcome.kind });
        return;
      }

      const url = URL.createObjectURL(new Blob([outcome.json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = outcome.filename;
      a.click();
      // Next macrotask, matching png.ts: revoking synchronously races the
      // browser's own read of the URL and yields a zero-byte file in Safari.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.setState({ rescue: 'saved' });
    } finally {
      store.close();
    }
  };

  override render(): ReactNode {
    const { error, componentStack, rescue } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="crash" role="alert">
        <div className="crash__panel">
          <h1 className="crash__title">The editor stopped.</h1>
          <p className="crash__body">
            Something in the interface threw an error and React unmounted the page.
            Your drawing is not lost — it was autosaved to this browser, and you can
            take a copy of it before doing anything else.
          </p>

          <div className="crash__actions">
            <button
              type="button"
              className="crash__button crash__button--primary"
              onClick={() => void this.download()}
              disabled={rescue === 'working'}
            >
              {rescue === 'working' ? 'Saving…' : 'Download my drawing'}
            </button>
            <button
              type="button"
              className="crash__button"
              onClick={() => window.location.reload()}
            >
              Reload the editor
            </button>
          </div>

          {rescue === 'saved' && (
            <p className="crash__note crash__note--ok">
              Saved. Note this is the last autosave, so up to a second of the most
              recent work may be missing.
            </p>
          )}
          {rescue === 'empty' && (
            <p className="crash__note">
              Nothing was autosaved yet — this looks like a new drawing.
            </p>
          )}
          {rescue === 'failed' && (
            <p className="crash__note crash__note--bad">
              Could not read the autosave. Reloading may still work; the document
              is stored in this browser, not in this page.
            </p>
          )}

          <details className="crash__details">
            <summary>Technical detail</summary>
            <pre className="crash__stack">
              {error.message}
              {componentStack ?? ''}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
