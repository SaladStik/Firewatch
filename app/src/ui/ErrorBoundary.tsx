/** Keeps a broken panel from unmounting the whole app (and the map with it). */
import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode; name: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[ui] ${this.props.name} crashed`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel pointer-events-auto px-3 py-2 text-[11px] text-ink-dim">
        {this.props.name} hit an error.{" "}
        <button className="text-phos underline" onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
  }
}
