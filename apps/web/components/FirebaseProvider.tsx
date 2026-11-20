'use client';

import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  FIREBASE_DATABASE_ID,
  FIREBASE_PROJECT_ID,
  getFirebaseAuth,
  getFirebaseDb,
  handleFirestoreError,
  OperationType,
  signInWithGooglePopup,
  signOutFirebaseUser,
  testFirestoreConnection,
  toSafeFirestoreDocId,
  validateOptionalRuntimeUrl,
} from '../lib/firebase';
import type { PlaylistData, PlaylistSource } from '../lib/types';

export interface AppRuntimeConfig {
  nextPublicApiUrl: string;
  fastapiUrl: string;
  useFirebaseYoutubeKey: boolean;
  existsInFirestore: boolean;
}

export interface SavedPlaylistRecord {
  docId: string;
  playlistId: string;
  source: PlaylistSource;
  url: string;
  name: string;
  ownerName: string;
  artworkUrl: string;
  trackCount: number;
  matchedCount: number;
}

interface FirebaseContextValue {
  projectId: string;
  databaseId: string;
  authReady: boolean;
  user: User | null;
  isAdmin: boolean;
  isOffline: boolean;
  runtimeConfig: AppRuntimeConfig;
  savedPlaylists: SavedPlaylistRecord[];
  firestoreError: string | null;
  clearFirestoreError: () => void;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  saveRuntimeConfig: (input: {
    nextPublicApiUrl: string;
    fastapiUrl: string;
    useFirebaseYoutubeKey: boolean;
  }) => Promise<void>;
  savePlaylistBookmark: (
    playlist: PlaylistData,
    url: string,
    matchedCount: number
  ) => Promise<void>;
  deletePlaylistBookmark: (docId: string) => Promise<void>;
}

const DEFAULT_RUNTIME_CONFIG: AppRuntimeConfig = {
  nextPublicApiUrl: '',
  fastapiUrl: '',
  useFirebaseYoutubeKey: true,
  existsInFirestore: false,
};

const BOOTSTRAPPED_ADMIN_EMAIL = 'zenitech007@gmail.com';

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

