# Mise en ligne sur un VPS Linux

Le site et son API tournent ensemble sur un serveur Node.js. Les demandes, tarifs, avis, actualités
vidéo, photos de la galerie, abonnements push et le mot de passe administrateur sont enregistrés
dans le dossier de données privé `.ehms-data/` (ou dans `EHMS_DATA_DIR`). Aucun service de base de
données ou de formulaire externe n’est nécessaire.

## Déploiement sur Render

Le fichier `render.yaml` configure un service web Node.js, une vérification de santé et un disque
persistant monté sur `/var/data`. Le service utilise le plan Starter, car le stockage local des
demandes, réglages, mots de passe, photos et vidéos nécessite un disque persistant. Le plan gratuit
de Render ne convient pas à ce stockage.

1. Place le projet dans un dépôt GitHub privé. Ne pousse pas `.ehms-data/`, les fichiers `.env` ou
   des données personnelles ; ils sont exclus par `.gitignore`.
2. Dans Render, choisis **New +** puis **Blueprint**, connecte GitHub et sélectionne ce dépôt.
   Render détecte `render.yaml` et affiche le service et le disque à créer.
3. Vérifie le coût affiché, puis crée le Blueprint. Render construit le site avec `npm run build`,
   lance `npm start` et génère un mot de passe administrateur initial aléatoire.
4. Dans l’environnement du service Render, configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et
   `VAPID_SUBJECT` pour activer les notifications push. Génère une paire VAPID avec
   `npx web-push generate-vapid-keys --json`, conserve la clé privée uniquement dans les variables
   secrètes de Render et définis `VAPID_SUBJECT` avec une adresse de contact `mailto:` ou une URL
   HTTPS.
5. Une fois le déploiement terminé, ouvre l’URL `onrender.com` fournie par Render. Vérifie
   `/api/health`, l’accueil et `/admin.html`. Récupère `EHMS_ADMIN_PASSWORD` dans l’environnement
   du service Render pour la première connexion, puis change-le depuis le dashboard.
6. Depuis le tableau de bord ouvert sur le téléphone du propriétaire, active « Alertes sur ce
   téléphone » et accepte la demande de permission du navigateur. Teste ensuite une demande.
7. Teste une demande, la mise à jour d’un tarif, l’enregistrement d’un revenu réellement encaissé
   à la fin d’une prestation et le téléversement d’une photo et d’une vidéo.
   Garde le disque attaché au service : les fichiers stockés dessus contiennent toutes les données
   persistantes de l’application. Configure aussi une sauvegarde régulière du disque.

La configuration définit `TRUST_PROXY=1` afin que le serveur reconnaisse correctement HTTPS derrière
le proxy de Render. Le disque est monté sur `/var/data`, qui est également utilisé pour
`EHMS_DATA_DIR`. Ne crée pas de second service web en parallèle avec le même disque de données.

## Prérequis

- Un VPS Linux avec Node.js 20 ou plus récent.
- Un nom de domaine pointant vers le VPS.
- Un reverse proxy (par exemple Nginx ou Caddy) configuré avec HTTPS et transmission vers le port
  local du serveur Node.
- Un répertoire persistant, sauvegardé et accessible en écriture au compte qui exécute Node.

## Installation et démarrage

1. Copie le projet sur le VPS et définis les variables d’environnement :
   - `NODE_ENV=production`
   - `EHMS_ADMIN_PASSWORD` : mot de passe initial facultatif. Si cette variable n’est pas définie,
     le code initial est `Home2026`. Change-le avant d’ouvrir le site au public ; le dashboard
     accepte les nouveaux mots de passe d’au moins 8 caractères. Ne mets aucun mot de passe dans
     le dépôt ni dans un fichier public.
   - `EHMS_DATA_DIR` : chemin absolu vers un dossier persistant hors du dossier publié par le
     serveur web.
   - `PUBLIC_ORIGIN` : origine exacte du site, par exemple `https://www.exemple.ci`, sans barre
     oblique finale.
   - `PORT=3000` (ou le port local choisi).
   - `HOST=127.0.0.1` si le reverse proxy est sur le même VPS.
   - `TRUST_PROXY=1` lorsque le reverse proxy termine HTTPS et transmet `X-Forwarded-Proto`.
