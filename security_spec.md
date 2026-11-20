# PlaylistDrop Firestore Security Specification (Phase 0)

## 1. Data Invariants

1. **Default Deny**: Every unmatched path in the database is denied for both reads and writes (`match /{document=**} { allow read, write: if false; }`).
2. **Runtime Config Integrity (`/appConfig/runtime`)**:
   - Only the singleton document ID `runtime` is readable (`get`) for non-secret endpoint discovery (`nextPublicApiUrl`, `fastapiUrl`, `useFirebaseYoutubeKey`). Listing `/appConfig` is strictly denied.
   - Only a verified administrator (`request.auth.token.email_verified == true` AND either `/admins/{uid}` exists or `request.auth.token.email == 'zenitech007@gmail.com'`) can create or update `/appConfig/runtime`.
   - `createdAt` is immutable after creation; `createdAt` (on create) and `updatedAt` (on create/update) must equal `request.time`.
   - `updatedBy` must strictly equal `request.auth.uid`.
   - No secret API keys or ghost fields may ever be written (`hasOnly` enforced on both create and update).
3. **Saved Playlist Ownership (`/users/{userId}/playlists/{playlistId}`)**:
   - Strict owner isolation: only an authenticated user whose `request.auth.uid == userId` AND `resource.data.ownerId == request.auth.uid` can `get`, `list`, `update`, or `delete`.
   - All writes require `request.auth.token.email_verified == true`.
   - `ownerId`, `playlistId`, `source`, `url`, and `createdAt` are immutable on update.
   - `trackCount` is bounded `[0, 200]` and `matchedCount` is bounded `[0, trackCount]`.
4. **Admin Privilege Isolation (`/admins/{adminId}`)**:
   - No client can ever `list`, `create`, `update`, or `delete` documents in `/admins`. A user may only `get` their own `/admins/{uid}` marker.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return `PERMISSION_DENIED`)

1. **Unauthenticated Write to `/appConfig/runtime`**:
   ```json
   { "path": "/appConfig/runtime", "auth": null, "op": "create", "data": { "nextPublicApiUrl": "https://evil.example", "fastapiUrl": "https://evil.example", "useFirebaseYoutubeKey": true, "updatedBy": "anon", "createdAt": "SERVER_TIME", "updatedAt": "SERVER_TIME" } }
   ```
2. **Non-Admin User Modifying `/appConfig/runtime`**:
   ```json
   { "path": "/appConfig/runtime", "auth": { "uid": "user-2", "email": "attacker@example.com", "email_verified": true }, "op": "update", "data": { "fastapiUrl": "https://evil.example", "updatedBy": "user-2", "updatedAt": "SERVER_TIME" } }
   ```
3. **Email Spoofing Attack (Admin Email with `email_verified: false`)**:
   ```json
   { "path": "/appConfig/runtime", "auth": { "uid": "spoof-1", "email": "zenitech007@gmail.com", "email_verified": false }, "op": "update", "data": { "fastapiUrl": "https://evil.example", "updatedBy": "spoof-1", "updatedAt": "SERVER_TIME" } }
   ```
4. **Shadow / Ghost Field Injection on `/appConfig/runtime` (`youtubeApiKey` secret leak attempt)**:
   ```json
   { "path": "/appConfig/runtime", "auth": { "uid": "admin-1", "email": "zenitech007@gmail.com", "email_verified": true }, "op": "create", "data": { "nextPublicApiUrl": "", "fastapiUrl": "", "useFirebaseYoutubeKey": true, "updatedBy": "admin-1", "createdAt": "SERVER_TIME", "updatedAt": "SERVER_TIME", "youtubeApiKey": "leaked-secret" } }
   ```
5. **Invalid URL Scheme Injection (`javascript:` / `file://`) in `fastapiUrl`**:
   ```json
   { "path": "/appConfig/runtime", "auth": { "uid": "admin-1", "email": "zenitech007@gmail.com", "email_verified": true }, "op": "update", "data": { "fastapiUrl": "file:///etc/passwd", "updatedBy": "admin-1", "updatedAt": "SERVER_TIME" } }
   ```
6. **Self-Assigned Admin Escalation in `/admins/{uid}`**:
   ```json
   { "path": "/admins/user-2", "auth": { "uid": "user-2", "email": "user2@example.com", "email_verified": true }, "op": "create", "data": { "grantedAt": "SERVER_TIME" } }
   ```
7. **Cross-User Saved Playlist Read (`get` / `list` on another user's subcollection)**:
   ```json
   { "path": "/users/victim-uid/playlists/pl-1", "auth": { "uid": "attacker-uid", "email": "a@example.com", "email_verified": true }, "op": "get" }
   ```
8. **Identity Spoofing in Saved Playlist (`ownerId != request.auth.uid`)**:
   ```json
   { "path": "/users/attacker-uid/playlists/pl-1", "auth": { "uid": "attacker-uid", "email": "a@example.com", "email_verified": true }, "op": "create", "data": { "ownerId": "victim-uid", "playlistId": "pl-1", "source": "deezer", "url": "https://deezer.com/playlist/123", "name": "Spoof", "ownerName": "", "artworkUrl": "", "trackCount": 1, "matchedCount": 0, "createdAt": "SERVER_TIME", "updatedAt": "SERVER_TIME" } }
   ```
9. **ID Poisoning Attack (Oversized / Invalid Characters in Document ID)**:
   ```json
   { "path": "/users/attacker-uid/playlists/../../../etc$passwd", "auth": { "uid": "attacker-uid", "email": "a@example.com", "email_verified": true }, "op": "create", "data": {} }
   ```
10. **Immutable Field Tampering (`createdAt` or `ownerId` mutated on update)**:
    ```json
    { "path": "/users/user-1/playlists/pl-1", "auth": { "uid": "user-1", "email": "u@example.com", "email_verified": true }, "op": "update", "data": { "createdAt": "CLIENT_FORGED_TIME", "updatedAt": "SERVER_TIME" } }
    ```
11. **Value Poisoning (`matchedCount > trackCount` or `trackCount > 200` or invalid `source`)**:
    ```json
    { "path": "/users/user-1/playlists/pl-1", "auth": { "uid": "user-1", "email": "u@example.com", "email_verified": true }, "op": "create", "data": { "ownerId": "user-1", "playlistId": "pl-1", "source": "apple_music", "url": "https://deezer.com/playlist/123", "name": "Bad", "ownerName": "", "artworkUrl": "", "trackCount": 500, "matchedCount": 600, "createdAt": "SERVER_TIME", "updatedAt": "SERVER_TIME" } }
    ```
12. **Client-Forged Timestamp (`updatedAt != request.time`)**:
    ```json
    { "path": "/users/user-1/playlists/pl-1", "auth": { "uid": "user-1", "email": "u@example.com", "email_verified": true }, "op": "create", "data": { "ownerId": "user-1", "playlistId": "pl-1", "source": "spotify", "url": "https://open.spotify.com/playlist/abc1234567", "name": "Forged Time", "ownerName": "", "artworkUrl": "", "trackCount": 5, "matchedCount": 2, "createdAt": "2020-01-01T00:00:00Z", "updatedAt": "2020-01-01T00:00:00Z" } }
    ```
