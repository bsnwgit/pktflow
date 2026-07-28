import { Component, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

// Root-level catch-all — without this, any uncaught render error anywhere in
// the tree unmounts the whole app and leaves a blank page with no on-screen
// indication of what happened (the error only exists in the browser console).
export default class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('pktFlow crashed:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen bg-gray-950 text-white p-6">
          <div className="max-w-lg space-y-3 text-center">
            <p className="text-lg font-semibold">Something went wrong</p>
            <p className="text-sm text-gray-400 font-mono break-words">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="text-xs text-gray-400 hover:text-white underline mt-2"
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
