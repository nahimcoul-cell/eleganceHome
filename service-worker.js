self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    console.error('Notification push reçue avec un contenu invalide.', error);
  }

  event.waitUntil(self.registration.showNotification(data.title || 'Elegance Home', {
    body: data.body || 'Une nouvelle demande est arrivée.',
    data: { url: data.url || '/admin.html' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/admin.html', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    return existing ? existing.navigate(targetUrl).then(() => existing.focus()) : self.clients.openWindow(targetUrl);
  }));
});
