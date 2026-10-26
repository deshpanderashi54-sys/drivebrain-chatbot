# DriveBrain Chatbot (Node.js + Google Drive)

A starter application with a chat UI, Google sign-in, per-user sessions, Drive file-name search, account switching, and server-side transcription for videos stored in Google Drive. Users do not select or upload a video from their computer into the chatbot: the backend fetches a video they already have permission to access in Drive, extracts audio with FFmpeg, transcribes it, and deletes temporary files.

## Requirements
- Node.js 20+
- FFmpeg installed and available as `ffmpeg`
- Google Cloud project with Google Drive API enabled and OAuth consent configured
- Gemini API key (for chat and audio transcription)

## Setup
1. Extract this folder and open a terminal inside it.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in credentials. Generate a strong `SESSION_SECRET`.
4. In Google Cloud Console, create an OAuth 2.0 **Web application** client. Add this exact authorized redirect URI: `http://localhost:3000/auth/google/callback`. Enable the Google Drive API and configure the OAuth consent screen/test users as needed.
5. Install FFmpeg. Ubuntu/Debian: `sudo apt update && sudo apt install ffmpeg`.
6. Start with `npm start`, then open `http://localhost:3000`.

## How it works
- **Multi-user login:** Google OAuth identifies each user. Each browser session has its own user and Google tokens.
- **Switch account:** destroys the current session and redirects to Google with `prompt=consent select_account` so Drive can receive the refresh token required for a persistent connection.
- **Automatic Drive matching:** chat messages trigger a best-effort search on file names. The Drive search panel allows explicit name search. This starter attempts to read the contents of matching Google Docs, Google Sheets (CSV export), and small plain-text/Markdown/CSV/JSON files. It does not parse PDFs, Word documents, images, or every file type, and it only inspects a few name-matched files per question.
- **Video transcription:** select a video already in Drive and click Transcribe. The server downloads it to a temporary directory, extracts audio, sends audio to the transcription API, and removes temporary files. The video itself is not uploaded through the chatbot UI, but the extracted audio is sent to the configured AI transcription provider. Review that provider's data handling terms before using sensitive recordings.
- **Gemini availability:** temporary overload and rate-limit responses are retried up to two times. If Drive reports that renewed authorization is needed, use Switch account and approve Drive access again.

## Important limitations and production hardening
- Google OAuth + Drive API setup is required; it cannot connect to a Google account without user consent. Each user authorizes their own account.
- The chat's automatic Drive search starts with filename matches and reads supported matching content. It is not a full semantic index of every file. A production RAG version should add parsers for PDF/DOCX/images, chunking, embeddings, a vector index, access-control filtering, and citations.
- SQLite session storage is suitable for a local demo. For deployment use HTTPS, a persistent session store, a database-backed user model, CSRF/rate limiting, secure secret management, background jobs for long videos, storage quotas, audit logs, and retention controls.
- For videos above the configured size limit, increase `MAX_VIDEO_BYTES` carefully and use a background job. Transcription provider file-size limits also apply.
- This starter does not provide local email/password registration; Google sign-in is the login option. Multiple users can use it by signing in with their own Google accounts.
- Do not expose `.env` or API credentials in frontend code. Restrict OAuth scopes and production origins appropriately.
