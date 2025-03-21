import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import getRawBody from "raw-body";

export async function createTestServer( {
	baseUrl, // Expected to always end in /
	report,
	middleware: userMiddleware = [],
	quiet,
	testUrls = []
} = {} ) {

	// Support connect-style middleware
	const middlewares = [];
	function use( middleware ) {
		middlewares.push( middleware );
	}

	function run( req, res ) {
		let i = 0;

		// Log responses unless quiet is set
		if ( !quiet ) {
			const originalEnd = res.end;
			res.end = function( ...args ) {
				console.log( `${ req.method } ${ req.url } ${ this.statusCode }` );
				originalEnd.call( this, ...args );
			};
		}

		// Add a parsed URL object to the request object
		req.parsedUrl = new URL(
			`http://${ process.env.HOST ?? "localhost" }${ req.url }`
		);

		// Add a simplified redirect helper to the response object
		res.redirect = ( status, location ) => {
			if ( !location ) {
				location = status;
				status = 303;
			}

			res.writeHead( status, { Location: location } );
			res.end();
		};

		const next = () => {
			const middleware = middlewares[ i++ ];
			if ( middleware ) {
				try {
					middleware( req, res, next );
				} catch ( error ) {
					console.error( error );
					res.writeHead( 500, { "Content-Type": "application/json" } );
					res.end( "Internal Server Error" );
				}
			} else {
				res.writeHead( 404 );
				res.end();
			}
		};

		next();
	}

	// Redirect home to test page
	if ( baseUrl !== "/" ) {
		use( ( req, res, next ) => {
			if ( req.parsedUrl.pathname === "/" ) {
				res.redirect( baseUrl );
			} else {
				next();
			}
		} );
	}

	// Redirect to trailing slash
	use( ( req, res, next ) => {
		if ( req.parsedUrl.pathname === baseUrl.replace( /\/$/, "" ) ) {
			res.redirect( 308, `${ req.parsedUrl.pathname }/${ req.parsedUrl.search }` );
		} else {
			next();
		}
	} );

	// Add a script tag to the index.html to load the QUnit listeners
	use( async( req, res, next ) => {
		const pathname = req.parsedUrl.pathname;
		if (
			( req.method === "GET" || req.method === "HEAD" ) &&
			( pathname === baseUrl || testUrls.includes( pathname.replace( baseUrl, "" ) ) )
		) {
			const indexHTML = await readFile(
				`.${ pathname }${ pathname.endsWith( ".html" ) ? "" : "index.html" }`,
				"utf8"
			);
			res.writeHead( 200, { "Content-Type": "text/html" } );
			res.end(
				indexHTML.replace(
					"</body>",
					"<script src=\"/node_modules/jquery-test-runner/listeners.js\"></script></body>"
				)
			);
		} else {
			next();
		}
	} );

	// Bind the reporter
	if ( report ) {
		use( async( req, res, next ) => {
			if ( req.url !== "/api/report" || req.method !== "POST" ) {
				return next();
			}
			let body;
			try {
				body = JSON.parse( await getRawBody( req ) );
			} catch ( error ) {
				if ( error.code === "ECONNABORTED" ) {
					return;
				}
				console.error( error );
				res.writeHead( 400, { "Content-Type": "application/json" } );
				res.end( JSON.stringify( { error: "Invalid JSON" } ) );
				return;
			}
			const response = await report( body );
			if ( response ) {
				res.writeHead( 200, { "Content-Type": "application/json" } );
				res.end( JSON.stringify( response ) );
			} else {
				res.writeHead( 204 );
				res.end();
			}
		} );
	}

	// Add user middleware
	userMiddleware.forEach( ( createMiddleware ) => {
		use( createMiddleware() );
	} );

	// Serve static files
	const validMimeTypes = {

		// No .mjs or .cjs files are used in tests
		".js": "application/javascript",
		".json": "application/json",
		".css": "text/css",
		".html": "text/html",
		".xml": "application/xml",
		".xhtml": "application/xhtml+xml",
		".jpg": "image/jpeg",
		".png": "image/png",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
		".map": "application/json",
		".txt": "text/plain",
		".log": "text/plain"
	};

	use( async( req, res, next ) => {

		// Allow serving anything but node_modules,
		// except for jquery-test-runner and qunit
		if (
			req.url.startsWith( "/node_modules/" ) &&
			!req.url.startsWith( "/node_modules/jquery-test-runner/" ) &&
			!req.url.startsWith( "/node_modules/qunit/" )
		) {
			return next();
		}
		const file = req.parsedUrl.pathname.slice( 1 );
		const ext = file.slice( file.lastIndexOf( "." ) );

		// Allow POST to .html files in tests
		if (
			req.method !== "GET" &&
			req.method !== "HEAD" &&
			( ext !== ".html" || req.method !== "POST" )
		) {
			return next();
		}
		const mimeType = validMimeTypes[ ext ];
		if ( mimeType ) {
			try {
				await stat( file );
			} catch ( _ ) {
				res.writeHead( 404 );
				res.end();
				return;
			}
			res.writeHead( 200, { "Content-Type": mimeType } );
			createReadStream( file )
				.pipe( res )
				.on( "error", ( error ) => {
					console.error( error );
					res.writeHead( 500 );
					res.end();
				} );
		} else {
			if ( !quiet ) {
				console.error( `Invalid file extension: ${ ext }` );
			}
			res.writeHead( 404 );
			res.end();
		}
	} );

	return http.createServer( run );
}
