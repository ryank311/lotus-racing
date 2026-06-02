// Thin app-wide alert shown when the user is signed out but cached telemetry is
// still available — pages stay usable read-only; only syncing is blocked.

export function SignedOutBanner({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="signed-out-banner" role="status">
      <span className="signed-out-banner-dot" />
      <span className="signed-out-banner-text">
        <strong>Signed out</strong>
        <span className="signed-out-banner-sep">·</span>
        viewing cached telemetry — sign in to sync new sessions
      </span>
      <button className="signed-out-banner-btn" onClick={onSignIn}>Sign In</button>
    </div>
  )
}
