import React from 'react';

interface Props {
  /** What the user calls this part of the window, e.g. “侧栏”. */
  name: string;
  children: React.ReactNode;
}
interface State {
  failed: boolean;
  generation: number;
}

/**
 * Keeps a failure inside one panel: the rest of the window keeps working, and this panel can be
 * rebuilt from scratch with “重新加载此面板”.
 */
export class PanelBoundary extends React.Component<Props, State> {
  state: State = { failed: false, generation: 0 };
  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[panel] ${this.props.name}`, error);
  }
  render() {
    if (this.state.failed)
      return (
        <div className="panel-error" role="alert" data-panel-error={this.props.name}>
          <p>{this.props.name}出了问题，窗口的其他部分不受影响。</p>
          <button
            className="secondary"
            data-action="reload-panel"
            onClick={() => this.setState((s) => ({ failed: false, generation: s.generation + 1 }))}
          >
            重新加载此面板
          </button>
        </div>
      );
    return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
  }
}
