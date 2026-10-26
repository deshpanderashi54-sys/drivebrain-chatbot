
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const app = express();
const SQLiteStore = connectSqlite3(session);
const PORT = Number(process.env.PORT || 3000);

const oauthConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET
);

const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.use(session({
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: './'
  }),
  secret: process.env.SESSION_SECRET || 'change-this-development-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static('public'));

// Google OAuth helpers
function oauthClient(
  redirectUri = process.env.GOOGLE_CALLBACK_URL ||
    `http://localhost:${PORT}/auth/google/callback`
) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

function driveFor(req) {
  if (!req.session.googleTokens?.refresh_token) {
    return null;
  }

  const auth = oauthClient();
  auth.setCredentials(req.session.googleTokens);

  auth.on('tokens', tokens => {
    req.session.googleTokens = {
      ...req.session.googleTokens,
      ...tokens
    };
  });

  return google.drive({ version: 'v3', auth });
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: 'Please sign in first.'
    });
  }

  next();
}

function requireDrive(req, res, next) {
  if (!driveFor(req)) {
    return res.status(401).json({
      error: 'Your Google Drive session needs renewed authorization. Reconnect your Google account and approve Drive access.'
    });
  }

  next();
}

// Application status
app.get('/api/status', (req, res) => {
  res.json({
    user: req.session.user || null,
    driveConnected: Boolean(req.session.googleTokens?.refresh_token),
    aiConfigured: Boolean(gemini),
    googleConfigured: oauthConfigured
  });
});

// Google sign-in
app.get('/auth/google', (req, res) => {
  if (!oauthConfigured) {
    return res.status(500).send(
      'Google OAuth is not configured. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file.'
    );
  }

  const oauth = oauthClient();

  const authUrl = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/drive.readonly'
    ]
  });

  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  if (!oauthConfigured) {
    return res.status(500).send(
      'Google OAuth is not configured.'
    );
  }

  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(
      `Google sign-in failed: ${String(error)}`
    );
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).send(
      'Missing Google authorization code.'
    );
  }

  try {
    const oauth = oauthClient();
    const { tokens } = await oauth.getToken(code);

    oauth.setCredentials(tokens);

    const oauth2 = google.oauth2({
      auth: oauth,
      version: 'v2'
    });

    const { data: profile } = await oauth2.userinfo.get();

    if (!profile.id) {
      return res.status(401).send(
        'Could not retrieve your Google account.'
      );
    }

    const refreshToken = tokens.refresh_token || (
      req.session.user?.id === profile.id
        ? req.session.googleTokens?.refresh_token
        : undefined
    );

    if (!refreshToken) {
      return res.status(401).send(
        'Google did not provide a refresh token, so Drive cannot stay connected. Revoke DriveBrain access in your Google Account security settings, then sign in again and approve Drive access.'
      );
    }

    const googleTokens = {
      ...tokens,
      refresh_token: refreshToken
    };

    req.session.regenerate(sessionError => {
      if (sessionError) {
        console.error('Session error:', sessionError.message);
        return res.status(500).send(
          'Could not create login session.'
        );
      }

      req.session.user = {
        id: profile.id,
        name: profile.name || profile.email || 'Google User',
        email: profile.email || ''
      };

      req.session.googleTokens = googleTokens;

      req.session.save(saveError => {
        if (saveError) {
          console.error('Session save error:', saveError.message);
          return res.status(500).send(
            'Could not save login session.'
          );
        }

        res.redirect('/');
      });
    });
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);

    res.status(500).send(
      'Google sign-in failed. Check your OAuth credentials and callback URL.'
    );
  }
});

// Logout and account switching
app.post('/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({
        error: 'Could not log out.'
      });
    }

    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.post('/auth/switch-account', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({
        error: 'Could not switch accounts.'
      });
    }

    res.clearCookie('connect.sid');
    res.json({
      ok: true,
      next: '/auth/google'
    });
  });
});

