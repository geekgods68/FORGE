/**
 * XR readiness states shown to the user (2D overlay and in-world panel).
 * Detection only reports what the browser says; "ready" does not prove that a
 * headset session will start, only that immersive-vr is reported as supported.
 */
export type XrState =
  | 'checking'
  | 'insecure-context'
  | 'no-webxr'
  | 'vr-unsupported'
  | 'ready'
  | 'entering'
  | 'in-xr'
  | 'exiting'
  | 'error';

export interface XrStatus {
  state: XrState;
  message: string;
}

interface XrEnv {
  isSecureContext: boolean;
  xr: { isSessionSupported(mode: 'immersive-vr'): Promise<boolean> } | undefined;
}

export async function detectXrSupport(env: XrEnv): Promise<XrStatus> {
  if (!env.isSecureContext) return status('insecure-context');
  if (!env.xr) return status('no-webxr');
  try {
    return status((await env.xr.isSessionSupported('immersive-vr')) ? 'ready' : 'vr-unsupported');
  } catch (e) {
    return status('error', `isSessionSupported failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function status(state: XrState, detail?: string): XrStatus {
  const base: Record<XrState, string> = {
    checking: 'Checking WebXR support…',
    'insecure-context': 'Not a secure context: WebXR needs HTTPS or localhost. See docs/HEADSET_ACCESS.md.',
    'no-webxr': 'This browser does not expose WebXR. Desktop mode only.',
    'vr-unsupported': 'WebXR present, but immersive VR is not supported here (no headset/runtime). Desktop mode only.',
    ready: 'Immersive VR available. Press “Enter VR”.',
    entering: 'Entering VR…',
    'in-xr': 'In VR session.',
    exiting: 'Exiting VR…',
    error: 'XR error.',
  };
  return { state, message: detail ? `${base[state]} ${detail}` : base[state] };
}

export const canEnter = (s: XrState) => s === 'ready';
