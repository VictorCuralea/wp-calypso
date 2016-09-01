/**
 * External dependencies
 */
import async from 'async';
import noop from 'lodash/noop';
import some from 'lodash/some';
import debugFactory from 'debug';
const debug = debugFactory( 'calypso:ad-tracking' );
import { clone, cloneDeep } from 'lodash';

/**
 * Internal dependencies
 */
import loadScript from 'lib/load-script';
import config from 'config';
import productsValues from 'lib/products-values';
import userModule from 'lib/user';

/**
 * Module variables
 */
const user = userModule();
let hasStartedFetchingScripts = false,
	hasFinishedFetchingScripts = false,
	retargetingInitialized = false;

/**
 * Constants
 */
const FACEBOOK_TRACKING_SCRIPT_URL = 'https://connect.facebook.net/en_US/fbevents.js',
	ATLAS_TRACKING_SCRIPT_URL = 'https://ad.atdmt.com/m/a.js',
	GOOGLE_TRACKING_SCRIPT_URL = 'https://www.googleadservices.com/pagead/conversion_async.js',
	BING_TRACKING_SCRIPT_URL = 'https://bat.bing.com/bat.js',
	CRITEO_TRACKING_SCRIPT_URL = 'https://static.criteo.net/js/ld/ld.js',
	GOOGLE_CONVERSION_ID = config( 'google_adwords_conversion_id' ),
	ONE_BY_AOL_PIXEL_URL = 'https://secure.ace-tag.advertising.com/action/type=132958/bins=1/rich=0/Mnum=1516/',
	TRACKING_IDS = {
		bingInit: '4074038',
		facebookInit: '823166884443641',
		googleConversionLabel: 'MznpCMGHr2MQ1uXz_AM',
		googleConversionLabelJetpack: '0fwbCL35xGIQqv3svgM',
		atlasUniveralTagId: '11187200770563',
		criteo: '31321',
		quantcast: 'p-3Ma3jHaQMB_bS'
	},

	// For converting other currencies into USD for tracking purposes
	EXCHANGE_RATES = {
		USD: 1,
		EUR: 1,
		JPY: 125,
		AUD: 1.35,
		CAD: 1.35,
		GBP: 0.75
	};

/**
 * Globals
 */
if ( ! window.fbq ) {
	setUpFacebookGlobal();
}

if ( ! window.uetq ) {
	window.uetq = []; // Bing global
}

if ( ! window.criteo_q ) {
	window.criteo_q = [];
}

// Quantcast Asynchronous Tag
if ( ! window._qevents ) {
	window._qevents = [];
}

/**
 * This sets up the globals that the Facebook event library expects.
 * More info here: https://www.facebook.com/business/help/952192354843755
 */
function setUpFacebookGlobal() {
	const facebookEvents = window.fbq = function() {
		if ( facebookEvents.callMethod ) {
			facebookEvents.callMethod.apply( facebookEvents, arguments );
		} else {
			facebookEvents.queue.push( arguments );
		}
	};

	if ( ! window._fbq ) {
		window._fbq = facebookEvents;
	}

	facebookEvents.push = facebookEvents;
	facebookEvents.loaded = true;
	facebookEvents.version = '2.0';
	facebookEvents.queue = [];
}

function loadTrackingScripts( callback ) {
	hasStartedFetchingScripts = true;

	async.parallel( [
		function( onComplete ) {
			loadScript.loadScript( FACEBOOK_TRACKING_SCRIPT_URL, onComplete );
		},
		function( onComplete ) {
			loadScript.loadScript( GOOGLE_TRACKING_SCRIPT_URL, onComplete );
		},
		function( onComplete ) {
			loadScript.loadScript( BING_TRACKING_SCRIPT_URL, onComplete );
		},
		function( onComplete ) {
			loadScript.loadScript( CRITEO_TRACKING_SCRIPT_URL, onComplete );
		},
		function( onComplete ) {
			loadScript.loadScript( quantcastAsynchronousTagURL(), onComplete );
		}
	], function( errors ) {
		if ( ! some( errors ) ) {
			// update Facebook's tracking global
			window.fbq( 'init', TRACKING_IDS.facebookInit );

			// update Bing's tracking global
			const bingConfig = {
				ti: TRACKING_IDS.bingInit,
				q: window.uetq
			};

			if ( typeof UET !== 'undefined' ) {
				// bing's script creates the UET global for us
				window.uetq = new UET( bingConfig ); // eslint-disable-line
				window.uetq.push( 'pageLoad' );
			}

			hasFinishedFetchingScripts = true;

			if ( typeof callback === 'function' ) {
				callback();
			}
		} else {
			debug( 'Some scripts failed to load: ', errors );
		}
	} );
}