// Search Google Drive files
app.get(
  '/api/drive/search',
  requireLogin,
  requireDrive,
  async (req, res) => {
    try {
      const query = String(req.query.q || '')
        .trim()
        .slice(0, 200);

      const drive = driveFor(req);

      const terms = query
        ? `name contains '${query.replaceAll("'", "\\'")}' and trashed = false`
        : 'trashed = false';

      const { data } = await drive.files.list({
        q: terms,
        pageSize: 15,
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size,description)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      res.json({
        files: (data.files || []).map(file => ({
          ...file,
          isVideo: (file.mimeType || '').startsWith('video/')
        }))
      });
    } catch (err) {
      const status = err.response?.status;
      const reason = err.response?.data?.error?.errors?.[0]?.reason;
      const apiMessage = err.response?.data?.error?.message;
      console.error('Drive search error:', {
        status,
        reason,
        message: apiMessage || err.message
      });

      let error = 'Could not search Google Drive.';

      if (status === 401) {
        error = 'Google Drive authorization expired or was revoked. Reconnect your Google account and try again.';
      } else if (status === 403 && reason === 'accessNotConfigured') {
        error = 'The Google Drive API is not enabled for this Google Cloud project.';
      } else if (status === 403) {
        error = `Google Drive denied access${apiMessage ? `: ${apiMessage.slice(0, 240)}` : ''}. Reconnect your account and verify that the Drive API is enabled and the account has permission to access these files.`;
      } else if (apiMessage) {
        error = `Google Drive error: ${apiMessage.slice(0, 240)}`;
      }

      res.status(status === 401 || status === 403 ? status : 500).json({
        error
      });
    }
  }
);

function geminiStatus(err) {
  const candidates = [
    err?.status,
    err?.error?.code,
    err?.response?.status
  ];

  for (const candidate of candidates) {
    const status = Number(candidate);

    if (Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  }

  try {
    const parsed = JSON.parse(err?.message || '');
    const status = Number(parsed?.error?.code);

    if (Number.isInteger(status) && status >= 400 && status < 600) {
      return status;
    }
  } catch {
    // The SDK error message is not always JSON.
  }

  return 0;
}

async function generateGeminiContent(request) {
  const maxAttempts = 3;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await gemini.models.generateContent(request);
    } catch (err) {
      const status = geminiStatus(err);

      if (![429, 500, 502, 503, 504].includes(status) || attempt >= maxAttempts) {
        throw err;
      }

      await new Promise(resolve =>
        setTimeout(resolve, 1000 * 2 ** (attempt - 1))
      );
    }
  }
}

function geminiFailure(err, action) {
  const status = geminiStatus(err);

  if (status === 503) {
    return {
      status: 503,
      error: `Gemini is temporarily overloaded. ${action} was retried; please try again in a minute.`
    };
  }

  if (status === 429) {
    return {
      status: 429,
      error: 'Gemini API quota or rate limit was reached. Please wait and try again.'
    };
  }

  return {
    status: 500,
    error: `${action} failed. Check Gemini API access and the configured model.`
  };
}

