/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import Sqids from 'sqids';
import { createCors, error, json, Router } from 'itty-router';

// Create a new router
const router = Router();

const sqids = new Sqids();

// Add CORS headers to every request
const { preflight, corsify } = createCors({
	origin: '*',
	methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'X-API-KEY'],
	maxAge: 86400,
});

router.all('*', preflight);

// upload image
router.put('/upload', async (request, env, context) => {
	try {
		const auth = request.headers.get('X-API-KEY');
		const expectedAuth = env.API_KEY;

		if (!auth || auth !== expectedAuth) {
			return new Response('Unauthorized', { status: 401 });
		}

		// Get the content type of the request
		const contentType = request.headers.get('content-type');

		// if the content type is application/json, then the body is a JSON string with array of image urls
		// if the content type is multipart/form-data, then the body is a form data with image files
		if (contentType === 'application/json') {
			const imageUrls = await request.json();
			console.log('body', imageUrls);

			const images = {};
			for (const imageUrl of imageUrls) {
				const response = await fetch(imageUrl);
				const blob = await response.blob();

				// generate an unique filename
				const filename = generateUniqueIDFromTimestamp();
				const extension = blob.type.split('/').pop().split('+').shift();
				const objectKey = `${filename}.${extension}`;

				const object = await env.IMAGES_BUCKET.put(objectKey, blob, {
					httpMetadata: {
						contentType: blob.type,
					},
				});

				images[imageUrl] = {
					path: `${env.DOMAIN}/images/${objectKey}`,
					etag: object.httpEtag,
					content_type: blob.type,
				};
			}

			return Response.json(images);
		}

		if (contentType.includes('multipart/form-data')) {
			const formData = await request.formData();
			const files = formData.getAll('files');

			// check if the files are images
			for (const file of files) {
				if (!file.type.startsWith('image/')) {
					return new Response('Invalid file type', { status: 400 });
				}
			}

			let images = {};
			for (const file of files) {
				// generate an unique filename
				const objectKey = `${generateUniqueIDFromTimestamp()}.${file.type.split('/').pop().split('+').shift()}`;

				const object = await env.IMAGES_BUCKET.put(objectKey, file, {
					httpMetadata: {
						contentType: file.type,
					},
				});

				images[file.name] = {
					path: `${env.DOMAIN}/images/${objectKey}`,
					etag: object.httpEtag,
					content_type: file.type,
				};
			}

			return Response.json(images);
		}

		return new Response('Invalid content type', { status: 400 });
	} catch (e) {
		return new Response('Error thrown ' + e.message);
	}
});

// fetch image
router.get('/images/:filename.:extension', async (request, env, context) => {
	try {
		const url = new URL(request.url);

		// Construct the cache key from the cache URL
		const cacheKey = new Request(url.toString(), request);
		const cache = caches.default;

		// Check whether the value is already available in the cache
		// if not, you will need to fetch it from R2, and store it in the cache
		// for future access
		let response = await cache.match(cacheKey);

		if (response) {
			console.log(`Cache hit for: ${request.url}.`);
			return response;
		}

		console.log(`Response for request url: ${request.url} not present in cache. Fetching and caching request.`);

		const { filename, extension } = request.params;

		// If not in cache, get it from R2
		const objectKey = `${filename}.${extension}`;
		const object = await env.IMAGES_BUCKET.get(objectKey);
		if (object === null) {
			return new Response('Object Not Found', { status: 404 });
		}

		// Set the appropriate object headers
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);

		// // set content-type header
		// headers.set('content-type', object.httpMetadata.contentType);
		// console.log('content-type', object.httpMetadata);

		// Cache API respects Cache-Control headers. Setting s-max-age to 3600
		// will limit the response to be in cache for 3600 seconds max
		// Any changes made to the response here will be reflected in the cached value
		headers.append('Cache-Control', 's-maxage=3600');

		response = new Response(object.body, {
			headers,
		});

		// Store the fetched response as cacheKey
		// Use waitUntil so you can return the response without blocking on
		// writing to cache
		context.waitUntil(cache.put(cacheKey, response.clone()));

		return response;
	} catch (e) {
		return new Response('Error thrown ' + e.message);
	}
});

router.all('*', () => new Response('404, not found!', { status: 404 }));

export default {
	fetch: (request) => router.handle(request).catch(error).then(corsify),
};

function generateUniqueIDFromTimestamp() {
	const timestamp = new Date().getTime();
	return sqids.encode([timestamp]);
}
