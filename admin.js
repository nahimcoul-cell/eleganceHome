document.addEventListener('DOMContentLoaded', () => {
  const element = (id) => document.getElementById(id);
  const accessOverlay = element('accessOverlay');
  const accessForm = element('accessForm');
  const accessStatus = element('accessStatus');
  const passwordInput = element('accessPasswordInput');
  const togglePasswordButton = element('toggleAccessPassword');
  const siteHomeUrl = new URL('index.html', window.location.href).href;
  const siteHomeLink = element('siteHomeLink');
  const copySiteLinkButton = element('copySiteLinkBtn');
  const siteLinkStatus = element('siteLinkStatus');
  const submitButton = accessForm.querySelector('button[type="submit"]');
  let appointments = [];
  let prices = {};
  let reviews = [];
  let videos = [];
  let galleryItems = [];
  let pushConfig = null;
  let pushSubscription = null;
  let currentFilter = 'all';
  let searchQuery = '';

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'La requête a échoué.');
    return body;
  }

  function setLocked(locked) {
    document.body.classList.toggle('locked', locked);
    accessOverlay.classList.toggle('hidden', !locked);
  }

  togglePasswordButton.addEventListener('click', () => {
    const isVisible = passwordInput.type === 'text';
    passwordInput.type = isVisible ? 'password' : 'text';
    togglePasswordButton.textContent = isVisible ? 'Afficher' : 'Masquer';
    togglePasswordButton.setAttribute('aria-label', isVisible ? 'Afficher le mot de passe' : 'Masquer le mot de passe');
    togglePasswordButton.setAttribute('aria-pressed', String(!isVisible));
  });

  siteHomeLink.href = siteHomeUrl;
  siteHomeLink.textContent = siteHomeUrl;
  copySiteLinkButton.addEventListener('click', async () => {
    siteLinkStatus.textContent = '';
    let clipboardError;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('La copie directe n’est pas disponible.');
      await navigator.clipboard.writeText(siteHomeUrl);
      siteLinkStatus.textContent = 'Lien de la page d’accueil copié.';
      return;
    } catch (error) {
      clipboardError = error;
    }

    const temporaryInput = document.createElement('textarea');
    temporaryInput.value = siteHomeUrl;
    temporaryInput.setAttribute('readonly', '');
    temporaryInput.style.position = 'fixed';
    temporaryInput.style.opacity = '0';
    document.body.append(temporaryInput);
    let copied = false;
    try {
      temporaryInput.select();
      copied = document.execCommand('copy');
    } catch (error) {
      clipboardError = error;
    } finally {
      temporaryInput.remove();
    }
    if (copied) {
      siteLinkStatus.textContent = 'Lien de la page d’accueil copié.';
      return;
    }
    siteLinkStatus.textContent = 'Copie impossible. Sélectionnez et copiez le lien affiché.';
    showToast(clipboardError.message, 'error');
  });

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `custom-toast ${type}`;
    const content = document.createElement('div');
    content.className = 'toast-content';
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'success' ? '✔' : '!';
    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    content.append(icon, text);
    toast.append(content);
    document.body.append(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function updateMetrics(list) {
    const total = list.length;
    const done = list.filter((item) => item.status === 'traite').length;
    const cities = new Set(list.map((item) => (item.ville || '').trim().toLowerCase()).filter(Boolean));
    element('totalRdv').textContent = total;
    element('nouveauxRdv').textContent = total - done;
    element('traitesRdv').textContent = done;
    element('villeCount').textContent = cities.size;
    const revenue = list.reduce((sum, item) => sum + (item.status === 'traite' && Number.isSafeInteger(item.revenueCfa) ? item.revenueCfa : 0), 0);
    element('revenueTotal').textContent = `${revenue.toLocaleString('fr-FR')} FCFA`;
    updateCities(list);
    const pct = total ? Math.round((done / total) * 100) : 0;
    element('ratioCircle').style.strokeDashoffset = 251.2 - (pct / 100) * 251.2;
    element('ratioText').textContent = `${pct}%`;
    element('ratioSub').textContent = `${done} demande${done > 1 ? 's' : ''} traitée${done > 1 ? 's' : ''} sur ${total}`;
  }

  function updateCities(list) {
    const counts = new Map();
    list.forEach((item) => {
      const city = (item.ville || '').trim();
      if (city) {
        const label = city.charAt(0).toUpperCase() + city.slice(1).toLowerCase();
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const container = element('topCitiesList');
    if (!top.length) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:.9rem;text-align:center;">Aucune donnée de commune.</p>';
      return;
    }
    const max = top[0][1];
    container.innerHTML = top.map(([city, count]) =>
      `<div class="city-item"><div class="city-meta"><span>${escapeHtml(city)}</span><span style="color:var(--primary-dark);font-weight:700;">${count} rendez-vous</span></div><div class="city-bar-track"><div class="city-bar-fill" style="width:${Math.round(count / max * 100)}%;"></div></div></div>`
    ).join('');
  }

  function renderAppointments() {
    const tbody = element('appointmentsBody');
    updateMetrics(appointments);
    let list = appointments;
    if (currentFilter !== 'all') list = list.filter((item) => item.status === currentFilter);
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      list = list.filter((item) =>
        [item.nom, item.telephone, item.ville, item.message].some((value) => String(value || '').toLowerCase().includes(query))
      );
    }
    if (!list.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7"><div class="empty-state"><h3>Aucun rendez-vous trouvé</h3><p style="color:var(--text-muted);font-size:.9rem;">Essayez d’ajuster les filtres ou la recherche.</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = list.map((item) => {
      const treated = item.status === 'traite';
      const date = item.createdAt || item.created_at;
      const id = escapeHtml(item.id);
      return `<tr id="row-${id}">
        <td class="td-nom" data-label="Nom du client">${escapeHtml(item.nom)}</td>
        <td data-label="Téléphone" style="font-weight:500;">${escapeHtml(item.telephone)}</td>
        <td data-label="Commune / Ville"><span style="font-weight:600;color:var(--primary);">${escapeHtml(item.ville)}</span></td>
        <td class="td-message" data-label="Demande">${escapeHtml(item.message)}</td>
        <td class="td-date" data-label="Date d’envoi">${date ? escapeHtml(new Date(date).toLocaleString('fr-FR')) : ''}</td>
        <td data-label="Réponse"><div class="row-actions">
          <button class="action-btn reply" data-action="whatsapp" data-id="${id}" title="Répondre à ${escapeHtml(item.nom)} sur WhatsApp" aria-label="Répondre à ${escapeHtml(item.nom)} sur WhatsApp">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.1a8.5 8.5 0 1 1 15.6-4.4Z"></path>
              <path d="M9 8.5c.2-.4.4-.5.7-.5h.5c.2 0 .3.1.4.4l.7 1.5c.1.2.1.4-.1.6l-.5.6c-.2.2-.2.4-.1.6.5.9 1.2 1.6 2.1 2.1.2.1.4.1.6-.1l.6-.5c.2-.2.4-.2.6-.1l1.5.7c.3.1.4.2.4.4v.5c0 .3-.1.5-.5.7-.5.2-1.4.3-2.4-.1s-2-1-2.9-1.9c-.9-.9-1.5-1.9-1.9-2.9-.4-1-.3-1.9-.1-2.4Z"></path>
            </svg>
            <span>Répondre</span>
          </button>
          ${treated ? '' : '<button class="action-btn done" data-action="done" data-id="' + id + '" title="Terminer la prestation et saisir le montant encaissé" aria-label="Terminer la prestation et saisir le montant encaissé">✓</button>'}
          <button class="action-btn delete" data-action="delete" data-id="${id}" title="Supprimer" aria-label="Supprimer">×</button>
        </div></td>
        <td data-label="Statut"><span class="status-badge ${treated ? 'traite' : 'nouveau'}">${treated ? 'Terminé' : 'Nouveau'}</span>${treated && Number.isSafeInteger(item.revenueCfa) ? `<div class="revenue-value">${item.revenueCfa.toLocaleString('fr-FR')} FCFA encaissés</div>` : ''}</td>
      </tr>`;
    }).join('');
  }

  async function loadDashboard() {
    const [appointmentData, priceData, reviewData, videoData, galleryData, pushData] = await Promise.all([
      api('/api/appointments'),
      api('/api/prices'),
      api('/api/admin/reviews'),
      api('/api/video-news'),
      api('/api/gallery'),
      api('/api/push/config')
    ]);
    appointments = appointmentData.items;
    prices = priceData;
    reviews = reviewData.items;
    videos = videoData.items;
    galleryItems = galleryData.items;
    pushConfig = pushData;
    renderAppointments();
    fillPricesForm();
    renderReviews();
    renderVideos();
    renderGallery();
    await updatePushAlertsState();
  }

  async function updateAppointments(items) {
    const result = await api('/api/appointments', {
      method: 'PUT',
      body: JSON.stringify({ items })
    });
    appointments = result.items;
    renderAppointments();
  }

  function applicationServerKey(key) {
    const padding = '='.repeat((4 - key.length % 4) % 4);
    const base64 = (key + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  }

  async function updatePushAlertsState() {
    const button = element('pushAlertsButton');
    const status = element('pushAlertsStatus');
    if (!pushConfig?.enabled) {
      button.disabled = true;
      button.textContent = 'Alertes non configurées';
      status.textContent = 'Les clés push doivent d’abord être configurées sur l’hébergement.';
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      button.disabled = true;
      button.textContent = 'Alertes indisponibles';
      status.textContent = 'Ce navigateur ne prend pas en charge les notifications push.';
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration('/');
    pushSubscription = registration ? await registration.pushManager.getSubscription() : null;
    button.disabled = false;
    button.textContent = pushSubscription ? 'Désactiver les alertes sur ce téléphone' : 'Activer les alertes sur ce téléphone';
    status.textContent = pushSubscription
      ? 'Ce téléphone recevra une alerte à chaque nouvelle demande.'
      : 'Autorisez les notifications pour recevoir une alerte à chaque nouvelle demande.';
  }

  element('pushAlertsButton').addEventListener('click', async () => {
    const button = element('pushAlertsButton');
    const status = element('pushAlertsStatus');
    button.disabled = true;
    try {
      if (pushSubscription) {
        await api('/api/push/subscriptions', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: pushSubscription.endpoint })
        });
        await pushSubscription.unsubscribe();
        pushSubscription = null;
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('Autorisez les notifications dans les réglages du navigateur.');
        const registration = await navigator.serviceWorker.register('/service-worker.js');
        pushSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(pushConfig.publicKey)
        });
        await api('/api/push/subscriptions', {
          method: 'POST',
          body: JSON.stringify(pushSubscription)
        });
      }
      await updatePushAlertsState();
    } catch (error) {
      status.textContent = error.message;
      showToast(error.message, 'error');
      button.disabled = false;
    }
  });

  accessForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    accessStatus.textContent = '';
    submitButton.disabled = true;
    submitButton.textContent = 'Vérification…';
    try {
      await api('/api/admin-login', {
        method: 'POST',
        body: JSON.stringify({ password: passwordInput.value })
      });
      passwordInput.value = '';
      await loadDashboard();
      setLocked(false);
    } catch (error) {
      accessStatus.textContent = error.message;
      passwordInput.value = '';
      passwordInput.focus();
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Ouvrir le tableau de bord';
    }
  });

  async function checkSession() {
    try {
      const result = await api('/api/admin-session');
      if (result.authenticated) {
        await loadDashboard();
        setLocked(false);
      } else {
        setLocked(true);
      }
    } catch (error) {
      accessStatus.textContent = `Serveur indisponible : ${error.message}`;
      setLocked(true);
    }
  }

  element('logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/admin-logout', { method: 'POST', body: '{}' });
      appointments = [];
      setLocked(true);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  element('refreshBtn').addEventListener('click', () => {
    loadDashboard().catch((error) => showToast(error.message, 'error'));
  });

  document.querySelectorAll('.filter-tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.dataset.filter;
    renderAppointments();
  }));
  element('searchInput').addEventListener('input', (event) => {
    searchQuery = event.target.value;
    renderAppointments();
  });
  element('clearBtn').addEventListener('click', async () => {
    if (!confirm('Voulez-vous vraiment vider toutes les demandes de rendez-vous ? Cette action est irréversible.')) return;
    try {
      await updateAppointments([]);
      showToast('Toutes les demandes ont été supprimées.');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  element('exportCsvBtn').addEventListener('click', () => {
    if (!appointments.length) {
      alert('Aucune réservation à exporter.');
      return;
    }
    const cell = (value) => {
      const text = String(value ?? '').replace(/\r?\n/g, ' ');
      return `"${(/^\s*[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
    };
    const lines = ['Nom,Téléphone,Commune/Ville,Détails,Date,Statut,Revenu encaissé (FCFA)'];
    appointments.forEach((item) => {
      const date = item.createdAt || item.created_at;
      lines.push([item.nom, item.telephone, item.ville, item.message, date ? new Date(date).toLocaleString('fr-FR') : '', item.status, item.revenueCfa ?? ''].map(cell).join(','));
    });
    const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `rdv_elegance_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });
  element('appointmentsBody').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    const appointment = appointments.find((item) => item.id === id);
    if (!appointment) return;
    if (action === 'whatsapp') {
      let phone = (appointment.telephone || '').replace(/\D/g, '');
      if (phone.startsWith('00')) phone = phone.slice(2);
      if (phone.length === 10 && phone.startsWith('0')) phone = `225${phone}`;
      if (phone.length < 8 || phone.length > 15) {
        alert('Numéro de téléphone invalide.');
        return;
      }
      const message = [`Bonjour ${appointment.nom || ''},`, 'Nous vous contactons au sujet de votre demande auprès d’Elegance Home Multi Service.', appointment.ville ? `Commune : ${appointment.ville}` : '', appointment.message ? `Votre demande : ${appointment.message}` : ''].filter(Boolean).join('\n');
      window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
      return;
    }
    if (action === 'delete' && !confirm('Voulez-vous vraiment supprimer ce rendez-vous ?')) return;
    if (action === 'done') {
      openProcessAppointment(appointment, button);
      return;
    }
    try {
      await updateAppointments(appointments.filter((item) => item.id !== id));
      showToast('Rendez-vous supprimé.');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  const processAppointmentModal = element('processAppointmentModal');
  const processAppointmentForm = element('processAppointmentForm');
  const processAppointmentRevenue = element('processAppointmentRevenue');
  const processAppointmentStatus = element('processAppointmentStatus');
  const submitProcessAppointment = element('submitProcessAppointment');
  let activeAppointmentId = null;
  let processAppointmentTrigger = null;

  function openProcessAppointment(appointment, trigger) {
    activeAppointmentId = appointment.id;
    processAppointmentTrigger = trigger;
    element('processAppointmentTitle').textContent = `Terminer la prestation de ${appointment.nom}`;
    element('processAppointmentDescription').textContent =
      'Saisissez le montant réellement encaissé. Indiquez 0 si aucun paiement n’a été reçu.';
    processAppointmentStatus.textContent = '';
    processAppointmentForm.reset();
    processAppointmentModal.hidden = false;
    processAppointmentModal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => processAppointmentModal.classList.add('active'));
    processAppointmentRevenue.focus();
  }

  function closeProcessAppointment(restoreFocus = true) {
    processAppointmentModal.classList.remove('active');
    processAppointmentModal.setAttribute('aria-hidden', 'true');
    const trigger = processAppointmentTrigger;
    activeAppointmentId = null;
    processAppointmentTrigger = null;
    setTimeout(() => {
      if (!processAppointmentModal.classList.contains('active')) processAppointmentModal.hidden = true;
    }, 300);
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }

  element('cancelProcessAppointment').addEventListener('click', () => closeProcessAppointment());
  element('cancelProcessAppointmentAction').addEventListener('click', () => closeProcessAppointment());
  processAppointmentModal.addEventListener('click', (event) => {
    if (event.target === processAppointmentModal) closeProcessAppointment();
  });
  document.addEventListener('keydown', (event) => {
    if (processAppointmentModal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeProcessAppointment();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...processAppointmentModal.querySelectorAll(
      'button:not([disabled]), input:not([disabled])'
    )].filter((item) => item.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  processAppointmentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const appointment = appointments.find((item) => item.id === activeAppointmentId);
    const revenueCfa = processAppointmentRevenue.valueAsNumber;
    if (!appointment) {
      processAppointmentStatus.textContent = 'Cette demande n’est plus disponible. Actualisez le tableau de bord.';
      return;
    }
    if (!Number.isSafeInteger(revenueCfa) || revenueCfa < 0 || revenueCfa > 1000000000) {
      processAppointmentStatus.textContent = 'Saisissez un montant entier valide entre 0 et 1 000 000 000 FCFA.';
      processAppointmentRevenue.focus();
      return;
    }
    submitProcessAppointment.disabled = true;
    processAppointmentStatus.textContent = '';
    try {
      const result = await api(`/api/appointments/${encodeURIComponent(appointment.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'traite', revenueCfa })
      });
      appointments = result.items;
      renderAppointments();
      closeProcessAppointment(false);
      showToast('Prestation terminée et revenu enregistré.');
    } catch (error) {
      processAppointmentStatus.textContent = error.message;
      showToast(error.message, 'error');
    } finally {
      submitProcessAppointment.disabled = false;
    }
  });

  const defaultPrices = {
    fauteuil: 7000, matelas_simple: 10000, matelas_double: 15000, matelas_king: 20000,
    tapis_petit: 5000, tapis_moyen: 10000, tapis_grand: 18000,
    menage_studio: 20000, menage_apt: 35000, menage_villa: 50000,
    fauteuil_places_max: 10, tapis_seuil_petit: 3, tapis_seuil_moyen: 6
  };
  const pricesModal = element('pricesModal');
  function fillPricesForm() {
    Object.keys(defaultPrices).forEach((key) => {
      const input = element(`price_${key}`);
      if (input) input.value = prices[key] ?? defaultPrices[key];
    });
  }
  function closePricesModal() { pricesModal.classList.remove('active'); }
  element('btnOpenPricesModal')?.addEventListener('click', () => {
    fillPricesForm();
    pricesModal.classList.add('active');
  });
  element('btnClosePricesModal')?.addEventListener('click', closePricesModal);
  element('btnCancelPrices')?.addEventListener('click', closePricesModal);
  pricesModal?.addEventListener('click', (event) => {
    if (event.target === pricesModal) closePricesModal();
  });
  element('btnResetPrices')?.addEventListener('click', async () => {
    if (!confirm('Voulez-vous réinitialiser tous les tarifs aux valeurs d’origine ?')) return;
    try {
      prices = await api('/api/prices', { method: 'PUT', body: JSON.stringify(defaultPrices) });
      fillPricesForm();
      closePricesModal();
      showToast('Tarifs réinitialisés.');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  element('pricesForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const updated = Object.fromEntries(Object.keys(defaultPrices).map((key) => [key, Number(element(`price_${key}`).value)]));
    try {
      prices = await api('/api/prices', { method: 'PUT', body: JSON.stringify(updated) });
      closePricesModal();
      showToast('Tarifs mis à jour.');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  const pendingReviewsList = element('pendingReviewsList');
  let reviewFilter = 'pending';

  function formatReviewDate(value) {
    if (!value || Number.isNaN(Date.parse(value))) return 'Date inconnue';
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
  }

  function renderReviews() {
    const pendingCount = reviews.filter((review) => review.status === 'pending').length;
    const publishedCount = reviews.filter((review) => review.status === 'published').length;
    element('pendingReviewCount').textContent = pendingCount;
    element('publishedReviewCount').textContent = publishedCount;
    document.querySelectorAll('[data-review-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.reviewFilter === reviewFilter));
    });
    const visibleReviews = reviews.filter((review) => review.status === reviewFilter);
    pendingReviewsList.replaceChildren();
    if (!visibleReviews.length) {
      const message = document.createElement('p');
      message.textContent = reviewFilter === 'pending'
        ? 'Aucun avis à vérifier pour le moment.'
        : 'Aucun avis publié pour le moment.';
      message.style.cssText = 'color:var(--text-muted);font-size:.85rem;';
      pendingReviewsList.append(message);
      return;
    }
    visibleReviews.forEach((review) => {
      const card = document.createElement('article');
      card.className = 'review-admin-card';
      const head = document.createElement('div');
      head.className = 'review-admin-card-head';
      const authorBlock = document.createElement('div');
      const author = document.createElement('strong');
      author.className = 'review-admin-author';
      author.textContent = review.name;
      const meta = document.createElement('p');
      meta.className = 'review-admin-meta';
      meta.textContent = [review.city, formatReviewDate(review.created_at || review.createdAt)].filter(Boolean).join(' · ');
      authorBlock.append(author, meta);
      const statusBadge = document.createElement('span');
      statusBadge.className = `review-admin-status${review.status === 'published' ? ' published' : ''}`;
      statusBadge.textContent = review.status === 'published' ? 'Publié' : 'À vérifier';
      head.append(authorBlock, statusBadge);
      const rating = document.createElement('div');
      rating.className = 'review-admin-author-row';
      const stars = document.createElement('span');
      stars.className = 'review-admin-stars';
      stars.setAttribute('aria-label', `Note : ${review.rating} sur 5`);
      stars.textContent = `${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}`;
      const ratingText = document.createElement('span');
      ratingText.className = 'review-admin-meta';
      ratingText.textContent = `${review.rating}/5`;
      rating.append(stars, ratingText);
      const message = document.createElement('p');
      message.className = 'review-admin-message';
      message.textContent = review.message;
      const actions = document.createElement('div');
      actions.className = 'review-admin-actions';
      const moderationAction = review.status === 'published' ? 'hide-review' : 'approve-review';
      const moderationLabel = review.status === 'published' ? 'Retirer de la page' : 'Publier l’avis';
      for (const [action, label, className] of [
        [moderationAction, moderationLabel, review.status === 'published' ? 'btn btn-secondary' : 'btn btn-primary'],
        ['delete-review', 'Supprimer', 'btn btn-danger']
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.dataset.action = action;
        button.dataset.id = review.id;
        button.textContent = label;
        actions.append(button);
      }
      card.append(head, rating, message, actions);
      pendingReviewsList.append(card);
    });
  }
  document.querySelectorAll('[data-review-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      reviewFilter = button.dataset.reviewFilter;
      renderReviews();
    });
  });
  pendingReviewsList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const review = reviews.find((item) => item.id === button.dataset.id);
    if (!review) return;
    if (button.dataset.action === 'delete-review' &&
        !confirm(`Supprimer définitivement l’avis de ${review.name} ?`)) return;
    button.disabled = true;
    try {
      const action = button.dataset.action;
      const id = encodeURIComponent(button.dataset.id);
      if (action === 'approve-review' || action === 'hide-review') {
        const status = action === 'approve-review' ? 'published' : 'pending';
        await api(`/api/admin/reviews/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
        reviews = reviews.map((item) => item.id === review.id ? { ...item, status } : item);
        showToast(status === 'published' ? 'Avis publié sur la page d’accueil.' : 'Avis retiré de la page publique.');
      } else {
        await api(`/api/admin/reviews/${id}`, { method: 'DELETE' });
        reviews = reviews.filter((item) => item.id !== review.id);
        showToast('Avis supprimé définitivement.');
      }
      renderReviews();
    } catch (error) {
      button.disabled = false;
      showToast(error.message, 'error');
    }
  });

  const videoNewsForm = element('videoNewsForm');
  const videoNewsList = element('videoNewsAdminList');
  const videoNewsFile = element('videoNewsFile');
  const videoNewsPreview = element('videoNewsPreview');
  const videoNewsFileInfo = element('videoNewsFileInfo');
  const videoMimeTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/3gpp']);
  let videoPreviewUrl = '';

  function releaseVideoPreview() {
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    videoPreviewUrl = '';
    videoNewsPreview.removeAttribute('src');
    videoNewsPreview.hidden = true;
    videoNewsPreview.load();
  }

  videoNewsFile.addEventListener('change', () => {
    releaseVideoPreview();
    const file = videoNewsFile.files[0];
    if (!file) {
      videoNewsFileInfo.textContent = 'Aucune limite de taille n’est imposée par le site. Le stockage disponible et l’hébergeur peuvent toutefois limiter l’envoi.';
      return;
    }
    if (!videoMimeTypes.has(file.type)) {
      videoNewsFileInfo.textContent = 'Format non pris en charge. Choisissez une vidéo MP4, WebM, MOV, M4V ou 3GP.';
      return;
    }
    videoNewsFileInfo.textContent = `${file.name} — ${(file.size / (1024 * 1024)).toFixed(1)} Mo`;
    videoPreviewUrl = URL.createObjectURL(file);
    videoNewsPreview.src = videoPreviewUrl;
    videoNewsPreview.hidden = false;
  });

  function renderVideos() {
    videoNewsList.replaceChildren();
    if (!videos.length) {
      const message = document.createElement('p');
      message.textContent = 'Aucune vidéo publiée pour le moment.';
      message.style.cssText = 'color:var(--text-muted);font-size:.85rem;';
      videoNewsList.append(message);
      return;
    }
    videos.forEach((video) => {
      const entry = document.createElement('div');
      entry.className = 'video-news-admin-item';
      const preview = document.createElement('video');
      preview.controls = true;
      preview.playsInline = true;
      preview.preload = 'metadata';
      if (/^\/videos\/[\da-f-]{36}\.(mp4|webm|mov|m4v|3gp)$/i.test(video.url || '')) {
        preview.src = video.url;
      } else {
        preview.hidden = true;
      }
      const details = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = video.title;
      details.append(title);
      if (video.description) {
        const description = document.createElement('p');
        description.textContent = video.description;
        details.append(description);
      }
      if (preview.hidden) {
        const legacy = document.createElement('p');
        legacy.textContent = 'Publication vidéo existante.';
        details.append(legacy);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.action = 'remove-video-news';
      remove.dataset.id = video.id;
      remove.textContent = 'Supprimer';
      entry.append(preview, details, remove);
      videoNewsList.append(entry);
    });
  }
  videoNewsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = element('videoNewsTitle').value.trim();
    const description = element('videoNewsDescription').value.trim();
    const file = videoNewsFile.files[0];
    const status = element('videoUploadStatus');
    const submit = videoNewsForm.querySelector('button[type="submit"]');
    if (!file) {
      status.textContent = 'Choisissez une vidéo avant de continuer.';
      return;
    }
    if (!videoMimeTypes.has(file.type)) {
      status.textContent = 'Choisissez une vidéo MP4, WebM, MOV, M4V ou 3GP.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Téléversement de la vidéo en cours…';
    try {
      const query = new URLSearchParams({ title, description });
      const item = await api(`/api/video-news?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: file
      });
      videos.unshift(item);
      videoNewsForm.reset();
      releaseVideoPreview();
      videoNewsFileInfo.textContent = 'Aucune limite de taille n’est imposée par le site. Le stockage disponible et l’hébergeur peuvent toutefois limiter l’envoi.';
      status.textContent = 'Vidéo publiée.';
      renderVideos();
      showToast('Vidéo publiée dans les actualités du site.');
    } catch (error) {
      status.textContent = error.message;
      showToast(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
  videoNewsList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="remove-video-news"]');
    if (!button || !confirm('Supprimer cette vidéo des actualités du site ?')) return;
    try {
      await api(`/api/video-news/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
      videos = videos.filter((video) => video.id !== button.dataset.id);
      renderVideos();
      showToast('Vidéo supprimée des actualités.');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  const galleryForm = element('galleryForm');
  const galleryList = element('galleryAdminList');
  const galleryStatus = element('galleryStatus');
  const galleryCapacity = element('galleryCapacity');
  const galleryInput = element('galleryImage');
  const galleryPendingList = element('galleryPendingList');
  const gallerySubmit = element('gallerySubmit');
  const maxGalleryImageSize = 8 * 1024 * 1024;
  const maxGalleryItems = 10;
  let pendingGalleryUploads = [];

  function imageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result));
      reader.addEventListener('error', () => reject(new Error('Impossible de lire le fichier image.')));
      reader.readAsDataURL(file);
    });
  }

  function renderGallery() {
    galleryList.replaceChildren();
    const remaining = Math.max(0, maxGalleryItems - galleryItems.length);
    galleryCapacity.textContent = `${galleryItems.length} photo${galleryItems.length === 1 ? '' : 's'} sur ${maxGalleryItems}. ${remaining} emplacement${remaining === 1 ? '' : 's'} disponible${remaining === 1 ? '' : 's'}.`;
    galleryInput.disabled = remaining === 0;
    gallerySubmit.disabled = remaining === 0 || !pendingGalleryUploads.length;
    if (!galleryItems.length) {
      const message = document.createElement('p');
      message.textContent = 'Aucune photo dans la galerie.';
      message.style.cssText = 'color:var(--text-muted);font-size:.85rem;';
      galleryList.append(message);
      return;
    }
    galleryItems.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'gallery-admin-item';
      const image = document.createElement('img');
      image.src = item.url;
      image.alt = item.title;
      image.loading = 'lazy';
      const details = document.createElement('div');
      details.className = 'gallery-admin-details';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const category = document.createElement('span');
      category.textContent = item.category;
      details.append(title, category);
      const controls = document.createElement('div');
      controls.className = 'gallery-admin-controls';
      const replaceInput = document.createElement('input');
      replaceInput.type = 'file';
      replaceInput.accept = 'image/jpeg,image/png,image/webp';
      replaceInput.setAttribute('aria-label', `Choisir une nouvelle photo pour ${item.title}`);
      replaceInput.dataset.galleryFile = item.id;
      const replace = document.createElement('button');
      replace.type = 'button';
      replace.dataset.action = 'replace-gallery-photo';
      replace.dataset.id = item.id;
      replace.textContent = 'Remplacer la photo';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.action = 'delete-gallery-photo';
      remove.dataset.id = item.id;
      remove.textContent = 'Supprimer';
      controls.append(replaceInput, replace, remove);
      card.append(image, details, controls);
      galleryList.append(card);
    });
  }

  function renderPendingGalleryUploads() {
    galleryPendingList.replaceChildren();
    pendingGalleryUploads.forEach((upload, index) => {
      const row = document.createElement('div');
      row.className = 'gallery-pending-item';
      const preview = document.createElement('img');
      preview.src = upload.previewUrl;
      preview.alt = '';
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 100;
      title.required = true;
      title.value = upload.title;
      title.placeholder = 'Titre de cette réalisation';
      title.setAttribute('aria-label', `Titre de la photo ${upload.file.name}`);
      title.addEventListener('input', () => {
        pendingGalleryUploads[index].title = title.value;
      });
      row.append(preview, title);
      galleryPendingList.append(row);
    });
    gallerySubmit.textContent = pendingGalleryUploads.length
      ? `Ajouter ${pendingGalleryUploads.length} photo${pendingGalleryUploads.length === 1 ? '' : 's'}`
      : 'Ajouter les photos';
    gallerySubmit.disabled = galleryItems.length >= maxGalleryItems || !pendingGalleryUploads.length;
  }

  galleryInput.addEventListener('change', () => {
    pendingGalleryUploads.forEach((upload) => URL.revokeObjectURL(upload.previewUrl));
    pendingGalleryUploads = [];
    galleryStatus.textContent = '';
    const remaining = Math.max(0, maxGalleryItems - galleryItems.length);
    const selected = Array.from(galleryInput.files);
    const validFiles = selected.filter((file) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > maxGalleryImageSize) {
        galleryStatus.textContent = `${file.name} n’est pas une image JPG, PNG ou WebP de 8 Mo maximum.`;
        return false;
      }
      return true;
    });
    if (validFiles.length > remaining) {
      galleryStatus.textContent = `Vous pouvez encore ajouter ${remaining} photo${remaining === 1 ? '' : 's'} au maximum. Les premières photos admissibles ont été retenues.`;
    }
    pendingGalleryUploads = validFiles.slice(0, remaining).map((file) => ({
      file,
      title: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 100) || 'Réalisation',
      previewUrl: URL.createObjectURL(file)
    }));
    renderPendingGalleryUploads();
  });

  galleryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingGalleryUploads.length) {
      galleryStatus.textContent = 'Sélectionnez au moins une photo et vérifiez son titre.';
      return;
    }
    if (pendingGalleryUploads.some((upload) => !upload.title.trim())) {
      galleryStatus.textContent = 'Chaque photo doit avoir un titre.';
      return;
    }
    gallerySubmit.disabled = true;
    let uploadedCount = 0;
    galleryStatus.textContent = `Téléversement de ${pendingGalleryUploads.length} photo(s)…`;
    try {
      while (pendingGalleryUploads.length) {
        const upload = pendingGalleryUploads[0];
        const item = await api('/api/admin/gallery', {
          method: 'POST',
          body: JSON.stringify({
            title: upload.title.trim(),
            category: element('galleryCategory').value,
            description: element('galleryDescription').value.trim(),
            image: await imageAsDataUrl(upload.file)
          })
        });
        galleryItems.unshift(item);
        URL.revokeObjectURL(upload.previewUrl);
        pendingGalleryUploads.shift();
        uploadedCount += 1;
        renderGallery();
        renderPendingGalleryUploads();
        galleryStatus.textContent = `${uploadedCount} photo${uploadedCount === 1 ? '' : 's'} ajoutée${uploadedCount === 1 ? '' : 's'}…`;
      }
      galleryForm.reset();
      galleryStatus.textContent = `${uploadedCount} photo${uploadedCount === 1 ? '' : 's'} ajoutée${uploadedCount === 1 ? '' : 's'} à la galerie de la page d’accueil.`;
      showToast(`${uploadedCount} photo${uploadedCount === 1 ? '' : 's'} publiée${uploadedCount === 1 ? '' : 's'} dans la galerie.`);
    } catch (error) {
      galleryStatus.textContent = uploadedCount
        ? `${uploadedCount} photo${uploadedCount === 1 ? '' : 's'} ajoutée${uploadedCount === 1 ? '' : 's'}. Le téléversement s’est arrêté : ${error.message} Les photos restantes sont toujours sélectionnées.`
        : error.message;
      showToast(error.message, 'error');
    } finally {
      renderPendingGalleryUploads();
    }
  });

  galleryList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const item = galleryItems.find((photo) => photo.id === button.dataset.id);
    if (!item) return;
    try {
      if (button.dataset.action === 'replace-gallery-photo') {
        const input = galleryList.querySelector(`input[data-gallery-file="${CSS.escape(item.id)}"]`);
        const image = input.files[0];
        if (!image) {
          galleryStatus.textContent = `Choisissez d’abord la nouvelle photo pour « ${item.title} ».`;
          input.focus();
          return;
        }
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type) || image.size > maxGalleryImageSize) {
          throw new Error('Choisissez une photo JPG, PNG ou WebP de 8 Mo maximum.');
        }
        const updated = await api(`/api/admin/gallery/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: item.title,
            category: item.category,
            description: item.description || '',
            image: await imageAsDataUrl(image)
          })
        });
        galleryItems = galleryItems.map((photo) => photo.id === item.id ? updated : photo);
        galleryStatus.textContent = `La photo « ${item.title} » a été remplacée.`;
        renderGallery();
        showToast('Photo remplacée dans la galerie.');
      } else {
        if (!confirm(`Supprimer la photo « ${item.title} » de la galerie ?`)) return;
        await api(`/api/admin/gallery/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
        galleryItems = galleryItems.filter((photo) => photo.id !== item.id);
        galleryStatus.textContent = 'Photo supprimée de la galerie.';
        renderGallery();
        showToast('Photo supprimée.');
      }
    } catch (error) {
      galleryStatus.textContent = error.message;
      showToast(error.message, 'error');
    }
  });

  element('securityPasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = element('securityPasswordStatus');
    const currentPassword = element('currentAdminPassword').value;
    const newPassword = element('newAdminPassword').value;
    const confirmation = element('confirmAdminPassword').value;
    if (newPassword.length < 8) {
      status.textContent = 'Le mot de passe doit contenir au moins 8 caractères.';
      return;
    }
    if (newPassword !== confirmation) {
      status.textContent = 'Les deux nouveaux mots de passe ne correspondent pas.';
      return;
    }
    try {
      await api('/api/admin-password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      element('securityPasswordForm').reset();
      status.textContent = 'Mot de passe modifié. Veuillez vous reconnecter.';
      setLocked(true);
    } catch (error) {
      status.textContent = error.message;
    }
  });

  setLocked(true);
  checkSession();
});
