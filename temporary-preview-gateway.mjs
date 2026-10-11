import { createServer, request } from 'node:http';

const upstream = new URL('http://127.0.0.1:3000');
const publicApiPaths = new Set([
  '/api/prices',
  '/api/reviews',
  '/api/gallery',
  '/api/video-news'
]);

function allowedPath(pathname) {
  if (pathname === '/' || pathname === '/index.html' ||
      pathname === '/public-api.js' || pathname === '/animations.js' ||
      pathname === '/animations.css' || pathname === '/confidentialite.html') return true;
  if (publicApiPaths.has(pathname)) return true;
  return /^\/images\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp|svg)$/i.test(pathname) ||
    /^\/uploads\/[\da-f-]{36}\.(?:jpg|png|webp)$/i.test(pathname) ||
    /^\/videos\/[\da-f-]{36}\.(?:mp4|webm|mov|m4v|3gp)$/i.test(pathname);
}

createServer((incoming, outgoing) => {
  const url = new URL(incoming.url, 'http://preview.local');
  if (!['GET', 'HEAD'].includes(incoming.method)) {
    outgoing.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    outgoing.end('Method not allowed');
    return;
  }
  if (!allowedPath(url.pathname)) {
    outgoing.writeHead(404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    outgoing.end('Not found');
    return;
  }

  const proxied = request({
    hostname: upstream.hostname,
    port: upstream.port,
    method: incoming.method,
    path: `${url.pathname}${url.search}`,
    headers: { host: upstream.host }
  }, (response) => {
    outgoing.writeHead(response.statusCode || 502, response.headers);
    response.pipe(outgoing);
  });
  proxied.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'Cache-Control': 'no-store' });
    outgoing.end('Preview upstream unavailable');
  });
  incoming.pipe(proxied);
}).listen(3002, '127.0.0.1');