// Read relevant Drive files for Gemini
async function getDriveContext(drive, message) {
  if (!drive) {
    return '';
  }

  const words = [
    ...new Set(
      message.match(/[\p{L}\p{N}._-]{3,}/gu) || []
    )
  ].slice(0, 5);

  const clauses = words.map(word =>
    `name contains '${word.replaceAll("'", "\\'")}'`
  );

  const query = clauses.length
    ? `trashed = false and (${clauses.join(' or ')})`
    : 'trashed = false';

  const found = await drive.files.list({
    q: query,
    pageSize: 8,
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,webViewLink,description,size)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const files = found.data.files || [];

  const details = await Promise.all(
    files.slice(0, 4).map(async file => {
      let content = '';

      try {
        if (
          file.mimeType === 'application/vnd.google-apps.document'
        ) {
          const result = await drive.files.export(
            {
              fileId: file.id,
              mimeType: 'text/plain'
            },
            { responseType: 'text' }
          );

          content = String(result.data || '').slice(0, 7000);
        } else if (
          file.mimeType === 'application/vnd.google-apps.spreadsheet'
        ) {
          const result = await drive.files.export(
            {
              fileId: file.id,
              mimeType: 'text/csv'
            },
            { responseType: 'text' }
          );

          content = String(result.data || '').slice(0, 5000);
        } else if (
          [
            'text/plain',
            'text/markdown',
            'text/csv',
            'application/json'
          ].includes(file.mimeType) &&
          Number(file.size || 0) < 1000000
        ) {
          const result = await drive.files.get(
            {
              fileId: file.id,
              alt: 'media'
            },
            { responseType: 'stream' }
          );

          const chunks = [];

          for await (const chunk of result.data) {
            chunks.push(Buffer.from(chunk));
          }

          content = Buffer.concat(chunks)
            .toString('utf8')
            .slice(0, 7000);
        }
      } catch (err) {
        console.warn(
          `Could not read Drive content for ${file.name}:`,
          err.message
        );
      }

      return [
        `File: ${file.name}`,
        `Type: ${file.mimeType}`,
        file.description ? `Description: ${file.description}` : '',
        file.webViewLink ? `Link: ${file.webViewLink}` : '',
        content
          ? `Extracted content:\n${content}`
          : 'Content was not extracted; only file metadata is available.'
      ].filter(Boolean).join('\n');
    })
  );

  return details.join('\n\n');
}

// Chat using Gemini, with automatic Drive search
app.post('/api/chat', requireLogin, async (req, res) => {
  try {
    if (!gemini) {
      return res.status(503).json({
        error: 'Add GEMINI_API_KEY to .env to enable AI answers.'
      });
    }

    const message = String(req.body.message || '').trim();

    if (!message) {
      return res.status(400).json({
        error: 'Type a question first.'
      });
    }

    const drive = driveFor(req);
    let driveContext = '';

    if (drive) {
      try {
        driveContext = await getDriveContext(drive, message);
      } catch (err) {
        console.warn('Drive context search error:', err.message);
      }
    }

    const response = await generateGeminiContent({
      model: GEMINI_MODEL,
      contents: `Google Drive files found automatically:
${driveContext || '(No matching files found, or Google Drive is not connected.)'}

User question:
${message}`,
      config: {
        systemInstruction: `You are DriveBrain, a helpful AI chatbot.
Answer general questions directly.
Use the supplied Google Drive context when it is relevant.
Mention relevant file names and include their links when available.
Do not claim to have read file contents when only metadata is available.
Be honest if no relevant file content was found.`,
        temperature: 0.3
      }
    });

    res.json({
      answer: response.text || 'I could not generate an answer.',
      driveMatches: driveContext
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    const failure = geminiFailure(err, 'Chat request');

    res.status(failure.status).json({
      error: failure.error
    });
  }
});

// Transcribe a Drive video using Gemini
app.post(
  '/api/drive/transcribe/:fileId',
  requireLogin,
  requireDrive,
  async (req, res) => {
    let tempDir;

    try {
      if (!gemini) {
        return res.status(503).json({
          error: 'Add GEMINI_API_KEY to .env to enable transcription.'
        });
      }

      const drive = driveFor(req);

      const meta = await drive.files.get({
        fileId: req.params.fileId,
        fields: 'id,name,mimeType,size',
        supportsAllDrives: true
      });

      if (!(meta.data.mimeType || '').startsWith('video/')) {
        return res.status(400).json({
          error: 'This Drive item is not a video file.'
        });
      }

      const maxBytes = Number(
        process.env.MAX_VIDEO_BYTES || 536870912
      );

      if (Number(meta.data.size || 0) > maxBytes) {
        return res.status(413).json({
          error: `Video exceeds configured ${Math.round(maxBytes / 1024 / 1024)} MB limit.`
        });
      }

      tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'drivebrain-')
      );

      const videoPath = path.join(tempDir, 'source-video');
      const audioPath = path.join(tempDir, 'audio.mp3');

      const download = await drive.files.get(
        {
          fileId: req.params.fileId,
          alt: 'media',
          supportsAllDrives: true
        },
        { responseType: 'stream' }
      );

      await pipeline(
        download.data,
        fs.createWriteStream(videoPath)
      );

      // Extract audio locally using ffmpeg.
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-y',
          '-i', videoPath,
          '-vn',
          '-ac', '1',
          '-ar', '16000',
          '-b:a', '64k',
          audioPath
        ]);

        let stderr = '';

        ffmpeg.stderr.on('data', data => {
          stderr += data.toString();
        });

        ffmpeg.on('error', reject);

        ffmpeg.on('close', code => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error('ffmpeg failed: ' + stderr.slice(-700))
            );
          }
        });
      });

      const audioBuffer = await fs.promises.readFile(audioPath);

      // Gemini receives the extracted audio, not the entire video.
      const transcriptResponse = await generateGeminiContent({
        model: GEMINI_MODEL,
        contents: [
          {
            inlineData: {
              mimeType: 'audio/mpeg',
              data: audioBuffer.toString('base64')
            }
          },
          {
            text: 'Transcribe the spoken words in this audio accurately. Preserve the language spoken. Do not summarize, translate, or add commentary. Return only the transcript.'
          }
        ],
        config: {
          temperature: 0
        }
      });

      res.json({
        fileName: meta.data.name,
        transcript: transcriptResponse.text || ''
      });
    } catch (err) {
      console.error('Transcription error:', err.message);
      const failure = geminiFailure(err, 'Transcription');

      res.status(failure.status).json({
        error: failure.error
      });
    } finally {
      if (tempDir) {
        await fs.promises.rm(
          tempDir,
          { recursive: true, force: true }
        ).catch(() => {});
      }
    }
  }
);

// Keep unknown API requests as JSON errors.
// Serve the frontend for browser routes.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'Not found'
    });
  }

  res.sendFile(path.resolve('public/index.html'));
});

app.listen(PORT, () => {
  console.log(`DriveBrain running at http://localhost:${PORT}`);
});
