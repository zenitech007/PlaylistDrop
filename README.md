# PlaylistDrop

PlaylistDrop is a monorepo web application (`Next.js 15` frontend + `FastAPI` async backend) that resolves public playlists from **Deezer**, **Spotify**, or **YouTube** without requiring user login, matches tracks against free Creative Commons catalogs (**Jamendo**), and streams matched audio individually or as a single ZIP archive. Unmatched commercial tracks remain listed and can always be exported as CSV or JSON.

---

## Monorepo Layout

```text
.
├── apps/
│   ├── api/                    # Python 3.12 + FastAPI + Pydantic v2 + httpx.AsyncClient
│   │   ├── app/
│   │   │   ├── main.py         # Routes, CORS, lifespan pooling, rate limit & request ID middleware
│   │   │   ├── config.py       # Env-only Pydantic settings
│   │   │   ├── schemas.py      # Strict Pydantic v2 models (PlaylistData, Track, MatchResult)
│   │   │   ├── errors.py       # Global { error: { code, message } } exception handlers
│   │   │   ├── resolvers/      # PlaylistResolver protocol: Deezer, Spotify, YouTube + Registry
│   │   │   ├── providers/      # TrackSourceProvider protocol: JamendoProvider + ProviderRegistry
│   │   │   └── services/       # SSRF guard (10-min TTL), audio streamer, async ZIP job manager
│   │   ├── tests/              # pytest + pytest-asyncio suite (all external API calls mocked)
│   │   ├── pyproject.toml
│   │   ├── requirements.txt
│   │   └── .env.example
│   └── web/                    # Next.js 15 App Router + TypeScript strict + Tailwind CSS
│       ├── app/
│       ├── components/
│       ├── lib/
│       ├── __tests__/          # Vitest + React Testing Library tests
│       └── .env.example
├── app/                        # Root Next.js entrypoint & server proxy/API routes (port 3000)
├── docker-compose.yml          # Optional one-command local stack (API :8000 + Web :3000)
├── pnpm-workspace.yaml
└── .env.example
```

---

## Obtaining Free API Keys

No secrets are committed to source code. Configure all credentials via environment variables.

### 1. Deezer — **No credentials required**
Public Deezer playlists (`deezer.com/{country?}/playlist/{id}`) work immediately out of the box via Deezer's public catalog endpoint.

### 2. Spotify (`SPOTIFY_CLIENT_ID` & `SPOTIFY_CLIENT_SECRET`) — Free
1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and sign in with a free Spotify account.
2. Click **Create app**, enter a name/description, select **Web API**, and save.
3. Open **Settings** on your new app and copy **Client ID** and **Client secret**.
4. Add them to `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `apps/api/.env`. PlaylistDrop uses the OAuth Client Credentials flow with an in-memory token cache (60s expiry buffer) — users never log in.

### 3. YouTube Data API v3 (`YOUTUBE_API_KEY`) & Firebase / Google Cloud — Free Tier
PlaylistDrop is pre-wired to Firebase & Google Cloud project `gen-lang-client-0762588499` (`firebase-applet-config.json`):
1. Open the [Google Cloud Console YouTube Data API v3 page for project `gen-lang-client-0762588499`](https://console.cloud.google.com/apis/library/youtube.googleapis.com?project=gen-lang-client-0762588499) and click **Enable**.
2. Server-side routes check `YOUTUBE_API_KEY` from the environment first; if unset and **Use provisioned Google Cloud project for YouTube Data API v3** is enabled in Firestore (`/appConfig/runtime`), they automatically fall back server-side to the provisioned Google Cloud project API key.
3. Administrators can sign in with Google inside the **Firebase Config** panel to persist `NEXT_PUBLIC_API_URL` and `FASTAPI_URL` in Firestore (`/appConfig/runtime`), while signed-in users can bookmark resolved playlists under `/users/{uid}/playlists`.

### 4. Jamendo (`JAMENDO_CLIENT_ID`) — Free
1. Register a free developer app at [Jamendo Developer Portal](https://dev.jamendo.com) (direct portal: `https://devportal.jamendo.com/`).
2. Create an app under **My Apps** and copy the generated **Client ID**.
3. Set `JAMENDO_CLIENT_ID` in `apps/api/.env`.