export function FirebaseProvider({ children }: { children: ReactNode }) {
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [user, setUser] = useState<User | null>(null);
  const [adminDocUid, setAdminDocUid] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState<boolean>(false);
  const [runtimeConfig, setRuntimeConfig] = useState<AppRuntimeConfig>(DEFAULT_RUNTIME_CONFIG);
  const [savedPlaylistsState, setSavedPlaylistsState] = useState<{
    uid: string | null;
    rows: SavedPlaylistRecord[];
  }>({ uid: null, rows: [] });
  const [firestoreError, setFirestoreError] = useState<string | null>(null);

  const isBootstrappedAdmin = Boolean(
    authReady &&
    user &&
    user.emailVerified &&
    user.email?.toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL
  );
  const isAdmin =
    isBootstrappedAdmin ||
    Boolean(authReady && user && user.emailVerified && adminDocUid === user.uid);

  const savedPlaylists = useMemo(
    () =>
      authReady && user && savedPlaylistsState.uid === user.uid ? savedPlaylistsState.rows : [],
    [authReady, savedPlaylistsState, user]
  );

  // Boot connectivity probe & auth listener
  useEffect(() => {
    let active = true;
    void testFirestoreConnection().then((ok) => {
      if (active && !ok) {
        setIsOffline(true);
      }
    });

    const auth = getFirebaseAuth();
    const unsubAuth = onAuthStateChanged(auth, (nextUser) => {
      if (!active) return;
      setUser(nextUser);
      setAuthReady(true);
    });

    return () => {
      active = false;
      unsubAuth();
    };
  }, []);

  // Determine admin privilege from /admins/{uid} when not bootstrapped admin
  useEffect(() => {
    let active = true;
    if (!authReady || !user || !user.emailVerified || isBootstrappedAdmin) {
      return;
    }

    const db = getFirebaseDb();
    const uid = user.uid;
    void getDoc(doc(db, 'admins', uid))
      .then((snap) => {
        if (active) {
          setAdminDocUid(snap.exists() ? uid : null);
        }
      })
      .catch(() => {
        if (active) {
          setAdminDocUid(null);
        }
      });

    return () => {
      active = false;
    };
  }, [authReady, isBootstrappedAdmin, user]);

  // Subscribe to singleton non-secret /appConfig/runtime document
  useEffect(() => {
    const db = getFirebaseDb();
    const configPath = 'appConfig/runtime';
    const unsub = onSnapshot(
      doc(db, 'appConfig', 'runtime'),
      (snap) => {
        if (!snap.exists()) {
          setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
          return;
        }
        const data = snap.data() as Record<string, unknown>;
        setRuntimeConfig({
          nextPublicApiUrl: typeof data.nextPublicApiUrl === 'string' ? data.nextPublicApiUrl : '',
          fastapiUrl: typeof data.fastapiUrl === 'string' ? data.fastapiUrl : '',
          useFirebaseYoutubeKey:
            typeof data.useFirebaseYoutubeKey === 'boolean' ? data.useFirebaseYoutubeKey : true,
          existsInFirestore: true,
        });
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.GET, configPath);
        } catch (wrapped) {
          setFirestoreError(wrapped instanceof Error ? wrapped.message : String(wrapped));
        }
      }
    );

    return () => unsub();
  }, []);

  // Subscribe to signed-in user's saved playlists only when authReady && user
  useEffect(() => {
    if (!authReady || !user) {
      return;
    }

    const db = getFirebaseDb();
    const uid = user.uid;
    const playlistsPath = `users/${uid}/playlists`;
    const q = query(
      collection(db, 'users', uid, 'playlists'),
      where('ownerId', '==', uid),
      orderBy('updatedAt', 'desc'),
      limit(12)
    );

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const rows: SavedPlaylistRecord[] = snapshot.docs.map((docSnap) => {
          const d = docSnap.data() as Record<string, unknown>;
          const src = d.source;
          const source: PlaylistSource =
            src === 'deezer' || src === 'spotify' || src === 'youtube' ? src : 'deezer';
          return {
            docId: docSnap.id,
            playlistId: typeof d.playlistId === 'string' ? d.playlistId : docSnap.id,
            source,
            url: typeof d.url === 'string' ? d.url : '',
            name: typeof d.name === 'string' ? d.name : 'Saved Playlist',
            ownerName: typeof d.ownerName === 'string' ? d.ownerName : '',
            artworkUrl: typeof d.artworkUrl === 'string' ? d.artworkUrl : '',
            trackCount: typeof d.trackCount === 'number' ? d.trackCount : 0,
            matchedCount: typeof d.matchedCount === 'number' ? d.matchedCount : 0,
          };
        });
        setSavedPlaylistsState({ uid, rows });
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, playlistsPath);
        } catch (wrapped) {
          setFirestoreError(wrapped instanceof Error ? wrapped.message : String(wrapped));
        }
      }
    );

    return () => unsub();
  }, [authReady, user]);

  const signIn = useCallback(async () => {
    setFirestoreError(null);
    await signInWithGooglePopup();
  }, []);

  const signOut = useCallback(async () => {
    setFirestoreError(null);
    await signOutFirebaseUser();
  }, []);

  const saveRuntimeConfig = useCallback(
    async (input: {
      nextPublicApiUrl: string;
      fastapiUrl: string;
      useFirebaseYoutubeKey: boolean;
    }) => {
      if (!user || !user.emailVerified || !isAdmin) {
        throw new Error(
          'Verified administrator sign-in is required to update Firebase runtime configuration.'
        );
      }

      const nextErr = validateOptionalRuntimeUrl(input.nextPublicApiUrl);
      if (nextErr) throw new Error(`NEXT_PUBLIC_API_URL: ${nextErr}`);
      const fastErr = validateOptionalRuntimeUrl(input.fastapiUrl);
      if (fastErr) throw new Error(`FASTAPI_URL: ${fastErr}`);

      const db = getFirebaseDb();
      const ref = doc(db, 'appConfig', 'runtime');
      const configPath = 'appConfig/runtime';

      const cleanNextUrl = input.nextPublicApiUrl.trim().replace(/\/+$/, '');
      const cleanFastApiUrl = input.fastapiUrl.trim().replace(/\/+$/, '');

      try {
        const existingSnap = await getDoc(ref);
        if (existingSnap.exists()) {
          await updateDoc(ref, {
            nextPublicApiUrl: cleanNextUrl,
            fastapiUrl: cleanFastApiUrl,
            useFirebaseYoutubeKey: Boolean(input.useFirebaseYoutubeKey),
            updatedBy: user.uid,
            updatedAt: serverTimestamp(),
          });
        } else {
          await setDoc(ref, {
            nextPublicApiUrl: cleanNextUrl,
            fastapiUrl: cleanFastApiUrl,
            useFirebaseYoutubeKey: Boolean(input.useFirebaseYoutubeKey),
            updatedBy: user.uid,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      } catch (error) {
        handleFirestoreError(
          error,
          runtimeConfig.existsInFirestore ? OperationType.UPDATE : OperationType.CREATE,
          configPath
        );
      }
    },
    [isAdmin, runtimeConfig.existsInFirestore, user]
  );

  const savePlaylistBookmark = useCallback(
    async (playlist: PlaylistData, rawUrl: string, matchedCount: number) => {
      if (!user || !user.emailVerified) {
        throw new Error('Sign in with a verified Google account to save playlists to Firebase.');
      }

      const db = getFirebaseDb();
      const docId = toSafeFirestoreDocId(`${playlist.source}_${playlist.id}`);
      const docPath = `users/${user.uid}/playlists/${docId}`;
      const ref = doc(db, 'users', user.uid, 'playlists', docId);

      const safeTrackCount = Math.min(200, Math.max(0, Math.floor(playlist.tracks.length)));
      const safeMatchedCount = Math.min(safeTrackCount, Math.max(0, Math.floor(matchedCount)));
      const safeName = (playlist.name.trim() || 'Untitled Playlist').slice(0, 200);
      const safeOwnerName = (playlist.owner?.trim() ?? '').slice(0, 200);
      const safeArtwork = (playlist.artworkUrl?.trim() ?? '').slice(0, 500);
      const safeUrl = rawUrl.trim().slice(0, 500);

      try {
        const existingSnap = await getDoc(ref);
        if (existingSnap.exists()) {
          await updateDoc(ref, {
            name: safeName,
            ownerName: safeOwnerName,
            artworkUrl: safeArtwork,
            trackCount: safeTrackCount,
            matchedCount: safeMatchedCount,
            updatedAt: serverTimestamp(),
          });
        } else {
          await setDoc(ref, {
            ownerId: user.uid,
            playlistId: docId,
            source: playlist.source,
            url: safeUrl,
            name: safeName,
            ownerName: safeOwnerName,
            artworkUrl: safeArtwork,
            trackCount: safeTrackCount,
            matchedCount: safeMatchedCount,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, docPath);
      }
    },
    [user]
  );

  const deletePlaylistBookmark = useCallback(
    async (docId: string) => {
      if (!user || !user.emailVerified) return;
      const db = getFirebaseDb();
      const docPath = `users/${user.uid}/playlists/${docId}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'playlists', docId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, docPath);
      }
    },
    [user]
  );

  const clearFirestoreError = useCallback(() => setFirestoreError(null), []);

  const value = useMemo<FirebaseContextValue>(
    () => ({
      projectId: FIREBASE_PROJECT_ID,
      databaseId: FIREBASE_DATABASE_ID,
      authReady,
      user,
      isAdmin,
      isOffline,
      runtimeConfig,
      savedPlaylists,
      firestoreError,
      clearFirestoreError,
      signIn,
      signOut,
      saveRuntimeConfig,
      savePlaylistBookmark,
      deletePlaylistBookmark,
    }),
    [
      authReady,
      clearFirestoreError,
      deletePlaylistBookmark,
      firestoreError,
      isAdmin,
      isOffline,
      runtimeConfig,
      savePlaylistBookmark,
      saveRuntimeConfig,
      savedPlaylists,
      signIn,
      signOut,
      user,
    ]
  );

  return <FirebaseContext.Provider value={value}>{children}</FirebaseContext.Provider>;
}

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error('useFirebase must be used within a FirebaseProvider');
  }
  return ctx;
}
