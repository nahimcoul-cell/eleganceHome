import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { createServer } from '../server.mjs';

let server;
let baseUrl;
let dataDirectory;

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'ehms-test-'));
  await writeFile(join(dataDirectory, 'gallery.json'), JSON.stringify([{
    id: 'd5b1cba4-0c02-4691-850b-c256fc961249',
    title: 'Notre équipe à Abidjan',
    category: 'Équipe',
    description: 'Elegance Home Multi Service à Abidjan.',
    url: '/images/direction-travail.jpg'
  }]));
  const configuredEnvironment = Object.fromEntries([
    'EHMS_ADMIN_PASSWORD', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'
  ].map((key) => [key, process.env[key]]));
  delete process.env.EHMS_ADMIN_PASSWORD;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  try {
    server = await createServer({ dataDirectory });
  } finally {
    for (const [key, value] of Object.entries(configuredEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(dataDirectory, { recursive: true, force: true });
});

async function post(path, payload, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, ...headers },
    body: JSON.stringify(payload)
  });
}

test('public submissions are stored but appointment data requires administrator login', async () => {
  const created = await post('/api/appointments', {
    nom: 'Élodie D’Guessan',
    telephone: '+225 01 23 45 67 89',
    ville: 'Cocody – Abidjan',
    message: 'Nettoyage des fauteuils : l’équipe est disponible.'
  });
  assert.equal(created.status, 201);
  const createdAppointment = await created.json();

  const privateBeforeLogin = await fetch(`${baseUrl}/api/appointments/${createdAppointment.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ status: 'traite', revenueCfa: 15000 })
  });
  assert.equal(privateBeforeLogin.status, 401);
  const privateListBeforeLogin = await fetch(`${baseUrl}/api/appointments`);
  assert.equal(privateListBeforeLogin.status, 401);
  const blockedPushRegistration = await post('/api/push/subscriptions', {
    endpoint: 'https://push.example.com/subscription',
    keys: { p256dh: 'test', auth: 'test' }
  });
  assert.equal(blockedPushRegistration.status, 401);

  const login = await post('/api/admin-login', { password: 'Home2026' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const appointments = await fetch(`${baseUrl}/api/appointments`, { headers: { Cookie: cookie } });
  assert.equal(appointments.status, 200);
  const savedAppointment = (await appointments.json()).items[0];
  assert.equal(savedAppointment.nom, 'Élodie D’Guessan');
  assert.equal(savedAppointment.ville, 'Cocody – Abidjan');
  assert.equal(savedAppointment.message, 'Nettoyage des fauteuils : l’équipe est disponible.');

  const invalidRevenue = await fetch(`${baseUrl}/api/appointments/${createdAppointment.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ status: 'traite', revenueCfa: -1 })
  });
  assert.equal(invalidRevenue.status, 400);

  const completed = await fetch(`${baseUrl}/api/appointments/${createdAppointment.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ status: 'traite', revenueCfa: 15000 })
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).item.revenueCfa, 15000);
  const savedAppointments = await (await fetch(`${baseUrl}/api/appointments`, { headers: { Cookie: cookie } })).json();
  assert.equal(savedAppointments.items[0].status, 'traite');
  assert.equal(savedAppointments.items[0].revenueCfa, 15000);

  const pushConfig = await (await fetch(`${baseUrl}/api/push/config`)).json();
  assert.equal(pushConfig.enabled, false);
  const unconfiguredPushRegistration = await post('/api/push/subscriptions', {
    endpoint: 'https://push.example.com/subscription',
    keys: { p256dh: 'test', auth: 'test' }
  }, { Cookie: cookie });
  assert.equal(unconfiguredPushRegistration.status, 503);
  const pushAsset = await fetch(`${baseUrl}/service-worker.js`);
  assert.equal(pushAsset.status, 200);
});

test('server publishes built pages and keeps project and data files private', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /charset=utf-8/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const homeHtml = await home.text();
  assert.match(homeHtml, /public-api\.js/);
  assert.match(homeHtml, /data-price-display="fauteuil"/);
  assert.match(homeHtml, /class="stats-bar reveal"[^>]*aria-label="Quelques chiffres"[\s\S]*?500\+[\s\S]*?Clients satisfaits[\s\S]*?24 h[\s\S]*?Réponse sous 24 heures[\s\S]*?100 %[\s\S]*?Prestations à domicile/);
  assert.match(homeHtml, /Nous vous répondrons sous 24 heures/);
  assert.match(homeHtml, /Notre équipe vous répondra sous 24 heures/);
  for (const [id, label] of [
    ['nom', 'Votre nom complet'],
    ['telephone', 'Votre numéro de téléphone'],
    ['ville', 'Votre commune ou ville'],
    ['message', 'Décrivez vos besoins en nettoyage'],
    ['reviewName', 'Votre nom'],
    ['reviewCity', 'Votre commune (facultatif)'],
    ['reviewRating', 'Votre note'],
    ['reviewMessage', 'Racontez brièvement votre expérience']
  ]) {
    assert.ok(homeHtml.includes(`<label class="visually-hidden" for="${id}">${label}</label>`));
  }
  assert.match(homeHtml, /id="workGallery"/);
  assert.match(homeHtml, /<img alt="" id="lightboxImg"/);
  assert.doesNotMatch(homeHtml, /<img src="" alt="" id="lightboxImg"/);
  assert.match(homeHtml, /Nos réalisations en photos/);
  assert.match(homeHtml, /Nos réalisations en photos seront bientôt disponibles/);
  assert.doesNotMatch(homeHtml, /Une équipe locale|Notre équipe à Abidjan/);
  assert.match(homeHtml, /gallery-carousel-controls/);
  assert.match(homeHtml, /Monsieur Dosso — PDG et Directeur Général, au bureau/);
  assert.doesNotMatch(homeHtml, /En activité/);
  assert.doesNotMatch(homeHtml, /data-carousel-index/);
  assert.match(homeHtml, /Photo précédente/);
  assert.match(homeHtml, /Photo suivante/);
  assert.match(homeHtml, /src="images\/materiel-qualite\.jpg" alt="Matériel et équipements de nettoyage professionnel Elegance Home" id="aboutMainImg"/);
  assert.match(homeHtml, /Nos équipements et matériels de nettoyage professionnel/);
  assert.doesNotMatch(homeHtml, /about-thumbnails-row|about-thumb-btn/);
  assert.match(homeHtml, /images\/direction-bureau\.jpg/);
  assert.match(homeHtml, /images\/direction-travail\.jpg/);
  assert.doesNotMatch(homeHtml, /En activité|en activité/);
  assert.doesNotMatch(homeHtml, /Ã|Â|â€|â†/);

  const dashboard = await fetch(`${baseUrl}/admin.html`);
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /admin\.js/);
  assert.match(dashboardHtml, /Tableau de bord des demandes de rendez-vous/);
  assert.match(dashboardHtml, /Accès à l’administration/);
  assert.match(dashboardHtml, /Supprimer toutes les demandes/);
  assert.match(dashboardHtml, /Principales communes/);
  assert.match(dashboardHtml, /Gestion des avis/);
  assert.match(dashboardHtml, /data-review-filter="published"/);
  assert.match(dashboardHtml, /pendingReviewCount/);
  assert.match(dashboardHtml, /type="file" accept="video\/mp4/);
  assert.match(dashboardHtml, /n’impose pas de limite de taille/);
  assert.doesNotMatch(dashboardHtml, /vidéo.*100 Mo maximum/i);
  assert.match(dashboardHtml, /id="galleryImage" type="file" accept="image\/jpeg,image\/png,image\/webp" multiple required/);
  assert.match(dashboardHtml, /id="galleryPendingList"/);
  assert.match(dashboardHtml, /<div class="stats">[\s\S]*?<div class="card revenus-card">[\s\S]*?id="revenueTotal"/);
  assert.match(dashboardHtml, /id="processAppointmentModal" hidden/);
  assert.match(dashboardHtml, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(dashboardHtml, /tbody tr:not\(\.empty-row\) \.td-message/);
  assert.match(dashboardHtml, /@media \(max-width: 700px\)/);
  assert.match(dashboardHtml, /id="revenueTotal"/);
  assert.match(dashboardHtml, /id="pushAlertsButton"/);
  assert.match(dashboardHtml, /titre à chaque réalisation/);
  assert.doesNotMatch(dashboardHtml, /Lien de la vidéo \(YouTube/);
  assert.doesNotMatch(dashboardHtml, /Ã|Â|â€|â†/);

  const adminScript = await fetch(`${baseUrl}/admin.js`);
  assert.equal(adminScript.status, 200);
  const adminScriptText = await adminScript.text();
  assert.match(adminScriptText, /processAppointmentForm\.addEventListener\('submit'/);
  assert.match(adminScriptText, /data-label="Nom du client"/);
  assert.match(adminScriptText, /<span>Répondre<\/span>/);
  assert.doesNotMatch(adminScriptText, /maxVideoSize/);
  assert.doesNotMatch(adminScriptText, /\bprompt\(/);

  const privacy = await fetch(`${baseUrl}/confidentialite.html`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Mise à jour le 7 octobre 2026/);

  const gallery = await fetch(`${baseUrl}/api/gallery`);
  assert.equal(gallery.status, 200);
  const galleryItems = (await gallery.json()).items;
  assert.deepEqual(galleryItems, []);

  assert.equal((await fetch(`${baseUrl}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/.ehms-data/appointments.json`)).status, 404);
});

test('administrator can manage prices, reviews, videos and realization photos', async () => {
  const login = await post('/api/admin-login', { password: 'Home2026' });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: baseUrl };

  const prices = await fetch(`${baseUrl}/api/prices`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      fauteuil: 7000, matelas_simple: 10000, matelas_double: 15000, matelas_king: 20000,
      tapis_petit: 5000, tapis_moyen: 10000, tapis_grand: 18000,
      menage_studio: 20000, menage_apt: 35000, menage_villa: 50000,
      fauteuil_places_max: 14, tapis_seuil_petit: 4, tapis_seuil_moyen: 8
    })
  });
  assert.equal(prices.status, 200);
  const savedSimulatorConfig = await (await fetch(`${baseUrl}/api/prices`)).json();
  assert.equal(savedSimulatorConfig.fauteuil_places_max, 14);
  assert.equal(savedSimulatorConfig.tapis_seuil_petit, 4);
  assert.equal(savedSimulatorConfig.tapis_seuil_moyen, 8);

  const invalidLimits = await fetch(`${baseUrl}/api/prices`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      fauteuil: 7000, matelas_simple: 10000, matelas_double: 15000, matelas_king: 20000,
      tapis_petit: 5000, tapis_moyen: 10000, tapis_grand: 18000,
      menage_studio: 20000, menage_apt: 35000, menage_villa: 50000,
      fauteuil_places_max: 14, tapis_seuil_petit: 8, tapis_seuil_moyen: 4
    })
  });
  assert.equal(invalidLimits.status, 400);

  const submittedReview = await post('/api/reviews', {
    name: 'Élodie D’Guessan',
    city: 'Abidjan',
    rating: 5,
    message: 'Équipe très professionnelle, merci !',
    consent: true
  });
  assert.equal(submittedReview.status, 201);
  const reviewId = (await submittedReview.json()).id;
  const reviewList = await fetch(`${baseUrl}/api/admin/reviews`, { headers: { Cookie: cookie } });
  const pendingReview = (await reviewList.json()).items[0];
  assert.equal(pendingReview.status, 'pending');
  assert.equal(pendingReview.name, 'Élodie D’Guessan');
  assert.equal(pendingReview.message, 'Équipe très professionnelle, merci !');

  const approved = await fetch(`${baseUrl}/api/admin/reviews/${reviewId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'published' })
  });
  assert.equal(approved.status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/reviews`)).json()).items[0].status, 'published');

  const unpublished = await fetch(`${baseUrl}/api/admin/reviews/${reviewId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'pending' })
  });
  assert.equal(unpublished.status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/reviews`)).json()).items.length, 0);
  const republished = await fetch(`${baseUrl}/api/admin/reviews/${reviewId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'published' })
  });
  assert.equal(republished.status, 200);
  assert.equal((await (await fetch(`${baseUrl}/api/reviews`)).json()).items[0].status, 'published');

  const videoData = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
  const addedVideo = await fetch(`${baseUrl}/api/video-news?title=${encodeURIComponent('Présentation')}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'video/webm' },
    body: videoData
  });
  assert.equal(addedVideo.status, 201);
  const createdVideo = await addedVideo.json();
  const videoId = createdVideo.id;
  assert.match(createdVideo.url, /^\/videos\/[\da-f-]{36}\.webm$/i);
  const uploadedVideo = await fetch(`${baseUrl}${createdVideo.url}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(uploadedVideo.status, 206);
  assert.equal(uploadedVideo.headers.get('content-type'), 'video/webm');
  assert.deepEqual(Buffer.from(await uploadedVideo.arrayBuffer()), videoData.subarray(0, 4));
  const largeVideoSize = 100 * 1024 * 1024 + 1;
  const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const largeVideoStream = async function* () {
    yield webmHeader;
    const chunk = Buffer.alloc(1024 * 1024, 0);
    let remaining = largeVideoSize - webmHeader.length;
    while (remaining > 0) {
      const nextChunk = chunk.subarray(0, Math.min(chunk.length, remaining));
      yield nextChunk;
      remaining -= nextChunk.length;
    }
  };
  const largeVideo = await fetch(`${baseUrl}/api/video-news?title=Vid%C3%A9o%20sans%20limite`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'video/webm' },
    body: Readable.from(largeVideoStream()),
    duplex: 'half'
  });
  assert.equal(largeVideo.status, 201);
  const createdLargeVideo = await largeVideo.json();
  const finalVideoByte = await fetch(`${baseUrl}${createdLargeVideo.url}`, {
    headers: { Range: `bytes=${largeVideoSize - 1}-${largeVideoSize - 1}` }
  });
  assert.equal(finalVideoByte.status, 206);
  assert.deepEqual(Buffer.from(await finalVideoByte.arrayBuffer()), Buffer.from([0]));
  const deleteLargeVideo = await fetch(`${baseUrl}/api/video-news/${createdLargeVideo.id}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(deleteLargeVideo.status, 200);
  const externalVideoLink = await fetch(`${baseUrl}/api/video-news?title=Ancien%20lien`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Ancien lien', url: 'https://www.youtube.com/watch?v=abcdefghijk' })
  });
  assert.equal(externalVideoLink.status, 415);
  const unsupportedVideoFormat = await fetch(`${baseUrl}/api/video-news?title=Format%20non%20pris%20en%20charge`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'video/x-msvideo' },
    body: Buffer.from('unsupported AVI')
  });
  assert.equal(unsupportedVideoFormat.status, 415);
  const deletedVideo = await fetch(`${baseUrl}/api/video-news/${videoId}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(deletedVideo.status, 200);
  assert.equal((await fetch(`${baseUrl}${createdVideo.url}`)).status, 404);

  const unauthorizedGalleryUpload = await post('/api/admin/gallery', {});
  assert.equal(unauthorizedGalleryUpload.status, 401);

  const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Bz8AAAAASUVORK5CYII=';
  const galleryUpload = await fetch(`${baseUrl}/api/admin/gallery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Canapé rénové à Cocody',
      category: 'Fauteuils et canapés',
      description: 'Taches éliminées et tissu ravivé.',
      image: `data:image/png;base64,${pngData}`
    })
  });
  assert.equal(galleryUpload.status, 201);
  const createdPhoto = await galleryUpload.json();
  assert.equal(createdPhoto.title, 'Canapé rénové à Cocody');
  assert.match(createdPhoto.url, /^\/uploads\/[\da-f-]{36}\.png$/i);
  const uploadedImage = await fetch(`${baseUrl}${createdPhoto.url}`);
  assert.equal(uploadedImage.status, 200);
  assert.match(uploadedImage.headers.get('content-type'), /image\/png/);

  const replacement = await fetch(`${baseUrl}/api/admin/gallery/${createdPhoto.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      title: createdPhoto.title,
      category: createdPhoto.category,
      description: createdPhoto.description,
      image: `data:image/png;base64,${pngData}`
    })
  });
  assert.equal(replacement.status, 200);
  const replacedPhoto = await replacement.json();
  assert.notEqual(replacedPhoto.url, createdPhoto.url);
  assert.equal((await fetch(`${baseUrl}${createdPhoto.url}`)).status, 404);

  const deletedPhoto = await fetch(`${baseUrl}/api/admin/gallery/${createdPhoto.id}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(deletedPhoto.status, 200);
  assert.equal((await fetch(`${baseUrl}${replacedPhoto.url}`)).status, 404);

  const galleryPhotos = [];
  for (let index = 0; index < 9; index += 1) {
    const uploaded = await fetch(`${baseUrl}/api/admin/gallery`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: `Réalisation ${index + 1}`,
        category: 'Fauteuils et canapés',
        description: '',
        image: `data:image/png;base64,${pngData}`
      })
    });
    assert.equal(uploaded.status, 201);
    galleryPhotos.push(await uploaded.json());
  }
  assert.equal((await (await fetch(`${baseUrl}/api/gallery`)).json()).items.length, 9);
  const fullGallery = await fetch(`${baseUrl}/api/admin/gallery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Réalisation 10',
      category: 'Fauteuils et canapés',
      description: '',
      image: `data:image/png;base64,${pngData}`
    })
  });
  assert.equal(fullGallery.status, 201);
  const tenthPhoto = await fullGallery.json();
  const overflowGallery = await fetch(`${baseUrl}/api/admin/gallery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Réalisation en trop',
      category: 'Fauteuils et canapés',
      description: '',
      image: `data:image/png;base64,${pngData}`
    })
  });
  assert.equal(overflowGallery.status, 409);
  for (const photo of [...galleryPhotos, tenthPhoto]) {
    const deleted = await fetch(`${baseUrl}/api/admin/gallery/${photo.id}`, { method: 'DELETE', headers });
    assert.equal(deleted.status, 200);
  }

  const changedPassword = await fetch(`${baseUrl}/api/admin-password`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ currentPassword: 'Home2026', newPassword: 'Client2026' })
  });
  assert.equal(changedPassword.status, 200);
  assert.equal((await post('/api/admin-login', { password: 'Home2026' })).status, 401);
  assert.equal((await post('/api/admin-login', { password: 'Client2026' })).status, 200);
});
