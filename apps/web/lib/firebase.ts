'use client';

import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, type Auth } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore, type Firestore } from 'firebase/firestore';
import firebaseConfig from '../../../firebase-applet-config.json';

export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
export const FIREBASE_DATABASE_ID = firebaseConfig.firestoreDatabaseId;
export const YOUTUBE_CLOUD_ENABLE_URL = `https://console.cloud.google.com/apis/library/youtube.googleapis.com?project=${encodeURIComponent(firebaseConfig.projectId)}`;

// Verbatim constraints synchronized with firebase-blueprint.json & firestore.rules
export const RUNTIME_URL_MAX_LENGTH = 500;
export const RUNTIME_URL_PATTERN = /^(|https?:\/\/[a-zA-Z0-9.-]+(:[0-9]{1,5})?(\/.*)?)$/;
export const VALID_DOC_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

let cachedApp: FirebaseApp | null = null;
let cachedDb: Firestore | null = null;
let cachedAuth: Auth | null = null;
let connectionChecked = false;

function getFirebaseApp(): FirebaseApp {
  if (!cachedApp) {
    const existing = getApps();
    cachedApp = existing[0] ?? initializeApp(firebaseConfig);
  }
  return cachedApp;
}

export function getFirebaseDb(): Firestore {
  if (!cachedDb) {
    const app = getFirebaseApp();
    cachedDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
  return cachedDb;
}

export function getFirebaseAuth(): Auth {
  if (!cachedAuth) {
    const app = getFirebaseApp();
    cachedAuth = getAuth(app);
  }
  return cachedAuth;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const auth = getFirebaseAuth();
  const currentUser = auth.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid ?? null,
      email: currentUser?.email ?? null,
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId ?? null,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) ?? [],
    },
    operationType,
    path,
  };
  const serialized = JSON.stringify(errInfo);
  console.error('Firestore Error: ', serialized);
  throw new Error(serialized);
}

export async function testFirestoreConnection(): Promise<boolean> {
  if (connectionChecked) return true;
  connectionChecked = true;
  try {
    const db = getFirebaseDb();
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    // Permission denied on test/connection confirms live server connectivity
    return true;
  }
}

export async function signInWithGooglePopup(): Promise<void> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithPopup(auth, provider);
}

export async function signOutFirebaseUser(): Promise<void> {
  const auth = getFirebaseAuth();
  await signOut(auth);
}

export function validateOptionalRuntimeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length > RUNTIME_URL_MAX_LENGTH) {
    return `URL must be ${RUNTIME_URL_MAX_LENGTH} characters or fewer.`;
  }
  if (!RUNTIME_URL_PATTERN.test(trimmed)) {
    return 'Enter an empty value (same-origin) or a valid http:// or https:// URL.';
  }
  if (/^https?:\/\/169\.254\./.test(trimmed)) {
    return 'Link-local metadata addresses are not permitted.';
  }
  return null;
}

export function toSafeFirestoreDocId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'playlist';
}
