import { createServer as createHttpServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = resolve(projectRoot, 'dist');
const defaultPrices = Object.freeze({
  fauteuil: 7000,
  matelas_simple: 10000,
  matelas_double: 15000,
  matelas_king: 20000,
  tapis_petit: 5000,
  tapis_moyen: 10000,
  tapis_grand: 18000,
  menage_studio: 20000,
  menage_apt: 35000,
  menage_villa: 50000,
  fauteuil_places_max: 10,
  tapis_seuil_petit: 3,
  tapis_seuil_moyen: 6
});
const initialGallery = Object.freeze([]);
const legacyTeamGalleryId = 'd5b1cba4-0c02-4691-850b-c256fc961249';
const maxGalleryItems = 10;
const galleryMimeTypes = Object.freeze({
  'image/jpeg': { extension: '.jpg', signature: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
  'image/png': { extension: '.png', signature: (data) => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/webp': { extension: '.webp', signature: (data) => data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' }
});
const videoMimeTypes = Object.freeze({
  'video/mp4': { extension: '.mp4', signature: (data) => data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' },
  'video/webm': { extension: '.webm', signature: (data) => data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  'video/quicktime': { extension: '.mov', signature: (data) => data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' },
  'video/x-m4v': { extension: '.m4v', signature: (data) => data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' },
  'video/3gpp': { extension: '.3gp', signature: (data) => data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' }
});
const fieldLimits = Object.freeze({ nom: 120, telephone: 40, ville: 120, message: 2000 });
const mimeTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
});

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('La requête est trop volumineuse.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    const error = new Error('Format de requête non pris en charge.');
    error.status = 415;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Le formulaire contient des données invalides.');
    error.status = 400;
    throw error;
  }
}

async function saveVideo(request, videoDirectory) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  const videoType = videoMimeTypes[contentType];
  if (!videoType) {
    const error = new Error('Choisissez une vidéo MP4, WebM, MOV, M4V ou 3GP.');
    error.status = 415;
    throw error;
  }
  const name = `${randomUUID()}${videoType.extension}`;
  const target = resolve(videoDirectory, name);
  let prefix = Buffer.alloc(0);
  const validateHeader = new Transform({
    transform(chunk, encoding, callback) {
      if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
      callback(null, chunk);
    },
    flush(callback) {
      if (!videoType.signature(prefix)) {
        const error = new Error('Le fichier vidéo est vide ou son format est invalide.');
        error.status = 400;
        callback(error);
        return;
      }
      callback();
    }
  });
  try {
    await pipeline(request, validateHeader, createWriteStream(target, { flags: 'wx' }));
  } catch (error) {
    await unlink(target).catch((cleanupError) => {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
  return `/videos/${name}`;
}

function cookieValue(request, name) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
}

function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (typeof password !== 'string' || !record?.salt || !record?.hash) return false;
  const actual = scryptSync(password, record.salt, 64);
  const expected = Buffer.from(record.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateAppointment(payload) {
  const appointment = {};
  for (const [field, maxLength] of Object.entries(fieldLimits)) {
    const value = payload?.[field];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
      throw new Error('Vérifiez les champs obligatoires et leur longueur.');
    }
    appointment[field] = value.trim();
  }
  const digits = appointment.telephone.replace(/\D/g, '');
  if (!/^\+?[0-9][0-9\s().-]{6,39}$/.test(appointment.telephone) ||
      digits.length < 8 || digits.length > 15) {
    throw new Error('Vérifiez le format du numéro de téléphone.');
  }
  return appointment;
}

function validateReview(payload) {
  const review = {
    name: typeof payload?.name === 'string' ? payload.name.trim() : '',
    city: typeof payload?.city === 'string' ? payload.city.trim() : '',
    rating: Number(payload?.rating),
    message: typeof payload?.message === 'string' ? payload.message.trim() : ''
  };
  if (!review.name || review.name.length > 120 ||
      review.city.length > 120 || !Number.isInteger(review.rating) ||
      review.rating < 1 || review.rating > 5 ||
      !review.message || review.message.length > 1200 || payload?.consent !== true) {
    throw new Error('Vérifiez les champs de votre avis et votre consentement.');
  }
  return review;
}

function validPrices(prices) {
  return prices && typeof prices === 'object' && !Array.isArray(prices) &&
    Object.keys(defaultPrices).every((key) => Number.isSafeInteger(prices[key])) &&
    Object.keys(defaultPrices).filter((key) => key.startsWith('fauteuil_places') || key.startsWith('tapis_seuil'))
      .every((key) => prices[key] >= 1 && prices[key] <= 100) &&
    prices.fauteuil_places_max <= 30 &&
    prices.tapis_seuil_moyen > prices.tapis_seuil_petit &&
    Object.keys(defaultPrices).filter((key) => !key.startsWith('fauteuil_places') && !key.startsWith('tapis_seuil'))
      .every((key) => prices[key] >= 0 && prices[key] <= 100000000);
}

export async function createServer(options = {}) {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (Boolean(vapidPublicKey) !== Boolean(vapidPrivateKey)) {
    throw new Error('Configurez ensemble VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY.');
  }
  if (vapidPublicKey) {
    const subject = process.env.VAPID_SUBJECT || '';
    if (!/^mailto:\S+@\S+$/.test(subject) && !/^https:\/\//.test(subject)) {
      throw new Error('VAPID_SUBJECT doit être une adresse mailto: ou une URL HTTPS.');
    }
    webPush.setVapidDetails(subject, vapidPublicKey, vapidPrivateKey);
  }
  const dataDirectory = resolve(options.dataDirectory || process.env.EHMS_DATA_DIR || resolve(projectRoot, '.ehms-data'));
  const files = {
    appointments: resolve(dataDirectory, 'appointments.json'),
    prices: resolve(dataDirectory, 'prices.json'),
    reviews: resolve(dataDirectory, 'reviews.json'),
    videos: resolve(dataDirectory, 'video-news.json'),
    gallery: resolve(dataDirectory, 'gallery.json'),
    password: resolve(dataDirectory, 'admin-password.json'),
    subscriptions: resolve(dataDirectory, 'push-subscriptions.json')
  };
  const galleryDirectory = resolve(dataDirectory, 'gallery');
  const videoDirectory = resolve(dataDirectory, 'videos');
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(galleryDirectory, { recursive: true });
  await mkdir(videoDirectory, { recursive: true });
  for (const file of Object.values(files)) {
    if (file !== files.password) {
      try {
        await readFile(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const initial = file === files.prices ? defaultPrices : file === files.gallery ? initialGallery : [];
        await writeFile(file, JSON.stringify(initial, null, 2), { flag: 'wx' });
      }
    }
  }

  let storedPassword;
  try {
    storedPassword = JSON.parse(await readFile(files.password, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const initialPassword = options.adminPassword || process.env.EHMS_ADMIN_PASSWORD || 'Home2026';
    if (initialPassword.length < 8) {
      throw new Error('Le mot de passe initial doit contenir au moins 8 caractères.');
    }
    storedPassword = passwordRecord(initialPassword);
    await writeFile(files.password, JSON.stringify(storedPassword), { flag: 'wx' });
  }

  const sessions = new Map();
  const loginAttempts = new Map();
  let writeQueue = Promise.resolve();
  const publicWrites = new Map();
  const allowedAssets = new Set([
    'index.html', 'admin.html', 'admin.js', 'confidentialite.html',
    'animations.css', 'animations.js', 'public-api.js', 'service-worker.js'
  ]);
  const sessionCookieName = 'ehms_admin_session';
  const sessionDuration = 8 * 60 * 60 * 1000;
  const secureCookie = process.env.NODE_ENV === 'production';

  async function loadJson(name) {
    await writeQueue;
    return JSON.parse(await readFile(files[name], 'utf8'));
  }

  function updateJson(name, updater) {
    const operation = writeQueue.then(async () => {
      const current = JSON.parse(await readFile(files[name], 'utf8'));
      const next = await updater(current);
      const temporary = `${files[name]}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
      await rename(temporary, files[name]);
      return next;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function sendAppointmentPush() {
    if (!vapidPublicKey) return;
    const subscriptions = await loadJson('subscriptions');
    const payload = JSON.stringify({
      title: 'Nouvelle demande de rendez-vous',
      body: 'Une nouvelle demande est arrivée. Touchez pour ouvrir le tableau de bord.',
      url: '/admin.html'
    });
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, payload);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          await updateJson('subscriptions', (items) => items.filter((item) => item.endpoint !== subscription.endpoint));
          return;
        }
        console.error('Échec de l’envoi d’une notification push.', error);
      }
    }));
  }

  await updateJson('gallery', (items) => items.filter((item) => item.id !== legacyTeamGalleryId));

  async function saveGalleryImage(payload) {
    if (typeof payload?.image !== 'string') {
      throw new Error('Sélectionnez une photo à téléverser.');
    }
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(payload.image);
    if (!match) throw new Error('Choisissez une image JPG, PNG ou WebP valide.');
    const imageType = galleryMimeTypes[match[1]];
    const data = Buffer.from(match[2], 'base64');
    if (!data.length || data.length > 8 * 1024 * 1024 || !imageType.signature(data)) {
      throw new Error('La photo est invalide ou dépasse la limite de 8 Mo.');
    }
    const name = `${randomUUID()}${imageType.extension}`;
    const target = resolve(galleryDirectory, name);
    await writeFile(target, data, { flag: 'wx' });
    return `/uploads/${name}`;
  }

  function uploadedVideoFile(url) {
    const match = typeof url === 'string' && /^\/videos\/([\da-f-]{36}\.(?:mp4|webm|mov|m4v|3gp))$/i.exec(url);
    return match ? resolve(videoDirectory, match[1]) : null;
  }

  function uploadedGalleryFile(url) {
    const match = typeof url === 'string' && /^\/uploads\/([\da-f-]{36}\.(?:jpg|png|webp))$/i.exec(url);
    return match ? resolve(galleryDirectory, match[1]) : null;
  }

  function clientAddress(request) {
    const forwarded = process.env.TRUST_PROXY === '1' ? request.headers['x-forwarded-for']?.split(',')[0].trim() : '';
    return forwarded || request.socket.remoteAddress || 'unknown';
  }

  async function purgeExpiredRecords() {
    const appointmentCutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const reviewCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    await updateJson('appointments', (items) => items.filter((item) => {
      const created = Date.parse(item.createdAt || item.created_at || '');
      return !Number.isFinite(created) || created >= appointmentCutoff;
    }));
    await updateJson('reviews', (items) => items.filter((item) => {
      if (item.status !== 'pending') return true;
      const created = Date.parse(item.created_at || item.createdAt || '');
      return !Number.isFinite(created) || created >= reviewCutoff;
    }));
  }

  function allowPublicWrite(request, bucket, limit, duration) {
    const key = `${bucket}:${clientAddress(request)}`;
    const now = Date.now();
    const recent = (publicWrites.get(key) || []).filter((time) => time > now - duration);
    if (recent.length >= limit) {
      publicWrites.set(key, recent);
      return false;
    }
    recent.push(now);
    publicWrites.set(key, recent);
    return true;
  }

  function originAllowed(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    const expected = process.env.PUBLIC_ORIGIN;
    if (expected) return origin === expected.replace(/\/$/, '');
    const forwardedProto = process.env.TRUST_PROXY === '1'
      ? request.headers['x-forwarded-proto']?.split(',')[0].trim()
      : '';
    const protocol = forwardedProto || (request.socket.encrypted ? 'https' : 'http');
    return origin === `${protocol}://${request.headers.host}`;
  }

  function isAdmin(request) {
    const id = cookieValue(request, sessionCookieName);
    const expiry = sessions.get(id);
    if (!id || !expiry || expiry <= Date.now()) {
      sessions.delete(id);
      return false;
    }
    sessions.set(id, Date.now() + sessionDuration);
    return true;
  }

  function adminRequired(request, response) {
    if (!isAdmin(request)) {
      json(response, 401, { error: 'Authentification requise.' });
      return false;
    }
    if (!originAllowed(request)) {
      json(response, 403, { error: 'Origine de requête non autorisée.' });
      return false;
    }
    return true;
  }

  async function serveStatic(request, response, pathname) {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const galleryImageMatch = relative.match(/^uploads\/([\da-f-]{36}\.(?:jpg|png|webp))$/i);
    if (galleryImageMatch) {
      const imagePath = resolve(galleryDirectory, galleryImageMatch[1]);
      try {
        const body = await readFile(imagePath);
        response.writeHead(200, {
          'Content-Type': ({
            '.jpg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp'
          })[extname(imagePath).toLowerCase()],
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=86400'
        });
        if (request.method === 'HEAD') response.end();
        else response.end(body);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    const videoMatch = relative.match(/^videos\/([\da-f-]{36}\.(?:mp4|webm|mov|m4v|3gp))$/i);
    if (videoMatch) {
      const videoPath = resolve(dataDirectory, 'videos', videoMatch[1]);
      try {
        const info = await stat(videoPath);
        const range = request.headers.range;
        let start = 0;
        let end = info.size - 1;
        let status = 200;
        if (range) {
          const match = range.match(/^bytes=(\d*)-(\d*)$/);
          if (!match || info.size === 0 || (!match[1] && !match[2])) {
            response.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            response.end();
            return true;
          }
          if (match[1]) {
            start = Number(match[1]);
            if (match[2]) end = Number(match[2]);
          } else {
            start = Math.max(0, info.size - Number(match[2]));
          }
          if (start >= info.size || end < start) {
            response.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
            response.end();
            return true;
          }
          end = Math.min(end, info.size - 1);
          status = 206;
        }
        response.writeHead(status, {
          'Content-Type': ({
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.mov': 'video/quicktime',
            '.m4v': 'video/x-m4v',
            '.3gp': 'video/3gpp'
          })[extname(videoPath).toLowerCase()],
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=86400',
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {})
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(videoPath, { start, end }).pipe(response);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    if (!(allowedAssets.has(relative) || relative.startsWith('images/'))) return false;
    const target = resolve(publicRoot, relative);
    if (!target.startsWith(publicRoot + sep)) return false;
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(target).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com; media-src 'self' https:; connect-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        ...(secureCookie ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
        'Cache-Control': /\.(?:html|js|css)$/.test(relative) ? 'no-cache' : 'public, max-age=86400'
      });
      if (request.method === 'HEAD') response.end();
      else response.end(body);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/health') {
        json(response, 200, { status: 'ok' });
        return;
      }

      if (path.startsWith('/api/')) {
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { Allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
          response.end();
          return;
        }
        if (path === '/api/admin-login' && request.method === 'POST') {
          if (!originAllowed(request)) {
            json(response, 403, { error: 'Origine de requête non autorisée.' });
            return;
          }
          const address = clientAddress(request);
          const attempts = loginAttempts.get(address) || { count: 0, resetAt: 0 };
          if (attempts.resetAt > Date.now() && attempts.count >= 5) {
            json(response, 429, { error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
            return;
          }
          const payload = await readBody(request);
          const valid = verifyPassword(payload.password, storedPassword);
          if (!valid) {
            const next = attempts.resetAt > Date.now() ? attempts : { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
            next.count += 1;
            loginAttempts.set(address, next);
            json(response, 401, { error: 'Mot de passe incorrect.' });
            return;
          }
          loginAttempts.delete(address);
          const sessionId = randomBytes(32).toString('base64url');
          sessions.set(sessionId, Date.now() + sessionDuration);
          const secure = secureCookie ? '; Secure' : '';
          json(response, 200, { authenticated: true }, {
            'Set-Cookie': `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDuration / 1000}${secure}`
          });
          return;
        }
        if (path === '/api/admin-session' && request.method === 'GET') {
          json(response, 200, { authenticated: isAdmin(request) });
          return;
        }
        if (path === '/api/admin-logout' && request.method === 'POST') {
          if (!originAllowed(request)) {
            json(response, 403, { error: 'Origine de requête non autorisée.' });
            return;
          }
          sessions.delete(cookieValue(request, sessionCookieName));
          json(response, 200, { authenticated: false }, {
            'Set-Cookie': `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`
          });
          return;
        }
        if (path === '/api/admin-password' && request.method === 'PUT') {
          if (!adminRequired(request, response)) return;
          const payload = await readBody(request);
          if (!verifyPassword(payload.currentPassword, storedPassword)) {
            json(response, 401, { error: 'Le mot de passe actuel est incorrect.' });
            return;
          }
          if (typeof payload.newPassword !== 'string' || payload.newPassword.length < 8 || payload.newPassword.length > 256) {
            json(response, 400, { error: 'Le nouveau mot de passe doit contenir entre 8 et 256 caractères.' });
            return;
          }
          storedPassword = passwordRecord(payload.newPassword);
          const temporary = `${files.password}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(storedPassword), { flag: 'wx' });
          await rename(temporary, files.password);
          sessions.clear();
          json(response, 200, { success: true }, {
            'Set-Cookie': `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie ? '; Secure' : ''}`
          });
          return;
        }

        if (path === '/api/push/config' && request.method === 'GET') {
          json(response, 200, { enabled: Boolean(vapidPublicKey), publicKey: vapidPublicKey || null });
          return;
        }

        if (path === '/api/push/subscriptions' && request.method === 'POST') {
          if (!adminRequired(request, response)) return;
          if (!vapidPublicKey) {
            json(response, 503, { error: 'Les notifications push ne sont pas encore configurées sur l’hébergement.' });
            return;
          }
          const payload = await readBody(request);
          let endpoint;
          try {
            endpoint = new URL(payload?.endpoint);
          } catch {
            json(response, 400, { error: 'Abonnement de notification invalide.' });
            return;
          }
          if (endpoint.protocol !== 'https:' || endpoint.href.length > 2048 ||
              typeof payload?.keys?.p256dh !== 'string' || payload.keys.p256dh.length > 256 ||
              typeof payload?.keys?.auth !== 'string' || payload.keys.auth.length > 128) {
            json(response, 400, { error: 'Abonnement de notification invalide.' });
            return;
          }
          const subscription = {
            endpoint: endpoint.href,
            keys: { p256dh: payload.keys.p256dh, auth: payload.keys.auth }
          };
          const subscriptions = await updateJson('subscriptions', (items) => {
            const otherDevices = items.filter((item) => item.endpoint !== subscription.endpoint);
            if (otherDevices.length >= 10) {
              const error = new Error('La limite de 10 appareils pour les alertes est atteinte.');
              error.status = 409;
              throw error;
            }
            return [...otherDevices, subscription];
          });
          json(response, 200, { success: true, devices: subscriptions.length });
          return;
        }

        if (path === '/api/push/subscriptions' && request.method === 'DELETE') {
          if (!adminRequired(request, response)) return;
          const payload = await readBody(request);
          if (typeof payload?.endpoint !== 'string') {
            json(response, 400, { error: 'Abonnement de notification invalide.' });
            return;
          }
          const subscriptions = await updateJson('subscriptions', (items) =>
            items.filter((item) => item.endpoint !== payload.endpoint));
          json(response, 200, { success: true, devices: subscriptions.length });
          return;
        }

        const appointmentMatch = /^\/api\/appointments\/([\da-f-]{36})$/i.exec(path);
        if (appointmentMatch && request.method === 'PATCH') {
          if (!adminRequired(request, response)) return;
          const payload = await readBody(request);
          if (payload?.status !== 'traite' || !Number.isSafeInteger(payload.revenueCfa) ||
              payload.revenueCfa < 0 || payload.revenueCfa > 1000000000) {
            json(response, 400, { error: 'Indiquez un revenu encaissé valide, en FCFA.' });
            return;
          }
          let updated;
          const appointments = await updateJson('appointments', (items) => items.map((item) => {
            if (item.id !== appointmentMatch[1]) return item;
            updated = { ...item, status: 'traite', revenueCfa: payload.revenueCfa };
            return updated;
          }));
          if (!updated) {
            json(response, 404, { error: 'Cette demande de rendez-vous est introuvable.' });
            return;
          }
          json(response, 200, { item: updated, items: appointments });
          return;
        }

        if (path === '/api/appointments') {
          if (request.method === 'GET') {
            if (!adminRequired(request, response)) return;
            json(response, 200, { items: await loadJson('appointments') });
            return;
          }
          if (request.method === 'POST') {
            if (!originAllowed(request)) {
              json(response, 403, { error: 'Origine de requête non autorisée.' });
              return;
            }
            if (!allowPublicWrite(request, 'appointment', 10, 10 * 60 * 1000)) {
              json(response, 429, { error: 'Trop de demandes depuis cette connexion. Réessayez plus tard.' });
              return;
            }
            const appointment = validateAppointment(await readBody(request));
            const item = {
              id: randomUUID(),
              ...appointment,
              createdAt: new Date().toISOString(),
              status: 'nouveau'
            };
            await updateJson('appointments', (items) => [item, ...items]);
            sendAppointmentPush().catch((error) => {
              console.error('Impossible de traiter les notifications des nouvelles demandes.', error);
            });
            json(response, 201, { success: true, id: item.id });
            return;
          }
          if (request.method === 'PUT') {
            if (!adminRequired(request, response)) return;
            const payload = await readBody(request);
            if (!Array.isArray(payload.items) || payload.items.some((item) =>
              typeof item.id !== 'string' || !/^[\da-f-]{36}$/i.test(item.id) ||
              !['nouveau', 'traite'].includes(item.status) ||
              typeof item.nom !== 'string' || !item.nom.trim())) {
              json(response, 400, { error: 'La liste de rendez-vous contient une entrée invalide.' });
              return;
            }
            await updateJson('appointments', () => payload.items);
            json(response, 200, { items: payload.items });
            return;
          }
          json(response, 405, { error: 'Méthode non autorisée.' });
          return;
        }

        if (path === '/api/prices') {
          if (request.method === 'GET') {
            json(response, 200, { ...defaultPrices, ...(await loadJson('prices')) });
            return;
          }
          if (request.method === 'PUT') {
            if (!adminRequired(request, response)) return;
            const payload = await readBody(request);
            if (!validPrices(payload)) {
              json(response, 400, { error: 'Un ou plusieurs tarifs sont invalides.' });
              return;
            }
            await updateJson('prices', () => payload);
            json(response, 200, payload);
            return;
          }
          json(response, 405, { error: 'Méthode non autorisée.' });
          return;
        }

        if (path === '/api/reviews') {
          if (request.method === 'GET') {
            const items = (await loadJson('reviews')).filter((review) => review.status === 'published');
            json(response, 200, { items });
            return;
          }
          if (request.method === 'POST') {
            if (!originAllowed(request)) {
              json(response, 403, { error: 'Origine de requête non autorisée.' });
              return;
            }
            if (!allowPublicWrite(request, 'review', 3, 60 * 60 * 1000)) {
              json(response, 429, { error: 'Trop d’avis envoyés depuis cette connexion. Réessayez plus tard.' });
              return;
            }
            const review = {
              id: randomUUID(),
              ...validateReview(await readBody(request)),
              status: 'pending',
              created_at: new Date().toISOString()
            };
            await updateJson('reviews', (items) => [review, ...items]);
            json(response, 201, { success: true, id: review.id });
            return;
          }
          json(response, 405, { error: 'Méthode non autorisée.' });
          return;
        }

        if (path === '/api/admin/reviews' && request.method === 'GET') {
          if (!adminRequired(request, response)) return;
          json(response, 200, { items: await loadJson('reviews') });
          return;
        }
        const reviewMatch = path.match(/^\/api\/admin\/reviews\/([\da-f-]{36})$/i);
        if (reviewMatch) {
          if (!adminRequired(request, response)) return;
          if (request.method === 'PATCH') {
            const payload = await readBody(request);
            if (!['pending', 'published'].includes(payload.status)) {
              json(response, 400, { error: 'Statut d’avis invalide.' });
              return;
            }
            let updated = false;
            const items = await updateJson('reviews', (reviews) => reviews.map((item) => {
              if (item.id !== reviewMatch[1]) return item;
              updated = true;
              return { ...item, status: payload.status };
            }));
            json(response, updated ? 200 : 404, updated ? { success: true } : { error: 'Avis introuvable.' });
            return;
          }
          if (request.method === 'DELETE') {
            let removed = false;
            await updateJson('reviews', (items) => items.filter((item) => {
              if (item.id !== reviewMatch[1]) return true;
              removed = true;
              return false;
            }));
            json(response, removed ? 200 : 404, removed ? { success: true } : { error: 'Avis introuvable.' });
            return;
          }
          json(response, 405, { error: 'Méthode non autorisée.' });
          return;
        }

        if (path === '/api/video-news') {
          if (request.method === 'GET') {
            json(response, 200, { items: await loadJson('videos') });
            return;
          }
          if (request.method === 'POST') {
            if (!adminRequired(request, response)) return;
            const title = url.searchParams.get('title')?.trim() || '';
            const description = url.searchParams.get('description')?.trim() || '';
            if (!title || title.length > 80 || description.length > 240) {
              json(response, 400, { error: 'Vérifiez le titre (80 caractères maximum) et la description (240 caractères maximum).' });
              return;
            }
            const videoUrl = await saveVideo(request, videoDirectory);
            const item = { id: randomUUID(), title, description, url: videoUrl, created_at: new Date().toISOString() };
            try {
              await updateJson('videos', (items) => [item, ...items]);
            } catch (error) {
              await unlink(uploadedVideoFile(videoUrl));
              throw error;
            }
            json(response, 201, item);
            return;
          }
          json(response, 405, { error: 'Méthode non autorisée.' });
          return;
        }
        const videoMatch = path.match(/^\/api\/video-news\/([\da-f-]{36})$/i);
        if (videoMatch && request.method === 'DELETE') {
          if (!adminRequired(request, response)) return;
          let removed = false;
          let removedItem;
          await updateJson('videos', (items) => items.filter((item) => {
            if (item.id !== videoMatch[1]) return true;
            removedItem = item;
            removed = true;
            return false;
          }));
          if (!removedItem) {
            json(response, 404, { error: 'Vidéo introuvable.' });
            return;
          }
          const storedVideo = uploadedVideoFile(removedItem.url);
          if (storedVideo) await unlink(storedVideo).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
          json(response, 200, { success: true });
          return;
        }

        if (path === '/api/gallery' && request.method === 'GET') {
          json(response, 200, { items: await loadJson('gallery') });
          return;
        }
        if (path === '/api/admin/gallery' && request.method === 'POST') {
          if (!adminRequired(request, response)) return;
          const payload = await readBody(request, 12 * 1024 * 1024);
          const title = typeof payload.title === 'string' ? payload.title.trim() : '';
          const category = typeof payload.category === 'string' ? payload.category.trim() : '';
          const description = typeof payload.description === 'string' ? payload.description.trim() : '';
          const categories = ['Fauteuils et canapés', 'Matelas', 'Tapis', 'Ménage à domicile', 'Autre réalisation'];
          if (!title || title.length > 100 || !categories.includes(category) || description.length > 240) {
            json(response, 400, { error: 'Vérifiez le titre, le type de prestation et la description.' });
            return;
          }
          if ((await loadJson('gallery')).length >= maxGalleryItems) {
            json(response, 409, { error: 'La galerie peut contenir au maximum 10 photos. Supprimez une photo avant d’en ajouter une autre.' });
            return;
          }
          const imageUrl = await saveGalleryImage(payload);
          const item = {
            id: randomUUID(),
            title,
            category,
            description,
            url: imageUrl,
            created_at: new Date().toISOString()
          };
          try {
            await updateJson('gallery', (items) => {
              if (items.length >= maxGalleryItems) {
                const error = new Error('La galerie peut contenir au maximum 10 photos. Supprimez une photo avant d’en ajouter une autre.');
                error.status = 409;
                throw error;
              }
              return [item, ...items];
            });
          } catch (error) {
            await unlink(uploadedGalleryFile(imageUrl));
            throw error;
          }
          json(response, 201, item);
          return;
        }
        const galleryMatch = path.match(/^\/api\/admin\/gallery\/([\da-f-]{36})$/i);
        if (galleryMatch) {
          if (!adminRequired(request, response)) return;
          if (request.method === 'PATCH') {
            const payload = await readBody(request, 12 * 1024 * 1024);
            const title = typeof payload.title === 'string' ? payload.title.trim() : '';
            const category = typeof payload.category === 'string' ? payload.category.trim() : '';
            const description = typeof payload.description === 'string' ? payload.description.trim() : '';
            const categories = ['Fauteuils et canapés', 'Matelas', 'Tapis', 'Ménage à domicile', 'Autre réalisation'];
            if (!title || title.length > 100 || !categories.includes(category) || description.length > 240) {
              json(response, 400, { error: 'Vérifiez le titre, le type de prestation et la description.' });
              return;
            }
            const existing = (await loadJson('gallery')).find((item) => item.id === galleryMatch[1]);
            if (!existing) {
              json(response, 404, { error: 'Photo introuvable dans la galerie.' });
              return;
            }
            const imageUrl = payload.image ? await saveGalleryImage(payload) : existing.url;
            const updatedItem = { ...existing, title, category, description, url: imageUrl };
            try {
              await updateJson('gallery', (items) => items.map((item) => item.id === galleryMatch[1] ? updatedItem : item));
            } catch (error) {
              if (imageUrl !== existing.url) await unlink(uploadedGalleryFile(imageUrl));
              throw error;
            }
            if (imageUrl !== existing.url) {
              const oldFile = uploadedGalleryFile(existing.url);
              if (oldFile) await unlink(oldFile).catch((error) => {
                if (error.code !== 'ENOENT') throw error;
              });
            }
            json(response, 200, updatedItem);
            return;
          }
          if (request.method === 'DELETE') {
            let removedItem;
            await updateJson('gallery', (items) => items.filter((item) => {
              if (item.id !== galleryMatch[1]) return true;
              removedItem = item;
              return false;
            }));
            if (!removedItem) {
              json(response, 404, { error: 'Photo introuvable dans la galerie.' });
              return;
            }
            const oldFile = uploadedGalleryFile(removedItem.url);
            if (oldFile) await unlink(oldFile).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
            json(response, 200, { success: true });
            return;
          }
          json(response, 405, { error: 'Méthode non autorisée.' });
          return;
        }

        json(response, 404, { error: 'Route API introuvable.' });
        return;
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        if (await serveStatic(request, response, path)) return;
      }
      json(response, 404, { error: 'Page introuvable.' });
    } catch (error) {
      if (error.status) {
        json(response, error.status, { error: error.message });
      } else {
        console.error('Request failed:', error);
        json(response, 500, { error: 'Erreur interne du serveur.' });
      }
    }
  });
  await purgeExpiredRecords();
  const cleanupTimer = setInterval(() => {
    purgeExpiredRecords().catch((error) => console.error('Scheduled data retention cleanup failed:', error));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();
  server.on('close', () => clearInterval(cleanupTimer));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const server = await createServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`Elegance Home server listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
  });
}