function retarget() {
	if ( ! hasStartedFetchingScripts ) {
		return loadTrackingScripts( retarget );
	}

	// The reason we check whether the scripts have finished is to avoid a situation
	// where retarget is called once (which starts the load process) then immediately
	// again (in which case they've started to be fetched, but haven't finished) which
	// would cause an undefined function error for `google_trackConversion` below.
	if ( hasFinishedFetchingScripts && ! retargetingInitialized ) {
		debug( 'Retargeting initialized' );

		retargetingInitialized = true;

		// Facebook
		window.fbq( 'track', 'PageView' );

		// AdWords
		if ( window.google_trackConversion ) {
			window.google_trackConversion( {
				google_conversion_id: GOOGLE_CONVERSION_ID,
				google_remarketing_only: true
			} );
		}
	}
}

/**
 * Records that an item was added to the cart
 *
 * @param {Object} cartItem - The item added to the cart
 * @returns {void}
 */
function recordAddToCart( cartItem ) {
	if ( ! config.isEnabled( 'ad-tracking' ) ) {
		return;
	}

	if ( ! hasStartedFetchingScripts ) {
		return loadTrackingScripts( recordAddToCart.bind( null, cartItem ) );
	}

	debug( 'Recorded that this item was added to the cart', cartItem );

	window.fbq(
		'track',
		'AddToCart',
		{
			product_slug: cartItem.product_slug,
			free_trial: Boolean( cartItem.free_trial )
		}
	);

	recordInCriteo( 'viewItem', {
		item: cartItem.product_id
	} );
}

/**
 * Records that a user viewed the checkout page
 *
 * @param {Object} cart - cart as `CartValue` object
 */
function recordViewCheckout( cart ) {
	recordViewCheckoutInCriteo( cart );
}

/**
 * Recorders an individual product purchase conversion
 *
 * @param {Object} product - the product
 * @param {Number} orderId - the order id
 * @returns {void}
 */
function recordPurchase( product, orderId ) {
	if ( ! config.isEnabled( 'ad-tracking' ) ) {
		return;
	}

	if ( ! hasStartedFetchingScripts ) {
		return loadTrackingScripts( recordPurchase.bind( null, product, orderId ) );
	}

	const isJetpackPlan = productsValues.isJetpackPlan( product );

	if ( isJetpackPlan ) {
		debug( 'Recording Jetpack purchase', product );
	} else {
		debug( 'Recording purchase', product );
	}

	const currentUser = user.get(),
		userId = currentUser ? currentUser.ID : 0,
		costUSD = costToUSD( product.cost, product.currency );

	// Facebook
	window.fbq(
		'track',
		'Purchase',
		{
			currency: product.currency,
			product_slug: product.product_slug,
			value: product.cost,
			user_id: userId,
			order_id: orderId
		}
	);

	// Bing
	if ( isSupportedCurrency( product.currency ) ) {
		window.uetq.push( {
			ec: 'purchase',
			gv: costUSD
		} );
	}

	// Google
	if ( window.google_trackConversion ) {
		window.google_trackConversion( {
			google_conversion_id: GOOGLE_CONVERSION_ID,
			google_conversion_label: isJetpackPlan
				? TRACKING_IDS.googleConversionLabelJetpack
				: TRACKING_IDS.googleConversionLabel,
			google_conversion_value: product.cost,
			google_conversion_currency: product.currency,
			google_custom_params: {
				product_slug: product.product_slug,
				user_id: userId,
				order_id: orderId
			},
			google_remarketing_only: false
		} );
	}

	// Quantcast
	// Note that all properties have to be strings or they won't get tracked
	if ( isSupportedCurrency( product.currency ) ) {
		window._qevents.push( {
			qacct: TRACKING_IDS.quantcast,
			labels: '_fp.event.Purchase Confirmation,_fp.pcat.' + product.product_slug,
			orderid: orderId.toString(),
			revenue: costUSD.toString(),
			event: 'refresh'
		} );
	}
}

/**
 * For Atlas, we track the entire order, not separately for each product in the order
 *
 * @see https://app.atlassolutions.com/help/atlashelp/727514814019823/ (Atlas account required)
 *
 * @param {Object} cart - cart as `CartValue` object
 * @param {Number} orderId - the order id
 */
function recordOrderInAtlas( cart, orderId ) {
	if ( ! config.isEnabled( 'ad-tracking' ) ) {
		return;
	}

	const currentUser = user.get();

	const params = {
		event: 'Purchase',
		products: cart.products.map( product => product.product_name ).join( ', ' ),
		product_slugs: cart.products.map( product => product.product_slug ).join( ', ' ),
		revenue: cart.total_cost,
		currency_code: cart.currency,
		user_id: currentUser ? currentUser.ID : 0,
		order_id: orderId
	};

	const urlParams = Object.keys( params ).map( function( key ) {
		return encodeURIComponent( key ) + '=' + encodeURIComponent( params[ key ] );
	} ).join( '&' );

	const urlWithParams = ATLAS_TRACKING_SCRIPT_URL + ';m=' + TRACKING_IDS.atlasUniveralTagId +
		';cache=' + Math.random() + '?' + urlParams;

	loadScript.loadScript( urlWithParams );
}

/**
 * Tracks the purchase conversion with One by AOL
 *
 * @note One by AOL does not record any specifics about the purchase
 */
