// Shown in place of a feature page when the user isn't signed in. A centered
// "locked instrument" panel that matches the app's telemetry aesthetic and
// routes the user into the global sign-in modal.

export function SignedOutGate({ feature, onSignIn }: { feature: string; onSignIn: () => void }) {
  return (
    <div className="signed-out-gate">
      <div className="signed-out-panel">
        <div className="card-corner-marks"><i /></div>

        <div className="signed-out-emblem">
          <span className="signed-out-led" />
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="M12.5 12.5 L20 20" />
            <path d="M17 17 L20 14" />
            <path d="M14.5 19.5 L17.5 16.5" />
          </svg>
        </div>

        <div className="signed-out-eyebrow">// not linked</div>
        <div className="signed-out-title">Sign in required</div>
        <div className="signed-out-body">
          Sign in with your Garmin account to use <span className="signed-out-feature">{feature}</span>.
        </div>

        <button className="btn primary signed-out-btn" onClick={onSignIn}>Sign In</button>
      </div>
    </div>
  )
}