---

## Environment Setup

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

### Backend (`apps/api/.env`)
```env
SPOTIFY_CLIENT_ID=          # https://developer.spotify.com/dashboard — free app
SPOTIFY_CLIENT_SECRET=      # https://developer.spotify.com/dashboard — free app
YOUTUBE_API_KEY=            # https://console.cloud.google.com/apis/credentials — YouTube Data API v3
JAMENDO_CLIENT_ID=          # https://dev.jamendo.com — free app
CORS_ORIGINS=http://localhost:3000
```

### Frontend (`apps/web/.env.local`)
```env
NEXT_PUBLIC_API_URL=http://localhost:8000
FASTAPI_URL=http://localhost:8000
```

---

## Running Locally

### Option A: Separate Backend + Frontend (Recommended)

**1. Start FastAPI (`apps/api`) on port 8000**

Using `uv`:
```bash
cd apps/api
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```

Or using `pip`:
```bash
cd apps/api
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**2. Start Next.js (`apps/web`) on port 3000**
```bash
pnpm install
pnpm --filter @playlistdrop/web dev
```

Visit `http://localhost:3000`.

### Option B: Docker Compose

```bash
SPOTIFY_CLIENT_ID="..." \
SPOTIFY_CLIENT_SECRET="..." \
YOUTUBE_API_KEY="..." \
JAMENDO_CLIENT_ID="..." \
docker compose up --build
```

---

## Testing, Linting & Typechecking

### Backend (`apps/api`)
```bash
cd apps/api
pytest -v
```
Covers:
- Multi-platform URL parser (Deezer, Spotify URLs + `spotify:playlist:` URIs, YouTube `playlist?list=`, `music.youtube.com`, `youtu.be/{video}?list=`, and malformed URL rejection with HTTP 400 listing supported platforms)
- Pure YouTube title parser (`Artist - Title`, `Artist: Title`, `Artist — Title`, noise stripping, channel fallback)
- Deezer, Spotify (including token cache & refresh), and YouTube (including pagination & `quotaExceeded` partial=true) resolvers and normalizers + 200-track cap (`422`)
- Track match scoring (`1.0` exact, `>= 0.8` fuzzy) & Creative Commons license verification
- SSRF guard, private IP blocking (`400`), filename sanitization, and `Content-Type` enforcement (`415`)
- End-to-end async ZIP job creation (`202`), `/status` polling, and streamed ZIP inspection

### Frontend (`apps/web` & root)
```bash
npm run test          # Vitest + React Testing Library (ResultsView happy-path with mocked fetch)
npm run typecheck     # tsc --noEmit (strict mode)
npm run lint          # ESLint
npm run format:check  # Prettier
```

---

## Architecture & Upgrade Paths

### Adding a New Playlist Platform (1-File Change)
Implement the `PlaylistResolver` protocol (`async def resolve(playlist_id: str, storefront: str | None = None) -> PlaylistData`) in a new file under `apps/api/app/resolvers/`, add its URL matcher in `parse_playlist_url`, and register it in `apps/api/app/resolvers/registry.py`. Route code in `main.py` stays untouched.

### Adding a New Free/CC Audio Provider (FMA, SoundCloud CC)
Implement the `TrackSourceProvider` protocol (`async def match(tracks: list[Track]) -> list[MatchResult]`) under `apps/api/app/providers/` and append it inside `build_default_provider_registry` in `apps/api/app/providers/registry.py`.

### Scaling ZIP Jobs & Rate Limits (Redis Upgrade Path)
In-memory structures currently hold ZIP job status (`ZipJobManager` using `dict` + `asyncio.Task`), the 10-minute SSRF allow-list (`MatchedUrlRegistry`), Spotify's cached client-credentials token, and sliding-window per-IP rate limits (`30 req/min`).

For multi-instance production deployments:
1. Store ZIP job state, matched-URL TTL keys, and the shared Spotify access token in **Redis** (`SETEX`).
2. Move ZIP packaging onto an async worker queue (e.g., ARQ or Celery backed by Redis) uploading streamed ZIPs to object storage (S3/GCS) with expiring signed URLs.
3. Back per-IP rate limiting with a Redis sorted-set sliding window so limits apply uniformly across replicas.