function recordConversionInOneByAOL() {
	if ( ! config.isEnabled( 'ad-tracking' ) ) {
		return;
	}

	new Image().src = ONE_BY_AOL_PIXEL_URL;
}

/**
 * Records an order in Criteo
 *
 * @param {Object} cart - cart as `CartValue` object
 * @param {Number} orderId - the order id
 * @returns {void}
 */
function recordOrderInCriteo( cart, orderId ) {
	if ( ! config.isEnabled( 'ad-tracking' ) ) {
		return;
	}

	recordInCriteo( 'viewBasket', {
		id: orderId,
		currency: cart.currency,
		items: cartToCriteoItems( cart )
	} );
}

/**
 * Records that a user viewed the checkout page
 *
 * @param {Object} cart - cart as `CartValue` object
 * @returns {void}
 */
function recordViewCheckoutInCriteo( cart ) {
	if ( ! config.isEnabled( 'ad-tracking' ) ) {
		return;
	}

	// Note that unlike `recordOrderInCriteo` above, this doesn't include the order id
	recordInCriteo( 'viewBasket', {
		currency: cart.currency,
		items: cartToCriteoItems( cart )
	} );
}

/**
 * Converts the products in a cart to the format Criteo expects for its `items` property
 *
 * @param {Object} cart - cart as `CartValue` object
 * @returns {Array} - An array of items to include in the Criteo tracking call
 */
function cartToCriteoItems( cart ) {
	return cart.products.map( product => {
		return {
			id: product.product_id,
			price: product.cost,
			quantity: product.volume
		};
	} );
}

/**
 * Records an event in Criteo
 *
 * @param {String} eventName - The name of the 'event' property such as 'viewItem' or 'viewBasket'
 * @param {Object} eventProps - Additional details about the event such as `{ item: '1' }`
 *
 * @returns {void}
 */
function recordInCriteo( eventName, eventProps ) {
	if ( ! config.isEnabled( 'ad-tracking' ) ) {
		return;
	}

	if ( ! hasStartedFetchingScripts ) {
		return loadTrackingScripts( recordInCriteo.bind( null, eventName, eventProps ) );
	}

	const events = [];
	events.push( { event: 'setAccount', account: TRACKING_IDS.criteo } );
	events.push( { event: 'setSiteType', type: criteoSiteType() } );

	if ( user.get() ) {
		events.push( { event: 'setEmail', email: [ user.get().email ] } );
	}

	const conversionEvent = clone( eventProps );
	conversionEvent.event = eventName;
	events.push( conversionEvent );

	// The deep clone is necessary because the Criteo script modifies the objects in the
	// array which causes the console to display different data than is originally added
	debug( 'Track `' + eventName + '` event in Criteo', cloneDeep( events ) );

	window.criteo_q.push( ...events );
}

/**
 * Returns the site type value that Criteo expects
 *
 * @note This logic was provided by Criteo and should not be modified
 *
 * @returns {String} 't', 'm', or 'd' for tablet, mobile, or desktop
 */
function criteoSiteType() {
	if ( /iPad/.test( navigator.userAgent ) ) {
		return 't';
	}

	if ( /Mobile|iP(hone|od)|Android|BlackBerry|IEMobile|Silk/.test( navigator.userAgent ) ) {
		return 'm';
	}

	return 'd';
}

/**
 * Returns the URL for Quantcast's Purchase Confirmation Tag
 *
 * @see https://www.quantcast.com/help/guides/using-the-quantcast-asynchronous-tag/
 *
 * @returns {String} The URL
 */
function quantcastAsynchronousTagURL() {
	const protocolAndSubdomain = document.location.protocol === 'https:' ? 'https://secure' : 'http://edge';

	return protocolAndSubdomain + '.quantserve.com/quant.js';
}

/**
 * Converts a cost into USD
 *
 * @note Don't rely on this for precise conversions, it's meant to be an estimate for ad tracking purposes
 *
 * @param {Number} cost - The cost of the cart or product
 * @param {String} currency - The currency such as `USD`, `JPY`, etc
 * @returns {Number} Or null if the currency is not supported
 */
function costToUSD( cost, currency ) {
	if ( ! isSupportedCurrency( currency ) ) {
		return null;
	}

	return cost / EXCHANGE_RATES[ currency ];
}

/**
 * Returns whether a currency is supported
 *
 * @param {String} currency - `USD`, `JPY`, etc
 * @returns {Boolean} Whether there's an exchange rate for the currency
 */
function isSupportedCurrency( currency ) {
	return Object.keys( EXCHANGE_RATES ).indexOf( currency ) !== -1;
}

module.exports = {
	retarget: function( context, next ) {
		const nextFunction = typeof next === 'function' ? next : noop;

		if ( config.isEnabled( 'ad-tracking' ) ) {
			retarget();
		}

		nextFunction();
	},

	recordAddToCart,
	recordViewCheckout,
	recordPurchase,
	recordOrderInAtlas,
	recordConversionInOneByAOL,
	recordOrderInCriteo
};
