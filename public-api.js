(() => {
  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || 'Une erreur est survenue. Réessayez plus tard.');
    }
    return result;
  }

  window.ehmsPublicData = Object.freeze({
    isConfigured: () => true,
    loadPrices: async () => request('/api/prices'),
    submitAppointment: (appointment) => request('/api/appointments', {
      method: 'POST',
      body: JSON.stringify(appointment)
    }),
    submitReview: (review) => request('/api/reviews', {
      method: 'POST',
      body: JSON.stringify(review)
    }),
    loadPublishedReviews: async () => (await request('/api/reviews')).items,
    loadVideoNews: async () => (await request('/api/video-news')).items,
    loadGallery: async () => (await request('/api/gallery')).items,
    videoUrl: (url) => url
  });
})();