2. Depuis le dossier du projet, exécute `npm ci`, `npm run build`, puis `npm start` pour installer
   les dépendances verrouillées et démarrer le site.
3. Configure le reverse proxy pour transmettre le trafic HTTPS au serveur Node, et active le
   renouvellement automatique du certificat TLS.
4. Visite `/api/health` et `/admin.html` en HTTPS. Le premier lancement crée les fichiers de données
   et enregistre un hachage du mot de passe initial dans le dossier privé. Les connexions sont
   protégées par cookie HTTPOnly et expirent après huit heures.
5. Connecte-toi au dashboard avec le mot de passe initial puis change-le avant la mise en ligne.
   Le nouveau mot de passe est haché côté serveur et enregistré dans le dossier privé.

Les demandes publiques sont limitées en taille et validées côté serveur. L’origine des écritures
est vérifiée ; les tentatives de connexion sont limitées. Le code initial `Home2026` est simple à
deviner et ne doit donc pas rester actif sur le site public. Les avis restent en attente jusqu’à leur
publication par l’administrateur. Les actualités vidéo se publient depuis le dashboard par
téléversement en flux d’un fichier MP4, WebM, MOV, M4V ou 3GP, sans limite de taille imposée par
l’application. L’espace disque disponible et les limites du fournisseur d’hébergement continuent
toutefois de s’appliquer ; surveille et sauvegarde le dossier `videos/`.

## Avant de communiquer le site

- Fais un envoi de test du formulaire et vérifie qu’il apparaît dans le dashboard.
- Teste la validation/publication et la suppression d’un avis, la mise à jour des tarifs et le
  téléversement, la lecture puis la suppression d’une actualité vidéo. Vérifie que les prix du
  simulateur et les tarifs des cartes de services suivent les modifications du dashboard.
- Ajoute, remplace et supprime une photo de réalisation dans le dashboard, puis vérifie la galerie
  publique. Tu peux téléverser plusieurs photos, chacune avec son propre titre ; la galerie publique
  les fait défiler automatiquement. Elle accepte au maximum 10 photos JPG, PNG ou WebP de 8 Mo
  maximum par photo.
- Vérifie que `/api/appointments`, `/api/admin/reviews` et les routes d’écriture admin refusent les
  visiteurs non authentifiés.
- Vérifie que le dossier de données n’est pas servi par Nginx, Caddy ou le serveur Node.
- Configure des sauvegardes chiffrées et périodiquement testées du dossier de données. Ne copie pas
  les données personnelles dans Git.
- Les photos téléversées sont enregistrées dans le sous-dossier `gallery/` du dossier de données
  et doivent être incluses dans les sauvegardes.
- Les vidéos téléversées sont enregistrées dans le sous-dossier `videos/` du dossier de données
  et doivent également être incluses dans les sauvegardes.
- Les revenus affichés correspondent uniquement aux montants saisis lors du marquage d’une
  prestation comme terminée ; les demandes anciennes ne reçoivent pas de revenu estimé.
- Les notifications nécessitent HTTPS, les trois variables VAPID configurées et l’autorisation
  du navigateur sur chaque téléphone. Le navigateur doit prendre en charge Web Push ; sur iPhone,
  l’application du site peut devoir être ajoutée à l’écran d’accueil.
- Les anciens fichiers `video-news.json` et `videos/` ne sont pas importés automatiquement. Vérifie
  leur contenu et les autorisations avant de les migrer.
- Fais vérifier les mentions légales et la politique de confidentialité avant la commercialisation.

## Limites de stockage

Le stockage JSON est prévu pour une seule instance Node sur un VPS et un faible volume. Ne lance
pas plusieurs instances en parallèle et n’utilise pas un hébergement serverless/éphémère : les
fichiers locaux y seraient perdus ou désynchronisés. Pour un trafic élevé ou plusieurs instances,
il faudra migrer le stockage vers une base de données adaptée.
