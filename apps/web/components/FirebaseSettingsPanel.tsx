'use client';

import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  Save,
  X,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { validateOptionalRuntimeUrl, YOUTUBE_CLOUD_ENABLE_URL } from '../lib/firebase';
import { useFirebase } from './FirebaseProvider';

interface FirebaseSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FirebaseSettingsPanel({ isOpen, onClose }: FirebaseSettingsPanelProps) {
  const {
    projectId,
    authReady,
    user,
    isAdmin,
    isOffline,
    runtimeConfig,
    signIn,
    signOut,
    saveRuntimeConfig,
  } = useFirebase();

  const [nextPublicApiUrl, setNextPublicApiUrl] = useState<string>(runtimeConfig.nextPublicApiUrl);
  const [fastapiUrl, setFastapiUrl] = useState<string>(runtimeConfig.fastapiUrl);
  const [useFirebaseYoutubeKey, setUseFirebaseYoutubeKey] = useState<boolean>(
    runtimeConfig.useFirebaseYoutubeKey
  );
  const [syncedFromDoc, setSyncedFromDoc] = useState<string>(
    `${runtimeConfig.nextPublicApiUrl}|${runtimeConfig.fastapiUrl}|${runtimeConfig.useFirebaseYoutubeKey}`
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sync local form fields cleanly if Firestore runtime doc updates externally
  const remoteSig = `${runtimeConfig.nextPublicApiUrl}|${runtimeConfig.fastapiUrl}|${runtimeConfig.useFirebaseYoutubeKey}`;
  if (remoteSig !== syncedFromDoc && !saving) {
    setSyncedFromDoc(remoteSig);
    setNextPublicApiUrl(runtimeConfig.nextPublicApiUrl);
    setFastapiUrl(runtimeConfig.fastapiUrl);
    setUseFirebaseYoutubeKey(runtimeConfig.useFirebaseYoutubeKey);
  }

  if (!isOpen) return null;

  async function handleSignIn() {
    setAuthBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await signIn();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Google sign-in failed.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    setAuthBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      await signOut();
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);

    const nextErr = validateOptionalRuntimeUrl(nextPublicApiUrl);
    if (nextErr) {
      setErrorMessage(`NEXT_PUBLIC_API_URL: ${nextErr}`);
      return;
    }
    const fastErr = validateOptionalRuntimeUrl(fastapiUrl);
    if (fastErr) {
      setErrorMessage(`FASTAPI_URL: ${fastErr}`);
      return;
    }

    setSaving(true);
    try {
      await saveRuntimeConfig({
        nextPublicApiUrl,
        fastapiUrl,
        useFirebaseYoutubeKey,
      });
      setStatusMessage('Saved to Firestore (/appConfig/runtime).');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not save Firebase runtime configuration.'
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Firebase backend configuration"
      className="mx-auto max-w-6xl px-4 pb-8 sm:px-6 lg:px-8"
    >
      <div className="rounded-lg border border-white/[0.1] bg-[#12161F] p-6">
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] pb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base font-semibold text-slate-100">
                Firebase &amp; Google Cloud Configuration
              </h2>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Project <span className="font-mono text-slate-200">{projectId}</span>
              <span aria-hidden="true" className="mx-1.5 text-slate-600">
                ·
              </span>
              Firestore document{' '}
              <span className="font-mono text-slate-300">/appConfig/runtime</span>
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Firebase configuration panel"
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/[0.06] hover:text-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {isOffline && (
          <div
            role="alert"
            className="mt-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-[#1A160E] px-3.5 py-2.5 text-xs text-amber-200"
          >
            <AlertCircle className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              Firestore client appears offline. Verify network connectivity and Firebase project
              settings.
            </span>
          </div>
        )}

        {/* Auth status row */}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/[0.08] pb-4">
          <div className="text-xs text-slate-300">
            {!authReady ? (
              <span className="text-slate-400">Checking Firebase Auth session…</span>
            ) : user ? (
              <span>
                Signed in as{' '}
                <span className="font-medium text-slate-100">
                  {user.email ?? user.displayName ?? 'Authenticated user'}
                </span>
                {isAdmin && (
                  <>
                    <span aria-hidden="true" className="mx-1.5 text-slate-600">
                      ·
                    </span>
                    <span className="text-emerald-400 font-medium">Admin</span>
                  </>
                )}
              </span>
            ) : (
              <span className="text-slate-400">
                Sign in with Google to save playlists to Firestore or edit runtime backend URLs.
              </span>
            )}
          </div>

          {authReady && (
            <div className="shrink-0">
              {user ? (
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => {
                    void handleSignOut();
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-white/[0.12] px-3.5 text-xs font-medium text-slate-200 hover:bg-white/[0.06] transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Sign out</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => {
                    void handleSignIn();
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-slate-100 px-3.5 text-xs font-semibold text-slate-950 hover:bg-white transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  {authBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  <span>Sign in with Google</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Runtime endpoint & Google Cloud YouTube API mode form */}
        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="firebase-next-public-api-url"
                className="block text-xs font-medium text-slate-200 mb-1.5"
              >
                NEXT_PUBLIC_API_URL (Browser API Origin)
              </label>
              <input
                id="firebase-next-public-api-url"
                type="url"
                value={nextPublicApiUrl}
                onChange={(e) => setNextPublicApiUrl(e.target.value)}
                disabled={!isAdmin || saving}
                placeholder="Leave blank for same-origin /api (or https://api.example.com)"
                className="h-10 w-full rounded-md border border-white/[0.12] bg-[#0A0D12] px-3 text-xs font-mono text-slate-100 placeholder:text-slate-500 disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </div>

            <div>
              <label
                htmlFor="firebase-fastapi-url"
                className="block text-xs font-medium text-slate-200 mb-1.5"
              >
                FASTAPI_URL (Server Proxy Target)
              </label>
              <input
                id="firebase-fastapi-url"
                type="url"
                value={fastapiUrl}
                onChange={(e) => setFastapiUrl(e.target.value)}
                disabled={!isAdmin || saving}
                placeholder="http://localhost:8000 (or deployed FastAPI Cloud Run URL)"
                className="h-10 w-full rounded-md border border-white/[0.12] bg-[#0A0D12] px-3 text-xs font-mono text-slate-100 placeholder:text-slate-500 disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-md border border-white/[0.08] bg-[#0A0D12] p-4 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={useFirebaseYoutubeKey}
                onChange={(e) => setUseFirebaseYoutubeKey(e.target.checked)}
                disabled={!isAdmin || saving}
                className="mt-0.5 h-4 w-4 rounded border-white/25 bg-[#12161F] text-emerald-500 accent-emerald-500 disabled:opacity-50"
              />
              <span className="text-xs leading-relaxed text-slate-300">
                <span className="font-medium text-slate-100 block">
                  Use provisioned Google Cloud project for YouTube Data API v3
                </span>
                Server routes use <span className="font-mono text-slate-200">YOUTUBE_API_KEY</span>{' '}
                env var first, then fall back server-side to project{' '}
                <span className="font-mono text-slate-200">{projectId}</span>.
              </span>
            </label>

            <a
              href={YOUTUBE_CLOUD_ENABLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.12] px-3 text-xs font-medium text-slate-200 hover:bg-white/[0.06] transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
            >
              <span>Enable YouTube API</span>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>

          {errorMessage && (
            <p role="alert" className="text-xs text-red-400">
              {errorMessage}
            </p>
          )}
          {statusMessage && (
            <p role="status" className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{statusMessage}</span>
            </p>
          )}

          <div className="flex items-center justify-between gap-4 pt-1">
            <p className="text-[11px] text-slate-500">
              {isAdmin
                ? 'Changes sync immediately to Firestore and apply to new playlist requests.'
                : 'Sign in with the project administrator account to edit Firestore runtime URLs.'}
            </p>

            {isAdmin && (
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-emerald-500 px-4 text-xs font-semibold text-slate-950 hover:bg-emerald-400 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>Save to Firestore</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
